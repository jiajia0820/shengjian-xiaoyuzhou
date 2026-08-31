import {
  buildAssistantPrompt,
  buildOriginalContext,
  extractSummarySection,
  generateAssistantAnswer,
} from "@/lib/analysis-assistant";
import { readActiveAiConfiguration } from "@/lib/ai-settings";
import { consumeUsage, getAnalysisResult, getEpisodeRecord, refundUsage } from "@/lib/db";
import { readMarkdown } from "@/lib/documents";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ eid: string }> };
type HistoryMessage = { role: "user" | "assistant"; content: string };

const MAX_SELECTED_TEXT = 8_000;
const MAX_ROLE = 160;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CONTENT = 8_000;

function parseText(value: unknown, label: string, maxChars: number, required = true): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_ASSISTANT_INPUT", `${label}格式无效`);
  const text = value.trim();
  if (required && !text) throw new HttpError(400, "INVALID_ASSISTANT_INPUT", `${label}不能为空`);
  if (Array.from(text).length > maxChars) throw new HttpError(400, "INVALID_ASSISTANT_INPUT", `${label}过长，请缩短后重试`);
  return text;
}

function parseHistory(value: unknown): HistoryMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "INVALID_ASSISTANT_INPUT", "对话记录格式无效");
  return value.slice(-MAX_HISTORY_MESSAGES).map((item) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "INVALID_ASSISTANT_INPUT", "对话记录格式无效");
    const record = item as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") {
      throw new HttpError(400, "INVALID_ASSISTANT_INPUT", "对话角色无效");
    }
    return {
      role: record.role,
      content: parseText(record.content, "对话内容", MAX_HISTORY_CONTENT),
    } as HistoryMessage;
  });
}

export async function POST(request: Request, context: Context) {
  let charged = false;
  let userId = "";
  try {
    const user = await requireApiUser({ mutation: true });
    userId = user.userId;
    const { eid } = await context.params;
    const episode = await getEpisodeRecord(user.userId, eid);
    if (!episode) throw new HttpError(404, "EPISODE_NOT_FOUND", "没有找到这篇文稿");

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "INVALID_ASSISTANT_INPUT", "助手请求格式无效");
    }
    const slot = parseText(body.slot, "分析结果", 180);
    if (!/^summary:[a-zA-Z0-9_-]{1,140}$/.test(slot)) {
      throw new HttpError(400, "INVALID_ASSISTANT_SLOT", "只能对内容梳理结果提问");
    }
    const result = await getAnalysisResult(user.userId, eid, slot);
    if (!result || result.kind !== "summary" || result.slot !== slot) {
      throw new HttpError(404, "ANALYSIS_NOT_FOUND", "还没有生成这份内容梳理");
    }
    const selectedText = parseText(body.selectedText, "选中文本", MAX_SELECTED_TEXT, false);
    const role = parseText(body.role, "助手身份", MAX_ROLE, false) || "本期主题研究顾问";
    const question = parseText(body.question, "问题", 2_000);
    const history = parseHistory(body.history);

    const summaryMarkdown = await readMarkdown(result.result_key);
    const summarySection = extractSummarySection(summaryMarkdown, selectedText);
    const summaryContext = selectedText ? summarySection.text : summaryMarkdown;
    let originalMarkdown: string | null = null;
    try {
      originalMarkdown = await readMarkdown(episode.original_key);
    } catch {
      originalMarkdown = null;
    }
    const originalContext = buildOriginalContext(originalMarkdown, `${selectedText}\n${summaryContext}`);
    const config = await readActiveAiConfiguration(user.userId);
    if (!await consumeUsage(user.userId, "ai", 20)) {
      throw new HttpError(429, "DAILY_AI_LIMIT", "今天的 20 次 AI 生成额度已用完，请明天再试");
    }
    charged = true;
    const modelRequest = buildAssistantPrompt({
      episodeTitle: episode.title,
      podcastTitle: episode.podcast_title,
      role,
      selectedText,
      summarySection: summaryContext,
      originalContext,
      history,
      question,
    });
    let answer: string;
    try {
      answer = await generateAssistantAnswer(config, modelRequest);
    } catch {
      throw new HttpError(502, "ASSISTANT_UNAVAILABLE", "AI 助手暂时无法回答，请稍后重试");
    }
    return Response.json({
      answer,
      context: {
        source: originalContext.source,
        timestamps: originalContext.timestamps,
        summarySection: summarySection.heading,
      },
    });
  } catch (error) {
    if (charged && userId) await refundUsage(userId, "ai").catch(() => undefined);
    return apiError(error);
  }
}
