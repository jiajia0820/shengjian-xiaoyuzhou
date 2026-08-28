from __future__ import annotations

import asyncio
import os
import shutil
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .audio import AudioValidationError, MAX_BYTES, SUPPORTED_SUFFIXES, validate_audio_file, validate_remote_audio_url
from .engine import PyannoteCommunityEngine, VoiceprintEngine
from .jobs import JobManager
from .models import JobSnapshot
from .voiceprint import VoiceprintInputError, parse_voiceprint_references, validate_voiceprint_reference_bounds

DEFAULT_ALLOWED_ORIGINS = frozenset({"http://localhost:3000", "http://127.0.0.1:3000"})
LOOPBACK_HOSTS = {"127.0.0.1", "::1"}
CLIENT_VERSION = "1"
MODEL_STATUS_VALUES = frozenset({"unloaded", "ready", "needs_setup"})
DEVICE_STATUS_VALUES = frozenset({"cpu", "cuda"})


@dataclass(frozen=True)
class ServiceSettings:
    job_root: Path
    allowed_origins: frozenset[str]
    cleanup_interval_seconds: float = 60.0


def load_settings() -> ServiceSettings:
    configured_origins = {
        origin.strip()
        for origin in os.environ.get("SPEAKER_ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    }
    return ServiceSettings(
        job_root=Path(__file__).resolve().parents[1] / ".speaker-jobs",
        allowed_origins=DEFAULT_ALLOWED_ORIGINS | configured_origins,
    )


def _job_payload(snapshot: JobSnapshot) -> dict:
    return {
        "jobId": snapshot.id,
        "status": snapshot.status,
        "progress": snapshot.progress,
        "expectedSpeakers": snapshot.expected_speakers,
        "durationMs": snapshot.duration_ms,
        "error": snapshot.error_code,
        "chunkIndex": snapshot.chunk_index,
        "chunkCount": snapshot.chunk_count,
        "mode": snapshot.mode,
        "segments": [
            {"startMs": turn.start_ms, "endMs": turn.end_ms, "speakerId": turn.speaker_id}
            for turn in snapshot.segments
        ],
    }


def _parse_expected_speakers(value: str | None) -> int | None:
    if value is None or value == "" or value == "auto":
        return None
    try:
        parsed = int(value)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="EXPECTED_SPEAKERS_INVALID") from error
    if parsed < 1 or parsed > 8 or str(parsed) != value:
        raise HTTPException(status_code=422, detail="EXPECTED_SPEAKERS_INVALID")
    return parsed


def _parse_mode(value: str | None) -> str:
    parsed = (value or "diarization").strip().lower()
    if parsed not in {"diarization", "voiceprint"}:
        raise HTTPException(status_code=422, detail="JOB_MODE_INVALID")
    return parsed


def _error_status(error: AudioValidationError) -> int:
    if error.code == "AUDIO_TOO_LARGE":
        return 413
    if error.code == "AUDIO_TYPE_UNSUPPORTED":
        return 415
    return 422


def _safe_engine_status(engine: object | None, method_name: str, allowed: frozenset[str], fallback: str) -> str:
    try:
        value = getattr(engine, method_name, lambda: fallback)()
    except Exception:
        return fallback
    return value if isinstance(value, str) and value in allowed else fallback


def create_app(settings: ServiceSettings | None = None, manager: JobManager | None = None) -> FastAPI:
    active_settings = settings or load_settings()
    owns_manager = manager is None
    active_manager = manager or JobManager(
        active_settings.job_root,
        PyannoteCommunityEngine(),
        voiceprint_engine=VoiceprintEngine(),
    )
    if owns_manager:
        active_manager.clear_orphaned_directories()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        async def cleanup_periodically() -> None:
            while True:
                await asyncio.sleep(max(0.01, active_settings.cleanup_interval_seconds))
                active_manager.cleanup_expired()

        active_manager.cleanup_expired()
        cleanup_task = asyncio.create_task(cleanup_periodically())
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task

    app = FastAPI(
        title="Local speaker diarization service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    async def require_local_client(request: Request) -> None:
        client_host = request.client.host if request.client else None
        if client_host not in LOOPBACK_HOSTS:
            raise HTTPException(status_code=403, detail="LOCAL_CLIENT_REQUIRED")
        if request.headers.get("origin") not in active_settings.allowed_origins:
            raise HTTPException(status_code=403, detail="ORIGIN_NOT_ALLOWED")
        if request.headers.get("x-speaker-client-version") != CLIENT_VERSION:
            raise HTTPException(status_code=403, detail="CLIENT_VERSION_REQUIRED")

    @app.middleware("http")
    async def local_cors_and_pna(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method == "OPTIONS":
            if origin not in active_settings.allowed_origins:
                return JSONResponse({"error": "ORIGIN_NOT_ALLOWED"}, status_code=403)
            response = Response(status_code=204)
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Speaker-Client-Version"
            response.headers["Access-Control-Max-Age"] = "600"
            response.headers["Vary"] = "Origin, Access-Control-Request-Headers"
            if request.headers.get("access-control-request-private-network") == "true":
                response.headers["Access-Control-Allow-Private-Network"] = "true"
            return response

        response = await call_next(request)
        if origin in active_settings.allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response

    @app.get("/health", dependencies=[Depends(require_local_client)])
    async def health() -> dict:
        voiceprint_engine = getattr(active_manager, "_voiceprint_engine", None)
        return {
            "service": "ok",
            "ffmpegAvailable": shutil.which("ffprobe") is not None,
            "model": _safe_engine_status(active_manager._engine, "model_status", MODEL_STATUS_VALUES, "unloaded"),
            "device": _safe_engine_status(active_manager._engine, "device_status", DEVICE_STATUS_VALUES, "cpu"),
            "voiceprintModel": _safe_engine_status(voiceprint_engine, "model_status", MODEL_STATUS_VALUES, "unloaded"),
            "voiceprintDevice": _safe_engine_status(voiceprint_engine, "device_status", DEVICE_STATUS_VALUES, "cpu"),
        }

    @app.post("/jobs", status_code=202, dependencies=[Depends(require_local_client)])
    async def create_job(
        request: Request,
        audio: UploadFile | None = File(None),
        sourceUrl: str | None = Form(None),
        fallbackUrl: str | None = Form(None),
        expectedSpeakers: str | None = Form(None),
        mode: str | None = Form(None),
        references: str | None = Form(None),
    ) -> dict:
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdecimal() and int(content_length) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="AUDIO_TOO_LARGE")

        source_value = sourceUrl.strip() if isinstance(sourceUrl, str) else ""
        fallback_value = fallbackUrl.strip() if isinstance(fallbackUrl, str) else ""
        remote_values = [value for value in (source_value, fallback_value) if value]
        if (audio is None) == (not source_value) or (fallback_value and not source_value):
            raise HTTPException(status_code=422, detail="AUDIO_SOURCE_REQUIRED")
        if audio is not None and remote_values:
            raise HTTPException(status_code=422, detail="AUDIO_SOURCE_REQUIRED")
        remote_sources: tuple[str, ...] | None = None
        if source_value:
            try:
                remote_sources = tuple(dict.fromkeys(
                    validate_remote_audio_url(value, active_settings.allowed_origins)
                    for value in remote_values
                ))
            except AudioValidationError as error:
                raise HTTPException(status_code=_error_status(error), detail=error.code) from error

        expected_speakers = _parse_expected_speakers(expectedSpeakers)
        parsed_mode = _parse_mode(mode)
        parsed_references = None
        if parsed_mode == "voiceprint":
            try:
                parsed_references = parse_voiceprint_references(references)
            except VoiceprintInputError as error:
                raise HTTPException(status_code=422, detail=error.code) from error
        try:
            job = active_manager.create_job(
                expected_speakers,
                mode=parsed_mode,
                references=parsed_references,
                source_urls=remote_sources,
                allowed_origins=active_settings.allowed_origins,
            )
        except ValueError as error:
            code = str(error) if str(error) in {"JOB_MODE_INVALID", "VOICEPRINT_REFERENCES_INVALID", "AUDIO_SOURCE_INVALID"} else "AUDIO_PROCESSING_REJECTED"
            raise HTTPException(status_code=422, detail=code) from error
        if remote_sources:
            try:
                active_manager.start(job.id)
            except Exception:
                active_manager.discard(job.id)
                raise HTTPException(status_code=422, detail="AUDIO_PROCESSING_REJECTED")
            return {"jobId": job.id, "status": "queued"}

        if audio is None:
            active_manager.discard(job.id)
            raise HTTPException(status_code=422, detail="AUDIO_SOURCE_REQUIRED")
        suffix = Path(audio.filename or "").suffix.lower()
        if suffix not in SUPPORTED_SUFFIXES:
            active_manager.discard(job.id)
            raise HTTPException(status_code=415, detail="AUDIO_TYPE_UNSUPPORTED")
        source_path = active_manager.upload_path(job.id, suffix)
        written = 0
        try:
            with source_path.open("wb") as target:
                while chunk := await audio.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise AudioValidationError("AUDIO_TOO_LARGE")
                    target.write(chunk)
            duration_ms = validate_audio_file(source_path)
            if parsed_references is not None:
                try:
                    validate_voiceprint_reference_bounds(parsed_references, duration_ms)
                except VoiceprintInputError as error:
                    raise HTTPException(status_code=422, detail=error.code) from error
            active_manager.queue(job.id, source_path, duration_ms)
            active_manager.start(job.id)
        except AudioValidationError as error:
            active_manager.discard(job.id)
            raise HTTPException(status_code=_error_status(error), detail=error.code) from error
        except HTTPException:
            active_manager.discard(job.id)
            raise
        except Exception:
            active_manager.discard(job.id)
            raise HTTPException(status_code=422, detail="AUDIO_PROCESSING_REJECTED")
        finally:
            if audio is not None:
                await audio.close()

        return {"jobId": job.id, "status": "queued"}

    @app.get("/jobs/{job_id}", dependencies=[Depends(require_local_client)])
    async def get_job(job_id: str) -> dict:
        try:
            return _job_payload(active_manager.snapshot(job_id))
        except KeyError as error:
            raise HTTPException(status_code=404, detail="JOB_NOT_FOUND") from error

    @app.delete("/jobs/{job_id}", dependencies=[Depends(require_local_client)])
    async def cancel_job(job_id: str) -> dict:
        try:
            return _job_payload(active_manager.cancel(job_id))
        except KeyError as error:
            raise HTTPException(status_code=404, detail="JOB_NOT_FOUND") from error

    return app


app = create_app()
