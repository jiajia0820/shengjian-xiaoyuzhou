# 声笺

一个 owner-only 的小宇宙官方文稿 Markdown 私有库。连接小宇宙账号后，粘贴带官方字幕的单集链接，即可提取、预览、编辑、复制和下载文稿，并按自定义框架生成内容梳理与单集专属学习 Prompt。

## 边界

- 只读取小宇宙已经生成的官方文稿
- 不下载音频，不执行 AI 语音转写
- 无官方字幕时给出明确提示
- 原始稿与工作稿分开保存，重新获取不会覆盖编辑稿
- 所有 AI 任务均由用户手动触发，可临时选择官方原稿或当前编辑稿
- 系统样本框架只读；可复制、创建并维护最多 50 份个性化 Markdown 框架
- 分析结果记录来源哈希；文稿变化后只提示过期，不自动消耗 AI 额度
- 超过 180,000 字时分段提炼，最多三路并发、最多处理 400,000 字

## 技术结构

- Sites + vinext
- D1：账号连接、文稿索引、梳理框架与分析结果索引
- R2：每期的 `original.md`、`current.md`、内容梳理与学习 Prompt
- AES-GCM：服务端加密 access token 与 refresh token
- DeepSeek Chat Completions API：V4 Flash，关闭思考模式，不启用联网工具
- DeepSeek API Key 由用户在私有站点内填写，使用 AES-GCM 加密后存入 D1
- Sites 登录用户头：所有 API 的所有权隔离

## 本地验证

```bash
npm install
npm run lint
npx tsc --noEmit
npm test
```

完整的 Workers 本地运行需要 D1、R2 和 `TOKEN_ENCRYPTION_KEY`。生产环境由 Sites 根据 `.openai/hosting.json` 和迁移文件自动配置。

## 环境变量

- `TOKEN_ENCRYPTION_KEY`：至少 32 字节的随机密钥；在 Sites 中必须标记为 Secret
- DeepSeek API Key 不使用环境变量；登录站点后在“设置 DeepSeek”中加密保存

## 数据迁移

Drizzle 迁移位于 `drizzle/`。修改 `db/schema.ts` 后运行：

```bash
npm run db:generate
```

## 从 GitHub 复现

1. 使用 Node.js 22.13 或更高版本克隆仓库并运行 `npm ci`。
2. 复制 `.env.example` 为本地环境变量配置，生成随机的 `TOKEN_ENCRYPTION_KEY`；不要把真实密钥提交到 Git。
3. 准备 D1、R2、Supabase 和腾讯云验证码配置，并按 `deploy/tencent-hk/` 中的说明配置网关。
4. 执行 `npm run lint`、`npx tsc --noEmit` 和 `npm test`。
5. 生产环境推荐使用 Sites/Cloudflare Workers 运行时；本项目依赖 D1、R2 和 Workers 绑定，不能仅通过 GitHub Pages 运行。

### 安全边界

本仓库只包含可复现源码、迁移文件和配置模板。每位部署者必须使用自己的小宇宙账号、DeepSeek API Key、Supabase/Tencent Cloud 凭据和存储资源。不要把 `.env`、访问令牌、Cookie、数据库导出或文稿正文提交到仓库。