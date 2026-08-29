import { readActiveAiConfiguration } from "@/lib/ai-settings";
import {
  acquireAnalysisLease,
  consumeUsage,
  getEpisodeRecord,
  refundUsage,
  releaseAnalysisLease,
  touchCurrentDocumentIfHash,
} from "@/lib/db";
import { deleteDocument, documentKeys, putJson, putMarkdownIfEtag, readJson, readMarkdown, readMarkdownWithEtag } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { parseTranscriptArtifact, withCurrentMarkdownHash } from "@/lib/transcript-artifact";
import { runTranscriptCleanup, type CleanupProgress, type TranscriptCleanupResult } from "@/lib/transcript-cleanup-ai";
import { parseCleanupDocument } from "@/lib/transcript-cleanup";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };
type CleanupPayload = Omit<TranscriptCleanupResult, "document" | "sourceDocument"> & {
  beforeHash: string;
  afterHash: string;
  undoAvailable: true;
  speakerLayoutStale: boolean;
};

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function safeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(502, "CLEANUP_PROVIDER_ERROR", "AI 清理服务暂时不可用，请稍后重试");
}

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(eid)) throw new HttpError(400, "INVALID_EPISODE_ID", "文稿标识无效");
    const keys = await documentKeys(user.userId, eid);
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    if (record.current_key !== keys.currentKey) throw new HttpError(409, "CLEANUP_DOCUMENT_KEY_MISMATCH", "当前文稿存储位置无效，请刷新后重试");
    let snapshot: unknown;
    try { snapshot = JSON.parse(await readJson(keys.aiCleanupSnapshotKey)); } catch { return Response.json({ undoAvailable: false }); }
    if (!snapshot || typeof snapshot !== "object") return Response.json({ undoAvailable: false });
    const value = snapshot as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.episodeId !== eid || !validHash(value.afterHash)) return Response.json({ undoAvailable: false });
    let current;
    try { current = await readMarkdownWithEtag(record.current_key); } catch { return Response.json({ undoAvailable: false }); }
    if (!current.etag) return Response.json({ undoAvailable: false });
    const currentHash = (await sha256Hex(current.markdown)).toLowerCase();
    return Response.json({ undoAvailable: currentHash === String(value.afterHash).toLowerCase() });
  } catch (error) {
    return apiError(safeError(error));
  }
}

