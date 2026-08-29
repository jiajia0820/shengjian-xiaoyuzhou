import { withFreshTokens } from "@/lib/connection";
import { getEpisodeRecord } from "@/lib/db";
import { issueAudioRelayTicket } from "@/lib/audio-relay-ticket";
import { getRuntimeEnv } from "@/lib/runtime";
import { apiError, HttpError, requireApiUser } from "@/lib/user";
import { getOfficialEpisode, validateOfficialAudioUrl } from "@/lib/xiaoyuzhou";

type Context = { params: Promise<{ eid: string }> };

const AUDIO_RELAY_TTL_SECONDS = 90;

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireApiUser();
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");

    const episode = await withFreshTokens(user.userId, (tokens) => getOfficialEpisode(eid, tokens));
    if (!episode.audioUrl) throw new HttpError(404, "NO_AUDIO", "该单集没有可用官方音频");
    const audioUrl = validateOfficialAudioUrl(episode.audioUrl);
    const ticket = await issueAudioRelayTicket(getRuntimeEnv().DB, {
      userId: user.userId,
      eid,
      ttlSeconds: AUDIO_RELAY_TTL_SECONDS,
    });
    const relayUrl = new URL(`/api/episodes/${encodeURIComponent(eid)}/audio-relay`, request.url);
    relayUrl.searchParams.set("ticket", ticket);
    const expiresAt = new Date(Date.now() + AUDIO_RELAY_TTL_SECONDS * 1000).toISOString();
    return Response.json({
      audioUrl,
      relayUrl: relayUrl.toString(),
      mimeType: episode.audioMimeType,
      durationSeconds: episode.durationSeconds ?? record.duration_seconds ?? null,
      expiresAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
