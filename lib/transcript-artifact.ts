import type { TranscriptSegment } from "./xiaoyuzhou.ts";

export type StoredTranscriptSegment = {
  startMs: number;
  endMs: number | null;
  text: string;
  speakerId: string | null;
  speakerConfidence: number | null;
  speakerNeedsReview: boolean;
};

export type SpeakerLabel = { id: string; label: string };

export const SPEAKER_ENGINES = ["pyannote-community-1", "pyannote-wespeaker-voiceprint-v1"] as const;
export type SpeakerEngine = typeof SPEAKER_ENGINES[number];

export function isSpeakerEngine(value: unknown): value is SpeakerEngine {
  return typeof value === "string" && (SPEAKER_ENGINES as readonly string[]).includes(value);
}

export type SpeakerLayout = {
  engine: SpeakerEngine;
  generatedAt: string;
  currentMarkdownHash: string;
  labels: SpeakerLabel[];
};

export type TranscriptArtifact = {
  schemaVersion: 2;
  source: "xiaoyuzhou";
  episodeId: string;
  capturedAt: string;
  segments: StoredTranscriptSegment[];
  speakerLayout: SpeakerLayout | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeSpeakerId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id && id.length <= 80 ? id : undefined;
}

function normalizeSegment(value: unknown): StoredTranscriptSegment | null {
  const item = objectValue(value);
  if (!item || !validTimestamp(item.startMs) || typeof item.text !== "string" || !item.text.trim()) return null;
  const endMs = item.endMs === undefined || item.endMs === null
    ? null
    : validTimestamp(item.endMs) && item.endMs >= item.startMs ? item.endMs : null;
  if (item.endMs !== undefined && item.endMs !== null && endMs === null) return null;
  const speakerId = normalizeSpeakerId(item.speakerId);
  if (speakerId === undefined) return null;
  const speakerConfidence = item.speakerConfidence === undefined || item.speakerConfidence === null
    ? null
    : typeof item.speakerConfidence === "number" && Number.isFinite(item.speakerConfidence)
      && item.speakerConfidence >= 0 && item.speakerConfidence <= 1
      ? item.speakerConfidence
      : null;
  if (item.speakerConfidence !== undefined && item.speakerConfidence !== null && speakerConfidence === null) return null;
  if (item.speakerNeedsReview !== undefined && typeof item.speakerNeedsReview !== "boolean") return null;
  return {
    startMs: item.startMs,
    endMs,
    text: item.text,
    speakerId: speakerId ?? null,
    speakerConfidence,
    speakerNeedsReview: item.speakerNeedsReview === true,
  };
}

function normalizeLabels(value: unknown): SpeakerLabel[] | null {
  if (!Array.isArray(value)) return null;
  const labels = value.map((item) => {
    const label = objectValue(item);
    if (!label || typeof label.id !== "string" || typeof label.label !== "string") return null;
    const id = label.id.trim();
    const display = label.label.trim();
    return id && id.length <= 80 && display && Array.from(display).length <= 40 ? { id, label: display } : null;
  });
  if (labels.some((label) => label === null)) return null;
  const result = labels as SpeakerLabel[];
  return new Set(result.map((label) => label.id)).size === result.length
    && new Set(result.map((label) => label.label)).size === result.length ? result : null;
}

function normalizeSpeakerLayout(value: unknown): SpeakerLayout | null | undefined {
  if (value === undefined || value === null) return value === undefined ? undefined : null;
  const layout = objectValue(value);
  if (!layout || !isSpeakerEngine(layout.engine) || typeof layout.generatedAt !== "string"
    || typeof layout.currentMarkdownHash !== "string" || !layout.currentMarkdownHash) return undefined;
  const labels = normalizeLabels(layout.labels);
  return labels === null ? undefined : {
    engine: layout.engine,
    generatedAt: layout.generatedAt,
    currentMarkdownHash: layout.currentMarkdownHash,
    labels,
  };
}

function normalizeSegments(value: unknown): StoredTranscriptSegment[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const segments = value.map(normalizeSegment);
  if (segments.some((segment) => segment === null)) return null;
  const result = segments as StoredTranscriptSegment[];
  return result.every((segment, index) => index === 0 || segment.startMs >= result[index - 1].startMs) ? result : null;
}

export function buildTranscriptArtifact(
  episodeId: string,
  segments: TranscriptSegment[],
  capturedAt: string,
): TranscriptArtifact {
  return {
    schemaVersion: 2,
    source: "xiaoyuzhou",
    episodeId,
    capturedAt,
    segments: segments.map((segment) => ({
      startMs: Math.max(0, Math.floor(segment.startMs)),
      endMs: segment.endMs == null ? null : Math.max(Math.floor(segment.startMs), Math.floor(segment.endMs)),
      text: segment.text,
      speakerId: segment.speakerId?.trim() || null,
      speakerConfidence: segment.speakerConfidence == null ? null : segment.speakerConfidence,
      speakerNeedsReview: segment.speakerNeedsReview === true,
    })),
    speakerLayout: null,
  };
}

export function parseTranscriptArtifact(value: string): TranscriptArtifact | null {
  try {
    const parsed = objectValue(JSON.parse(value));
    if (!parsed || parsed.source !== "xiaoyuzhou" || typeof parsed.episodeId !== "string" || !parsed.episodeId
      || typeof parsed.capturedAt !== "string" || !parsed.capturedAt) return null;
    const segments = normalizeSegments(parsed.segments);
    if (!segments) return null;
    if (parsed.schemaVersion === 1) {
      return { schemaVersion: 2, source: "xiaoyuzhou", episodeId: parsed.episodeId, capturedAt: parsed.capturedAt, segments, speakerLayout: null };
    }
    if (parsed.schemaVersion !== 2) return null;
    const speakerLayout = normalizeSpeakerLayout(parsed.speakerLayout);
    if (speakerLayout === undefined) return null;
    return { schemaVersion: 2, source: "xiaoyuzhou", episodeId: parsed.episodeId, capturedAt: parsed.capturedAt, segments, speakerLayout };
  } catch {
    return null;
  }
}
