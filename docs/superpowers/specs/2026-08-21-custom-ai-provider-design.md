# 声笺：DeepSeek 与自定义 OpenAI 兼容 API 设计

- 日期：2026-08-21
- 状态：已确认，待实施
- 范围：只扩展 AI 提供商接入；现有小宇宙连接、文稿导入与编辑、框架、分析结果、下载、账户和用量限制保持原有行为

## 1. 背景与目标

当前系统只允许每位用户保存一把 DeepSeek API Key，并将模型、Base URL 与 Chat Completions 请求格式硬编码为 DeepSeek 配置。目标是在完整保留 DeepSeek 的同时，增加一个用户自带密钥的“自定义 API”连接，使用户可以：

1. 填写任意符合安全规则的 OpenAI 兼容 Base URL；
2. 保存自己的 API Key 与模型 ID；
3. 明确选择 Responses 或 Chat Completions 格式；
4. 同时保留 DeepSeek 与自定义连接，并选择一个全局默认提供商；
5. 使用现有内容梳理和学习 Prompt 工作流生成结果。

第一版只提供两个连接槽位：`deepseek` 和 `custom`。每位用户最多保存一个自定义连接。后续若需要多个自定义连接，可以在不改变适配器接口的前提下扩展。

## 2. 非目标

- 不支持任意、非 OpenAI 兼容的请求或响应结构；此类服务需要单独开发适配器。
- 不自动探测 API 格式，避免额外调用、误判和重复计费。
- 不开放自定义 HTTP 请求头、Cookie、查询参数或工具调用。
- 不自动从失败的提供商回退到另一个提供商。
- 不改变文稿导入、编辑、恢复、下载、框架管理、账户连接、每日用量、任务互斥或结果存储逻辑。
- 不在本次改造中进行无关的页面重构或视觉改版。

## 3. 用户体验

现有 AI 设置弹窗改为“AI 提供商设置”，包含两个连接卡片。

### 3.1 DeepSeek

- 保留现有 API Key 输入、替换、脱敏提示与删除功能。
- Base URL、模型与关闭思考模式的行为保持现状。
- 现有用户的 DeepSeek 配置通过数据库迁移自动保留。

### 3.2 自定义 API

用户需要填写：

- Base URL：例如 `https://example.com/v1`，指向 API 根路径而不是具体的 `/responses` 或 `/chat/completions`；
- API Key：仅在提交时出现，保存后只返回末四位提示；
- 模型 ID：按中转站或供应商实际提供的模型名填写；
- API 格式：`Responses` 或 `Chat Completions`；
- 推理强度：只在 Responses 格式下显示，可选择“不发送”、`low`、`medium` 或 `high`。选择“不发送”时不向上游提交 reasoning 参数。

界面提供一个“Codex 中转预设”，只预填以下非敏感配置：

- 模型：`gpt-5.6-luna`
- API 格式：Responses
- 推理强度：`medium`

预设不包含、展示或预填 Base URL，也不包含 API Key。用户必须手动填写自己的 Base URL 和 Key，并且可以修改预填的模型、格式与推理强度。

### 3.3 默认提供商

- 两种连接可以同时保存。
- 只有已连接的提供商可以设为全局默认。
- 保存第一种连接且尚无默认值时，自动将其设为默认。
- 保存第二种连接不会自动切换默认值。
- 删除当前默认连接时，如果另一种连接仍存在，则将另一种设为默认；否则默认值为空。
- 顶部 AI 状态按钮显示当前默认提供商、模型和 Key 提示。
- 首次设置引导在任意一种提供商连接成功后视为 AI 设置完成。

## 4. 数据模型与迁移

### 4.1 `ai_settings`

将现有单用户主键改为 `(user_id, provider)` 复合唯一约束，并增加：

- `provider`：`deepseek | custom`
- `api_format`：`chat_completions | responses`
- `base_url`：DeepSeek 为 `null`，自定义连接保存规范化后的 URL
- `model`：实际配置的模型 ID
- `reasoning_effort`：`null | low | medium | high`
- `api_key_cipher`：AES-GCM 加密后的 Key
- `key_hint`
- `connected_at`
- `updated_at`

### 4.2 `ai_preferences`

新增每用户一行的偏好表：

- `user_id`：主键
- `active_provider`：`deepseek | custom | null`
- `updated_at`

### 4.3 `analysis_results`

保留现有 `model` 字段，新增：

- `provider`
- `api_format`

历史结果回填为 `deepseek` 与 `chat_completions`。新生成的 Markdown frontmatter 同步记录 `provider`、`api_format` 和实际 `model`。不记录 API Key，也不在结果中保存完整自定义 URL。

### 4.4 迁移策略

迁移使用 SQLite 表重建方式：创建新结构、复制现有 DeepSeek 行、创建默认偏好、回填分析结果，再替换旧表。迁移必须保证已有 Key 密文、连接时间、分析结果和用户数据不丢失。

## 5. 服务端架构

### 5.1 配置服务

AI 配置服务负责：

- 校验、加密、读取和删除各提供商设置；
- 读取与切换全局默认提供商；
- 只向客户端返回脱敏状态；
- 为生成流程返回已解密、已验证的内部配置对象。

### 5.2 统一模型接口

分析编排逻辑继续负责长文分段、并发笔记、最终汇总、安全提示词和 Markdown 清洗。它不再直接创建 DeepSeek 客户端，而是依赖统一模型接口：

```ts
type ModelRequest = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
};

type ModelResponse = {
  text: string;
  provider: "deepseek" | "custom";
  apiFormat: "chat_completions" | "responses";
  model: string;
};
```

提供商路由读取当前默认设置，创建对应适配器，并把统一结果返回给分析编排层。

