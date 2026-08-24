import { consumeUsage, getEpisodeRecord, listEpisodes, publicEpisode, upsertEpisode } from "@/lib/db";
import { withFreshTokens } from "@/lib/connection";
import { documentKeys, putJson, putMarkdown, readMarkdown } from "@/lib/documents";
import { buildMarkdown } from "@/lib/markdown";
import { sha256Hex } from "@/lib/security";
import { buildTranscriptArtifact } from "@/lib/transcript-artifact";
import { apiError, requireApiUser } from "@/lib/user";
import { getOfficialEpisode, getTranscriptSegments, parseEpisodeUrl, XiaoyuzhouError } from "@/lib/xiaoyuzhou";

export async function POST(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await request.json() as Record<string, unknown>;
    const parsed = parseEpisodeUrl(String(body.url ?? ""));
    const refresh = body.refresh === true;
    const existing = await getEpisodeRecord(user.userId, parsed.eid);

    if (existing && !refresh) {
      return Response.json({
        episode: publicEpisode(existing),
        markdown: await readMarkdown(existing.current_key),
        duplicate: true,
      });
    }
    if (!existing && (await listEpisodes(user.userId)).length >= 100) {
      throw new XiaoyuzhouError("EPISODE_LIMIT_REACHED", "公开测试期间每个账号最多保存 100 期文稿", 409);
    }
    if (!await consumeUsage(user.userId, "import", 30)) {
      throw new XiaoyuzhouError("DAILY_IMPORT_LIMIT", "今天的 30 次导入额度已用完，请明天再试", 429);
    }

    const extracted = await withFreshTokens(user.userId, async (tokens) => {
      const episode = await getOfficialEpisode(parsed.eid, tokens);
      if (!episode.mediaId) throw new XiaoyuzhouError("NO_TRANSCRIPT", "该单集暂无小宇宙官方文稿", 404);
      const segments = await getTranscriptSegments(parsed.eid, episode.mediaId, tokens);
      if (!segments.length) throw new XiaoyuzhouError("NO_TRANSCRIPT", "该单集的官方文稿为空", 404);
      return { episode, segments };
    });

    const markdown = buildMarkdown(extracted.episode, parsed.canonicalUrl, extracted.segments);
    const keys = await documentKeys(user.userId, parsed.eid);
    const now = new Date().toISOString();
    const originalHash = await sha256Hex(markdown);

    await putMarkdown(keys.originalKey, markdown);
    await putJson(keys.transcriptKey, buildTranscriptArtifact(parsed.eid, extracted.segments, now));
    if (!existing) await putMarkdown(keys.currentKey, markdown);

    await upsertEpisode({
      user_id: user.userId,
      eid: parsed.eid,
      source_url: parsed.canonicalUrl,
      title: extracted.episode.title,
      podcast_title: extracted.episode.podcastTitle,
      published_at: extracted.episode.publishedAt,
      duration_seconds: extracted.episode.durationSeconds,
      segment_count: extracted.segments.length,
      original_key: keys.originalKey,
      current_key: keys.currentKey,
      original_hash: originalHash,
      content_hash: existing?.content_hash ?? originalHash,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    const saved = await getEpisodeRecord(user.userId, parsed.eid);
    return Response.json({
      episode: saved ? publicEpisode(saved) : null,
      markdown: existing ? await readMarkdown(keys.currentKey) : markdown,
      refreshed: Boolean(existing),
    });
  } catch (error) {
    return apiError(error);
  }
}
