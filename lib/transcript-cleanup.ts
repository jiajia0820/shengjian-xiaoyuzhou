export type CleanupBlock = {
  id: string;
  speakerLabel: string | null;
  timestampText: string | null;
  text: string;
  ordinal: number;
};

export type CleanupDocument = {
  sourceMarkdown: string;
  immutableSkeleton: string[];
  blocks: CleanupBlock[];
};

export type CleanupChange = {
  type: "filler" | "repetition" | "typo" | "punctuation";
  from: string;
  to: string;
  confidence: number;
};

export type CleanupModelResult = {
  schemaVersion: 1;
  segments: Array<{ id: string; text: string; changes: CleanupChange[] }>;
};

type Span = { start: number; end: number };
const TIMESTAMP = /\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/g;
const SECTION = /^##\s+(.+?)\s*$/;
const SPEAKER = /^###\s+(.+?)\s*$/;

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function lineRecords(value: string): Array<{ text: string; start: number; end: number; contentEnd: number }> {
  const records: Array<{ text: string; start: number; end: number; contentEnd: number }> = [];
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline < 0 ? value.length : newline + 1;
    const contentEnd = newline < 0 ? end : newline;
    const raw = value.slice(start, contentEnd);
    records.push({ text: raw.replace(/\r$/, ""), start, end, contentEnd });
    start = end;
  }
  if (!records.length) records.push({ text: "", start: 0, end: 0, contentEnd: 0 });
  return records;
}

function trimBodySpan(source: string, start: number, end: number): Span {
  let bodyStart = start;
  while (bodyStart < end && /\s/.test(source[bodyStart])) bodyStart++;
  let bodyEnd = end;
  while (bodyEnd > bodyStart && (source[bodyEnd - 1] === "\n" || source[bodyEnd - 1] === "\r")) bodyEnd--;
  while (bodyEnd > bodyStart && (source[bodyEnd - 1] === " " || source[bodyEnd - 1] === "\t")) bodyEnd--;
  return { start: bodyStart, end: bodyEnd };
}

export function parseCleanupDocument(markdown: string): CleanupDocument {
  const lines = lineRecords(markdown);
  let officialLine = -1;
  for (const line of lines) {
    if (SECTION.test(line.text) && line.text.trim() === "## 官方文稿") {
      officialLine = lines.indexOf(line);
      break;
    }
  }
  if (officialLine < 0) throw codedError("CLEANUP_NO_BLOCKS", "未找到官方文稿区域或其中没有可清理片段");
  let regionEnd = markdown.length;
  for (let index = officialLine + 1; index < lines.length; index++) {
    if (/^##\s+/.test(lines[index].text)) {
      regionEnd = lines[index].start;
      break;
    }
  }

  type Event = { kind: "heading" | "timestamp"; start: number; end: number; label?: string; timestampText?: string };
  const events: Event[] = [];
  let speakerLabel: string | null = null;
  for (let index = officialLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.start >= regionEnd) break;
    const heading = line.text.match(SPEAKER);
    if (heading) {
      speakerLabel = heading[1].trim() || null;
      events.push({ kind: "heading", start: line.start, end: line.end, label: speakerLabel ?? undefined });
      continue;
    }
    TIMESTAMP.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP.exec(line.text)) !== null) {
      const absoluteStart = line.start + match.index;
      const absoluteEnd = absoluteStart + match[0].length;
      events.push({ kind: "timestamp", start: absoluteStart, end: absoluteEnd, timestampText: match[0] });
    }
  }

  const blocks: CleanupBlock[] = [];
  const spans: Span[] = [];
  let currentLabel: string | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind === "heading") currentLabel = event.label ?? null;
    const rawEnd = Math.min(events[index + 1]?.start ?? regionEnd, regionEnd);
    const span = trimBodySpan(markdown, event.end, rawEnd);
    const text = markdown.slice(span.start, span.end);
    if (!text.trim()) continue;
    spans.push(span);
    blocks.push({
      id: `seg-${String(blocks.length + 1).padStart(6, "0")}`,
      speakerLabel: currentLabel,
      timestampText: event.kind === "timestamp" ? event.timestampText ?? null : null,
      text,
      ordinal: blocks.length,
    });
  }
  if (!blocks.length) throw codedError("CLEANUP_NO_BLOCKS", "官方文稿区域没有可清理片段");

  const immutableSkeleton = [markdown.slice(0, spans[0].start)];
  for (let index = 1; index < spans.length; index++) immutableSkeleton.push(markdown.slice(spans[index - 1].end, spans[index].start));
  immutableSkeleton.push(markdown.slice(spans.at(-1)!.end));
  return { sourceMarkdown: markdown, immutableSkeleton, blocks };
}

