import { formatTimestamp } from "./markdown.ts";
import { isSpeakerEngine, type SpeakerEngine, type SpeakerLabel, type StoredTranscriptSegment } from "./transcript-artifact.ts";

function updateFrontmatter(markdown: string, engine: SpeakerEngine): string {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?=\n|$)/);
  if (match) {
    const fields = match[1].split("\n").filter((line) => !/^\s*(transcript_layout|organization_mode|speaker_source):/.test(line));
    fields.push('transcript_layout: "speaker-v1"', `speaker_source: "${engine}"`);
    return `---\n${fields.join("\n")}\n---${normalized.slice(match[0].length)}`;
  }
  return `---\ntranscript_layout: "speaker-v1"\nspeaker_source: "${engine}"\n---\n\n${normalized}`;
}

function safeLabel(value: string | undefined): string {
  const label = (value ?? "待确认").replace(/[\r\n#]/g, " ").replace(/\s+/g, " ").trim();
  return label || "待确认";
}

function appendText(current: string, next: string): string {
  if (!current) return next;
  return /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(next) ? `${current} ${next}` : `${current}${next}`;
}

function speakerKey(segment: StoredTranscriptSegment): string {
  return segment.speakerNeedsReview || segment.speakerId === null ? "unconfirmed" : segment.speakerId;
}

export function renderSpeakerMarkdown(
  officialMarkdown: string,
  segments: readonly StoredTranscriptSegment[],
  labels: readonly SpeakerLabel[],
  engine: SpeakerEngine = "pyannote-community-1",
): string {
  const normalized = updateFrontmatter(officialMarkdown, isSpeakerEngine(engine) ? engine : "pyannote-community-1");
  const lines = normalized.split("\n");
  const officialIndex = lines.findIndex((line) => line.trim() === "## 官方文稿");
  if (officialIndex < 0) throw new Error("没有找到“## 官方文稿”区域");
  const nextSection = lines.findIndex((line, index) => index > officialIndex && /^##\s+/.test(line));
  const before = lines.slice(0, officialIndex + 1);
  const after = nextSection < 0 ? [] : lines.slice(nextSection);
  const labelById = new Map(labels.map((label) => [label.id, safeLabel(label.label)]));
  const turns: Array<{ key: string; startMs: number; text: string }> = [];
  for (const segment of segments) {
    const key = speakerKey(segment);
    const previous = turns.at(-1);
    if (!previous || previous.key !== key) {
      turns.push({ key, startMs: segment.startMs, text: segment.text });
    } else {
      previous.text = appendText(previous.text, segment.text);
    }
  }
  const transcript = turns.map((turn) => {
    const label = turn.key === "unconfirmed" ? "待确认" : labelById.get(turn.key) ?? "待确认";
    return `### ${label}\n\n[${formatTimestamp(turn.startMs)}] ${turn.text}`;
  }).join("\n\n");
  const output = [...before, "", transcript, ...after.length ? ["", ...after] : []].join("\n");
  return output.endsWith("\n") ? output : `${output}\n`;
}