async function performCleanup(
  userId: string,
  eid: string,
  currentHash: string,
  onProgress?: (progress: CleanupProgress) => void,
): Promise<CleanupPayload> {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(eid)) {
    throw new HttpError(400, "INVALID_EPISODE_ID", "文稿标识无效");
  }
  const keys = await documentKeys(userId, eid);
  const record = await getEpisodeRecord(userId, eid);
  if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
  if (record.current_key !== keys.currentKey) {
    throw new HttpError(409, "CLEANUP_DOCUMENT_KEY_MISMATCH", "当前文稿存储位置无效，请刷新后重试");
  }
  const currentObject = await readMarkdownWithEtag(record.current_key);
  const markdown = currentObject.markdown;
  if (!currentObject.etag) throw new HttpError(409, "CLEANUP_DOCUMENT_CHANGED", "当前文稿版本不可验证，请刷新后重试");
  const beforeHash = await sha256Hex(markdown);
  if (beforeHash !== currentHash || (record.content_hash && record.content_hash !== beforeHash)) {
    throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已被修改，请刷新后重试");
  }
  if (new TextEncoder().encode(markdown).byteLength > 5_000_000 || Array.from(markdown).length > 400_000) {
    throw new HttpError(413, "CLEANUP_DOCUMENT_TOO_LARGE", "文稿超过清理上限");
  }
  let parsedDocument;
  try { parsedDocument = parseCleanupDocument(markdown); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "CLEANUP_NO_BLOCKS") {
      throw new HttpError(400, "CLEANUP_NO_BLOCKS", "文稿没有可清理的段落");
    }
    throw error;
  }
  if (parsedDocument.blocks.length === 0) {
    throw new HttpError(400, "CLEANUP_NO_BLOCKS", "文稿没有可清理的段落");
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
    let refunded = false;
    const refundOnce = async () => { if (!refunded) { refunded = true; await refundUsage(userId, "ai"); } };
    let result: TranscriptCleanupResult;
    try {
      const config = await readActiveAiConfiguration(userId);
      result = await runTranscriptCleanup({ markdown, config, onProgress });
    } catch (error) {
      await refundOnce();
      throw safeError(error);
    }
    const blockCount = result.document.blocks.length;
    const allBlocksRejected = result.rejectedIds.length >= blockCount
      || result.stats.unprocessedBlocks >= blockCount;
    if ((blockCount > 0 && result.stats.processedBlocks === 0 && allBlocksRejected)
      || result.failedBatchCount >= blockCount) {
      await refundOnce();
      throw new HttpError(502, "CLEANUP_PROVIDER_FAILED", "AI 清理未能处理任何段落，请稍后重试");
    }
    let latestMarkdown: string;
    let latestHash: string;
    try { latestMarkdown = await readMarkdown(record.current_key); latestHash = await sha256Hex(latestMarkdown); }
    catch (error) { await refundOnce(); throw safeError(error); }
    if (latestHash !== beforeHash) {
      await refundOnce();
      throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已被修改，请刷新后重试");
    }
    const afterHash = await sha256Hex(result.markdown);
    if (new TextEncoder().encode(result.markdown).byteLength > 5_000_000 || Array.from(result.markdown).length > 400_000) {
      await refundOnce();
      throw new HttpError(413, "CLEANUP_DOCUMENT_TOO_LARGE", "清理结果超过文稿上限");
    }
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
    let snapshotWritten = false;
    let currentWriteStarted = false;
    let currentWriteSucceeded = false;
    let writtenEtag: string | null = null;
    let casConflict = false;
    try {
      onProgress?.({ stage: "saving" });
      await putJson(keys.aiCleanupSnapshotKey, snapshot);
      snapshotWritten = true;
      currentWriteStarted = true;
      writtenEtag = await putMarkdownIfEtag(record.current_key, result.markdown, currentObject.etag);
      if (!writtenEtag) {
        casConflict = true;
        throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已被修改，请刷新后重试");
      }
      currentWriteSucceeded = true;
      if (!await touchCurrentDocumentIfHash(userId, eid, beforeHash, afterHash)) {
        casConflict = true;
        throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已被修改，请刷新后重试");
      }
    } catch (error) {
      // Best-effort compensation across object storage and DB; never report success on failure.
      let currentRestored = !currentWriteStarted;
      let hashRestored = !currentWriteStarted;
      if (currentWriteSucceeded && writtenEtag && !casConflict) {
          try { currentRestored = Boolean(await putMarkdownIfEtag(record.current_key, markdown, writtenEtag)); } catch { /* retain snapshot for manual recovery */ }
          try {
            hashRestored = await touchCurrentDocumentIfHash(userId, eid, afterHash, beforeHash);
            if (!hashRestored) {
              const observed = await sha256Hex(await readMarkdown(record.current_key));
              hashRestored = observed === beforeHash;
            }
          } catch { /* best effort */ }
      }
      if (snapshotWritten && currentRestored && hashRestored) {
        try { await deleteDocument(keys.aiCleanupSnapshotKey); } catch { /* retain snapshot for recovery */ }
      }
      await refundOnce();
      throw safeError(error);
    }
    let speakerLayoutStale = false;
    try {
      const artifact = parseTranscriptArtifact(await readJson(keys.transcriptKey));
      if (!artifact || artifact.episodeId !== eid || artifact.speakerLayout?.currentMarkdownHash !== beforeHash) {
        speakerLayoutStale = true;
      } else {
        await putJson(keys.transcriptKey, withCurrentMarkdownHash(artifact, afterHash));
      }
    } catch {
      speakerLayoutStale = true;
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
      speakerLayoutStale,
    };
  } finally {
    try { await releaseAnalysisLease(userId, leaseId); } catch { /* best effort */ }
  }
}

export async function POST(request: Request, context: Context) {
  const wantsSse = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    let body: unknown;
    try { body = await request.json(); } catch { throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "请求参数无效"); }
    if (!body || typeof body !== "object" || !validHash((body as Record<string, unknown>).currentHash)) {
      throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "currentHash 必须是有效的 SHA-256");
    }
    const requestedHash = ((body as Record<string, unknown>).currentHash as string).toLowerCase();
    if (wantsSse) {
      let cancelled = false;
      const stream = new ReadableStream({
        cancel() { cancelled = true; },
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
          void (async () => {
            try {
              const result = await performCleanup(user.userId, eid, requestedHash, (progress) => send({ type: "progress", ...progress }));
              send({ type: "complete", result });
            } catch (error) {
              const safe = safeError(error);
              send({ type: "error", error: safe.code, message: safe.message });
            } finally { if (!cancelled) controller.close(); }
          })();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    }
    const result = await performCleanup(user.userId, eid, requestedHash);
    return Response.json(result);
  } catch (error) {
    const safe = safeError(error);
    return apiError(safe);
  }
}
