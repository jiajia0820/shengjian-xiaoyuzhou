import {
  acquireAnalysisLease,
  getEpisodeRecord,
  releaseAnalysisLease,
  touchCurrentDocumentIfHash,
} from "@/lib/db";
import {
  deleteDocument,
  documentKeys,
  putMarkdownIfEtag,
  readJson,
  readMarkdownWithEtag,
} from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

type CleanupSnapshot = {
  schemaVersion: 1;
  episodeId: string;
  beforeHash: string;
  afterHash: string;
  createdAt: string;
  beforeMarkdown: string;
  provider: string;
  model: string;
  stats: Record<string, unknown>;
};

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function safeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(502, "CLEANUP_UNDO_ERROR", "撤销 AI 清理暂时失败，请稍后重试");
}

function parseSnapshot(raw: string, eid: string): CleanupSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(409, "CLEANUP_SNAPSHOT_INVALID", "AI 清理快照无效，请重新执行清理");
  }
  if (!value || typeof value !== "object") {
    throw new HttpError(409, "CLEANUP_SNAPSHOT_INVALID", "AI 清理快照无效，请重新执行清理");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1
    || snapshot.episodeId !== eid
    || !validHash(snapshot.beforeHash)
    || !validHash(snapshot.afterHash)
    || typeof snapshot.beforeMarkdown !== "string"
    || !snapshot.beforeMarkdown
    || typeof snapshot.createdAt !== "string"
    || !snapshot.createdAt
    || typeof snapshot.provider !== "string"
    || !snapshot.provider
    || (snapshot.provider !== "deepseek" && snapshot.provider !== "custom")
    || typeof snapshot.model !== "string"
    || !snapshot.model
    || !snapshot.stats || typeof snapshot.stats !== "object") {
    throw new HttpError(409, "CLEANUP_SNAPSHOT_INVALID", "AI 清理快照无效，请重新执行清理");
  }
  return {
    schemaVersion: 1,
    episodeId: eid,
    beforeHash: snapshot.beforeHash.toLowerCase(),
    afterHash: snapshot.afterHash.toLowerCase(),
    createdAt: snapshot.createdAt,
    beforeMarkdown: snapshot.beforeMarkdown,
    provider: snapshot.provider,
    model: snapshot.model,
    stats: snapshot.stats as Record<string, unknown>,
  };
}

