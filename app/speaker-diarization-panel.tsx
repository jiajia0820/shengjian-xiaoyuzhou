"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { apiFetch } from "@/lib/auth-client";
import {
  cancelLocalSpeakerJob,
  createLocalSpeakerJob,
  getLocalSpeakerHealth,
  getLocalSpeakerJob,
  localSpeakerErrorMessage,
  type LocalSpeakerMode,
  type LocalSpeakerTurn,
} from "@/lib/local-speaker-client";
import {
  VOICEPRINT_LABELS,
  validateVoiceprintReferences,
  type VoiceprintReferences,
} from "@/lib/voiceprint";

type Notice = { kind: "success" | "error" | "info"; text: string };
type Phase = "idle" | "validating" | "uploading" | "diarizing" | "reviewing" | "saving";
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
type ReferenceSpeakerId = keyof VoiceprintReferences;
type ReferenceInput = { start: string; end: string };
type ReferenceInputs = Record<ReferenceSpeakerId, ReferenceInput>;

const MAX_BYTES = 1 * 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const AUDIO_ACCEPT = ".mp3,.m4a,.wav,.flac,.ogg,.mp4,.webm";
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
    idle: "选择本地音频后开始",
    validating: "正在检查本地音频…",
    uploading: "正在发送到本机服务…",
    diarizing: "本机正在识别说话人…",
    reviewing: "请检查并修正说话人归属",
    saving: "正在保存说话人分段…",
  }[phase];
}

