import type { VoiceprintReferences } from "./voiceprint.ts";

export type LocalSpeakerMode = "diarization" | "voiceprint";

export type LocalSpeakerHealth = {
  service: "ok";
  ffmpegAvailable: boolean;
  model: "unloaded" | "ready" | "needs_setup";
  device?: "cpu" | "cuda";
  voiceprintModel?: "unloaded" | "ready" | "needs_setup";
  voiceprintDevice?: "cpu" | "cuda";
};

export type LocalSpeakerTurn = {
  startMs: number;
  endMs: number;
  speakerId: string;
};

export type LocalSpeakerJob = {
  jobId: string;
  status: "queued" | "decoding" | "diarizing" | "ready" | "failed" | "cancelled";
  progress: number;
  expectedSpeakers: number | null;
  durationMs: number | null;
  error: string | null;
  chunkIndex: number;
  chunkCount: number;
  segments: LocalSpeakerTurn[];
  mode: LocalSpeakerMode;
};

export type LocalSpeakerJobOptions =
  | { mode?: "diarization"; expectedSpeakers: number | null }
  | { mode: "voiceprint"; references: VoiceprintReferences };

const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_LOCAL_SPEAKER_URL?.trim() : "";
// Keep the browser on the same loopback hostname as the dev site. Using
// 127.0.0.1 from a localhost page triggers a private-network preflight in
// some Chromium environments before the local service can answer it.
const LOCAL_SPEAKER_URL = (configuredUrl || "http://localhost:8765").replace(/\/+$/, "");
const CLIENT_HEADERS = { "X-Speaker-Client-Version": "1" };
const speakerIdPattern = /^speaker_[0-9]{1,3}$/;

