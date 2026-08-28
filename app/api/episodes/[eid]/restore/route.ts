import { acquireAnalysisLease, getEpisodeRecord, releaseAnalysisLease, touchCurrentDocument } from "@/lib/db";
import { putMarkdown, readMarkdown } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

export async function POST(_request: Request, context: Context) {
  let leaseId: string | null = null;
  let leaseUserId: string | null = null;
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    leaseId = await acquireAnalysisLease(user.userId);
    if (!leaseId) throw new HttpError(409, "ANALYSIS_ALREADY_RUNNING", "AI 任务正在运行，请完成后再恢复文稿");
    leaseUserId = user.userId;
    const markdown = await readMarkdown(record.original_key);
    await putMarkdown(record.current_key, markdown);
    await touchCurrentDocument(user.userId, eid, await sha256Hex(markdown));
    return Response.json({ restored: true, markdown });
  } catch (error) {
    return apiError(error);
  } finally {
    if (leaseId && leaseUserId) { try { await releaseAnalysisLease(leaseUserId, leaseId); } catch { /* best effort */ } }
  }
}
