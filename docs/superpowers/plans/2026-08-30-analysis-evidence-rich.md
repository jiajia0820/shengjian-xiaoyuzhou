# 内容梳理证据展开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让“通用内容梳理”在保留明确结论的同时，按信息量补充原文脉络、论证过程、论据/案例、短引文和时间戳，减少提纲式和生硬的输出。

**Architecture:** 不改变页面、API、数据库或分析结果格式。更新系统框架提示词负责最终成稿结构；更新长文分段事实笔记提示词负责保留可追溯材料；摘要最终调用只增加展开提醒并提高输出预算，学习 Prompt 链路保持原样。

**Tech Stack:** TypeScript、Node.js 内置测试、Vinext/Next API、现有 DeepSeek 或 OpenAI 兼容 provider。

---

## 文件边界

- Modify: lib/frameworks.ts:8-30 — 更新只读系统框架“通用内容梳理”的输出协议和写作约束。
- Modify: lib/analysis.ts:17-104 — 增强摘要类长文分段事实笔记提示、摘要最终提示和摘要输出预算；不改学习 Prompt 分支。
- Modify: tests/core.test.ts:1541-1554 — 增加系统框架关键规则的回归断言。
- Modify: tests/rendered-html.test.mjs:455-478 — 增加分析分段提示和摘要预算的静态回归断言。
- No change: app/workspace.tsx、分析 API 路由、lib/analysis-format.ts、数据库迁移和历史 Markdown 文件。

### Task 1: 先写能锁定新行为的失败测试

**Files:**

- Modify: tests/core.test.ts:1541-1554
- Modify: tests/rendered-html.test.mjs:455-478

- [x] **Step 1: 在核心测试中扩展系统框架断言**

在现有 test("validates reusable Markdown analysis frameworks", ...) 中保留原有断言，并加入以下断言，锁定最终框架必须要求证据展开而非只给结论：

~~~ts
  assert.match(SYSTEM_FRAMEWORK.instructions, /原文脉络/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /论证过程/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /论据\/案例/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /时间戳/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /按信息量自然展开/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /禁止为了达到长度重复/);
~~~

- [x] **Step 2: 在静态分析测试中锁定分段和最终摘要提示**

在 tests/rendered-html.test.mjs 的 generates staged podcast-host learning prompts 测试之后新增一个测试，读取 ../lib/analysis.ts，加入下列断言：

~~~js
test("保留内容梳理的原文证据和分段上下文", async () => {
  const analysis = await readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8");

  assert.match(analysis, /观点提出的上下文/);
  assert.match(analysis, /论证步骤/);
  assert.match(analysis, /具体论据、故事、案例/);
  assert.match(analysis, /限定条件和反例/);
  assert.match(analysis, /短引文或忠实转述/);
  assert.match(analysis, /原文时间戳/);
  assert.match(analysis, /不要只摘录结论/);
  assert.match(analysis, /不要生成最终梳理/);
  assert.match(analysis, /maxOutputTokens: 2_000/);
  assert.match(analysis, /maxOutputTokens: 4_000/);
});
~~~

- [x] **Step 3: 运行新增测试，确认它们因实现尚未更新而失败**

Run:

~~~bash
npm run build
node --experimental-strip-types --test tests/core.test.ts tests/rendered-html.test.mjs
~~~

Expected: 构建成功，但新增断言至少出现一次 AssertionError，原因是当前框架没有“原文脉络”等规则，当前 analysis.ts 没有增强分段提示且仍使用 1_600 和 3_000 摘要预算。不要修改测试来绕过失败。

### Task 2: 更新系统内置“通用内容梳理”框架

**Files:**

- Modify: lib/frameworks.ts:12-30
- Test: tests/core.test.ts:1541-1554

- [x] **Step 1: 替换系统框架的目标和输出结构文本**

保留六个部分的名称和安全边界，在 SYSTEM_FRAMEWORK.instructions 中将摘要协议更新为以下内容：

