# 内容梳理预览标题优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让“文稿”“内容梳理”和“学习 Prompt”预览的主标题统一更紧凑，并仅在内容梳理预览中隐藏模型正文开头与系统标题重复的“内容梳理”，而不改动已保存的分析 Markdown。

**Architecture:** 在共享的分析格式模块中加入一个纯函数，只针对系统标题之后紧邻的独立 `# 内容梳理` 做显示层过滤。`MarkdownPreview` 通过内容梳理预览变体调用该函数，所有 Markdown 预览共用紧凑一级标题样式；学习 Prompt 只使用字号调整，不启用过滤。

**Tech Stack:** React 19、TypeScript、CSS、Node.js 内置测试运行器、ESLint、TypeScript 编译器。

---

### Task 1: 增加重复标题过滤函数及单元测试

**Files:**
- Modify: `tests/core.test.ts:6`（补充函数导入）和分析格式测试附近（新增行为测试）
- Modify: `lib/analysis-format.ts:15`（新增纯函数）

- [ ] **Step 1: 写失败测试**

在 `tests/core.test.ts` 从 `../lib/analysis-format.ts` 一并导入 `stripRedundantAnalysisHeading`，并加入：

```ts
test("只移除系统标题后的重复内容梳理一级标题", () => {
  const source = [
    "# 单集标题｜内容梳理", "", "# 内容梳理", "", "## 一句话主旨", "结论。",
  ];
  assert.deepEqual(stripRedundantAnalysisHeading(source), [
    "# 单集标题｜内容梳理", "", "## 一句话主旨", "结论。",
  ]);
  const nonDuplicate = ["# 单集标题｜内容梳理", "", "## 内容梳理", "正文。"];
  assert.deepEqual(stripRedundantAnalysisHeading(nonDuplicate), nonDuplicate);
  const laterHeading = ["# 单集标题｜内容梳理", "", "## 主旨", "正文。", "", "# 内容梳理"];
  assert.deepEqual(stripRedundantAnalysisHeading(laterHeading), laterHeading);
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`node --experimental-strip-types --test tests/core.test.ts`

预期：测试在导入未导出的 `stripRedundantAnalysisHeading` 处失败。

- [ ] **Step 3: 实现最小纯函数**

在 `lib/analysis-format.ts` 的 `splitForAnalysis` 前加入：

```ts
export function stripRedundantAnalysisHeading(lines: string[]): string[] {
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (titleIndex < 0) return lines;
  let cursor = titleIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  if (lines[cursor]?.trim() !== "# 内容梳理") return lines;
  cursor += 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  return [...lines.slice(0, titleIndex + 1), "", ...lines.slice(cursor)];
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`node --experimental-strip-types --test tests/core.test.ts`

预期：该测试及 core 测试全部通过。

- [ ] **Step 5: 提交共享过滤逻辑**

```bash
git add lib/analysis-format.ts tests/core.test.ts
git commit -m "feat: filter duplicate analysis heading in preview"
```

### Task 2: 将过滤逻辑接入内容梳理预览

**Files:**
- Modify: `app/workspace.tsx:1`（增加共享函数导入）、`MarkdownPreview` 定义附近（增加分析预览变体）和分析正文渲染处（传入变体）
- Modify: `tests/rendered-html.test.mjs:125` 附近（增加静态接线断言）

- [ ] **Step 1: 写失败的接线测试**

在 `tests/rendered-html.test.mjs` 增加：

```js
test("仅为内容梳理预览启用重复标题过滤并统一标题样式", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /stripRedundantAnalysisHeading/);
  assert.match(workspace, /analysisPreview=\{documentTab === "summary"\}/);
  assert.match(workspace, /className=\{analysisPreview \? "markdown-preview analysis-preview"/);
  assert.match(workspace, /<MarkdownPreview markdown=\{markdown\} hideEpisodeMeta \/>/);
});
```

运行：`node --experimental-strip-types --test tests/rendered-html.test.mjs`

预期：在尚未接线时失败。

- [ ] **Step 2: 在 MarkdownPreview 中接入分析变体**

在 `app/workspace.tsx` 引入函数并调整组件：

```tsx
import { stripRedundantAnalysisHeading } from "@/lib/analysis-format";

function MarkdownPreview({
  markdown,
  hideEpisodeMeta = false,
  analysisPreview = false,
}: { markdown: string; hideEpisodeMeta?: boolean; analysisPreview?: boolean }) {
  const body = useMemo(() => markdown.replace(/^---[\s\S]*?---\s*/, ""), [markdown]);
  const lines = useMemo(() => {
    let nextLines = body.split(/\r?\n/);
    if (hideEpisodeMeta) nextLines = stripEpisodeMetaFromPreview(nextLines);
    if (analysisPreview) nextLines = stripRedundantAnalysisHeading(nextLines);
    return nextLines;
  }, [body, hideEpisodeMeta, analysisPreview]);
  return (
    <div className={analysisPreview ? "markdown-preview analysis-preview" : "markdown-preview"}>
      {/* 以下 Markdown 行渲染保持现有逻辑 */}
    </div>
  );
}
```

将分析正文调用改为：

```tsx
<MarkdownPreview markdown={analysisMarkdown} analysisPreview={documentTab === "summary"} />
```

“文稿”调用继续保留 `hideEpisodeMeta`，不传 `analysisPreview`。

- [ ] **Step 3: 运行接线测试确认通过**

运行：`node --experimental-strip-types --test tests/rendered-html.test.mjs`

预期：新增接线测试及已有渲染静态测试通过。

- [ ] **Step 4: 提交预览接线**

```bash
git add app/workspace.tsx tests/rendered-html.test.mjs
git commit -m "feat: use compact analysis preview variant"
```

### Task 3: 统一所有预览字号并验证边界

**Files:**
- Modify: `app/globals.css:323` 附近（调整 `.markdown-preview h1` 为统一紧凑字号）
- Modify: `tests/rendered-html.test.mjs`（增加样式断言）

- [ ] **Step 1: 写失败的样式断言**

在内容梳理预览测试中加入：

```js
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
assert.match(styles, /\.markdown-preview h1\s*\{[^}]*font-size:\s*clamp\(28px, 3\.6vw, 42px\)/);
assert.doesNotMatch(styles, /\.analysis-preview h1\s*\{/);
```

运行：`node --experimental-strip-types --test tests/rendered-html.test.mjs`

预期：样式断言失败。

- [ ] **Step 2: 添加紧凑标题样式**

将现有 `.markdown-preview h1` 规则改为：

```css
.markdown-preview h1 {
  font-size: clamp(28px, 3.6vw, 42px);
  line-height: 1.16;
  letter-spacing: -.035em;
  margin-bottom: 22px;
}
```

该规则作用于文稿、内容梳理和学习 Prompt 三种预览；`analysis-preview` 类仍仅用于重复标题过滤，不再承担字号覆盖。

- [ ] **Step 3: 运行样式与行为测试**

运行：`node --experimental-strip-types --test tests/core.test.ts tests/rendered-html.test.mjs`

预期：全部通过，且重复标题边界测试仍保持通过。

- [ ] **Step 4: 提交样式调整**

```bash
git add app/globals.css tests/rendered-html.test.mjs
git commit -m "style: compact content summary preview title"
```

### Task 4: 全量验证与交付检查

**Files:**
- Verify only; no source changes expected unless a failing check identifies a concrete issue.

- [ ] **Step 1: 构建与完整测试**

运行：`npm test`

预期：构建成功，Node 测试全部通过且失败数为 0。

- [ ] **Step 2: 静态质量检查**

依次运行：`npm run lint`、`npx tsc --noEmit`、`git diff --check`

预期：三个命令均以退出码 0 完成。

- [ ] **Step 3: 检查工作树并记录结果**

运行：`git status --short`、`git log -4 --oneline`

确认本次源代码、测试和文档提交均在当前分支，未覆盖用户已有的其它未提交修改；在最终回复中说明访问 `http://localhost:3000/` 刷新后可验证。
