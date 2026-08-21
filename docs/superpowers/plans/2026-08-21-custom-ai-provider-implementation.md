# 自定义 AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在完整保留 DeepSeek 的前提下，让每个用户额外保存一个自定义 OpenAI 兼容连接，并可选择默认连接完成既有内容梳理和学习 Prompt 生成。

**Architecture:** 用 provider 相关的配置类型、URL 策略和模型适配器隔离外部 API 差异；分析编排只接收统一的已解密运行配置。D1 将单条 AI 设置迁移为按 provider 保存的两条连接，并新增默认 provider 偏好；浏览器只拿到脱敏连接状态。

**Tech Stack:** Next/Vinext、React 19、TypeScript、Cloudflare D1/R2、OpenAI SDK（DeepSeek）、原生 Fetch（自定义 OpenAI 兼容 Responses 与 Chat Completions）、Node test。

---

## 文件结构

- Create: lib/ai-provider.ts — provider 类型、Base URL 验证、DeepSeek 与自定义 OpenAI 兼容请求适配器。
- Modify: lib/ai-settings.ts — 加密保存、读取、删除和切换两个连接，永不向客户端暴露明文 Key。
- Modify: lib/analysis.ts — 将现有分析编排从单独的 DeepSeek Key 改为统一运行配置。
- Modify: lib/analysis-format.ts — 结果 frontmatter 写入实际 provider、API 格式和模型。
- Modify: lib/db.ts — 迁移保护、两个连接的 CRUD、默认 provider 偏好、分析结果元数据。
- Modify: db/schema.ts — Drizzle 对应的最终 D1 schema。
- Create: drizzle/0006_custom_ai_providers.sql — 保留历史 DeepSeek 密文、时间和分析记录的数据迁移。
- Modify: drizzle/meta/_journal.json and drizzle/meta/0006_snapshot.json — 由 drizzle-kit 生成的 schema 元数据。
- Modify: app/api/ai-settings/route.ts — GET、PUT、PATCH、DELETE 的多 provider 合约。
- Modify: app/api/episodes/[eid]/analyses/generate/route.ts — 读取默认 provider 并保存生成来源。
- Modify: app/workspace.tsx and app/globals.css — 双连接设置、默认切换、无 URL 的 Codex 预设、现有入口文案。
- Modify: tests/core.test.ts, tests/rendered-html.test.mjs, package.json, README.md — 覆盖行为并把测试与运行说明同步到新能力。

### Task 1: 建立可单测的 Provider 类型、URL 策略和请求适配器

**Files:**
- Create: lib/ai-provider.ts
- Modify: tests/core.test.ts

- [ ] **Step 1: 写出失败的 URL 与请求映射测试**

在 tests/core.test.ts 增加对下列公开函数的导入和断言：

~~~ts
import {
  buildCustomModelRequest,
  normalizeCustomBaseUrl,
  type CustomAiRuntimeConfig,
} from "../lib/ai-provider.ts";

test("normalizes only safe HTTPS custom API roots", () => {
  assert.equal(normalizeCustomBaseUrl(" https://relay.example/v1/ "), "https://relay.example/v1");
  for (const value of [
    "http://relay.example/v1",
    "https://user:pass@relay.example/v1",
    "https://relay.example/v1?token=secret",
    "https://relay.example/v1#fragment",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://api.internal/v1",
  ]) assert.throws(() => normalizeCustomBaseUrl(value));
});

test("maps custom Responses and Chat Completions without DeepSeek thinking", () => {
  const base: CustomAiRuntimeConfig = {
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
  };
  const responses = buildCustomModelRequest(base, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  });
  assert.equal(responses.url, "https://relay.example/v1/responses");
  assert.deepEqual(responses.body, {
    model: "gpt-5.6-luna", instructions: "system rules", input: "document",
    max_output_tokens: 1600, reasoning: { effort: "medium" },
  });
  const chat = buildCustomModelRequest({ ...base, apiFormat: "chat_completions", reasoningEffort: null }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  });
  assert.equal(chat.url, "https://relay.example/v1/chat/completions");
  assert.deepEqual(chat.body, {
    model: "gpt-5.6-luna",
    messages: [{ role: "system", content: "system rules" }, { role: "user", content: "document" }],
    stream: false, max_tokens: 1600,
  });
});
~~~

- [ ] **Step 2: 运行测试并确认它因模块不存在而失败**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: FAIL，错误包含 Cannot find module 或不存在 normalizeCustomBaseUrl。