function invalidEpisodeId(eid: string): boolean {
  return !/^[A-Za-z0-9_-]{1,180}$/.test(eid);
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    if (invalidEpisodeId(eid)) {
      throw new HttpError(400, "INVALID_EPISODE_ID", "文稿标识无效");
    }

    let body: unknown;
    try { body = await request.json(); } catch { throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "请求参数无效"); }
    if (!body || typeof body !== "object" || !validHash((body as Record<string, unknown>).currentHash)) {
      throw new HttpError(400, "INVALID_CLEANUP_REQUEST", "currentHash 必须是有效的 SHA-256");
    }
    const requestedHash = ((body as Record<string, unknown>).currentHash as string).toLowerCase();

    const keys = await documentKeys(user.userId, eid);
    const episode = await getEpisodeRecord(user.userId, eid);
    if (!episode) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    if (episode.current_key !== keys.currentKey) {
      throw new HttpError(409, "CLEANUP_DOCUMENT_KEY_MISMATCH", "当前文稿存储位置无效，请刷新后重试");
    }

    let rawSnapshot: string;
    try {
      rawSnapshot = await readJson(keys.aiCleanupSnapshotKey);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(404, "CLEANUP_SNAPSHOT_NOT_FOUND", "没有可撤销的 AI 清理记录");
      }
      throw new HttpError(502, "CLEANUP_SNAPSHOT_READ_FAILED", "AI 清理快照暂时无法读取，请稍后重试");
    }
    const snapshot = parseSnapshot(rawSnapshot, eid);
    if ((await sha256Hex(snapshot.beforeMarkdown)).toLowerCase() !== snapshot.beforeHash) {
      throw new HttpError(409, "CLEANUP_SNAPSHOT_INVALID", "AI 清理快照无效，请重新执行清理");
    }

    const currentObject = await readMarkdownWithEtag(episode.current_key);
    if (!currentObject.etag) throw new HttpError(409, "CLEANUP_DOCUMENT_CHANGED", "当前文稿版本不可验证，请刷新后重试");
    const actualHash = (await sha256Hex(currentObject.markdown)).toLowerCase();
    if (requestedHash !== actualHash || actualHash !== snapshot.afterHash) {
      throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已发生变化，无法安全撤销，请刷新后重试");
    }

    const leaseId = await acquireAnalysisLease(user.userId);
    if (!leaseId) throw new HttpError(409, "ANALYSIS_ALREADY_RUNNING", "当前账号已有一个 AI 任务正在运行，请等待完成");

    let writtenEtag: string | null = null;
    let writeStarted = false;
    let writeSucceeded = false;
    let dbStateUnknown = false;
    try {
      writeStarted = true;
      try {
        writtenEtag = await putMarkdownIfEtag(episode.current_key, snapshot.beforeMarkdown, currentObject.etag);
      } catch {
        // The conditional writer may have committed before reporting an error.
        // Observe the object and reconcile hash state without any unconditional write.
        try {
          const observed = await readMarkdownWithEtag(episode.current_key);
          const observedHash = (await sha256Hex(observed.markdown)).toLowerCase();
          if (observed.etag && observedHash === snapshot.beforeHash) {
            let dbSynced = false;
            let dbUnknown = false;
            try { dbSynced = await touchCurrentDocumentIfHash(user.userId, eid, snapshot.afterHash, snapshot.beforeHash); }
            catch { dbUnknown = true; }
            if (!dbSynced) {
              let objectRestored = false;
              try { objectRestored = Boolean(await putMarkdownIfEtag(episode.current_key, currentObject.markdown, observed.etag)); } catch { /* preserve snapshot */ }
              if (dbUnknown && objectRestored) {
                try { await touchCurrentDocumentIfHash(user.userId, eid, snapshot.beforeHash, snapshot.afterHash); } catch { /* preserve snapshot */ }
              }
            }
          }
        } catch { /* preserve snapshot and report a safe write error */ }
        throw new HttpError(502, "CLEANUP_UNDO_WRITE_FAILED", "撤销写入失败，请稍后重试");
      }
      if (!writtenEtag) throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已发生变化，无法安全撤销，请刷新后重试");
      writeSucceeded = true;

      let casUpdated = false;
      try {
        casUpdated = await touchCurrentDocumentIfHash(user.userId, eid, snapshot.afterHash, snapshot.beforeHash);
      } catch {
        dbStateUnknown = true;
        throw new HttpError(502, "CLEANUP_UNDO_DB_FAILED", "撤销状态更新失败，请稍后重试");
      }
      if (!casUpdated) throw new HttpError(409, "CLEANUP_STALE_HASH", "当前文稿已发生变化，无法安全撤销，请刷新后重试");

      try {
        await deleteDocument(keys.aiCleanupSnapshotKey);
      } catch {
        // The restored document and hash are already committed; retain a successful response.
      }
      return Response.json({ restored: true, markdown: snapshot.beforeMarkdown, restoredHash: snapshot.beforeHash });
    } catch (error) {
      // If the conditional write completed but the DB CAS did not, restore the cleaned
      // content only when the object is still the version written by this request.
      if (writeStarted && writeSucceeded && writtenEtag) {
        let objectRestored = false;
        try { objectRestored = Boolean(await putMarkdownIfEtag(episode.current_key, currentObject.markdown, writtenEtag)); } catch { /* preserve snapshot as recovery evidence */ }
        // A thrown CAS has unknown commit state. Once the object is conditionally
        // restored, attempt the inverse CAS so DB and object remain consistent.
        if (dbStateUnknown && objectRestored) {
          try { await touchCurrentDocumentIfHash(user.userId, eid, snapshot.beforeHash, snapshot.afterHash); } catch { /* preserve snapshot as recovery evidence */ }
        }
      }
      throw error;
    } finally {
      try { await releaseAnalysisLease(user.userId, leaseId); } catch { /* best effort */ }
    }
  } catch (error) {
    return apiError(safeError(error));
  }
}
