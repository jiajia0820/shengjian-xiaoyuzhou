import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisMarkdown, splitForAnalysis } from "../lib/analysis-format.ts";
import { SYSTEM_FRAMEWORK, validateFrameworkInput } from "../lib/frameworks.ts";
import { buildMarkdown, formatTimestamp, shownotesToMarkdown } from "../lib/markdown.ts";
import { decryptSecret, encryptSecret, phoneHint, sha256Hex } from "../lib/security.ts";
import { parseEpisodeUrl, XiaoyuzhouError } from "../lib/xiaoyuzhou.ts";
import { isAllowedOrigin, parseCookieHeader, serializeCookie } from "../lib/request-security-core.ts";
import { anonymousTokenHash, createAnonymousToken } from "../lib/anonymous-auth-core.ts";

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
