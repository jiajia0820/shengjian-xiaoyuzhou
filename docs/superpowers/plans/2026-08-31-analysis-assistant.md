# 内容梳理 AI 助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“内容梳理”结果中选中文字后，通过受限侧栏向结合官方原文证据的主题顾问提问，并保留单集本地对话。

**Architecture:** 新增纯函数模块负责选文所在小节、时间戳/关键词原文窗口、身份建议和安全提示词；新增无状态单集问答 API 重新读取用户拥有的分析结果与原稿，复用现有 AI 提供商和额度；新增客户端侧栏负责选区入口、消息状态和 localStorage。没有数据库迁移、向量索引或浏览器直连模型。

**Tech Stack:** React 19、TypeScript、vinext/Next 风格 Route Handler、Cloudflare D1/R2、现有 `apiFetch` 和 `executeModelRequest`。

---

### Task 1: 为上下文计算和提示词建立失败测试

**Files:**
- Create: `tests/analysis-assistant.test.ts`
- Modify: `package.json`（把测试文件加入 `npm test`）

- [ ] **Step 1: 写纯函数失败测试**：在 `tests/analysis-assistant.test.ts` 导入尚不存在的函数，并用以下行为断言建立契约：

```ts
test("extracts the selected summary section", () => {
  const result = extractSummarySection("# 标题\n\n## 观点\n\n选中的判断。\n\n## 其它\n\n后文", "选中的判断");
  assert.equal(result.heading, "## 观点");
  assert.match(result.text, /选中的判断/);
  assert.doesNotMatch(result.text, /后文/);
});

test("uses a ninety-second timestamp window and caps source text", () => {
  const result = buildOriginalContext(
    "[00:10:00] 甲\n[00:11:00] 乙\n[00:12:20] 丙\n[00:14:00] 丁",
    "[00:11:00] 选中的观点",
  );
  assert.equal(result.source, "official_timestamp");
  assert.deepEqual(result.timestamps, ["00:10:00", "00:11:00", "00:12:20"]);
  assert.doesNotMatch(result.text, /00:14:00/);
});

test("falls back to a possibly-related keyword window", () => {
  const result = buildOriginalContext("这是关于向量数据库的原文。\n后续解释。", "向量数据库");
  assert.equal(result.source, "official_keyword");
  assert.match(result.notice, /可能相关/);
});

test("suggests a topic-aware role and rejects oversized input", () => {
  assert.equal(inferAssistantRole("AI 产品经理访谈", "模型评估"), "AI 产品与技术顾问");
  assert.throws(() => validateAssistantQuestion(""), /问题/);
  assert.throws(() => validateAssistantQuestion("x".repeat(2_001)), /过长/);
});
```

- [ ] **Step 2: 运行测试确认失败**：

```powershell
node --experimental-strip-types --test tests/analysis-assistant.test.ts
```

预期：因 `lib/analysis-assistant.ts` 尚不存在而失败。

- [ ] **Step 3: 写最小纯函数实现**：新增 `lib/analysis-assistant.ts`，实现以下固定接口，不引入第三方库：

```ts
export type AssistantSource = "official_timestamp" | "official_keyword" | "summary_only";
export type AssistantContext = { heading: string | null; text: string; source: AssistantSource; timestamps: string[]; notice: string };
export function inferAssistantRole(title: string, selectedText: string): string;
export function validateAssistantQuestion(value: string): string;
export function extractSummarySection(markdown: string, selectedText: string): { heading: string | null; text: string };
export function buildOriginalContext(originalMarkdown: string | null, evidenceText: string): AssistantContext;
export function buildAssistantPrompt(args: {
  episodeTitle: string; podcastTitle: string; role: string; selectedText: string;
  summarySection: string; originalContext: AssistantContext;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  question: string;
}): { instructions: string; input: string; maxOutputTokens: number };
```

`buildOriginalContext` 必须用每个时间戳前后 90 秒过滤原文行，官方时间戳最多 8,000 字；无时间戳时按选文关键词截取最多 4,000 字并返回“可能相关”；没有原文返回 `summary_only`。所有函数按 Unicode 字符计数并拒绝超限输入。

- [ ] **Step 4: 运行纯函数测试确认通过**：`node --experimental-strip-types --test tests/analysis-assistant.test.ts` 应全部通过。
- [ ] **Step 5: 提交**：

```powershell
git add lib/analysis-assistant.ts tests/analysis-assistant.test.ts package.json
git commit -m "test: define analysis assistant context contract"
```

### Task 2: 新增安全的单集助手 API

**Files:**
- Create: `app/api/episodes/[eid]/assistant/route.ts`
- Modify: `tests/core.test.ts`（为新别名模块增加测试注入映射和路由测试）

- [ ] **Step 1: 写失败路由测试**：在 `tests/core.test.ts` 添加 `analysis assistant` 测试，注入用户、单集、summary 结果、原稿和模型执行器，断言：