~~~ts
instructions: `# 内容梳理目标

把播客整理成一份可快速复习、可追溯原文的可读笔记。保留清晰结论，但不要把每个小点压缩成一句判断；要让读者看见原文是如何提出问题、展开讨论并形成判断的。不要补充文稿没有出现的事实。

## 输出结构

1. **一句话主旨**：先交代本期讨论的核心对象或矛盾，再用一至两句话概括主要判断。
2. **核心问题与结论**：列出 3–5 组关键问题。每组用自然段展开：说明问题为什么出现、讨论从哪里开始；概括主播或嘉宾如何解释、比较或修正观点；保留具体论据、故事、数字、例子、限定条件或反例；最后明确结论，并标明它是原文事实、播客观点还是 AI 基于多处原文的归纳。每组附最接近证据的时间点或时间范围。
3. **关键论据、案例与时间戳**：建立证据索引，说明原文说了什么、它支撑哪一判断以及对应时间戳。可以保留少量忠实短引文；引文过长时准确转述，不要只重复抽象结论。
4. **重要概念和方法**：说明概念在本期论证中的含义、作用、使用方式、适用边界或与其他概念的关系，并结合原文案例或时间戳（若有）。
5. **可执行建议**：先列播客明确提出的行动，再单独标注“AI 归纳”或“基于文稿的延伸”；不能把 AI 新增建议写成播客观点。
6. **值得继续追问的问题**：给出 3–5 个问题，并各用一句话说明它承接哪段原文、哪项证据或哪处未解决的张力，避免泛泛提问。

## 写作约束

- 使用简洁、自然的中文 Markdown；段落之间要有必要的过渡，避免机械套用固定标签。
- 正文通常约 1,500–2,500 字，但这是软目标：信息少时可以更短，信息丰富时按需要展开；禁止为了达到长度重复同一观点。
- 明确区分“原文事实”“播客观点”和“AI 归纳”。
- 短引用必须忠于文稿并附时间戳；找不到依据时不要虚构。
- 对含糊、冲突、说话人无法可靠区分或时间戳缺失的内容标注“不确定”。
- 不写空泛开场、免责声明或与本期无关的通用知识。`,
~~~

六个栏目仍保持兼容，旧自定义框架和已保存分析不会被改写；系统框架只是下次重新生成时使用新指令。

- [x] **Step 2: 运行核心测试确认框架规则通过**

Run:

~~~bash
node --experimental-strip-types --test tests/core.test.ts
~~~

Expected: validates reusable Markdown analysis frameworks 和其余核心测试全部 PASS。

- [x] **Step 3: 提交仅包含框架文件的变更**

~~~bash
git add -- lib/frameworks.ts tests/core.test.ts
git commit -m "feat: expand content summary framework with evidence"
~~~

不要把工作树中已有的声纹、文稿清理或 UI 修改加入本次提交。

### Task 3: 增强长文证据提炼和摘要最终调用

**Files:**

- Modify: lib/analysis.ts:36-104
- Test: tests/rendered-html.test.mjs 中本次新增静态测试

- [x] **Step 1: 在摘要分段 focus 中加入证据卡片规则**

保留学习 Prompt 分支原文不变，只把 kind === "summary" 的 focus 改为以下完整指令：

~~~ts
const focus = kind === "summary"
  ? `为后续按指定框架生成展开版内容梳理提取材料。不要只摘录结论，也不要生成最终梳理。请按证据卡片记录：
- 本段主题，以及它在整期节目中的位置；
- 观点或问题出现的上下文、论证步骤、比较和观点变化；
- 具体论据、故事、案例、数字、对比、限定条件和反例；
- 可支持判断的短引文或忠实转述；
- 原文已有的时间戳及其对应内容；没有可靠时间戳时写“不确定”；
- 文稿中能可靠识别的说话人及其立场；无法确认时标记“不确定”；
- 与前后段衔接或冲突的线索。
框架关注点如下：
${frameworkInstructions}`
  : `为后续生成“听众听完本期播客后，与主播进行深度探讨”的学习 Prompt 提取材料。
请重点记录：主题与观点、播客明确提及的概念及其上下文、不同人物各自的观点、立场、表达习惯与论证方式，以及案例、方法、争议、行动建议和时间戳证据。
同时根据内容长度与知识密度整理适合阶段化对谈的学习顺序，标出不同人物可以提供的互补或冲突视角，避免多个阶段围绕同一个方面重复扩展。`;
~~~

这段指令要继续放在现有 <document-part> 输入之前，避免把文稿中的文字当成模型指令。

- [x] **Step 2: 提高分段事实笔记预算并保持并发策略**

摘要分段使用 2_000，learning_prompt 分段保持 1_600：

