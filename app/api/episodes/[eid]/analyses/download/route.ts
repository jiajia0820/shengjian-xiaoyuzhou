import { getAnalysisResult, getEpisodeRecord } from "@/lib/db";
import { readMarkdown } from "@/lib/documents";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    const slot = new URL(request.url).searchParams.get("slot") ?? "";
    if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(slot)) {
      throw new HttpError(400, "INVALID_ANALYSIS_SLOT", "分析结果标识无效");
    }
    const episode = await getEpisodeRecord(user.userId, eid);
    if (!episode) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const result = await getAnalysisResult(user.userId, eid, slot);
    if (!result) throw new HttpError(404, "ANALYSIS_NOT_FOUND", "还没有生成这份分析");
    const suffix = result.kind === "summary" ? `内容梳理-${result.framework_name ?? "未命名"}` : "学习-Prompt";
    const filename = `${episode.podcast_title}-${episode.title}-${suffix}.md`
      .replace(/[\\/:*?"<>|]/g, "-").slice(0, 140);
    return new Response(await readMarkdown(result.result_key), {
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
