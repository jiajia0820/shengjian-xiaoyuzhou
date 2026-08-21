import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAnalysisMarkdown, splitForAnalysis } from "../lib/analysis-format.ts";
import { SYSTEM_FRAMEWORK, validateFrameworkInput } from "../lib/frameworks.ts";
import { buildMarkdown, formatTimestamp, shownotesToMarkdown } from "../lib/markdown.ts";
import { decryptSecret, encryptSecret, phoneHint, sha256Hex } from "../lib/security.ts";
import { parseEpisodeUrl, XiaoyuzhouError } from "../lib/xiaoyuzhou.ts";
import { isAllowedOrigin, parseCookieHeader, serializeCookie } from "../lib/request-security-core.ts";
import { anonymousTokenHash, createAnonymousToken } from "../lib/anonymous-auth-core.ts";
import { buildCustomModelRequest, normalizeCustomBaseUrl, requestCustomModel } from "../lib/ai-provider.ts";
import type { DeepseekAiRuntimeConfig } from "../lib/ai-provider.ts";
import { HttpError } from "../lib/http-error.ts";

test("defines multi-provider AI persistence and a data-preserving migration", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /import \{[^}]*primaryKey/);
  assert.match(schema, /export const aiPreferences = sqliteTable\("ai_preferences"/);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.userId, table\.provider\] \}\)/);
  assert.match(schema, /apiFormat: text\("api_format"\)\.notNull\(\)/);
  assert.match(schema, /baseUrl: text\("base_url"\)/);

  const migration = await readFile(new URL("../drizzle/0006_custom_ai_providers.sql", import.meta.url), "utf8");
  assert.match(migration, /INSERT INTO `__new_ai_settings`/);
  assert.match(migration, /'deepseek'/);
  assert.match(migration, /ADD `provider` text DEFAULT 'deepseek' NOT NULL/);
  assert.match(migration, /ADD `api_format` text DEFAULT 'chat_completions' NOT NULL/);
});

test("uses provider-aware records, queries, and public analysis metadata", async () => {
  const source = await readFile(new URL("../lib/db.ts", import.meta.url), "utf8");
  assert.match(source, /provider: AiProvider;\s*api_format: AiApiFormat;/);
  assert.match(source, /base_url: string \| null;\s*model: string;\s*reasoning_effort: ReasoningEffort \| null;/);
  assert.match(source, /export type AiPreferenceRecord = \{\s*user_id: string;\s*active_provider: AiProvider \| null;/);
  assert.match(source, /export async function getAiSettings\(userId: string\)/);
  assert.match(source, /export async function getAiSetting\(userId: string, provider: AiProvider\)/);
  assert.match(source, /ON CONFLICT\(user_id, provider\)/);
  assert.match(source, /export async function getAiPreference\(userId: string\)/);
  assert.match(source, /export async function setAiPreference\(userId: string, provider: AiProvider \| null\)/);
  assert.match(source, /export async function deleteAiSetting\(userId: string, provider: AiProvider\)/);
  assert.match(source, /PRAGMA table_info\(ai_settings\)/);
  assert.match(source, /ALTER TABLE analysis_results ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek'/);
  assert.match(source, /provider: record\.provider,\s*apiFormat: record\.api_format/);
});

test("normalizes a safe custom API root", () => {
  assert.equal(normalizeCustomBaseUrl(" https://relay.example/v1/ "), "https://relay.example/v1");
});

test("rejects unsafe custom API roots", () => {
  for (const value of [
    "http://relay.example/v1",
    "https://name:pass@relay.example/v1",
    "https://relay.example/v1?token=secret",
    "https://relay.example/v1?",
    "https://relay.example/v1#fragment",
    "https://relay.example/v1#",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://localhost./v1",
    "https://api.internal/v1",
  ]) assert.throws(() => normalizeCustomBaseUrl(value));
});

test("maps a custom Responses request with selected reasoning effort", () => {
  assert.deepEqual(buildCustomModelRequest({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }), {
    url: "https://relay.example/v1/responses",
    body: {
      model: "gpt-5.6-luna", instructions: "system rules", input: "document",
      max_output_tokens: 1600, reasoning: { effort: "medium" },
    },
  });
});

test("maps a custom Chat Completions request without DeepSeek thinking", () => {
  assert.deepEqual(buildCustomModelRequest({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "chat_completions", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }), {
    url: "https://relay.example/v1/chat/completions",
    body: {
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "document" },
      ],
      stream: false,
      max_tokens: 1600,
    },
  });
});

test("sends a custom Responses request without following redirects", async () => {
  const response = await requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async (url, init) => {
    assert.equal(String(url), "https://relay.example/v1/responses");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer relay-key");
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "## Result" }] }],
    });
  });
  assert.equal(response.text, "## Result");
  assert.equal(response.provider, "custom");
  assert.equal(response.apiFormat, "responses");
  assert.equal(response.model, "gpt-5.6-luna");
});

