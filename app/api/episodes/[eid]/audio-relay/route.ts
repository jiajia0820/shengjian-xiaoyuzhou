import { withFreshTokens } from "@/lib/connection";
import { getEpisodeRecord } from "@/lib/db";
import { consumeAudioRelayTicket } from "@/lib/audio-relay-ticket";
import { getRuntimeEnv } from "@/lib/runtime";
import { apiError, HttpError } from "@/lib/user";
import { fetchOfficialAudio, getOfficialEpisode, validateOfficialAudioUrl } from "@/lib/xiaoyuzhou";

type Context = { params: Promise<{ eid: string }> };

const MAX_AUDIO_BYTES = 1_000_000_000;
const SAFE_HEADERS = ["content-type", "content-length", "accept-ranges"] as const;

function responseMimeIsAudio(value: string | null): boolean {
  if (!value) return true;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return mime.startsWith("audio/") || mime === "application/octet-stream" || mime === "video/mp4";
}

export async function GET(request: Request, context: Context) {
  try {
    const { eid } = await context.params;
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    const bound = await consumeAudioRelayTicket(getRuntimeEnv().DB, ticket, eid);
    if (!bound) throw new HttpError(410, "AUDIO_RELAY_EXPIRED", "音频中转地址已过期，请重新获取");

    const record = await getEpisodeRecord(bound.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const upstreamUrl = await withFreshTokens(bound.userId, async (tokens) => {
      const episode = await getOfficialEpisode(eid, tokens);
      if (!episode.audioUrl) throw new HttpError(404, "NO_AUDIO", "该单集没有可用官方音频");
      return validateOfficialAudioUrl(episode.audioUrl);
    });

    const range = request.headers.get("range");
    const upstream = await fetchOfficialAudio(upstreamUrl, range ? { headers: { range } } : undefined);
    if (!upstream.ok) throw new HttpError(502, "AUDIO_DOWNLOAD_FAILED", "官方音频下载失败，请重试");
    const contentLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
      throw new HttpError(413, "AUDIO_TOO_LARGE", "官方音频超过 1GB，无法处理");
    }
    if (!upstream.body || !responseMimeIsAudio(upstream.headers.get("content-type"))) {
      throw new HttpError(502, "AUDIO_DOWNLOAD_FAILED", "官方音频格式不可用，请重试");
    }
    const headers = new Headers();
    for (const name of SAFE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return apiError(error);
  }
}
