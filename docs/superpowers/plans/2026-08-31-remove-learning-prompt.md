# 下线学习 Prompt 生成功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭新的学习 Prompt 生成路径，同时让已有 `learning_prompt` 分析结果继续只读查看、复制和下载。

**Architecture:** 保留分析结果数据库和 GET/下载读路径作为历史兼容层；生成 API 在进入文稿读取、额度和 lease 流程前只接受 `summary`，对旧类型返回稳定的 410。前端根据单集是否存在旧结果动态显示“历史 Prompt”只读标签，内容梳理和其它功能沿用现有流程。

**Tech Stack:** React 19、TypeScript、vinext/Vite、Cloudflare Worker API、SQLite/D1、Node 内置测试运行器。

---

## 文件变更地图

- Modify `tests/core.test.ts`：先增加生成接口拒绝学习 Prompt 的路由回归，并将不再适用的学习 Prompt 生成预算测试改为历史类型兼容测试。
- Modify `tests/rendered-html.test.mjs`：验证新页面不显示生成入口，历史结果仍有只读标签与操作。
- Modify `app/api/episodes/[eid]/analyses/generate/route.ts`：只接受 `summary`，对 `learning_prompt` 返回 410。
- Modify `lib/analysis.ts`：删除新的学习 Prompt 提示词和生成分支，保留历史记录所需的分析类型兼容。
- Modify `app/workspace.tsx`：动态渲染“历史 Prompt”，隐藏其生成控件和来源选择，更新删除及 AI 设置文案。
- Modify `app/layout.tsx`：移除学习 Prompt 的当前功能描述。
- Modify `README.md`：移除当前功能清单和 AI 设置中关于新生成学习 Prompt 的表述，补充历史结果只读兼容说明。
- Delete `Prompt.md`：删除会误导用户的旧生成规范；Git 历史保留可恢复版本。
- Create `docs/superpowers/specs/2026-08-31-remove-learning-prompt-design.md`：已完成并提交的设计依据，本计划不再修改。

## Task 1: 先写生成接口的失败回归测试

**Files:**
- Modify: `tests/core.test.ts`（分析生成路由测试区域，约 2000 行以后）

- [ ] **Step 1: 添加拒绝下线类型的测试。**

在现有 `globalThis.__analysisGenerateRouteTestDeps` 动态模块 mock 约定旁新增测试。计数器和 mock 需要覆盖所有不应发生的副作用：

```ts
test("rejects removed learning prompt generation before charging or calling AI", async () => {
  let documentReads = 0;
  let usageCalls = 0;
  let leaseCalls = 0;
  let configCalls = 0;
  globalThis.__analysisGenerateRouteTestDeps = {
    "@/lib/analysis": { buildAnalysisMarkdown, generateAnalysisBody: async () => "unexpected" },
    "@/lib/ai-settings": { readActiveAiConfiguration: async () => { configCalls += 1; throw new Error("unexpected"); } },
    "@/lib/db": {
      acquireAnalysisLease: async () => { leaseCalls += 1; return "lease"; },
      consumeUsage: async () => { usageCalls += 1; return true; },
      getEpisodeRecord: async () => analysisEpisode,
      getFramework: async () => null,
      publicAnalysis: (record: Record<string, unknown>) => record,
      refundUsage: async () => undefined,
      releaseAnalysisLease: async () => undefined,
      setOriginalHash: async () => undefined,
      upsertAnalysisResult: async () => { throw new Error("unexpected"); },
    },
    "@/lib/documents": {
      analysisDocumentKey: async () => "unexpected",
      putMarkdown: async () => { throw new Error("unexpected"); },
      readMarkdown: async () => { documentReads += 1; throw new Error("unexpected"); },
    },
    "@/lib/frameworks": { frameworkForAnalysis: () => SYSTEM_FRAMEWORK, SYSTEM_FRAMEWORK_ID: SYSTEM_FRAMEWORK.id },
    "@/lib/security": { sha256Hex: async () => "unexpected" },
    "@/lib/user": {
      apiError: (error: unknown) => error instanceof HttpError
        ? Response.json({ error: error.code, message: error.message }, { status: error.status })
        : Response.json({ error: "INTERNAL_ERROR" }, { status: 500 }),
      HttpError,
      requireApiUser: async () => ({ userId: "owner" }),
    },
  };
  try {
    const route = await import(`${new URL("../app/api/episodes/[eid]/analyses/generate/route.ts", import.meta.url).href}?removed=${crypto.randomUUID()}`);
    const response = await route.POST(new Request("https://app.example/api/episodes/episode-id/analyses/generate", {
      method: "POST",
      body: JSON.stringify({ kind: "learning_prompt", source: "current" }),
    }), { params: Promise.resolve({ eid: "episode-id" }) });
    const payload = await response.json() as { error?: string; message?: string };

    assert.equal(response.status, 410);
    assert.equal(payload.error, "ANALYSIS_KIND_REMOVED");
    assert.match(payload.message ?? "", /学习 Prompt 生成功能已下线/);
    assert.equal(documentReads, 0);
    assert.equal(usageCalls, 0);
    assert.equal(leaseCalls, 0);
    assert.equal(configCalls, 0);
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
  }
});
```