### 5.3 DeepSeek 适配器

DeepSeek 适配器保持现有行为：

- 固定 `https://api.deepseek.com`；
- 固定 `deepseek-v4-flash`；
- 使用 Chat Completions；
- `thinking.type = disabled`；
- 保留当前超时、重试和输出清洗逻辑。

### 5.4 自定义 Responses 适配器

- 使用用户配置的 Base URL、Key 和模型；
- 将系统提示映射到 `instructions`，用户材料映射到 `input`；
- 使用 `max_output_tokens`；
- 仅在用户选择推理强度时发送 `reasoning.effort`；
- 不传入工具，不启用流式输出；
- 从 Responses 文本输出中提取最终正文，空响应按上游错误处理。

### 5.5 自定义 Chat Completions 适配器

- 使用用户配置的 Base URL、Key 和模型；
- 将提示映射为 `system` 与 `user` 消息；
- 使用非流式请求与输出 token 上限；
- 不传入 DeepSeek 专属 `thinking` 参数；
- 从首个文本 choice 中提取正文。

## 6. API 合约

沿用 `/api/ai-settings` 路径，避免扩散接口数量：

- `GET`：返回默认提供商及 DeepSeek、自定义连接的脱敏状态；
- `PUT`：按 `provider` 保存或替换一套配置；
- `PATCH`：切换已连接的默认提供商；
- `DELETE?provider=...`：删除指定连接。

客户端不能提交 DeepSeek 的 Base URL 或模型。服务端忽略或拒绝不属于当前提供商的字段。生成 API 不接受临时 provider 参数，始终使用服务端保存的全局默认值，防止客户端绕过配置校验。

## 7. URL 与凭据安全

自定义 Base URL 必须通过集中式 URL 策略：

- 必须是绝对 HTTPS URL；
- 最长 2,048 字符；
- 禁止用户名、密码、查询参数和 fragment；
- 禁止 IP 字面量；
- 禁止 `localhost`、`.localhost`、`.local`、`.internal` 等本地名称；
- 规范化尾部斜杠后保存；
- 上游请求禁止跟随重定向；
- 所有请求只由服务端发起，浏览器永远接触不到已保存的完整 Key。

自定义 Key 只做长度、控制字符和空白校验，不强制 `sk-` 前缀，以兼容不同中转站。Key 使用现有 `TOKEN_ENCRYPTION_KEY` 进行 AES-GCM 加密。错误、日志和 API 响应不得包含完整 Key、Authorization 头、完整上游响应或文稿正文。

界面明确告知用户：所选文稿和梳理框架会发送到当前默认第三方 API，用户应自行确认供应商的数据处理政策。

## 8. 错误处理与用量一致性

统一映射以下错误：

- 未配置或默认提供商失效：400；
- Base URL、模型、格式或 Key 输入无效：400；
- 上游 401/403：凭据错误，400；
- 上游 402/429：余额或限流，保留相应状态；
- 上游 5xx 或格式不兼容：502；
- 超时：504；
- 空文本输出：502。

错误信息包含当前提供商名称，帮助用户定位配置，但不暴露秘密。生成失败继续沿用现有用量退款与分析任务 lease 释放逻辑。系统不会在失败后自动调用另一提供商。

## 9. 向后兼容与改动边界

- 现有 DeepSeek 用户无需重新输入 Key。
- 现有分析结果、Markdown 文件、来源哈希与过期判断保持可读。
- 每日导入与 AI 限额、单用户并发生成限制保持不变。
- 文稿、框架、账户、小宇宙验证码与部署网关相关 API 不改变。
- UI 只修改 AI 设置弹窗、顶部 AI 状态按钮和首次设置引导中的 AI 文案。
- 现有生成提示词、长文拆分阈值、最多三路并发和 400,000 字上限不改变。

## 10. 测试与验收

### 10.1 自动测试

- 数据迁移保留既有 DeepSeek 密文、时间与历史分析记录；
- 每用户可同时保存两个连接，且默认值切换规则正确；
- URL 校验覆盖 HTTPS、用户信息、查询参数、fragment、IP、本机名称与重定向；
- DeepSeek 请求保持原有字段；
- Responses 请求映射、可选 reasoning 和文本提取正确；
- Chat Completions 请求映射与文本提取正确；
- 各类上游错误映射、用量退款和 lease 释放正确；
- API 永不返回明文 Key；
- 所有现有测试继续通过。

### 10.2 完整验证

实施结束前必须执行：

```bash
npm run lint
npx tsc --noEmit
npm test
```

`npm test` 已包含生产构建；任何失败都必须修复或明确报告，不能以静态检查代替。

### 10.3 网页端试用

完成验证后启动本地开发服务器，并在应用内浏览器打开可操作页面。试用应至少验证：

1. 原有首页、文稿库、框架和账户入口仍可打开；
2. DeepSeek 配置仍可保存、显示脱敏提示和设为默认；
3. 自定义 API 可手动配置，Codex 中转预设只填入模型、格式和推理强度，Base URL 与 Key 仍须手动填写；
4. 两种连接可以切换默认并删除；
5. 页面不显示已保存的完整 Key；
6. 用户在网页中自行填写真实 Key 后，可通过对应兼容服务执行实际生成。

真实小宇宙导入和实际 AI 生成仍依赖用户自己的账号、Key、外部服务余额以及本地/部署环境绑定；这些凭据不会写入仓库或对话。

## 11. 完成标准

- 规格中的数据库、API、服务层和 UI 行为全部实现；
- 现有功能无回归；
- 自动验证全部通过；
- 本地网页已启动并交付可点击试用地址；
- 没有真实密钥、Cookie、令牌、文稿正文或数据库导出进入版本控制。