test("reads a custom Chat Completions response without a DeepSeek thinking field", async () => {
  const response = await requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "chat_completions", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async (url, init) => {
    assert.equal(String(url), "https://relay.example/v1/chat/completions");
    assert.equal(init?.redirect, "manual");
    assert.equal(JSON.stringify(init?.body).includes("thinking"), false);
    return Response.json({ choices: [{ message: { content: "## Result" } }] });
  });
  assert.equal(response.text, "## Result");
  assert.equal(response.apiFormat, "chat_completions");
});

test("maps a custom API credential rejection without leaking its key", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => new Response("unauthorized", { status: 401 })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "AI_CREDENTIAL_ERROR");
    assert.doesNotMatch(error.message, /relay-key/);
    return true;
  });
});

test("maps a custom API forbidden response to a credential error", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => new Response("forbidden", { status: 403 })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "AI_CREDENTIAL_ERROR");
    assert.doesNotMatch(error.message, /relay-key/);
    return true;
  });
});

test("preserves a custom API rate-limit status", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => new Response("limited", { status: 429 })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "AI_RATE_LIMITED");
    return true;
  });
});

test("maps custom API redirects and upstream failures to a safe gateway error", async () => {
  for (const status of [302, 500]) {
    await assert.rejects(requestCustomModel({
      provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
      model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => new Response(null, { status })), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "AI_UPSTREAM_ERROR");
      return true;
    });
  }
});

test("rejects an empty custom API response", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => Response.json({ output: [] })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AI_EMPTY_OUTPUT");
    return true;
  });
});

test("maps a custom API timeout to a gateway timeout", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => {
    throw new DOMException("timed out", "AbortError");
  }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 504);
    assert.equal(error.code, "AI_TIMEOUT");
    return true;
  });
});

test("maps a custom API network failure to a safe gateway error", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => {
    throw new Error("connection refused");
  }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AI_UPSTREAM_ERROR");
    assert.doesNotMatch(error.message, /relay-key|connection refused/);
    return true;
  });
});

test("dispatches DeepSeek through its SDK configuration with thinking disabled", async () => {
  const aiProvider = await import("../lib/ai-provider.ts");
  assert.equal(typeof aiProvider.executeModelRequest, "function");

  const deepseekConfig = {
    provider: "deepseek",
    apiKey: "deepseek-key",
    baseUrl: null,
    model: "deepseek-v4-flash",
    apiFormat: "chat_completions",
    reasoningEffort: null,
  } satisfies DeepseekAiRuntimeConfig;
  let clientOptions: unknown;
  let modelRequest: unknown;
  const response = await aiProvider.executeModelRequest(deepseekConfig, {
    instructions: "system rules",
    input: "document",
    maxOutputTokens: 1600,
  }, {
    createDeepseekClient: async (options) => {
      clientOptions = options;
      return {
        chat: {
          completions: {
            create: async (request) => {
              modelRequest = request;
              return { choices: [{ message: { content: "```markdown\n## Result\n```" } }] };
            },
          },
        },
      };
    },
  });

  assert.deepEqual(clientOptions, {
    apiKey: "deepseek-key",
    baseURL: "https://api.deepseek.com",
    timeout: 120_000,
    maxRetries: 1,
  });
  assert.deepEqual(modelRequest, {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "document" },
    ],
    stream: false,
    max_tokens: 1600,
    thinking: { type: "disabled" },
  });
  assert.deepEqual(response, {
    text: "## Result",
    provider: "deepseek",
    apiFormat: "chat_completions",
    model: "deepseek-v4-flash",
  });
});

test("accepts only canonical Xiaoyuzhou episode links", () => {
  assert.deepEqual(
    parseEpisodeUrl("https://www.xiaoyuzhoufm.com/episode/6a7e91ff36641f136d8807ab?utm_source=share"),
    {
      eid: "6a7e91ff36641f136d8807ab",
      canonicalUrl: "https://www.xiaoyuzhoufm.com/episode/6a7e91ff36641f136d8807ab",
    },
  );
  assert.throws(() => parseEpisodeUrl("https://example.com/episode/6a7e91ff36641f136d8807ab"), XiaoyuzhouError);
  assert.throws(() => parseEpisodeUrl("http://www.xiaoyuzhoufm.com/episode/6a7e91ff36641f136d8807ab"), XiaoyuzhouError);
});

