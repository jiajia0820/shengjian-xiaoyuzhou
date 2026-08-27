export type VoiceprintReferenceRange = {
  startMs: number;
  endMs: number;
};

export type VoiceprintReferences = {
  speaker_0: VoiceprintReferenceRange;
  speaker_1: VoiceprintReferenceRange;
};

export const VOICEPRINT_LABELS = {
  speaker_0: "主持人",
  speaker_1: "嘉宾",
} as const;

export const MIN_VOICEPRINT_REFERENCE_MS = 5_000;
export const MAX_VOICEPRINT_REFERENCE_MS = 30_000;

function validMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRange(value: unknown): value is VoiceprintReferenceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  return validMs(range.startMs) && validMs(range.endMs) && range.endMs > range.startMs;
}

export function validateVoiceprintReferences(
  references: unknown,
  durationMs: number | null,
): string | null {
  if (!Number.isSafeInteger(durationMs) || (durationMs as number) <= 0) {
    return "无法读取音频时长，请重新选择文件";
  }
  if (!references || typeof references !== "object" || Array.isArray(references)) {
    return "请填写主持人和嘉宾参考时间";
  }
  const value = references as Record<string, unknown>;
  const speakerIds = ["speaker_0", "speaker_1"] as const;
  if (Object.keys(value).length !== speakerIds.length || speakerIds.some((id) => !(id in value))) {
    return "请填写主持人和嘉宾参考时间";
  }
  const ranges = speakerIds.map((id) => value[id]);
  if (ranges.some((range) => !validRange(range))) {
    return "参考时间必须是有效的开始和结束秒数";
  }
  const [host, guest] = ranges as VoiceprintReferenceRange[];
  for (const range of [host, guest]) {
    const length = range.endMs - range.startMs;
    if (length < MIN_VOICEPRINT_REFERENCE_MS) return "每段参考需至少 5 秒";
    if (length > MAX_VOICEPRINT_REFERENCE_MS) return "每段参考不能超过 30 秒";
    if (range.endMs > (durationMs as number)) return "参考时间不能超过音频时长";
  }
  if (host.startMs < guest.endMs && guest.startMs < host.endMs) {
    return "主持人和嘉宾参考时间不能重叠";
  }
  return null;
}