- [ ] **Step 2: 运行该测试，确认当前实现先失败。**

Run: `node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="removed learning prompt"`

Expected: FAIL，因为当前 `parseKind` 接受 `learning_prompt` 并继续进入生成流程。

## Task 2: 先写前端历史只读入口的失败回归

**Files:**
- Modify: `tests/rendered-html.test.mjs`（现有学习 Prompt 静态测试位置）

- [ ] **Step 1: 将旧的“生成 staged learning prompts”测试替换为下线契约测试。**

测试读取 `app/workspace.tsx`、`lib/analysis.ts`、`app/layout.tsx` 和 `README.md`，断言页面包含历史结果条件和只读操作，同时不再包含生成分支的关键文案：

```js
test("keeps legacy learning prompts read-only", async () => {
  const [workspace, analysis, layout, readme] = await Promise.all([
    readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /result\.kind === "learning_prompt"/);
  assert.match(workspace, /历史 Prompt/);
  assert.match(workspace, /documentTab === "learning_prompt"/);
  assert.doesNotMatch(workspace, /生成一份播客专属学习 Prompt/);
  assert.doesNotMatch(workspace, /学习 Prompt 已生成/);
  assert.doesNotMatch(analysis, /最高优先级：对话启动协议/);
  assert.doesNotMatch(analysis, /播客听后深度对谈 Prompt/);
  assert.doesNotMatch(layout, /内容梳理与学习 Prompt/);
  assert.match(readme, /历史.*Prompt.*只读/);
});
```

- [ ] **Step 2: 运行渲染测试，确认当前实现先失败。**

Run: `node --experimental-strip-types --test tests/rendered-html.test.mjs --test-name-pattern="legacy learning prompts"`

Expected: FAIL，因为当前页面仍显示可生成的学习 Prompt 标签、按钮和说明。

## Task 3: 关闭服务端生成入口

**Files:**
- Modify: `app/api/episodes/[eid]/analyses/generate/route.ts`

- [ ] **Step 1: 收紧生成类型解析。**

将现有解析函数改为只接受摘要，并让下线类型产生稳定错误：

```ts
function parseKind(value: unknown): Extract<AnalysisKind, "summary"> {
  if (value === "summary") return value;
  if (value === "learning_prompt") {
    throw new HttpError(410, "ANALYSIS_KIND_REMOVED", "学习 Prompt 生成功能已下线，历史结果仍可查看");
  }
  throw new HttpError(400, "INVALID_ANALYSIS_KIND", "分析类型无效");
}
```