test("formats timestamped Markdown without rewriting transcript text", () => {
  const markdown = buildMarkdown({
    eid: "6a7e91ff36641f136d8807ab",
    title: "测试：谈钱，但不只是钱",
    podcastTitle: "知行小酒馆",
    shownotesHtml: "<p>第一段<br>第二行</p><ul><li>要点 &amp; 链接</li></ul>",
    durationSeconds: 3723,
    publishedAt: "2025-08-28T00:00:00.000Z",
    mediaId: "media.m4a",
  }, "https://www.xiaoyuzhoufm.com/episode/6a7e91ff36641f136d8807ab", [
    { startMs: 0, text: "原话一字不改。" },
    { startMs: 3_723_000, text: "第二段原话。" },
  ], "2026-08-15T00:00:00.000Z");
  assert.match(markdown, /segment_count: 2/);
  assert.match(markdown, /\[00:00:00\] 原话一字不改。/);
  assert.match(markdown, /\[01:02:03\] 第二段原话。/);
  assert.match(markdown, /第一段\n第二行/);
  assert.equal(formatTimestamp(3_723_999), "01:02:03");
  assert.equal(shownotesToMarkdown("<p>A &amp; B</p>"), "A & B");
});

test("encrypts credentials and produces stable privacy helpers", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = await encryptSecret("secret-token", key);
  assert.notEqual(encrypted, "secret-token");
  assert.equal(await decryptSecret(encrypted, key), "secret-token");
  assert.equal(phoneHint("13800138000"), "•••• 8000");
  assert.equal(await sha256Hex("same"), await sha256Hex("same"));
  await assert.rejects(() => decryptSecret(encrypted, Buffer.alloc(32, 8).toString("base64")));
});

test("validates reusable Markdown analysis frameworks", () => {
  assert.match(SYSTEM_FRAMEWORK.instructions, /一句话主旨/);
  assert.match(SYSTEM_FRAMEWORK.instructions, /AI 归纳/);
  const valid = validateFrameworkInput({
    name: "  投资研究  ",
    instructions: "# 目标\n\n" + "关注论据、风险和反例。".repeat(12),
  });
  assert.equal(valid.name, "投资研究");
  assert.throws(() => validateFrameworkInput({ name: "", instructions: "a".repeat(100) }));
  assert.throws(() => validateFrameworkInput({ name: "太短", instructions: "a".repeat(99) }));
  assert.throws(() => validateFrameworkInput({ name: "过长", instructions: "a".repeat(20_001) }));
});

test("splits long transcripts without dropping content", () => {
  const paragraph = "播客内容".repeat(25_000);
  const source = `${paragraph}\n\n${paragraph}\n\n结尾`;
  const chunks = splitForAnalysis(source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 50_000));
  assert.equal(chunks.join("").replaceAll("\n", ""), source.replaceAll("\n", ""));
});

test("adds server-owned frontmatter to AI Markdown", () => {
  const markdown = buildAnalysisMarkdown({
    episode: {
      id: 1, user_id: "owner", eid: "episode-id", source_url: "https://www.xiaoyuzhoufm.com/episode/episode-id",
      title: "如何建立统计直觉", podcast_title: "样本播客", published_at: null, duration_seconds: 3600,
      segment_count: 20, original_key: "original.md", current_key: "current.md", original_hash: "original",
      content_hash: "current", created_at: "2026-08-15T00:00:00.000Z", updated_at: "2026-08-15T00:00:00.000Z",
    },

    kind: "summary", sourceType: "current", sourceHash: "abc123",
    generatedAt: "2026-08-15T01:00:00.000Z", body: "## 一句话主旨\n\n建立统计直觉。",
    frameworkId: SYSTEM_FRAMEWORK.id, frameworkName: SYSTEM_FRAMEWORK.name,
  });
  assert.match(markdown, /result_type: "summary"/);
  assert.match(markdown, /analysis_source: "current"/);
  assert.match(markdown, /model: "deepseek-v4-flash"/);
  assert.match(markdown, /# 如何建立统计直觉｜内容梳理/);
});

test("builds secure same-origin cookies and rejects foreign origins", () => {
  assert.deepEqual(parseCookieHeader("sj_access=abc.def; sj_csrf=hello%20world"), {
    sj_access: "abc.def",
    sj_csrf: "hello world",
  });
  const cookie = serializeCookie({ name: "sj_access", value: "token", maxAge: 3600, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(isAllowedOrigin("https://notes.example.com", "notes.example.com", "notes.example.com"), true);
  assert.equal(isAllowedOrigin("https://evil.example", "notes.example.com", "notes.example.com"), false);
  assert.equal(isAllowedOrigin(null, "notes.example.com", "notes.example.com"), false);
});
test("creates isolated opaque tokens for anonymous browser accounts", async () => {
  const first = createAnonymousToken();
  const second = createAnonymousToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(await anonymousTokenHash(first), await anonymousTokenHash(first));
  assert.notEqual(await anonymousTokenHash(first), first);
  assert.notEqual(await anonymousTokenHash(first), await anonymousTokenHash(second));
});
