"use client";

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth-client";
import {
  cancelLocalSpeakerJob,
  createLocalSpeakerJob,
  getLocalSpeakerHealth,
  getLocalSpeakerJob,
  localSpeakerErrorMessage,
  type LocalSpeakerTurn,
  type RemoteSpeakerAudioSource,
} from "@/lib/local-speaker-client";
import {
  VOICEPRINT_LABELS,
  parseVoiceprintTimestamp,
  validateVoiceprintReferences,
  type VoiceprintReferences,
} from "@/lib/voiceprint";

type Notice = { kind: "success" | "error" | "info"; text: string };
type Phase = "idle" | "fetching" | "validating" | "uploading" | "diarizing" | "reviewing" | "saving";
type SpeakerLabel = { id: string; label: string };
type ReviewSegment = {
  startMs: number;
  endMs: number | null;
  text: string;
  speakerId: string | null;
  speakerConfidence: number | null;
  speakerNeedsReview: boolean;
};
type Preview = { segments: ReviewSegment[]; labels: SpeakerLabel[]; markdown: string; reviewCount: number };
type AudioSource = {
  audioUrl: string;
  relayUrl: string;
  mimeType: string | null;
  durationSeconds: number | null;
  expiresAt: string;
};
type ReferenceSpeakerId = keyof VoiceprintReferences;
type ReferenceInput = { start: string; end: string };
type ReferenceInputs = Record<ReferenceSpeakerId, ReferenceInput>;

const MAX_DURATION_SECONDS = 2 * 60 * 60;
const DEFAULT_REFERENCE_INPUTS: ReferenceInputs = {
  speaker_0: { start: "", end: "" },
  speaker_1: { start: "", end: "" },
};

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseLabel(phase: Phase): string {
  return {
    idle: "官方音频已就绪，可开始识别",
    fetching: "正在获取小宇宙官方音频…",
    validating: "正在检查官方音频…",
    uploading: "正在交给本机服务…",
    diarizing: "本机正在识别说话人…",
    reviewing: "请检查并修正说话人归属",
    saving: "正在保存说话人分段…",
  }[phase];
}

function toVoiceprintReferences(inputs: ReferenceInputs): VoiceprintReferences {
  const milliseconds = (value: string) => parseVoiceprintTimestamp(value) ?? Number.NaN;
  return {
    speaker_0: {
      startMs: milliseconds(inputs.speaker_0.start),
      endMs: milliseconds(inputs.speaker_0.end),
    },
    speaker_1: {
      startMs: milliseconds(inputs.speaker_1.start),
      endMs: milliseconds(inputs.speaker_1.end),
    },
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "请求失败，请稍后重试");
  return data;
}

function parseAudioSource(value: unknown): AudioSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("官方音频获取失败，可重试");
  const record = value as Record<string, unknown>;
  if (typeof record.audioUrl !== "string" || !record.audioUrl
    || typeof record.relayUrl !== "string" || !record.relayUrl
    || (record.mimeType !== null && typeof record.mimeType !== "string")
    || (record.durationSeconds !== null && (typeof record.durationSeconds !== "number" || !Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0))
    || typeof record.expiresAt !== "string" || !record.expiresAt) {
    throw new Error("官方音频获取失败，可重试");
  }
  return {
    audioUrl: record.audioUrl,
    relayUrl: record.relayUrl,
    mimeType: record.mimeType as string | null,
    durationSeconds: record.durationSeconds as number | null,
    expiresAt: record.expiresAt,
  };
}

