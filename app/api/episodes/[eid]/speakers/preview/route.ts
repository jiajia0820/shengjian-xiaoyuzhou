import { getEpisodeRecord } from "@/lib/db";
import { documentKeys, readJson, readMarkdown } from "@/lib/documents";
import { renderSpeakerMarkdown } from "@/lib/speaker-markdown";
import { parseTranscriptArtifact } from "@/lib/transcript-artifact";
import {
  alignTranscriptSpeakers,
  normalizeDiarizationTurns,
  normalizeSpeakerLabels,
  SpeakerInputError,
} from "@/lib/transcript-speakers";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

const MAX_REQUEST_BYTES = 1_000_000;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "SPEAKER_REQUEST_TOO_LARGE", "说话人数据过大，无法预览");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_SPEAKER_PREVIEW", "说话人数据格式无效");
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const body = await readBody(request);
    const keys = await documentKeys(user.userId, eid);
    const artifact = parseTranscriptArtifact(await readJson(keys.transcriptKey));
    if (!artifact || artifact.episodeId !== eid) {
      throw new HttpError(409, "TRANSCRIPT_ARTIFACT_UNAVAILABLE", "文稿结构文件不可用，请重新获取官方原稿后重试");
    }
    const turns = normalizeDiarizationTurns(body.turns);
    const aligned = alignTranscriptSpeakers(
      artifact.segments,
      turns,
      record.duration_seconds === null ? null : record.duration_seconds * 1000,
    );
    const labels = normalizeSpeakerLabels(undefined, aligned.speakerIds);
    const markdown = renderSpeakerMarkdown(await readMarkdown(record.original_key), aligned.segments, labels);
    return Response.json({
      preview: {
        segments: aligned.segments,
        labels,
        markdown,
        reviewCount: aligned.reviewCount,
      },
    });
  } catch (error) {
    if (error instanceof SpeakerInputError) {
      return apiError(new HttpError(400, "INVALID_SPEAKER_PREVIEW", error.message));
    }
    return apiError(error);
  }
}
