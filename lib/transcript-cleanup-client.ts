export type CleanupStats = {
  processedBlocks: number;
  changedBlocks: number;
  fillerRemoved: number;
  repetitionsMerged: number;
  typosFixed: number;
  punctuationAdjusted?: number;
  unprocessedBlocks: number;
};

export type CleanupPayload = {
  markdown: string;
  beforeHash: string;
  afterHash: string;
  stats: CleanupStats;
  failedBatchCount?: number;
  rejectedIds?: string[];
  undoAvailable?: boolean;
  speakerLayoutStale?: boolean;
};

export type CleanupProgress = {
  type?: "progress" | "complete" | "error";
  stage?: string;
  batchIndex?: number;
  batchCount?: number;
  processedBlocks?: number;
  failedBatchCount?: number;
  result?: CleanupPayload;
  message?: string;
  error?: string;
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCleanupEventData(data: string): CleanupProgress | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed) as CleanupProgress; }
  catch { return null; }
}

export function cleanupProgressLabel(progress: CleanupProgress): string {
  const stage = progress.stage;
  const batch = typeof progress.batchIndex === "number" && typeof progress.batchCount === "number"
    ? ` · 第 ${progress.batchIndex + 1}/${progress.batchCount} 批` : "";
  if (stage === "parsing") return `正在解析文稿${batch}`;
  if (stage === "processing") return `AI 正在整理${batch}`;
  if (stage === "saving") return "正在保存整理结果…";
  if (stage === "complete") return "AI 整理完成";
  return stage ? `AI 整理：${stage}${batch}` : "AI 处理中…";
}

export async function consumeCleanupResponse(
  response: Response,
  onProgress: (progress: CleanupProgress) => void,
): Promise<CleanupPayload> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(data.message || "AI 整理失败，请稍后重试");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    onProgress({ stage: "processing" });
    const payload = await response.json() as CleanupPayload;
    return payload;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: CleanupPayload | null = null;
  const dispatch = (chunk: string) => {
    const lines = chunk.replaceAll("\r\n", "\n").split("\n");
    let dataLines: string[] = [];
    const flush = () => {
      if (!dataLines.length) return;
      const progress = parseCleanupEventData(dataLines.join("\n"));
      dataLines = [];
      if (!progress) return;
      onProgress(progress);
      if (progress.type === "error") throw new Error(progress.message || "AI 整理失败，请稍后重试");
      if (progress.type === "complete" && progress.result) completed = progress.result;
    };
    for (const line of lines) {
      if (!line.trim()) flush();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    flush();
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) dispatch(`${part}\n\n`);
      if (done) break;
    }
    if (buffer.trim()) dispatch(`${buffer}\n\n`);
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  if (!completed) throw new Error("AI 整理未返回完成结果，请稍后重试");
  return completed;
}