export function SpeakerDiarizationPanel({
  episode,
  onSaved,
  reportNotice,
  onBusyChange,
  disabled = false,
}: {
  episode: { eid: string; durationSeconds: number | null; title: string };
  onSaved: (markdown: string) => void;
  reportNotice: (notice: Notice) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [audioSource, setAudioSource] = useState<AudioSource | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(
    episode.durationSeconds && episode.durationSeconds > 0 ? Math.round(episode.durationSeconds * 1000) : null,
  );
  const [referenceInputs, setReferenceInputs] = useState<ReferenceInputs>(DEFAULT_REFERENCE_INPUTS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [turns, setTurns] = useState<LocalSpeakerTurn[]>([]);
  const [labels, setLabels] = useState<SpeakerLabel[]>([]);
  const [overrides, setOverrides] = useState<Record<number, string | null>>({});
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const busy = ["fetching", "validating", "uploading", "diarizing", "saving"].includes(phase);
  const speakerEngine = "pyannote-wespeaker-voiceprint-v1" as const;

  const updatePhase = useCallback((next: Phase) => {
    setPhase(next);
    onBusyChange?.(["fetching", "validating", "uploading", "diarizing", "saving"].includes(next));
  }, [onBusyChange]);

  const fetchAudioSource = useCallback(async (): Promise<AudioSource | null> => {
    setError(null);
    updatePhase("fetching");
    try {
      const source = parseAudioSource(await responseJson<unknown>(await apiFetch(`/api/episodes/${episode.eid}/audio-source`, { cache: "no-store" })));
      setAudioSource(source);
      setAudioDurationMs(source.durationSeconds && source.durationSeconds > 0
        ? Math.round(source.durationSeconds * 1000)
        : episode.durationSeconds && episode.durationSeconds > 0 ? Math.round(episode.durationSeconds * 1000) : null);
      updatePhase("idle");
      return source;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "官方音频获取失败，可重试";
      setAudioSource(null);
      setError(message);
      reportNotice({ kind: "error", text: message });
      updatePhase("idle");
      return null;
    }
  }, [episode.eid, episode.durationSeconds, reportNotice, updatePhase]);

  function openPanel() {
    setOpen(true);
    void fetchAudioSource();
  }

  function updateReference(speakerId: ReferenceSpeakerId, field: "start" | "end", value: string) {
    setReferenceInputs((current) => ({
      ...current,
      [speakerId]: { ...current[speakerId], [field]: value },
    }));
    setError(null);
  }

  function reset() {
    jobIdRef.current = null;
    cancelledRef.current = false;
    setAudioSource(null);
    setAudioDurationMs(episode.durationSeconds && episode.durationSeconds > 0 ? Math.round(episode.durationSeconds * 1000) : null);
    setReferenceInputs(DEFAULT_REFERENCE_INPUTS);
    setPreview(null);
    setTurns([]);
    setLabels([]);
    setOverrides({});
    setProgress(0);
    setChunkIndex(0);
    setChunkCount(0);
    setError(null);
    updatePhase("idle");
  }

  async function close() {
    const jobId = jobIdRef.current;
    if (busy && jobId) {
      cancelledRef.current = true;
      await cancelLocalSpeakerJob(jobId).catch(() => undefined);
    }
    setOpen(false);
    reset();
  }

  async function createPreview(nextTurns: LocalSpeakerTurn[]) {
    const data = await responseJson<{ preview: Preview }>(await apiFetch(`/api/episodes/${episode.eid}/speakers/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns: nextTurns, engine: speakerEngine }),
    }));
    const nextLabels = data.preview.labels.map((label) => ({
      ...label,
      label: VOICEPRINT_LABELS[label.id as ReferenceSpeakerId] ?? label.label,
    }));
    const nextPreview = { ...data.preview, labels: nextLabels };
    setPreview(nextPreview);
    setLabels(nextLabels);
    updatePhase("reviewing");
  }

  async function start() {
    let source = audioSource;
    if (!source || (Date.parse(source.expiresAt) > 0 && Date.parse(source.expiresAt) <= Date.now() + 5_000)) {
      source = await fetchAudioSource();
    }
    if (!source) {
      setError("正在获取小宇宙官方音频，请稍后重试");
      return;
    }
    setError(null);
    setPreview(null);
    cancelledRef.current = false;
    try {
      updatePhase("validating");
      if (audioDurationMs !== null && audioDurationMs > MAX_DURATION_SECONDS * 1000) {
        throw new Error("音频超过 2 小时，未开始处理");
      }

      if (audioDurationMs === null) throw new Error("请等待播放器读取音频时长后再开始");
      const references = toVoiceprintReferences(referenceInputs);
      const validationError = validateVoiceprintReferences(references, audioDurationMs);
      if (validationError) throw new Error(validationError);

      const health = await getLocalSpeakerHealth();
      if (!health.ffmpegAvailable) throw new Error("本地服务找不到 FFmpeg，请安装后重新启动服务");
      if (health.voiceprintModel === "needs_setup") {
        throw new Error("声纹模型尚未登录。请在项目根目录运行 .\\local-audio-service\\.venv\\Scripts\\hf.exe auth login");
      }

      updatePhase("uploading");
      const sourceInput: RemoteSpeakerAudioSource = { sourceUrl: source.audioUrl, fallbackUrl: source.relayUrl };
      const job = await createLocalSpeakerJob(sourceInput, { mode: "voiceprint", references });
      jobIdRef.current = job.jobId;
      updatePhase("diarizing");
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        if (cancelledRef.current) return;
        const current = await getLocalSpeakerJob(job.jobId);
        setProgress(current.progress);
        setChunkIndex(current.chunkIndex);
        setChunkCount(current.chunkCount);
        if (current.status === "ready") {
          setTurns(current.segments);
          await createPreview(current.segments);
          return;
        }
        if (current.status === "failed") throw new Error(localSpeakerErrorMessage(current.error));
        if (current.status === "cancelled") throw new Error("本地任务已取消");
      }
    } catch (caught) {
      if (!cancelledRef.current) {
        const message = caught instanceof Error ? caught.message : "本地说话人识别失败";
        setError(message);
        reportNotice({ kind: "error", text: message });
      }
      updatePhase("idle");
    }
  }

  function changeOverride(index: number, speakerId: string) {
    setOverrides((current) => ({ ...current, [index]: speakerId || null }));
  }

  async function save() {
    if (!preview) return;
    try {
      updatePhase("saving");
      const overrideItems = Object.entries(overrides).map(([index, speakerId]) => ({ index: Number(index), speakerId }));
      const data = await responseJson<{ markdown: string; reviewCount: number }>(await apiFetch(`/api/episodes/${episode.eid}/speakers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns, labels, overrides: overrideItems, engine: speakerEngine }),
      }));
      onSaved(data.markdown);
      reportNotice({ kind: "success", text: data.reviewCount ? `已保存；仍有 ${data.reviewCount} 段待确认` : "已按说话人轮次保存当前稿" });
      setOpen(false);
      reset();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "保存说话人分段失败";
      setError(message);
      reportNotice({ kind: "error", text: message });
      updatePhase("reviewing");
    }
  }

  const visibleSegments = preview?.segments.map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => showAll || segment.speakerNeedsReview) ?? [];

  return <>
    <button type="button" disabled={disabled} onClick={openPanel}>识别说话人</button>
    {open && <div className="modal-backdrop speaker-diarization-backdrop">
      <section className="connect-modal speaker-diarization-modal" role="dialog" aria-modal="true" aria-labelledby="speaker-diarization-title">
        <button className="modal-close" type="button" disabled={disabled || busy} onClick={() => void close()} aria-label="关闭说话人识别">×</button>
        <p className="modal-kicker">LOCAL · EXPERIMENTAL</p>
        <h2 id="speaker-diarization-title">按说话人分段</h2>

        {!preview ? <div className="speaker-upload-form">
          {audioSource ? <div className="speaker-audio">
            <audio controls preload="metadata" src={audioSource.audioUrl}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) setAudioDurationMs(Math.round(duration * 1000));
              }}
              onError={() => setError("浏览器无法读取官方音频；可重新获取音频后再试")}
            ><track kind="captions" /></audio>
            <small>{audioDurationMs ? `音频时长：${formatTime(audioDurationMs)}` : "正在读取音频时长…"}</small>
          </div> : <div className="speaker-source-state" aria-live="polite">
            <p>{phase === "fetching" ? "正在获取小宇宙官方音频…" : "暂时没有获取到官方音频"}</p>
            {phase !== "fetching" && <button type="button" onClick={() => void fetchAudioSource()}>重新获取官方音频</button>}
          </div>}
          <div className="speaker-reference-form">
            <p className="speaker-reference-hint">当前固定使用两人声纹，适合已有小宇宙文稿的双人节目。请在上方原音频播放器中找到只有一人连续说话的片段，各选 5–30 秒（推荐 8–10 秒以上）；避开片头音乐、多人抢话和明显噪声。</p>
            <div className="speaker-reference-grid">
              {(["speaker_0", "speaker_1"] as const).map((speakerId) => <div className="speaker-reference-card" key={speakerId}>
                <strong>{speakerId === "speaker_0" ? "主持人参考" : "嘉宾参考"}</strong>
                <label>开始（分:秒）
                  <input type="text" inputMode="numeric" placeholder="例如 10:39" disabled={disabled || busy} value={referenceInputs[speakerId].start}
                    onChange={(event) => updateReference(speakerId, "start", event.target.value)} />
                </label>
                <label>结束（分:秒）
                  <input type="text" inputMode="numeric" placeholder="例如 10:39" disabled={disabled || busy} value={referenceInputs[speakerId].end}
                    onChange={(event) => updateReference(speakerId, "end", event.target.value)} />
                </label>
              </div>)}
            </div>
            <small>格式：分:秒（例如 10:39）；每段必须为 5–30 秒、在音频时长内，且两段不能重叠；5 秒是最低值，越长通常越稳定。</small>
          </div>
          <small>上限：2 小时、1GB。将按约 10 分钟分块处理。需要先运行 scripts/start-local-speaker-service.ps1。</small>
          <div className="speaker-progress" aria-live="polite">{phaseLabel(phase)}{phase === "diarizing" && ` ${progress}%`}{phase === "diarizing" && chunkCount > 0 && ` · 第 ${chunkIndex}/${chunkCount} 块`}</div>
          {error && <p className="speaker-error" role="alert">{error}</p>}
          <div className="speaker-modal-actions">
            {busy && jobIdRef.current ? <button type="button" className="danger-button" onClick={() => void close()}>取消本地任务</button>
              : <button type="button" className="save-button" disabled={disabled || busy || !audioSource} onClick={() => void start()}>开始识别</button>}
          </div>
        </div> : <div className="speaker-review" aria-live="polite">
          <p>已完成对齐。{preview.reviewCount ? `${preview.reviewCount} 段需要你确认。` : "你仍可检查和修改归属。"}</p>
          <div className="speaker-label-grid">
            {labels.map((label) => <label key={label.id}>{label.id}
              <input value={label.label} disabled={disabled} maxLength={40} onChange={(event) => setLabels((current) => current.map((item) => item.id === label.id ? { ...item, label: event.target.value } : item))} />
            </label>)}
          </div>
          <div className="speaker-review-head">
            <h3>待确认片段</h3>
            <button type="button" disabled={disabled} onClick={() => setShowAll((current) => !current)}>{showAll ? "仅看待确认" : "查看全部片段"}</button>
          </div>
          <div className="speaker-review-list">
            {!visibleSegments.length && <p>没有待确认片段。</p>}
            {visibleSegments.map(({ segment, index }) => <div className="speaker-review-item" key={index}>
              <time>{formatTime(segment.startMs)}</time>
              <p>{segment.text}</p>
              {segment.speakerNeedsReview && <span>待确认</span>}
              <label>归属
                <select value={overrides[index] ?? segment.speakerId ?? ""} disabled={disabled} onChange={(event) => changeOverride(index, event.target.value)}>
                  <option value="">待确认</option>
                  {labels.map((label) => <option key={label.id} value={label.id}>{label.label}</option>)}
                </select>
              </label>
            </div>)}
          </div>
          {error && <p className="speaker-error" role="alert">{error}</p>}
          <p className="speaker-save-warning">音频不会上传，只在本机临时处理；保存后将覆盖当前编辑稿。</p>
          <div className="speaker-modal-actions">
            <button type="button" onClick={() => void close()} disabled={disabled || phase === "saving"}>取消</button>
            <button className="save-button" type="button" onClick={() => void save()} disabled={disabled || phase === "saving"}>{phase === "saving" ? "保存中…" : "保存为当前稿"}</button>
          </div>
        </div>}
      </section>
    </div>}
  </>;
}
