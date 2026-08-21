import type { FrameworkRecord } from "./db";
import { HttpError } from "./http-error.ts";

export const SYSTEM_FRAMEWORK_ID = "system-brief-v1";

export const SYSTEM_FRAMEWORK = {
  id: SYSTEM_FRAMEWORK_ID,
  name: "通用内容梳理",
  isSystem: true,
  createdAt: null,
  updatedAt: null,
  instructions: `# 内容梳理目标

把播客整理成一份可快速复习、可追溯原文的简要笔记。不要补充文稿没有出现的事实。

## 输出结构

1. **一句话主旨**：用一到两句话概括本期最核心的问题和结论。
2. **核心问题与结论**：列出 3–5 组关键问题及对应结论。
3. **关键论据、案例与时间戳**：保留能支撑结论的论据、故事或案例，并标注最接近的原文时间戳。
4. **重要概念和方法**：解释本期出现的概念、模型、方法或判断框架。
5. **可执行建议**：提炼听众可以采取的具体行动，不把 AI 自己的建议冒充播客观点。
6. **值得继续追问的问题**：给出 3–5 个可用于后续学习或讨论的问题。

## 写作约束

- 使用简洁中文和 Markdown，正文约 800–1,200 字。
- 明确区分“原文事实”“播客观点”和“AI 归纳”。
- 短引用必须忠于文稿并附时间戳；找不到依据时不要虚构。
- 对含糊、冲突或无法确认的内容标注“不确定”。
- 不写空泛开场、免责声明或与本期无关的通用知识。`,
} as const;

export function validateFrameworkInput(body: Record<string, unknown>): { name: string; instructions: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (!name || name.length > 60) {
    throw new HttpError(400, "INVALID_FRAMEWORK_NAME", "框架名称需为 1–60 个字符");
  }
  const length = Array.from(instructions).length;
  if (length < 100 || length > 20_000) {
    throw new HttpError(400, "INVALID_FRAMEWORK_CONTENT", "框架内容需为 100–20,000 个字符");
  }
  return { name, instructions };
}

export function frameworkForAnalysis(record: FrameworkRecord | null, requestedId: string) {
  if (requestedId === SYSTEM_FRAMEWORK_ID) return SYSTEM_FRAMEWORK;
  if (!record) throw new HttpError(404, "FRAMEWORK_NOT_FOUND", "没有找到这个梳理框架");
  return {
    id: record.id,
    name: record.name,
    instructions: record.instructions,
    isSystem: false,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