```ts
const response = await route.POST(new Request("https://app.example/api/episodes/ep-1/assistant", {
  method: "POST",
  body: JSON.stringify({ slot: "summary:system-brief-v1", selectedText: "选中观点", role: "主题顾问", question: "依据是什么？", history: [] }),
}), { params: Promise.resolve({ eid: "ep-1" }) });
assert.equal(response.status, 200);
assert.equal((await response.json()).context.source, "official_timestamp");
assert.equal(usageCalls, 1);
assert.equal(modelCalls, 1);
```

同一测试文件还要断言空问题、`learning_prompt` slot 和 2,001 字问题返回 400，模型异常返回 502 且 `refundUsage` 调用一次、`upsertAnalysisResult` 从未调用。

- [ ] **Step 2: 运行目标测试确认失败**：

```powershell
node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="analysis assistant"
```

预期：新路由不存在或返回错误。

- [ ] **Step 3: 写最小 Route Handler**：实现 `POST` 的固定顺序：认证 → 读取并校验单集 → 校验 `summary:*` 结果 → 限长解析 body → 读取 summary 与 `original_key` → 调用 `buildAssistantPrompt` 和 `executeModelRequest` → 消耗/失败退款额度 → 返回 `{ answer, context }`。只调用 `consumeUsage(userId, "ai", 20)`，不调用分析 lease 或任何写文稿函数；所有异常交给 `apiError`，且错误文本不得包含配置密钥。
- [ ] **Step 4: 运行路由测试确认通过**：目标测试全部通过，并确认请求体和回答中不出现 API Key/Base URL。
- [ ] **Step 5: 提交**：

```powershell
git add app/api/episodes/[eid]/assistant/route.ts tests/core.test.ts
git commit -m "feat: add evidence-aware analysis assistant API"
```

### Task 3: 添加内容梳理选区入口与侧栏状态

**Files:**
- Create: `app/analysis-assistant.tsx`
- Modify: `app/workspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

- [ ] **Step 1: 写渲染失败测试**：在 `tests/rendered-html.test.mjs` 添加静态断言：

```js
assert.match(workspace, /onTextSelection/);
assert.match(workspace, /问 AI/);
assert.match(workspace, /\/api\/episodes\/\$\{episode\.eid\}\/assistant/);
assert.match(workspace, /AI 助手/);
assert.match(workspace, /aria-label="关闭 AI 助手"/);
assert.doesNotMatch(workspace, /MarkdownPreview markdown=\{markdown\}[^\n]*onTextSelection/);
```

- [ ] **Step 2: 运行静态测试确认失败**：

```powershell
node --experimental-strip-types --test tests/rendered-html.test.mjs --test-name-pattern="analysis assistant"
```

预期：缺少新入口/组件而失败。

- [ ] **Step 3: 写最小客户端实现**：给 `MarkdownPreview` 增加 `onTextSelection?: (text: string, rect: DOMRect) => void`，仅在 `analysisPreview` 时绑定选区事件；新增 `app/analysis-assistant.tsx`，接收 `episodeTitle`、`podcastTitle`、`eid`、`slot`、`selectedText`、`defaultRole` 和 `onClose`，调用 `apiFetch` 的 POST 接口，消息类型固定为 `{ role, content, createdAt }`，localStorage 键固定为 `shengjian:analysis-assistant:v1:${eid}`，最多保留 20 条、发送最多 8 条。
- [ ] **Step 4: 写样式并运行测试**：侧栏固定右侧、窄屏全宽；按钮和关闭控件满足可操作尺寸；加载/错误/空状态清晰；静态测试通过。
- [ ] **Step 5: 提交**：

```powershell
git add app/analysis-assistant.tsx app/workspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add selectable analysis assistant sidebar"
```

### Task 4: 完整验证与文档同步

**Files:**
- Modify: `README.md`（补充内容梳理助手的实际使用方式和证据范围）
- Modify: `tests/analysis-assistant.test.ts`（补边界回归）

- [ ] **Step 1: 运行完整测试**：`npm test`，预期构建成功且所有测试通过。
- [ ] **Step 2: 运行质量检查**：`npm run lint`、`npm exec tsc -- --noEmit --pretty false`、`git diff --check`，预期均退出码 0。
- [ ] **Step 3: 手工验证关键路径**：运行 `npm run dev` 后打开 `http://localhost:3000/`，完成以下可复现检查：在内容梳理结果选中一句话 → 点击“问 AI” → 修改身份 → 输入问题并发送 → 看到回答和“官方原文/时间戳”提示；关闭侧栏后再次选文，确认同一单集历史仍在；用无时间戳测试数据确认显示“关键词匹配，可能相关”；点击文稿编辑页确认没有“问 AI”。
- [ ] **Step 4: 更新 README**：说明入口、上下文范围、额度沿用和“没有时间戳时可能相关”的提示。
- [ ] **Step 5: 提交**：

```powershell
git add README.md tests/analysis-assistant.test.ts
git commit -m "docs: document analysis assistant workflow"
```