function toVoiceprintReferences(inputs: ReferenceInputs): VoiceprintReferences {
  const milliseconds = (value: string) => Math.round(Number(value) * 1000);
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

export function SpeakerDiarizationPanel({
  episode,
  onSaved,
  reportNotice,
  onBusyChange,
}: {
  episode: { eid: string; durationSeconds: number | null; title: string };
  onSaved: (markdown: string) => void;
  reportNotice: (notice: Notice) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);
  const [mode, setMode] = useState<LocalSpeakerMode>("diarization");
  const [expectedSpeakers, setExpectedSpeakers] = useState<number | null>(null);
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
  const audioUrlRef = useRef<string | null>(null);

  const busy = ["validating", "uploading", "diarizing", "saving"].includes(phase);
  const speakerEngine = mode === "voiceprint"
    ? "pyannote-wespeaker-voiceprint-v1" as const
    : "pyannote-community-1" as const;

  useEffect(() => () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  function updatePhase(next: Phase) {
    setPhase(next);
    onBusyChange?.(["validating", "uploading", "diarizing", "saving"].includes(next));
  }

  function releaseAudioUrl() {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setAudioUrl(null);
    setAudioDurationMs(null);
  }

  function reset() {
    jobIdRef.current = null;
    cancelledRef.current = false;
    releaseAudioUrl();
    setFile(null);
    setMode("diarization");
    setExpectedSpeakers(null);
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

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    releaseAudioUrl();
    setFile(nextFile);
    setError(null);
    if (nextFile) {
      const nextUrl = URL.createObjectURL(nextFile);
      audioUrlRef.current = nextUrl;
      setAudioUrl(nextUrl);
    }
  }

  function updateReference(speakerId: ReferenceSpeakerId, field: "start" | "end", value: string) {
    setReferenceInputs((current) => ({
      ...current,
      [speakerId]: { ...current[speakerId], [field]: value },
    }));
    setError(null);
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
    const nextLabels = mode === "voiceprint"
      ? data.preview.labels.map((label) => ({
        ...label,
        label: VOICEPRINT_LABELS[label.id as ReferenceSpeakerId] ?? label.label,
      }))
      : data.preview.labels;
    const nextPreview = { ...data.preview, labels: nextLabels };
    setPreview(nextPreview);
    setLabels(nextLabels);
    updatePhase("reviewing");
  }

  async function start() {
    if (!file) {
      setError("请先选择本地音频文件");
      return;
    }
    setError(null);
    setPreview(null);
    cancelledRef.current = false;
    try {
      updatePhase("validating");
      if (file.size > MAX_BYTES) throw new Error("音频超过 1GB，未开始处理");
      if (audioDurationMs !== null && audioDurationMs > MAX_DURATION_SECONDS * 1000) {
        throw new Error("音频超过 2 小时，未开始处理");
      }

      let references: VoiceprintReferences | undefined;
      if (mode === "voiceprint") {
        if (audioDurationMs === null) throw new Error("请等待播放器读取音频时长后再开始");
        references = toVoiceprintReferences(referenceInputs);
        const validationError = validateVoiceprintReferences(references, audioDurationMs);
        if (validationError) throw new Error(validationError);
      }

      const health = await getLocalSpeakerHealth();
      if (!health.ffmpegAvailable) throw new Error("本地服务找不到 FFmpeg，请安装后重新启动服务");
      if (mode === "voiceprint" && health.voiceprintModel === "needs_setup") {
        throw new Error("声纹模型尚未登录。请在项目根目录运行 .\\local-audio-service\\.venv\\Scripts\\hf.exe auth login");
      }
      if (mode === "diarization" && health.model === "needs_setup") {
        throw new Error("本地模型尚未登录。请在项目根目录运行 .\\local-audio-service\\.venv\\Scripts\\hf.exe auth login");
      }

      updatePhase("uploading");
      const job = mode === "voiceprint"
        ? await createLocalSpeakerJob(file, { mode: "voiceprint", references: references as VoiceprintReferences })
        : await createLocalSpeakerJob(file, { mode: "diarization", expectedSpeakers });
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
    <button type="button" onClick={() => setOpen(true)}>从本地音频识别说话人</button>
    {open && <div className="modal-backdrop speaker-diarization-backdrop">
      <section className="connect-modal speaker-diarization-modal" role="dialog" aria-modal="true" aria-labelledby="speaker-diarization-title">
        <button className="modal-close" type="button" onClick={() => void close()} aria-label="关闭说话人识别">×</button>
        <p className="modal-kicker">LOCAL · EXPERIMENTAL</p>
        <h2 id="speaker-diarization-title">按说话人分段</h2>
        <p>音频只发送到你电脑上的本地服务，不会上传到声笺服务器。系统不会改写官方正文。</p>

        {!preview ? <div className="speaker-upload-form">
          <label>选择本地音频
            <input aria-label="选择本地音频" type="file" accept={AUDIO_ACCEPT} disabled={busy} onChange={handleFileChange} />
          </label>
          {file && <small>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</small>}
          {file && audioUrl && <div className="speaker-audio">
            <audio controls preload="metadata" src={audioUrl}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) setAudioDurationMs(Math.round(duration * 1000));
              }}
              onError={() => setError("浏览器无法读取音频时长；本地服务仍会再次检查")}
            ><track kind="captions" /></audio>
            <small>{audioDurationMs ? `音频时长：${formatTime(audioDurationMs)}` : "正在读取音频时长…"}</small>
          </div>}
          <label>识别模式
            <select aria-label="识别模式" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as LocalSpeakerMode)}>
              <option value="diarization">全自动识别</option>
              <option value="voiceprint">两人声纹</option>
            </select>
          </label>
          {mode === "diarization" && <label>说话人数
            <select value={expectedSpeakers ?? "auto"} disabled={busy}
              onChange={(event) => setExpectedSpeakers(event.target.value === "auto" ? null : Number(event.target.value))}>
              <option value="auto">自动判断</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count} 人</option>)}
            </select>
          </label>}
          {mode === "voiceprint" && <div className="speaker-reference-form">
            <p className="speaker-reference-hint">两人声纹模式只适合已有小宇宙文稿的双人节目。请在播放器中找到只有一人连续说话的片段，各选 5–30 秒（推荐 8–10 秒以上）；避开片头音乐、多人抢话和明显噪声。</p>
            <div className="speaker-reference-grid">
              {(["speaker_0", "speaker_1"] as const).map((speakerId) => <div className="speaker-reference-card" key={speakerId}>
                <strong>{speakerId === "speaker_0" ? "主持人参考" : "嘉宾参考"}</strong>
                <label>开始（秒）
                  <input type="number" min="0" step="0.1" inputMode="decimal" value={referenceInputs[speakerId].start}
                    onChange={(event) => updateReference(speakerId, "start", event.target.value)} />
                </label>
                <label>结束（秒）
                  <input type="number" min="0" step="0.1" inputMode="decimal" value={referenceInputs[speakerId].end}
                    onChange={(event) => updateReference(speakerId, "end", event.target.value)} />
                </label>
              </div>)}
            </div>
            <small>每段必须为 5–30 秒、在音频时长内，且两段不能重叠；5 秒是最低值，越长通常越稳定。</small>
          </div>}
          <small>上限：2 小时、1GB。将按约 10 分钟分块处理。需要先运行 scripts/start-local-speaker-service.ps1。</small>
          <div className="speaker-progress" aria-live="polite">{phaseLabel(phase)}{phase === "diarizing" && ` ${progress}%`}{phase === "diarizing" && chunkCount > 0 && ` · 第 ${chunkIndex}/${chunkCount} 块`}</div>
          {error && <p className="speaker-error" role="alert">{error}</p>}
          <div className="speaker-modal-actions">
            {busy ? <button type="button" className="danger-button" onClick={() => void close()}>取消本地任务</button>
              : <button type="button" className="save-button" onClick={() => void start()}>开始识别</button>}
          </div>
        </div> : <div className="speaker-review" aria-live="polite">
          <p>已完成对齐。{preview.reviewCount ? `${preview.reviewCount} 段需要你确认。` : "你仍可检查和修改归属。"}</p>
          <div className="speaker-label-grid">
            {labels.map((label) => <label key={label.id}>{label.id}
              <input value={label.label} maxLength={40} onChange={(event) => setLabels((current) => current.map((item) => item.id === label.id ? { ...item, label: event.target.value } : item))} />
            </label>)}
          </div>
          <div className="speaker-review-head">
            <h3>待确认片段</h3>
            <button type="button" onClick={() => setShowAll((current) => !current)}>{showAll ? "仅看待确认" : "查看全部片段"}</button>
          </div>
          <div className="speaker-review-list">
            {!visibleSegments.length && <p>没有待确认片段。</p>}
            {visibleSegments.map(({ segment, index }) => <div className="speaker-review-item" key={index}>
              <time>{formatTime(segment.startMs)}</time>
              <p>{segment.text}</p>
              {segment.speakerNeedsReview && <span>待确认</span>}
              <label>归属
                <select value={overrides[index] ?? segment.speakerId ?? ""} onChange={(event) => changeOverride(index, event.target.value)}>
                  <option value="">待确认</option>
                  {labels.map((label) => <option key={label.id} value={label.id}>{label.label}</option>)}
                </select>
              </label>
            </div>)}
          </div>
          {error && <p className="speaker-error" role="alert">{error}</p>}
          <p className="speaker-save-warning">音频不会上传，保存后将覆盖当前编辑稿。</p>
          <div className="speaker-modal-actions">
            <button type="button" onClick={() => void close()} disabled={phase === "saving"}>取消</button>
            <button className="save-button" type="button" onClick={() => void save()} disabled={phase === "saving"}>{phase === "saving" ? "保存中…" : "保存为当前稿"}</button>
          </div>
        </div>}
      </section>
    </div>}
  </>;
}
