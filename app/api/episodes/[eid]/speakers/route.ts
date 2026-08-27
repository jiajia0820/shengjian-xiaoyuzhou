import { getEpisodeRecord, touchCurrentDocument } from "@/lib/db";
import { documentKeys, putJson, putMarkdown, readJson, readMarkdown } from "@/lib/documents";
import { sha256Hex } from "@/lib/security";
import { renderSpeakerMarkdown } from "@/lib/speaker-markdown";
import { parseTranscriptArtifact } from "@/lib/transcript-artifact";
import { isSpeakerEngine, type SpeakerEngine } from "@/lib/transcript-artifact";
import {
  alignTranscriptSpeakers,
  applySpeakerOverrides,
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
    throw new HttpError(413, "SPEAKER_REQUEST_TOO_LARGE", "说话人数据过大，无法保存");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_SPEAKER_REQUEST", "说话人数据格式无效");
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const record = await getEpisodeRecord(user.userId, eid);
    if (!record) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const body = await readBody(request);
    const engine: SpeakerEngine = body.engine === undefined
      ? "pyannote-community-1"
      : isSpeakerEngine(body.engine) ? body.engine : (() => { throw new SpeakerInputError("说话人引擎无效"); })();
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
    const labels = normalizeSpeakerLabels(body.labels, aligned.speakerIds);
    const segments = applySpeakerOverrides(aligned.segments, body.overrides, aligned.speakerIds);
    const currentMarkdown = await readMarkdown(record.current_key);
    const currentHash = await sha256Hex(currentMarkdown);
    if (currentHash !== record.original_hash && currentHash !== artifact.speakerLayout?.currentMarkdownHash) {
      throw new HttpError(409, "CURRENT_DOCUMENT_CHANGED", "当前编辑稿已被手动修改；为避免覆盖，请先下载备份并恢复官方原稿后再保存说话人分段");
    }

    const officialMarkdown = await readMarkdown(record.original_key);
    const markdown = renderSpeakerMarkdown(officialMarkdown, segments, labels, engine);
    const markdownHash = await sha256Hex(markdown);
    const nextArtifact = {
      ...artifact,
      segments,
      speakerLayout: {
        engine,
        generatedAt: new Date().toISOString(),
        currentMarkdownHash: markdownHash,
        labels,
      },
    };
    await putJson(keys.transcriptKey, nextArtifact);
    await putMarkdown(record.current_key, markdown);
    await touchCurrentDocument(user.userId, eid, markdownHash);
    return Response.json({ markdown, reviewCount: segments.filter((segment) => segment.speakerNeedsReview).length, labels });
  } catch (error) {
    if (error instanceof SpeakerInputError) {
      return apiError(new HttpError(400, "INVALID_SPEAKER_REQUEST", error.message));
    }
    return apiError(error);
  }
}
