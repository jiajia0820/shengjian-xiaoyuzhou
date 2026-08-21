import { getAnalysisResult, getEpisodeRecord, listAnalysisResults, publicAnalysis, setOriginalHash } from "@/lib/db";
import { readMarkdown } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

function validSlot(value: string): string {
  if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(value)) {
    throw new HttpError(400, "INVALID_ANALYSIS_SLOT", "分析结果标识无效");
  }
  return value;
}

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    const episode = await getEpisodeRecord(user.userId, eid);
    if (!episode) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");

    if (!episode.original_hash) {
      episode.original_hash = await sha256Hex(await readMarkdown(episode.original_key));
      await setOriginalHash(user.userId, eid, episode.original_hash);
    }

    const slot = new URL(request.url).searchParams.get("slot");
    if (slot) {
      const result = await getAnalysisResult(user.userId, eid, validSlot(slot));
      if (!result) throw new HttpError(404, "ANALYSIS_NOT_FOUND", "还没有生成这份分析");
      return Response.json({
        result: publicAnalysis(result, episode),
        markdown: await readMarkdown(result.result_key),
      });
    }

    const results = await listAnalysisResults(user.userId, eid);
    return Response.json({ results: results.map((result) => publicAnalysis(result, episode)) });
  } catch (error) {
    return apiError(error);
  }
}
