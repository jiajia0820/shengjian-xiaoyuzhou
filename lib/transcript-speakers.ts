import type { SpeakerLabel, StoredTranscriptSegment } from "./transcript-artifact.ts";

const MAX_TURNS = 10_000;
const SPEAKER_ID_PATTERN = /^speaker_[0-9]{1,3}$/;
const REVIEW_THRESHOLD = 0.6;

export type DiarizationTurn = {
  startMs: number;
  endMs: number;
  speakerId: string;
};

export type TranscriptSpeakerInput = {
  startMs: number;
  endMs?: number | null;
  text: string;
};

export type SpeakerOverride = { index: number; speakerId: string | null };

export class SpeakerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeakerInputError";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function roundedCoverage(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function normalizeDiarizationTurns(value: unknown): DiarizationTurn[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TURNS) {
    throw new SpeakerInputError("说话人时间区间无效");
  }
  const turns = value.map((entry) => {
    const item = objectValue(entry);
    if (!item || !validMs(item.startMs) || !validMs(item.endMs) || item.endMs <= item.startMs
      || typeof item.speakerId !== "string" || !SPEAKER_ID_PATTERN.test(item.speakerId)) {
      throw new SpeakerInputError("说话人时间区间无效");
    }
    return { startMs: item.startMs, endMs: item.endMs, speakerId: item.speakerId };
  });
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1];
    const current = turns[index];
    if (current.startMs < previous.startMs || current.startMs < previous.endMs) {
      throw new SpeakerInputError("说话人时间区间顺序异常");
    }
  }
  return turns;
}

function segmentEnd(
  segment: TranscriptSpeakerInput,
  next: TranscriptSpeakerInput | undefined,
  episodeDurationMs: number | null,
): number {
  if (Number.isInteger(segment.endMs) && (segment.endMs as number) >= segment.startMs) return segment.endMs as number;
  if (next && next.startMs >= segment.startMs) return next.startMs;
  if (episodeDurationMs !== null && Number.isInteger(episodeDurationMs) && episodeDurationMs >= segment.startMs) return episodeDurationMs;
  return segment.startMs + 1;
}

export function alignTranscriptSpeakers(
  segments: readonly TranscriptSpeakerInput[],
  turns: readonly DiarizationTurn[],
  episodeDurationMs: number | null,
): { segments: StoredTranscriptSegment[]; reviewCount: number; speakerIds: string[] } {
  const speakerIds: string[] = [];
  const seenSpeakerIds = new Set<string>();
  for (const turn of turns) {
    if (!seenSpeakerIds.has(turn.speakerId)) {
      seenSpeakerIds.add(turn.speakerId);
      speakerIds.push(turn.speakerId);
    }
  }
  const aligned = segments.map((segment, index) => {
    const endMs = segmentEnd(segment, segments[index + 1], episodeDurationMs);
    const durationMs = Math.max(1, endMs - segment.startMs);
    const overlaps = new Map<string, number>();
    for (const turn of turns) {
      if (turn.startMs >= endMs) break;
      if (turn.endMs <= segment.startMs) continue;
      const overlapMs = Math.max(0, Math.min(endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs));
      if (overlapMs) overlaps.set(turn.speakerId, (overlaps.get(turn.speakerId) ?? 0) + overlapMs);
    }
    let speakerId: string | null = null;
    let largestOverlap = 0;
    for (const [candidateId, overlap] of overlaps) {
      if (overlap > largestOverlap) {
        speakerId = candidateId;
        largestOverlap = overlap;
      }
    }
    const speakerConfidence = speakerId === null ? null : roundedCoverage(largestOverlap / durationMs);
    const speakerNeedsReview = speakerId === null || speakerConfidence === null
      || speakerConfidence < REVIEW_THRESHOLD || overlaps.size > 1;
    return {
      startMs: segment.startMs,
      endMs: segment.endMs ?? null,
      text: segment.text,
      speakerId,
      speakerConfidence,
      speakerNeedsReview,
    };
  });
  return {
    segments: aligned,
    reviewCount: aligned.filter((segment) => segment.speakerNeedsReview).length,
    speakerIds,
  };
}

export function normalizeSpeakerLabels(value: unknown, knownSpeakerIds: readonly string[]): SpeakerLabel[] {
  const known = new Set(knownSpeakerIds);
  if (value === undefined || value === null) {
    return knownSpeakerIds.map((id, index) => ({ id, label: `说话人 ${index + 1}` }));
  }
  if (!Array.isArray(value) || value.length !== knownSpeakerIds.length) {
    throw new SpeakerInputError("说话人标签无效");
  }
  const labels = value.map((entry) => {
    const item = objectValue(entry);
    if (!item || typeof item.id !== "string" || typeof item.label !== "string" || !known.has(item.id)) {
      throw new SpeakerInputError("说话人标签无效");
    }
    const label = item.label.trim();
    if (!label || Array.from(label).length > 40) throw new SpeakerInputError("说话人标签无效");
    return { id: item.id, label };
  });
  const ids = new Set(labels.map((label) => label.id));
  const names = new Set(labels.map((label) => label.label));
  if (ids.size !== known.size || names.size !== labels.length) throw new SpeakerInputError("说话人标签无效");
  return knownSpeakerIds.map((id) => labels.find((label) => label.id === id) as SpeakerLabel);
}

export function applySpeakerOverrides(
  segments: readonly StoredTranscriptSegment[],
  value: unknown,
  knownSpeakerIds: readonly string[],
): StoredTranscriptSegment[] {
  if (value === undefined || value === null) return segments.map((segment) => ({ ...segment }));
  if (!Array.isArray(value)) throw new SpeakerInputError("说话人修正无效");
  const known = new Set(knownSpeakerIds);
  const result = segments.map((segment) => ({ ...segment }));
  const seen = new Set<number>();
  for (const entry of value) {
    const item = objectValue(entry);
    const index = item?.index;
    const speakerId = item?.speakerId;
    if (!item || !Number.isInteger(index) || (index as number) < 0 || (index as number) >= result.length
      || seen.has(index as number) || (speakerId !== null && (typeof speakerId !== "string" || !known.has(speakerId)))) {
      throw new SpeakerInputError("说话人修正无效");
    }
    seen.add(index as number);
    result[index as number].speakerId = speakerId as string | null;
    result[index as number].speakerNeedsReview = speakerId === null;
  }
  return result;
}