保持 `getEpisodeRecord` 在解析前执行以继续做单集归属校验，但确保拒绝发生在 `readMarkdown`、`sha256Hex`、`consumeUsage`、`acquireAnalysisLease`、`readActiveAiConfiguration` 之前。类型推断应让后续 `kind === "summary"` 分支不再需要处理学习 Prompt。

- [ ] **Step 2: 运行 Task 1 回归测试，确认通过。**

Run: `node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="removed learning prompt"`

Expected: PASS，HTTP 410、错误码和零副作用计数全部符合断言。

## Task 4: 删除新的学习 Prompt 模型生成分支，保留历史类型

**Files:**
- Modify: `lib/analysis.ts`
- Modify: `lib/analysis-format.ts`（仅在 TypeScript 类型需要拆分时调整导出）
- Modify: `tests/core.test.ts`

- [ ] **Step 1: 删除 `generateAnalysisBody` 的学习 Prompt 分支。**

移除 `generateAnalysisBody` 中从 `return runModel` 开始的学习 Prompt系统提示词、学习地图和 `maxOutputTokens: 5_200` 调用，仅保留摘要分支；函数参数的 `kind` 使用 `Extract<AnalysisKind, "summary">` 或新的 `GeneratedAnalysisKind = "summary"`。

保留 `AnalysisKind = "summary" | "learning_prompt"` 供历史 `AnalysisRecord`、`publicAnalysis` 和读路径使用；保留 `buildAnalysisMarkdown` 中学习 Prompt 的标题分支，确保旧 Markdown 不被改名。

- [ ] **Step 2: 删除过时的学习 Prompt 生成预算测试，保留历史格式测试。**

移除 `uses the dedicated learning prompt budget for short transcripts`，新增直接调用 `buildAnalysisMarkdown({ kind: "learning_prompt", ... })` 的断言，确认结果标题仍包含 `深度学习与实践 Prompt`，且不调用模型。

- [ ] **Step 3: 运行分析相关测试。**

Run: `node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="analysis|learning prompt|content summary"`

Expected: 摘要预算、长文证据分段、历史标题兼容测试 PASS；不再存在学习 Prompt 模型请求预算断言。

## Task 5: 调整前端为动态历史只读模式

**Files:**
- Modify: `app/workspace.tsx`

- [ ] **Step 1: 增加历史结果判定并保留读路径状态。**

在 `selectedAnalysis` 计算附近增加：

```ts
const hasLegacyLearningPrompt = analysisResults.some((result) => result.kind === "learning_prompt");
```

保留 `DocumentTab`、`selectedSlot` 和 `switchDocumentTab` 对 `learning_prompt` 的读取分支；它们只用于历史结果，不触发生成。

- [ ] **Step 2: 动态渲染标签并改为历史名称。**

在文稿抽屉导航中仅在 `hasLegacyLearningPrompt` 为真时渲染：

```tsx
{hasLegacyLearningPrompt && (
  <button className={documentTab === "learning_prompt" ? "active" : ""}
    type="button" disabled={speakerProcessing || cleanupProcessing}
    onClick={() => switchDocumentTab("learning_prompt")}
  >历史 Prompt</button>
)}
```

- [ ] **Step 3: 让历史分析工具栏只剩读取操作。**

将分析工具栏中的“分析来源”选择限制在 `documentTab === "summary"`；当 `documentTab === "learning_prompt"` 时保留过期徽标、来源/日期元数据、复制和下载按钮，但不渲染生成/重新生成按钮。下载文件名仍根据旧类型使用 `学习Prompt`，以兼容历史文件。

- [ ] **Step 4: 处理历史页面空状态和生成函数保护。**

历史标签只在已有结果时出现，因此正常情况下不会进入空状态；仍保留可读错误提示。将 `generateAnalysis` 的入口收紧为 `if (!selected || documentTab !== "summary" || cleanupProcessing) return;`，请求体固定使用 `kind: "summary"`。