function hasUnsafeMarker(value: string): boolean {
  return /\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/.test(value)
    || /^\s*#{1,6}(?:[ \t]+.*)?[ \t]*$/m.test(value)
    || /^\s*---\s*$/m.test(value)
    || /^\s*(?:`{3,}|~{3,})/m.test(value);
}

export function assembleCleanupDocument(document: CleanupDocument, replacements: ReadonlyMap<string, string>): string {
  const known = new Set(document.blocks.map((block) => block.id));
  for (const id of replacements.keys()) if (!known.has(id)) throw codedError("CLEANUP_UNKNOWN_ID", `未知片段 ID: ${id}`);
  const parts: string[] = [document.immutableSkeleton[0] ?? document.sourceMarkdown];
  for (let index = 0; index < document.blocks.length; index++) {
    const block = document.blocks[index];
    const proposed = replacements.get(block.id);
    const text = proposed && proposed.trim() && !hasUnsafeMarker(proposed) ? proposed : block.text;
    if (proposed && proposed.trim() && hasUnsafeMarker(proposed)) throw codedError("CLEANUP_UNSAFE_REPLACEMENT", `片段 ${block.id} 含有不可替换的 Markdown 元数据`);
    parts.push(text, document.immutableSkeleton[index + 1] ?? "");
  }
  return parts.join("");
}

export function splitCleanupBlocks(blocks: readonly CleanupBlock[], maxChars: number): CleanupBlock[][] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new RangeError("maxChars must be positive");
  const chunks: CleanupBlock[][] = [];
  let current: CleanupBlock[] = [];
  let length = 0;
  for (const block of blocks) {
    const size = Array.from(block.text).length;
    if (current.length && length + size > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(block);
    length += size;
    if (size > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], context: string): void {
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new TypeError(`${context} fields are invalid`);
}

export function parseCleanupModelResult(value: string): CleanupModelResult {
  if (typeof value !== "string") throw new TypeError("model result must be a string");
  const trimmed = value.trim();
  const fence = trimmed.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  const json = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new SyntaxError("model result must be valid JSON without trailing explanation"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("model result must be an object");
  const root = parsed as Record<string, unknown>;
  exactKeys(root, ["schemaVersion", "segments"], "result");
  if (root.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1");
  if (!Array.isArray(root.segments)) throw new TypeError("segments must be an array");
  const seen = new Set<string>();
  const segments = root.segments.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`segment ${index} must be an object`);
    const segment = raw as Record<string, unknown>;
    exactKeys(segment, ["id", "text", "changes"], `segment ${index}`);
    if (typeof segment.id !== "string" || !segment.id || seen.has(segment.id)) throw new TypeError(`segment ${index} has duplicate or invalid id`);
    if (typeof segment.text !== "string") throw new TypeError(`segment ${index}.text must be a string`);
    if (!Array.isArray(segment.changes)) throw new TypeError(`segment ${index}.changes must be an array`);
    seen.add(segment.id);
    const changes = segment.changes.map((rawChange, changeIndex) => {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) throw new TypeError(`change ${index}.${changeIndex} must be an object`);
      const change = rawChange as Record<string, unknown>;
      exactKeys(change, ["type", "from", "to", "confidence"], `change ${index}.${changeIndex}`);
      if (typeof change.type !== "string" || !["filler", "repetition", "typo", "punctuation"].includes(change.type)) throw new TypeError(`change ${index}.${changeIndex}.type is invalid`);
      if (typeof change.from !== "string" || typeof change.to !== "string") throw new TypeError(`change ${index}.${changeIndex} text fields are invalid`);
      if (typeof change.confidence !== "number" || !Number.isFinite(change.confidence) || change.confidence < 0 || change.confidence > 1) throw new RangeError(`change ${index}.${changeIndex}.confidence is invalid`);
      return { type: change.type as CleanupChange["type"], from: change.from, to: change.to, confidence: change.confidence };
    });
    return { id: segment.id, text: segment.text, changes };
  });
  return { schemaVersion: 1, segments };
}

function nonWhitespaceLength(value: string): number { return value.replace(/\s/g, "").length; }

function applyDeclaredChanges(original: string, changes: readonly CleanupChange[]): string | null {
  let value = original;
  for (const change of changes) {
    if (!change.from || value.indexOf(change.from) < 0) return null;
    const index = value.indexOf(change.from);
    value = `${value.slice(0, index)}${change.to}${value.slice(index + change.from.length)}`;
  }
  return value;
}

export function validateCleanupModelResult(document: CleanupDocument, result: CleanupModelResult, allowedIds?: ReadonlySet<string>): { replacements: Map<string, string>; changes: CleanupChange[]; rejectedIds: string[] } {
  const expected = allowedIds ?? new Set(document.blocks.map((block) => block.id));
  const actual = new Set<string>();
  for (const segment of result.segments) {
    if (actual.has(segment.id)) throw codedError("CLEANUP_INVALID_IDS", `duplicate segment ID: ${segment.id}`);
    actual.add(segment.id);
  }
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length || extra.length) throw codedError("CLEANUP_INVALID_IDS", `missing or extra segment IDs: ${[...missing, ...extra].join(", ")}`);
  const blocks = new Map(document.blocks.map((block) => [block.id, block]));
  const replacements = new Map<string, string>();
  const changes: CleanupChange[] = [];
  const rejectedIds: string[] = [];
  for (const segment of result.segments) {
    const block = blocks.get(segment.id);
    if (!block) { rejectedIds.push(segment.id); continue; }
    if (!segment.text.trim()) { rejectedIds.push(segment.id); continue; }
    if (segment.text !== block.text && !segment.changes.length) { rejectedIds.push(segment.id); continue; }
    const declaredText = applyDeclaredChanges(block.text, segment.changes);
    if (declaredText === null || declaredText !== segment.text) { rejectedIds.push(segment.id); continue; }
    const unsafe = hasUnsafeMarker(segment.text) || segment.changes.some((change) => hasUnsafeMarker(change.from) || hasUnsafeMarker(change.to));
    const lowTypo = segment.changes.some((change) => change.type === "typo" && change.confidence < 0.9);
    const removalOnly = segment.changes.length > 0 && segment.changes.every((change) =>
      (change.type === "filler" || change.type === "repetition") && change.from.trim().length > 0 && change.to.trim().length === 0,
    );
    const originalLength = nonWhitespaceLength(block.text);
    const outputLength = nonWhitespaceLength(segment.text);
    const tooLong = originalLength > 0 && outputLength > originalLength * 1.5;
    const tooShort = originalLength > 0 && outputLength < originalLength * 0.5;
    if (unsafe || lowTypo || ((!removalOnly) && (tooLong || tooShort))) { rejectedIds.push(segment.id); continue; }
    if (segment.text !== block.text) replacements.set(segment.id, segment.text);
    changes.push(...segment.changes);
  }
  return { replacements, changes, rejectedIds };
}