- [ ] **Step 3: 实现纯类型、URL 校验和请求体生成**

创建 lib/ai-provider.ts，定义以下可复用边界：

~~~ts
export type AiProvider = "deepseek" | "custom";
export type AiApiFormat = "chat_completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high";

export type ModelRequest = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
};

export type ModelResponse = {
  text: string;
  provider: AiProvider;
  apiFormat: AiApiFormat;
  model: string;
};

export type CustomAiRuntimeConfig = {
  provider: "custom";
  apiKey: string;
  baseUrl: string;
  model: string;
  apiFormat: AiApiFormat;
  reasoningEffort: ReasoningEffort | null;
};

export type DeepseekAiRuntimeConfig = {
  provider: "deepseek";
  apiKey: string;
  model: "deepseek-v4-flash";
  apiFormat: "chat_completions";
  baseUrl: null;
  reasoningEffort: null;
};

export type AiRuntimeConfig = DeepseekAiRuntimeConfig | CustomAiRuntimeConfig;

export function normalizeCustomBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const hostname = url.hostname.toLowerCase();
  const isIpv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);
  const isIpv6 = hostname.startsWith("[") || hostname.includes(":");
  const privateName = hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname === "local" || hostname.endsWith(".local")
    || hostname === "internal" || hostname.endsWith(".internal");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || isIpv4 || isIpv6 || privateName || value.length > 2048) throw new Error("INVALID_CUSTOM_BASE_URL");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function buildCustomModelRequest(config: CustomAiRuntimeConfig, request: ModelRequest) {
  const suffix = config.apiFormat === "responses" ? "responses" : "chat/completions";
  const url = new URL(suffix, config.baseUrl + "/").toString();
  if (config.apiFormat === "responses") {
    const body: Record<string, unknown> = {
      model: config.model, instructions: request.instructions, input: request.input,
      max_output_tokens: request.maxOutputTokens,
    };
    if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
    return { url, body };
  }
  return {
    url,
    body: {
      model: config.model,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.input },
      ],
      stream: false,
      max_tokens: request.maxOutputTokens,
    },
  };
}
~~~

随后在同一模块实现 executeModelRequest(config, request)。DeepSeek 分支保持现有 OpenAI SDK 的 baseURL、120 秒超时、1 次重试和 thinking: { type: "disabled" }；自定义分支使用 fetch，带 Authorization Bearer、Content-Type JSON、redirect: "manual" 和 AbortSignal.timeout(120000)。Responses 从 output 数组中的 message/content/type=output_text/text 提取正文；Chat Completions 从 choices[0].message.content 提取字符串正文；两种格式均调用现有 Markdown 清洗逻辑并拒绝空文本。

~~~ts
export async function executeModelRequest(
  config: AiRuntimeConfig,
  request: ModelRequest,
): Promise<ModelResponse> {
  if (config.provider === "deepseek") {
    return requestDeepseekModel(config, request);
  }
  return requestCustomModel(config, request);
}
~~~

- [ ] **Step 4: 补上自定义请求运行与错误映射测试**

向 tests/core.test.ts 增加一个接受 fetch 实现参数的 requestCustomModel 测试。伪造 200 Responses JSON 并断言：

~~~ts
const response = await requestCustomModel(base, {
  instructions: "safe", input: "source", maxOutputTokens: 20,
}, async (url, init) => {
  assert.equal(String(url), "https://relay.example/v1/responses");
  assert.equal(init?.redirect, "manual");
  return Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text: "## result" }] }],
  });
});
assert.equal(response.text, "## result");
~~~

再对 401、429、500、302、空输出和 AbortError 分别断言 HttpError 的 status 为 400、429、502、502、502、504；错误消息不得含 relay-key。

- [ ] **Step 5: 运行单元测试并确认通过**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: PASS，包含 URL 策略、Responses、Chat Completions、错误映射和既有核心测试。

- [ ] **Step 6: 提交该独立适配器**

Run:

~~~bash
git add lib/ai-provider.ts tests/core.test.ts
git commit -m "feat: add custom AI provider adapter"
~~~

### Task 2: 迁移 D1 并实现双连接及默认 provider 数据访问

**Files:**
- Modify: db/schema.ts
- Modify: lib/db.ts
- Create: drizzle/0006_custom_ai_providers.sql
- Modify: drizzle/meta/_journal.json
- Create: drizzle/meta/0006_snapshot.json
- Modify: tests/core.test.ts

