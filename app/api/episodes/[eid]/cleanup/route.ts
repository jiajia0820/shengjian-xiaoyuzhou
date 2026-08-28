import { readActiveAiConfiguration } from "@/lib/ai-settings";
import {
  acquireAnalysisLease,
  consumeUsage,
  getEpisodeRecord,
  refundUsage,
  releaseAnalysisLease,
  touchCurrentDocument,
} from "@/lib/db";
import { documentKeys, putJson, putMarkdown, readMarkdown } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { runTranscriptCleanup, type CleanupProgress, type TranscriptCleanupResult } from "@/lib/transcript-cleanup-ai";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };
type CleanupPayload = Omit<TranscriptCleanupResult, "document" | "sourceDocument"> & {
  beforeHash: string;
  afterHash: string;
  undoAvailable: true;
};

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function safeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(502, "CLEANUP_PROVIDER_ERROR", "AI 清理服务暂时不可用，请稍后重试");
}

async function performCleanup(
  userId: string,
  eid: string,
  currentHash: string,
  onProgress?: (progress: CleanupProgress) => void,
): Promise<CleanupPayload> {
  const record = await getEpisodeRecord(userId, eid);
  if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
  const keys = await documentKeys(userId, eid);
  const markdown = await readMarkdown(record.current_key);
  const beforeHash = await sha256Hex(markdown);
  if (beforeHash !== currentHash || (record.content_hash && record.content_hash !== beforeHash)) {
    throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已发生变化，请刷新后重试");
  }
  if (!await consumeUsage(userId, "ai", 20)) {
    throw new HttpError(429, "DAILY_AI_LIMIT", "今天的 20 次 AI 清理额度已用完，请明天再试");
  }
  const leaseId = await acquireAnalysisLease(userId);
  if (!leaseId) {
    await refundUsage(userId, "ai");
    throw new HttpError(409, "ANALYSIS_ALREADY_RUNNING", "当前账号已有一个 AI 任务正在运行，请等待完成");
  }
  try {
    let result: TranscriptCleanupResult;
    try {
      const config = await readActiveAiConfiguration(userId);
      result = await runTranscriptCleanup({ markdown, config, onProgress });
    } catch (error) {
      await refundUsage(userId, "ai");
      throw safeError(error);
    }
    const blockCount = result.document.blocks.length;
    if ((result.failedBatchCount > 0 && result.stats.unprocessedBlocks >= blockCount) || result.failedBatchCount >= blockCount) {
      await refundUsage(userId, "ai");
      throw new HttpError(502, "CLEANUP_PROVIDER_FAILED", "AI 清理未能处理任何段落，请稍后重试");
    }
    const latestMarkdown = await readMarkdown(record.current_key);
    const latestHash = await sha256Hex(latestMarkdown);
    if (latestHash !== beforeHash) {
      await refundUsage(userId, "ai");
      throw new HttpError(409, "CLEANUP_STALE_HASH", "处理期间当前文稿已发生变化，请刷新后重试");
    }
    const afterHash = await sha256Hex(result.markdown);
    const snapshot = {
      schemaVersion: 1,
      episodeId: eid,
      beforeHash,
      afterHash,
      createdAt: new Date().toISOString(),
      beforeMarkdown: markdown,
      provider: result.provider,
      model: result.model,
      stats: result.stats,
    };
    try {
      onProgress?.({ stage: "saving" });
      await putJson(keys.aiCleanupSnapshotKey, snapshot);
      await putMarkdown(record.current_key, result.markdown);
      await touchCurrentDocument(userId, eid, afterHash);
    } catch (error) {
      await refundUsage(userId, "ai");
      throw safeError(error);
    }
    onProgress?.({ stage: "complete", processedBlocks: result.stats.processedBlocks, failedBatchCount: result.failedBatchCount });
    return {
      markdown: result.markdown,
      beforeHash,
      afterHash,
      stats: result.stats,
      failedBatchCount: result.failedBatchCount,
      rejectedIds: result.rejectedIds,
      provider: result.provider,
      model: result.model,
      undoAvailable: true,
    };
  } finally {
    await releaseAnalysisLease(userId, leaseId);
  }
}

export async function POST(request: Request, context: Context) {
  const wantsSse = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  const events: unknown[] = [];
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    let body: unknown;
    try { body = await request.json(); } catch { throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "请求参数无效"); }
    if (!body || typeof body !== "object" || !validHash((body as Record<string, unknown>).currentHash)) {
      throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "currentHash 必须是有效的 SHA-256");
    }
    const result = await performCleanup(user.userId, eid, (body as Record<string, unknown>).currentHash as string, (progress) => {
      if (wantsSse) events.push({ type: "progress", ...progress });
    });
    if (wantsSse) {
      events.push({ type: "complete", result });
      const stream = new ReadableStream({ start(controller) { const encoder = new TextEncoder(); for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    }
    return Response.json(result);
  } catch (error) {
    const safe = safeError(error);
    if (wantsSse) {
      events.push({ type: "error", error: safe.code, message: safe.message });
      const stream = new ReadableStream({ start(controller) { const encoder = new TextEncoder(); for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }
    return apiError(safe);
  }
}