export function localSpeakerErrorMessage(code: string | null): string {
  switch (code) {
    case "HF_TOKEN_MISSING": return "本地模型尚未登录。请在项目根目录运行 .\\local-audio-service\\.venv\\Scripts\\hf.exe auth login 后重试";
    case "PYANNOTE_UNAVAILABLE": return "本地服务缺少 pyannote 依赖，请先运行安装脚本";
    case "PYANNOTE_MODEL_UNAVAILABLE": return "本地模型不可用；请确认已接受 Community-1 模型条件并检查网络";
    case "AUDIO_TOO_LARGE": return "音频超过 1GB，未开始处理";
    case "AUDIO_TOO_LONG": return "音频超过 2 小时，未开始处理";
    case "AUDIO_TYPE_UNSUPPORTED": return "该音频格式暂不支持";
    case "AUDIO_DECODE_FAILED": return "音频解码失败，请确认 FFmpeg 已安装并在 PATH 中";
    case "JOB_NOT_FOUND": return "本地任务已过期或已被清理";
    case "DIARIZATION_FAILED": return "本地说话人识别失败，请检查音频和模型配置";
    case "VOICEPRINT_REFERENCES_INVALID": return "两段参考音频需各为 5–30 秒、位于音频内且不能重叠";
    case "VOICEPRINT_REFERENCES_TOO_SHORT": return "参考片段中的有效语音不足 3 秒，请换一段只有一人连续说话的音频";
    case "VOICEPRINT_MODEL_UNAVAILABLE": return "声纹模型不可用，请检查 Hugging Face 登录和网络";
    case "VOICEPRINT_LOW_CONFIDENCE": return "声纹置信度不足，请换用更干净的参考片段或改用全自动识别";
    case "VOICEPRINT_FAILED": return "本地声纹识别失败，请检查音频和参考片段";
    default: return "本地说话人服务请求失败";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

async function localRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${LOCAL_SPEAKER_URL}${path}`, {
      ...init,
      headers: { ...CLIENT_HEADERS, ...init.headers },
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new Error("无法连接本地说话人服务，请先运行 scripts/start-local-speaker-service.ps1");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const record = asObject(body);
    const code = typeof record?.detail === "string" ? record.detail
      : typeof record?.error === "string" ? record.error : null;
    throw new Error(localSpeakerErrorMessage(code));
  }
  return body;
}

function parseHealth(value: unknown): LocalSpeakerHealth {
  const record = asObject(value);
  if (!record || record.service !== "ok" || typeof record.ffmpegAvailable !== "boolean"
    || !["unloaded", "ready", "needs_setup"].includes(String(record.model))
    || (record.device !== undefined && !["cpu", "cuda"].includes(String(record.device)))
    || (record.voiceprintModel !== undefined && !["unloaded", "ready", "needs_setup"].includes(String(record.voiceprintModel)))
    || (record.voiceprintDevice !== undefined && !["cpu", "cuda"].includes(String(record.voiceprintDevice)))) {
    throw new Error("本地说话人服务返回了无法识别的状态");
  }
  return record as LocalSpeakerHealth;
}

function parseTurn(value: unknown): LocalSpeakerTurn | null {
  const record = asObject(value);
  const startMs = record?.startMs;
  const endMs = record?.endMs;
  if (!record || !isInteger(startMs) || !isInteger(endMs)
    || startMs < 0 || endMs <= startMs
    || typeof record.speakerId !== "string" || !speakerIdPattern.test(record.speakerId)) return null;
  return record as LocalSpeakerTurn;
}

function parseJob(value: unknown): LocalSpeakerJob {
  const record = asObject(value);
  const statuses = ["queued", "decoding", "diarizing", "ready", "failed", "cancelled"];
  const progress = record?.progress;
  const expectedSpeakers = record?.expectedSpeakers;
  const durationMs = record?.durationMs;
  const chunkIndex = record?.chunkIndex;
  const chunkCount = record?.chunkCount;
  if (!record || typeof record.jobId !== "string" || !statuses.includes(String(record.status))
    || !isInteger(progress) || progress < 0 || progress > 100
    || !(expectedSpeakers === null || (isInteger(expectedSpeakers) && expectedSpeakers >= 1 && expectedSpeakers <= 8))
    || !(durationMs === null || (isInteger(durationMs) && durationMs > 0))
    || !(record.error === null || typeof record.error === "string")
    || (record.mode !== undefined && !["diarization", "voiceprint"].includes(String(record.mode)))
    || !isInteger(chunkIndex) || chunkIndex < 0
    || !isInteger(chunkCount) || chunkCount < 0
    || chunkIndex > chunkCount || !Array.isArray(record.segments)) {
    throw new Error("本地说话人服务返回了无法识别的任务数据");
  }
  const segments = record.segments.map(parseTurn);
  if (segments.some((segment) => segment === null)) throw new Error("本地说话人服务返回了无效的时间区间");
  return {
    ...record,
    mode: (record.mode ?? "diarization") as LocalSpeakerMode,
    status: record.status as LocalSpeakerJob["status"],
    segments: segments as LocalSpeakerTurn[],
  } as LocalSpeakerJob;
}

export async function getLocalSpeakerHealth(): Promise<LocalSpeakerHealth> {
  return parseHealth(await localRequest("/health"));
}

export async function createLocalSpeakerJob(
  file: File,
  expectedSpeakers: number | null,
): Promise<{ jobId: string; status: "queued" }>;
export async function createLocalSpeakerJob(
  file: File,
  options: LocalSpeakerJobOptions,
): Promise<{ jobId: string; status: "queued" }>;
export async function createLocalSpeakerJob(
  file: File,
  optionsOrExpected: number | null | LocalSpeakerJobOptions,
): Promise<{ jobId: string; status: "queued" }> {
  const form = new FormData();
  form.append("audio", file);
  if (typeof optionsOrExpected === "number" || optionsOrExpected === null) {
    form.append("mode", "diarization");
    form.append("expectedSpeakers", optionsOrExpected === null ? "auto" : String(optionsOrExpected));
  } else if (optionsOrExpected.mode === "voiceprint") {
    form.append("mode", "voiceprint");
    form.append("references", JSON.stringify(optionsOrExpected.references));
  } else {
    form.append("mode", "diarization");
    form.append("expectedSpeakers", optionsOrExpected.expectedSpeakers === null ? "auto" : String(optionsOrExpected.expectedSpeakers));
  }
  const record = asObject(await localRequest("/jobs", { method: "POST", body: form }));
  if (!record || typeof record.jobId !== "string" || record.status !== "queued") {
    throw new Error("本地说话人服务未能创建任务");
  }
  return { jobId: record.jobId, status: "queued" };
}

export async function getLocalSpeakerJob(jobId: string): Promise<LocalSpeakerJob> {
  return parseJob(await localRequest(`/jobs/${encodeURIComponent(jobId)}`));
}

export async function cancelLocalSpeakerJob(jobId: string): Promise<LocalSpeakerJob> {
  return parseJob(await localRequest(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }));
}