- [ ] **Step 1: 写出迁移和 schema 的失败检查**

在 tests/core.test.ts 读取 db/schema.ts、lib/db.ts 和 drizzle/0006_custom_ai_providers.sql，并断言最终 schema 包含：

~~~ts
assert.match(schema, /sqliteTable\("ai_preferences"/);
assert.match(schema, /primaryKey\(\{ columns: \[table\.userId, table\.provider\] \}/);
assert.match(schema, /apiFormat: text\("api_format"\)/);
assert.match(schema, /baseUrl: text\("base_url"\)/);
assert.match(migration, /INSERT INTO __new_ai_settings/);
assert.match(migration, /'deepseek'/);
assert.match(migration, /ALTER TABLE analysis_results ADD COLUMN provider/);
~~~

- [ ] **Step 2: 运行测试并确认迁移文件尚不存在**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: FAIL，错误包含 ENOENT: drizzle/0006_custom_ai_providers.sql。

- [ ] **Step 3: 更新 Drizzle schema 并生成元数据**

将 ai_settings 定义成 user_id 和 provider 的复合主键，并加入 api_format、base_url、model、reasoning_effort。新增 ai_preferences（user_id 主键、active_provider 可空、updated_at）；在 analysis_results 新增非空 provider 与 api_format 字段。执行：

~~~bash
npm run db:generate -- --name custom_ai_providers
~~~

Expected: 生成 drizzle/0006_custom_ai_providers.sql、drizzle/meta/0006_snapshot.json，并在 journal 添加第 6 条记录。

- [ ] **Step 4: 用数据保留 SQL 替换生成迁移的 ai_settings 部分**

保证最终 drizzle/0006_custom_ai_providers.sql 依次执行以下完整语义：

~~~sql
CREATE TABLE __new_ai_settings (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_format TEXT NOT NULL,
  base_url TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  api_key_cipher TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
INSERT INTO __new_ai_settings (
  user_id, provider, api_format, base_url, model, reasoning_effort,
  api_key_cipher, key_hint, connected_at, updated_at
) SELECT user_id, 'deepseek', 'chat_completions', NULL, 'deepseek-v4-flash', NULL,
  api_key_cipher, key_hint, connected_at, updated_at FROM ai_settings;
DROP TABLE ai_settings;
ALTER TABLE __new_ai_settings RENAME TO ai_settings;
CREATE TABLE ai_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  active_provider TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO ai_preferences (user_id, active_provider, updated_at)
SELECT user_id, 'deepseek', updated_at FROM ai_settings;
ALTER TABLE analysis_results ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek';
ALTER TABLE analysis_results ADD COLUMN api_format TEXT NOT NULL DEFAULT 'chat_completions';
~~~

在 lib/db.ts 的 ensureSchema 中先创建最终新表结构，然后检测 ai_settings 是否缺少 api_format；发现旧表时执行相同的重建和复制逻辑。检测 analysis_results 的新增列并用 ALTER TABLE 补齐，保证尚未运行部署迁移的旧数据库也不会因新代码启动失败。

- [ ] **Step 5: 替换单条设置 DB API**

用以下边界替换 getAiSetting(userId) 和 deleteAiSetting(userId)：

~~~ts
export async function getAiSettings(userId: string): Promise<AiSettingRecord[]>;
export async function getAiSetting(userId: string, provider: AiProvider): Promise<AiSettingRecord | null>;
export async function saveAiSetting(record: AiSettingRecord): Promise<void>;
export async function getAiPreference(userId: string): Promise<AiPreferenceRecord | null>;
export async function setAiPreference(userId: string, provider: AiProvider | null): Promise<void>;
export async function deleteAiSetting(userId: string, provider: AiProvider): Promise<void>;
~~~

saveAiSetting 必须使用 ON CONFLICT(user_id, provider)，不覆盖第二种连接。deleteAiSetting 删除后若删除的是 active_provider，则选择剩余的一个 provider；没有剩余连接则写入 null。upsertAnalysisResult、AnalysisRecord 和 publicAnalysis 同时读写 provider、api_format。

- [ ] **Step 6: 运行迁移结构测试**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: PASS，且所有既有 Markdown、加密、框架、文稿分段测试继续通过。

- [ ] **Step 7: 提交迁移与数据库访问层**

Run:

~~~bash
git add db/schema.ts lib/db.ts drizzle tests/core.test.ts
git commit -m "feat: store multiple AI provider settings"
~~~

### Task 3: 加密配置服务与 AI 设置 API

**Files:**
- Modify: lib/ai-settings.ts
- Modify: app/api/ai-settings/route.ts
- Modify: tests/core.test.ts

- [ ] **Step 1: 为输入校验写失败测试**

在 tests/core.test.ts 对 validateCustomAiInput 断言：

~~~ts
assert.deepEqual(validateCustomAiInput({
  apiKey: "relay-secret-123", baseUrl: "https://relay.example/v1/",
  model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
}), {
  apiKey: "relay-secret-123", baseUrl: "https://relay.example/v1",
  model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
});
assert.throws(() => validateCustomAiInput({
  apiKey: "contains space", baseUrl: "https://relay.example/v1",
  model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
}));
~~~

- [ ] **Step 2: 运行测试并确认校验函数未导出**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: FAIL，错误包含 validateCustomAiInput is not a function 或未导出。

- [ ] **Step 3: 实现设置服务**

将 lib/ai-settings.ts 改为暴露：

~~~ts
export async function getAiSettingsStatus(userId: string): Promise<AiSettingsStatus>;
export async function saveAiProvider(userId: string, body: Record<string, unknown>): Promise<AiSettingsStatus>;
export async function setDefaultAiProvider(userId: string, provider: AiProvider): Promise<AiSettingsStatus>;
export async function removeAiProvider(userId: string, provider: AiProvider): Promise<AiSettingsStatus>;
export async function readActiveAiConfiguration(userId: string): Promise<AiRuntimeConfig>;
~~~

DeepSeek 分支继续只接受 sk- 前缀、固定 deepseek-v4-flash、chat_completions 和 null Base URL。custom 分支要求无空白或控制字符的 Key、1 到 200 个字符的模型名、严格的 apiFormat 和可选 low/medium/high 推理强度；调用 Task 1 的 URL 策略。两支均用 TOKEN_ENCRYPTION_KEY 进行 AES-GCM 加密，返回对象只包含 keyHint。首次保存时如果无 active_provider，就将本次 provider 设为默认。

- [ ] **Step 4: 改写 AI 设置路由合约**

GET 返回：

~~~json
{
  "defaultProvider": "custom",
  "providers": {
    "deepseek": { "provider": "deepseek", "connected": true, "model": "deepseek-v4-flash", "apiFormat": "chat_completions", "keyHint": "•••• 1234", "connectedAt": "2026-08-21T00:00:00.000Z" },
    "custom": { "provider": "custom", "connected": true, "baseUrl": "https://relay.example/v1", "model": "gpt-5.6-luna", "apiFormat": "responses", "reasoningEffort": "medium", "keyHint": "•••• 5678", "connectedAt": "2026-08-21T00:00:00.000Z" }
  }
}
~~~

PUT 保存 body.provider 指定的连接；PATCH 校验已连接后切换 body.provider；DELETE 从 request.url 的 provider 查询参数删除指定连接。拒绝不存在的 provider、DeepSeek 的自定义字段和任何未连接 provider 的默认切换。所有失败使用 apiError，任何响应、日志或错误字符串均不能包含 apiKey。

- [ ] **Step 5: 测试 API 公开面和秘密边界**

扩展 rendered-html.test.mjs 与 core.test.ts，读取路由和服务源码并断言 GET 响应没有 api_key_cipher、apiKey、Authorization，路由包含 PATCH、DELETE 的 provider 参数，且服务使用 encryptSecret 与 decryptSecret。

- [ ] **Step 6: 运行目标测试**

Run: node --experimental-strip-types --test tests/core.test.ts tests/rendered-html.test.mjs

Expected: PASS，AI 设置状态只包含脱敏信息。

- [ ] **Step 7: 提交设置服务**

Run:

~~~bash
git add lib/ai-settings.ts app/api/ai-settings/route.ts tests
git commit -m "feat: manage custom AI provider settings"
~~~

### Task 4: 将生成流程路由到默认 provider 并保存来源元数据

**Files:**
- Modify: lib/analysis.ts
- Modify: lib/analysis-format.ts
- Modify: app/api/episodes/[eid]/analyses/generate/route.ts
- Modify: tests/core.test.ts

- [ ] **Step 1: 为结果 frontmatter 写失败测试**

将现有 adds server-owned frontmatter 测试扩展为：

~~~ts
const markdown = buildAnalysisMarkdown({
  episode, kind: "summary", sourceType: "current", sourceHash: "abc123",
  generatedAt: "2026-08-21T01:00:00.000Z", body: "正文",
  frameworkId: "system-brief-v1", frameworkName: "通用内容梳理",
  provider: "custom", apiFormat: "responses", model: "gpt-5.6-luna",
});
assert.match(markdown, /provider: "custom"/);
assert.match(markdown, /api_format: "responses"/);
assert.match(markdown, /model: "gpt-5.6-luna"/);
assert.doesNotMatch(markdown, /relay\.example|relay-secret/);
~~~

- [ ] **Step 2: 运行测试并确认新字段尚未出现**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: FAIL，frontmatter 仍只写死 DeepSeek 模型。

- [ ] **Step 3: 替换分析层的单一 Key 依赖**

在 lib/analysis.ts 保留原有 400000 字限制、180000/50000 分段阈值、最多三路并发、提示词、Markdown 清洗和错误处理结构。将 runModel(apiKey, instructions, input, maxOutputTokens) 替换为：

~~~ts
async function runModel(config: AiRuntimeConfig, request: ModelRequest): Promise<string> {
  const response = await executeModelRequest(config, request);
  return response.text;
}
~~~

buildChunkNotes 和 generateAnalysisBody 都接收 config: AiRuntimeConfig，并将同一配置传给每个并发分段和最终汇总，不接受客户端临时 provider 参数。

- [ ] **Step 4: 写入真实生成 provider、格式和模型**

在生成路由的 lease 内读取：

~~~ts
const config = await readActiveAiConfiguration(user.userId);
const generatedBody = await generateAnalysisBody({ config, kind, markdown, episode, frameworkName, frameworkInstructions });
~~~

将 config.provider、config.apiFormat 和 config.model 传入 buildAnalysisMarkdown 与 upsertAnalysisResult。保持未配置、上游失败、余额不足、超时的用量退款和 finally 中 releaseAnalysisLease。自定义 URL 和 Key 不写入 R2、analysis_results 或 JSON 响应。

- [ ] **Step 5: 运行核心测试**

Run: node --experimental-strip-types --test tests/core.test.ts

Expected: PASS，历史调用使用默认 DeepSeek 字段，新调用可写入 custom/responses/gpt-5.6-luna。

- [ ] **Step 6: 提交生成路由改造**

Run:

~~~bash
git add lib/analysis.ts lib/analysis-format.ts app/api/episodes/[eid]/analyses/generate/route.ts tests/core.test.ts
git commit -m "feat: generate analyses with selected AI provider"
~~~

### Task 5: 实现双连接设置界面且预设绝不含 URL

**Files:**
- Modify: app/workspace.tsx
- Modify: app/globals.css
- Modify: tests/rendered-html.test.mjs

- [ ] **Step 1: 写出界面文本与安全预设的失败检查**

在 tests/rendered-html.test.mjs 中把原本的 DeepSeek-only 断言改为：

~~~js
assert.match(workspace, /AI 提供商设置/);
assert.match(workspace, /自定义 API/);
assert.match(workspace, /Codex 中转预设/);
assert.match(workspace, /gpt-5\.6-luna/);
assert.doesNotMatch(preset, /setCustomBaseUrl|https?:\/\//);
assert.match(workspace, /Base URL 与 Key 仍须手动填写/);
~~~

预设函数只允许写入模型、接口格式和推理强度；不得内嵌或预填任何 Base URL。

- [ ] **Step 2: 运行渲染测试并确认新界面尚不存在**

Run: node --experimental-strip-types --test tests/rendered-html.test.mjs

Expected: FAIL，workspace 仍显示 连接 DeepSeek。

- [ ] **Step 3: 扩展客户端状态与 API 操作**

将 AiStatus 改为 AiSettingsStatus：含 defaultProvider 与 providers.deepseek/providers.custom。增加 customBaseUrl、customApiKey、customModel、customApiFormat、customReasoningEffort 状态；为保存、删除、设默认分别调用 PUT、DELETE?provider= 和 PATCH。加载成功后用 API 的脱敏状态覆盖界面状态，并在生成前用 Boolean(defaultProvider) 判断是否已配置。

- [ ] **Step 4: 重新组织 AI modal**

将标题改为 AI 提供商设置，使用两个独立卡片：

1. DeepSeek 卡片维持现有 Key 替换和删除动作，显示固定模型。
2. 自定义 API 卡片包含 Base URL、API Key、模型 ID、API 格式 select 和仅 Responses 时可见的推理强度 select。

Codex 中转预设按钮只执行：

~~~ts
function applyCodexPreset() {
  setCustomModel("gpt-5.6-luna");
  setCustomApiFormat("responses");
  setCustomReasoningEffort("medium");
}
~~~

它不得读取、写入、显示或预填 customBaseUrl。卡片下方明确写 Base URL 与 Key 仍须手动填写。每个已连接卡片可设置为默认；顶部 chip 显示默认 provider 名称、模型与 keyHint；首次设置引导改为 设置 AI 提供商，并在任一种连接已保存时显示完成。

- [ ] **Step 5: 添加样式和响应式验证**

在 app/globals.css 添加 ai-provider-grid、ai-provider-form、provider-field-row 和 provider-default-action 规则：桌面双列、窄屏单列；select/input 与现有 connect-modal 共用纸张色、焦点环、边框、禁用态和可见焦点。不要改动文稿库、框架、小宇宙登录和账户 UI 的选择器。

- [ ] **Step 6: 运行渲染测试**

Run: node --experimental-strip-types --test tests/rendered-html.test.mjs

Expected: PASS，服务器仍能渲染，设置引导保留两步且不存在中转 URL 或完整 Key。

- [ ] **Step 7: 提交界面**

Run:

~~~bash
git add app/workspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add dual AI provider settings UI"
~~~

### Task 6: 同步文档并完成全量验证和网页试用

**Files:**
- Modify: package.json
- Modify: README.md
- Modify: tests/core.test.ts
- Modify: tests/rendered-html.test.mjs

- [ ] **Step 1: 扩展测试命令**

在 package.json 的 test 脚本显式包含现有 TypeScript 单测与渲染测试：

~~~json
"test": "npm run build && node --experimental-strip-types --test tests/core.test.ts tests/rendered-html.test.mjs"
~~~

Task 1 至 Task 4 的纯 TypeScript 测试均放在 tests/core.test.ts，避免测试脚本引用不存在的文件。

- [ ] **Step 2: 更新 README 的能力和安全边界**

将 DeepSeek-only 描述改成：DeepSeek Chat Completions 保持固定模型与关闭思考；自定义连接支持 HTTPS OpenAI 兼容 Responses 或 Chat Completions；自定义 URL 和 Key 由用户手填、Key AES-GCM 加密、URL 不进入分析结果。写明 Codex 中转预设仅填模型、格式和 medium，不填 URL 或 Key。

- [ ] **Step 3: 执行静态与完整测试**

Run:

~~~bash
npm run lint
npx tsc --noEmit
npm test
~~~

Expected: 三条命令均以 exit code 0 完成；npm test 构建 dist、检查第 0006 迁移并通过全部 Node tests。

- [ ] **Step 4: 启动本地网页并做无凭据试用**

Run:

~~~bash
npm run dev
~~~

在本地浏览器打开开发服务器，确认首页、文稿库、框架、账户入口仍显示；打开 AI 提供商设置，确认 DeepSeek 与自定义卡片都显示、预设不写 URL、Base URL 与 Key 都需要人工输入、默认切换与删除入口可点击、页面不显示任何保存的完整 Key。真实生成只在用户随后自行填写其外部服务 Key 后执行。

- [ ] **Step 5: 提交文档、测试和收尾**

Run:

~~~bash
git add package.json README.md tests
git commit -m "test: verify custom AI provider support"
git status --short
~~~

Expected: 工作区没有本功能遗留的未提交文件，且不包含 .env、Key、Cookie、数据库导出或文稿正文。

## 计划自审

- 覆盖性：Task 1 处理安全 URL、适配器和上游错误；Task 2 迁移、双槽位、默认偏好和结果表；Task 3 加密配置与 API；Task 4 生成和 frontmatter；Task 5 UI 与无 URL 预设；Task 6 文档、全量验证和浏览器试用。
- 一致性：AiProvider、AiApiFormat、ReasoningEffort、AiRuntimeConfig 在 Task 1 定义，并在 Task 2 至 Task 5 使用同一命名。
- 无秘密边界：只有 Task 3 的服务端运行配置含 apiKey；Task 4 只把 provider、apiFormat、model 写入结果；Task 5 不显示完整 Key，预设不含 URL。
