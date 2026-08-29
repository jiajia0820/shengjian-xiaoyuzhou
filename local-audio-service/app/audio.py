from __future__ import annotations

import math
import ipaddress
import socket
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from urllib.parse import urlsplit

MAX_BYTES = 1 * 1024 * 1024 * 1024
MAX_DURATION_MS = 2 * 60 * 60 * 1000
SUPPORTED_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".mp4", ".webm"}
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_REDIRECTS = 3
OFFICIAL_AUDIO_HOST_SUFFIXES = ("xyzcdn.net", "xiaoyuzhoufm.com")
PROXY_DNS_BENCHMARK_NETWORK = ipaddress.ip_network("198.18.0.0/15")
DEFAULT_ALLOWED_ORIGINS = frozenset({"http://localhost:3000", "http://127.0.0.1:3000"})


@dataclass
class AudioValidationError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


def probe_duration_ms(path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        check=False, capture_output=True, text=True, timeout=20,
    )
    try:
        seconds = float(result.stdout.strip())
    except ValueError as error:
        raise AudioValidationError("AUDIO_PROBE_FAILED") from error
    if result.returncode != 0 or not math.isfinite(seconds) or seconds <= 0:
        raise AudioValidationError("AUDIO_PROBE_FAILED")
    return round(seconds * 1000)


def validate_audio_file(path: Path) -> int:
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise AudioValidationError("AUDIO_TYPE_UNSUPPORTED")
    try:
        if path.stat().st_size > MAX_BYTES:
            raise AudioValidationError("AUDIO_TOO_LARGE")
    except FileNotFoundError as error:
        raise AudioValidationError("AUDIO_FILE_MISSING") from error
    duration_ms = probe_duration_ms(path)
    if duration_ms > MAX_DURATION_MS:
        raise AudioValidationError("AUDIO_TOO_LONG")
    return duration_ms


def _official_audio_host(hostname: str) -> bool:
    host = hostname.lower().rstrip(".")
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in OFFICIAL_AUDIO_HOST_SUFFIXES)


def _loopback_host(hostname: str) -> bool:
    normalized = hostname.lower().rstrip(".")
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _url_origin(parts) -> str:
    host = parts.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = parts.port
    if port is None:
        return f"{parts.scheme}://{host}"
    return f"{parts.scheme}://{host}:{port}"


def validate_remote_audio_url(value: str, allowed_origins=frozenset()) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")
    raw = value.strip()
    try:
        parts = urlsplit(raw)
        hostname = parts.hostname
        port = parts.port
    except ValueError as error:
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED") from error
    if not hostname or parts.username or parts.password or parts.fragment:
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")

    origin = _url_origin(parts)
    configured = {str(item).strip().rstrip("/") for item in (allowed_origins or DEFAULT_ALLOWED_ORIGINS) if str(item).strip()}
    is_configured_relay = (
        parts.scheme in {"http", "https"}
        and _loopback_host(hostname)
        and origin.rstrip("/") in configured
    )
    if is_configured_relay:
        return raw
    if parts.scheme != "https" or not _official_audio_host(hostname) or port not in {None, 443}:
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")
    return raw


def _validate_public_dns(hostname: str) -> None:
    # When urllib is configured with an HTTPS proxy, the proxy resolves the
    # remote hostname. Some local proxy clients intentionally map public
    # domains to RFC 2544 benchmark addresses (for example 198.18.0.0/15),
    # which must not be mistaken for a direct private-network target here.
    # The URL host/redirect allowlist is still enforced before this function.
    proxies = urllib.request.getproxies()
    try:
        proxy_bypasses_host = urllib.request.proxy_bypass(hostname)
    except OSError:
        proxy_bypasses_host = True
    proxy_resolves_host = bool((proxies.get("https") or proxies.get("all")) and not proxy_bypasses_host)
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None:
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast or address.is_unspecified:
            raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")
        return
    try:
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except OSError as error:
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED") from error
    addresses = {info[4][0] for info in infos if info[4]}
    if not addresses:
        raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")
    for value in addresses:
        try:
            address = ipaddress.ip_address(value)
        except ValueError as error:
            raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED") from error
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast or address.is_unspecified:
            if proxy_resolves_host and address in PROXY_DNS_BENCHMARK_NETWORK:
                continue
            raise AudioValidationError("AUDIO_HOST_NOT_ALLOWED")


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_origins):
        super().__init__()
        self._allowed_origins = allowed_origins
        self._redirect_count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self._redirect_count += 1
        if self._redirect_count > MAX_REDIRECTS:
            raise AudioValidationError("AUDIO_REDIRECT_NOT_ALLOWED")
        validated = validate_remote_audio_url(newurl, self._allowed_origins)
        target = urlsplit(validated)
        if not _loopback_host(target.hostname or ""):
            _validate_public_dns(target.hostname or "")
        return super().redirect_request(req, fp, code, msg, headers, validated)


def build_remote_opener(allowed_origins=frozenset()):
    return urllib.request.build_opener(_SafeRedirectHandler(allowed_origins))


def _content_header(response, name: str) -> str:
    headers = getattr(response, "headers", {})
    value = headers.get(name) if hasattr(headers, "get") else None
    return str(value or "").strip()


def _audio_suffix(url: str, content_type: str) -> str | None:
    suffix = Path(urlsplit(url).path).suffix.lower()
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime and not (mime.startswith("audio/") or mime in {"application/octet-stream", "video/mp4", "video/webm"}):
        return None
    if suffix in SUPPORTED_SUFFIXES:
        return suffix
    return {
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/flac": ".flac",
        "audio/ogg": ".ogg",
        "audio/webm": ".webm",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
    }.get(mime)


def download_remote_audio(
    url: str,
    destination_dir: Path,
    *,
    allowed_origins=frozenset(),
    cancel_event: Event | None = None,
) -> tuple[Path, int]:
    validated = validate_remote_audio_url(url, allowed_origins)
    parts = urlsplit(validated)
    if not _loopback_host(parts.hostname or ""):
        _validate_public_dns(parts.hostname or "")
    destination_dir.mkdir(parents=True, exist_ok=True)
    path: Path | None = None
    try:
        opener = build_remote_opener(allowed_origins)
        request = urllib.request.Request(
            validated,
            headers={"Accept": "audio/*,video/mp4,video/webm,application/octet-stream", "User-Agent": "ShengjianLocalSpeaker/1"},
        )
        with opener.open(request, timeout=30) as response:
            status = int(getattr(response, "status", 200) or 200)
            if status < 200 or status >= 300:
                raise AudioValidationError("AUDIO_DOWNLOAD_FAILED")
            declared = _content_header(response, "Content-Length")
            try:
                content_length = int(declared) if declared else None
            except ValueError:
                content_length = None
            if content_length is not None and content_length > MAX_BYTES:
                raise AudioValidationError("AUDIO_TOO_LARGE")
            suffix = _audio_suffix(validated, _content_header(response, "Content-Type"))
            if suffix is None:
                raise AudioValidationError("AUDIO_TYPE_UNSUPPORTED")
            path = destination_dir / f"remote{suffix}"
            written = 0
            with path.open("wb") as target:
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise AudioValidationError("JOB_CANCELLED")
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise AudioValidationError("AUDIO_TOO_LARGE")
                    target.write(chunk)
        duration_ms = validate_audio_file(path)
        return path, duration_ms
    except AudioValidationError:
        if path is not None:
            path.unlink(missing_ok=True)
        raise
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        if path is not None:
            path.unlink(missing_ok=True)
        raise AudioValidationError("AUDIO_DOWNLOAD_FAILED")