~~~ts
      maxOutputTokens: 2_000,
~~~

保留 Math.min(3, chunks.length) 的并发上限（最多 3 并发不变）、数组顺序和 ## 文稿分段 N 标题，确保长文顺序与覆盖范围不变。

- [x] **Step 3: 给摘要最终模型增加展开提醒并提高预算**

在摘要分支现有框架说明之后加入以下文字，不覆盖框架或安全规则：

~~~ts
当框架要求输出问题、观点或结论时，请用自然段交代原文脉络和论证过程，并优先引用或转述具体论据、案例、限定条件和时间戳；不要把每个小点只写成一句结论，也不要为了达到字数重复内容。信息不足时明确写“不确定”，不要用常识补齐。
~~~

并将摘要最终请求的预算从 3_000 改为 4_000：

~~~ts
      maxOutputTokens: 4_000,
~~~

学习 Prompt 分支继续使用 5_200，不改变其生成规则。

- [x] **Step 4: 运行静态回归测试确认提示词和预算已接线**

Run:

~~~bash
npm run build
node --experimental-strip-types --test tests/rendered-html.test.mjs
~~~

Expected: 构建成功；“保留内容梳理的原文证据和分段上下文”测试 PASS；学习 Prompt 相关测试仍 PASS。

- [x] **Step 5: 提交分析链路变更**

~~~bash
git add -- lib/analysis.ts tests/rendered-html.test.mjs
git commit -m "feat: preserve evidence when summarizing long transcripts"
~~~

不要提交其他已有修改。

### Task 4: 全量验证和实际输出验收

**Files:**

- Test: tests/core.test.ts
- Test: tests/rendered-html.test.mjs
- Test: package scripts（只读检查，不修改）

- [x] **Step 1: 运行完整自动化测试**

~~~bash
npm test
~~~

Expected: 构建成功，完整测试集全部 PASS，且无新增失败。

- [x] **Step 2: 运行 lint 和差异检查**

~~~bash
npm run lint
git diff --check HEAD~2..HEAD
~~~

Expected: ESLint 无错误；Git 无空白错误。若提交数量因执行顺序不同，使用 git diff --check 检查本次修改涉及的提交范围，不触碰其他工作树改动。

- [x] **Step 3: 进行一篇短文的实际生成验收**

使用包含至少两个观点、一个具体案例和时间戳的现有播客文稿，在网页中重新生成“内容梳理”，检查：

1. “核心问题与结论”每组有连续的背景/讨论过程和结论，不是单句判断。
2. “关键论据、案例与时间戳”能指向原文，短引文与文稿一致。
3. “值得继续追问的问题”说明提问缘由，而不是泛化问题。
4. 文稿信息少时结果可以短于 1,500 字；信息丰富时不被 1,200 字旧限制截断。
5. 重新生成不会影响声纹结果、学习 Prompt、历史分析读取和文稿过期判断。

- [x] **Step 4: 记录验证结果并检查工作树边界**

~~~bash
git status --short --branch
git log -3 --oneline --decorate
~~~

Expected: 本次新增的设计、框架和分析提交清晰可见；用户此前未提交的其他文件仍保持原状，没有被暂存或覆盖。

## 审查后加固

- [x] **Task 5：运行时回归测试** — tests/core.test.ts 已覆盖真实 ModelRequest 运行时行为：短 summary、短 learning_prompt、长 summary 的预算、证据提示、最多 3 并发和结果顺序；未虚构真实 provider 验收。
- [x] **Task 6：可选执行器注入** — lib/analysis.ts 已支持可选 executeModel 注入；未传入时默认使用 executeModelRequest，保持既有调用行为。

## 计划自检

- 设计文档中的目标、非目标、六部分展开协议、长文证据卡片、安全边界、预算和回滚方式均由 Task 2–4 覆盖。
- 没有新增数据库字段、路由参数或页面状态，历史结果兼容性由 Task 4 验收。
- “通常 1,500–2,500 字”明确为软目标，与“按信息量自然展开、禁止凑字数”一致。
- 分段事实笔记仍明确“不生成最终梳理”，最终模型仍接收框架指令和证据材料，类型和调用签名不变。
- 计划自检已补充审查后加固：Task 5 的运行时回归测试和 Task 6 的可选 executeModel 注入均已完成，且未将真实 provider 验收写成已执行事项。
