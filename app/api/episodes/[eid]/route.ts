import { acquireAnalysisLease, deleteEpisodeRecords, getEpisodeRecord, publicEpisode, releaseAnalysisLease, touchCurrentDocument } from "@/lib/db";
import { deleteEpisodeDocuments, putMarkdown, readMarkdown } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    return Response.json({ episode: publicEpisode(record), markdown: await readMarkdown(record.current_key) });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const body = await request.json() as Record<string, unknown>;
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (!markdown.trim()) throw new HttpError(400, "EMPTY_DOCUMENT", "文稿不能为空");
    if (new TextEncoder().encode(markdown).byteLength > 5_000_000) {
      throw new HttpError(413, "DOCUMENT_TOO_LARGE", "文稿超过 5 MB，无法保存");
    }
    await putMarkdown(record.current_key, markdown);
    await touchCurrentDocument(user.userId, eid, await sha256Hex(markdown));
    return Response.json({ saved: true, updatedAt: new Date().toISOString() });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");

    const leaseId = await acquireAnalysisLease(user.userId);
    if (!leaseId) {
      throw new HttpError(409, "ANALYSIS_ALREADY_RUNNING", "AI 任务正在运行，请完成后再删除文稿");
    }
    try {
      await deleteEpisodeDocuments(user.userId, record.eid);
      if (!await deleteEpisodeRecords(user.userId, record.eid)) {
        throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
      }
      return Response.json({ deleted: true, eid: record.eid, inventoryReleased: true });
    } finally {
      await releaseAnalysisLease(user.userId, leaseId);
    }
  } catch (error) {
    return apiError(error);
  }
}
