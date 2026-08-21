import { getEpisodeRecord } from "@/lib/db";
import { readMarkdown } from "@/lib/documents";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const filename = `${record.podcast_title}-${record.title}.md`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    return new Response(await readMarkdown(record.current_key), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