- [ ] **Step 5: 更新删除确认、AI 设置和连接提示文案。**

删除确认改为“官方原稿、编辑稿、历史分析结果……”，连接成功和 AI 设置说明只写“内容梳理”。不删除 `analysisResults` 中历史条目，确保打开单集后标签能恢复。

- [ ] **Step 6: 运行前端静态回归。**

Run: `node --experimental-strip-types --test tests/rendered-html.test.mjs --test-name-pattern="legacy learning prompts|analysis preview|document"`

Expected: 历史只读契约、内容梳理标题/滚动和文稿工具栏测试 PASS。

## Task 6: 清理当前文档和旧生成规范

**Files:**
- Modify: `app/layout.tsx`
- Modify: `README.md`
- Delete: `Prompt.md`

- [ ] **Step 1: 更新布局描述和 README。**

将产品描述从“内容梳理与学习 Prompt”改为“内容梳理”；功能清单、R2 说明和 AI 设置说明只描述当前可生成的内容梳理。增加一句“历史上已生成的学习 Prompt 仍可只读查看、复制和下载，不再支持新生成”。保留来源与修改说明、声纹和 AI 整理文档。

- [ ] **Step 2: 删除旧生成规范文件。**

使用 `apply_patch` 删除仓库根目录 `Prompt.md`。不删除数据库字段、迁移、对象存储历史结果或 GET/下载路由。

- [ ] **Step 3: 运行静态文案检查。**

Run: `rg -n -i "学习 Prompt 已生成|生成一份播客专属学习 Prompt|内容梳理与学习 Prompt|Prompt.md" app README.md; if (Test-Path Prompt.md) { Write-Error "Prompt.md 仍然存在"; exit 1 }`

Expected: `rg` 不匹配当前页面或 README 的新生成功能文案，且 `Prompt.md` 不存在；设计/计划档案中的历史描述不在本次检查范围内。

## Task 7: 全量验证并提交

**Files:**
- Modify: all files from Tasks 3–6
- Test: `tests/core.test.ts`, `tests/rendered-html.test.mjs`

- [ ] **Step 1: 运行完整测试套件。**

Run: `npm test`

Expected: 构建成功，所有测试通过；测试总数应等于或高于当前 191，且失败数为 0。

- [ ] **Step 2: 运行 lint、类型检查和差异检查。**

Run: `npm run lint`

Expected: exit code 0，无 ESLint 错误。

Run: `npm exec tsc -- --noEmit --pretty false`

Expected: exit code 0，无 TypeScript 错误。

Run: `git diff --check`

Expected: 无输出、exit code 0。

- [ ] **Step 3: 检查历史兼容和工作树。**

Run: `git diff --stat; git status --short`

Expected: 只包含本计划列出的代码、文案、测试和 `Prompt.md` 删除；没有 `.env`、密钥或音频文件。

- [ ] **Step 4: 创建独立提交。**

```bash
git add app/api/episodes/[eid]/analyses/generate/route.ts app/workspace.tsx app/layout.tsx lib/analysis.ts lib/analysis-format.ts README.md tests/core.test.ts tests/rendered-html.test.mjs
git add -u Prompt.md
git commit -m "feat: 下线学习prompt生成并保留历史结果"
```

Expected: 新提交只包含本功能下线改动；不修改已推送的 `263e9c3` 归档提交。

## 完成标准

- 新的 `learning_prompt` POST 请求稳定返回 410，且不扣额度、不占 lease、不调用模型。
- 没有历史结果的单集不显示学习 Prompt 标签；有历史结果的单集显示“历史 Prompt”，只可查看、复制、下载。
- 旧结果的读取、frontmatter、过期状态和下载文件名保持兼容。
- 内容梳理、声纹识别、AI 整理、自定义 API 和单集删除流程均未改变。
- `npm test`、`npm run lint`、`npm exec tsc -- --noEmit --pretty false` 和 `git diff --check` 全部通过。
