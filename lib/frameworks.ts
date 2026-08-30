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

把播客整理成一份可快速复习、又能沿着**原文脉络**回查的笔记。保留清晰结论，但不要把小点压缩成一句判断：要让读者看见问题怎样提出、讨论怎样展开、证据怎样被比较和修正，以及最后如何形成判断。只使用文稿中出现的内容，不补充文稿外事实、出处或常识性推断。

## 输出结构

1. **一句话主旨**：先指出本期讨论的核心对象或矛盾，再用 1–2 句写出主要判断；若判断属于 AI 归纳，要明确标注。
2. **核心问题与结论**：整理 3–5 组问题。每组用自然段呈现完整的**论证过程**：说明问题为何出现、从哪里开始讨论，主播或嘉宾如何解释、比较、修正或提出限定，带出具体**论据/案例**（故事、数字、例子、反例或条件），最后给出结论，并区分“原文事实”“播客观点”“AI 归纳”。每组附最接近的**时间戳**或时间范围。
3. **关键论据、案例与时间戳**：做成可回查的证据索引。逐条说明原文具体说了什么、它支撑或限制哪项判断及对应**时间戳**；可以保留少量忠实短引文，过长内容要准确转述，不能只重复抽象结论。
4. **重要概念和方法**：解释每个概念、模型、方法或判断框架在本期论证中的含义、作用和实际用法，说明其边界、与其他概念的关系，并尽量结合案例或时间戳；不要写脱离本期的百科知识。
5. **可执行建议**：先列出播客明确提出或认可的行动，并说明其依据和适用条件；随后另起部分标为“AI 归纳”或“基于文稿的延伸”，再写从文稿证据推出的行动，不能把 AI 的建议伪装成播客观点。
6. **值得继续追问的问题**：提出 3–5 个问题。每个问题都要说明承接的原文、相关证据或尚未解决的张力，以及为什么值得继续追问，而不是泛泛列题。

## 写作约束

- 使用简洁、自然的中文 Markdown，有必要的过渡，避免机械地堆砌标签；正文按信息量自然展开，通常约 1500–2500 字。信息少可以更短，信息丰富可以更长，**禁止为了达到长度重复**。
- 始终区分“原文事实”“播客观点”和“AI 归纳”：事实是文稿直接陈述的内容，观点归给明确的主播/嘉宾（无法识别说话人时写“不确定”），AI 归纳只用于整理关系或提出延伸。
- 短引文必须忠于原文并对应时间戳；不得编造引语、数字、人物、因果关系或缺失的时间戳。时间戳只能使用文稿给出的值或最接近的范围。
- 遇到含糊、冲突、无法识别说话人、缺少时间戳或证据不足的内容，明确标注“不确定”，并保留冲突本身及其影响，不替原文强行裁决。
- 不写空泛开场、免责声明、文稿外事实或与本期无关的通用知识。`,
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
