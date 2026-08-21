import {
  buildAnalysisMarkdown,
  generateAnalysisBody,
  type AnalysisKind,
  type AnalysisSource,
  ANALYSIS_MODEL,
} from "@/lib/analysis";
import { readDeepseekApiKey } from "@/lib/ai-settings";
import {
  acquireAnalysisLease,
  consumeUsage,
  getEpisodeRecord,
  getFramework,
  publicAnalysis,
  refundUsage,
  releaseAnalysisLease,
  setOriginalHash,
  upsertAnalysisResult,
} from "@/lib/db";
import { analysisDocumentKey, putMarkdown, readMarkdown } from "@/lib/documents";
import { frameworkForAnalysis, SYSTEM_FRAMEWORK_ID } from "@/lib/frameworks";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };

function parseKind(value: unknown): AnalysisKind {
  if (value === "summary" || value === "learning_prompt") return value;
  throw new HttpError(400, "INVALID_ANALYSIS_KIND", "分析类型无效");
}

function parseSource(value: unknown): AnalysisSource {
  if (value === "original" || value === "current") return value;
  throw new HttpError(400, "INVALID_ANALYSIS_SOURCE", "请选择官方原稿或当前编辑稿");
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { eid } = await context.params;
    const episode = await getEpisodeRecord(user.userId, eid);
    if (!episode) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");
    const body = await request.json() as Record<string, unknown>;
    const kind = parseKind(body.kind);
    const sourceType = parseSource(body.source);
    const markdown = await readMarkdown(sourceType === "original" ? episode.original_key : episode.current_key);
    const sourceHash = await sha256Hex(markdown);
    if (sourceType === "original" && episode.original_hash !== sourceHash) {
      episode.original_hash = sourceHash;
      await setOriginalHash(user.userId, eid, sourceHash);
    }

    let frameworkId: string | null = null;
    let frameworkName: string | null = null;
    let frameworkSnapshot: string | null = null;
    if (kind === "summary") {
      frameworkId = typeof body.frameworkId === "string" ? body.frameworkId : SYSTEM_FRAMEWORK_ID;
      const record = frameworkId === SYSTEM_FRAMEWORK_ID ? null : await getFramework(user.userId, frameworkId);
      const framework = frameworkForAnalysis(record, frameworkId);
      frameworkName = framework.name;
      frameworkSnapshot = framework.instructions;
    }

    if (!await consumeUsage(user.userId, "ai", 20)) {
      throw new HttpError(429, "DAILY_AI_LIMIT", "今天的 20 次 AI 生成额度已用完，请明天再试");
    }
    const leaseId = await acquireAnalysisLease(user.userId);
    if (!leaseId) {
      await refundUsage(user.userId, "ai");
      throw new HttpError(409, "ANALYSIS_ALREADY_RUNNING", "当前账号已有一个 AI 任务正在运行，请等待完成");
    }
    try {
      const generatedAt = new Date().toISOString();
      const apiKey = await readDeepseekApiKey(user.userId);
      const generatedBody = await generateAnalysisBody({
        apiKey,
        kind,
        markdown,
        episode,
        frameworkName: frameworkName ?? undefined,
        frameworkInstructions: frameworkSnapshot ?? undefined,
      });
      const resultMarkdown = buildAnalysisMarkdown({
        episode,
        kind,
        sourceType,
        sourceHash,
        generatedAt,
        body: generatedBody,
        frameworkId,
        frameworkName,
      });
      const slot = kind === "summary" ? `summary:${frameworkId}` : "learning_prompt";
      const resultKey = await analysisDocumentKey(user.userId, eid, slot);
      await putMarkdown(resultKey, resultMarkdown);
      const record = {
        user_id: user.userId,
        eid,
        slot,
        kind,
        framework_id: frameworkId,
        framework_name: frameworkName,
        framework_snapshot: frameworkSnapshot,
        source_type: sourceType,
        source_hash: sourceHash,
        model: ANALYSIS_MODEL,
        result_key: resultKey,
        generated_at: generatedAt,
      } as const;
      await upsertAnalysisResult(record);
      return Response.json({ result: publicAnalysis({ id: 0, ...record }, episode), markdown: resultMarkdown });
    } catch (error) {
      await refundUsage(user.userId, "ai");
      throw error;
    } finally {
      await releaseAnalysisLease(user.userId, leaseId);
    }
  } catch (error) {
    return apiError(error);
  }
}
