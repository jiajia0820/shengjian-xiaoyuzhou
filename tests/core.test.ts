import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { buildAnalysisMarkdown, splitForAnalysis } from "../lib/analysis-format.ts";
import { SYSTEM_FRAMEWORK, validateFrameworkInput } from "../lib/frameworks.ts";
import { buildMarkdown, formatTimestamp, shownotesToMarkdown } from "../lib/markdown.ts";
import { decryptSecret, encryptSecret, phoneHint, sha256Hex } from "../lib/security.ts";
import {
  getOfficialEpisode,
  loginWithSms,
  parseEpisodeUrl,
  sendSmsCode,
  XiaoyuzhouError,
} from "../lib/xiaoyuzhou.ts";
import {
  buildSmsCodeRequestBody,
  normalizeXiaoyuzhouCaptcha,
  withTimeout,
} from "../lib/xiaoyuzhou-auth.ts";
import { isAllowedOrigin, parseCookieHeader, serializeCookie } from "../lib/request-security-core.ts";
import { anonymousTokenHash, createAnonymousToken } from "../lib/anonymous-auth-core.ts";
import {
  buildCustomModelRequest,
  normalizeCustomBaseUrl,
  requestCustomModel,
  requestDeepseekModel,
  resolveHostnameViaDoh,
} from "../lib/ai-provider.ts";
import type { DeepseekAiRuntimeConfig } from "../lib/ai-provider.ts";
import { HttpError } from "../lib/http-error.ts";

type SqliteRow = Record<string, unknown>;

class SqliteD1Statement {
  private readonly database: DatabaseSync;
  private readonly query: string;
  private readonly values: SQLInputValue[];

  constructor(
    database: DatabaseSync,
    query: string,
    values: SQLInputValue[] = [],
  ) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: SQLInputValue[]) {
    return new SqliteD1Statement(this.database, this.query, values);
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values) as { changes?: number | bigint };
    return { meta: { changes: Number(result.changes ?? 0) } };
  }

  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values) as SqliteRow | undefined;
    return row ? Object.fromEntries(Object.entries(row)) as T : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.database.prepare(this.query).all(...this.values) as SqliteRow[];
    return { results: rows.map((row) => Object.fromEntries(Object.entries(row)) as T) };
  }
}

class SqliteD1Database {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

declare global {
  var __aiProviderTestEnv: {
    DB: SqliteD1Database;
    TOKEN_ENCRYPTION_KEY?: string;
    XIAOYUZHOU_DEV_PROXY_URL?: string;
    XIAOYUZHOU_DEV_PROXY_TOKEN?: string;
  } | undefined;
  var __analysisGenerateRouteTestDeps: Record<string, Record<string, unknown>> | undefined;
}

function routeMockModule(specifier: string): string | undefined {
  if (!globalThis.__analysisGenerateRouteTestDeps) return undefined;
  const exports: Record<string, string> = {
    "@/lib/analysis": "buildAnalysisMarkdown,generateAnalysisBody",
    "@/lib/ai-settings": "readActiveAiConfiguration",
    "@/lib/db": "acquireAnalysisLease,consumeUsage,getEpisodeRecord,getFramework,publicAnalysis,refundUsage,releaseAnalysisLease,setOriginalHash,touchCurrentDocument,upsertAnalysisResult",
    "@/lib/documents": "analysisDocumentKey,documentKeys,putJson,putMarkdown,readJson,readMarkdown",
    "@/lib/frameworks": "frameworkForAnalysis,SYSTEM_FRAMEWORK_ID",
    "@/lib/security": "sha256Hex",
    "@/lib/user": "apiError,HttpError,requireApiUser",
    "@/lib/transcript-artifact": "isSpeakerEngine,parseTranscriptArtifact",
    "@/lib/transcript-speakers": "alignTranscriptSpeakers,applySpeakerOverrides,normalizeDiarizationTurns,normalizeSpeakerLabels,SpeakerInputError",
    "@/lib/speaker-markdown": "renderSpeakerMarkdown",
  };
  const names = exports[specifier];
  if (!names) return undefined;
  const source = names.split(",").map((name) => (
    name === "HttpError" || name === "SYSTEM_FRAMEWORK_ID" || name === "SpeakerInputError"
      ? `export const ${name} = globalThis.__analysisGenerateRouteTestDeps[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`
      : `export const ${name} = (...args) => globalThis.__analysisGenerateRouteTestDeps[${JSON.stringify(specifier)}][${JSON.stringify(name)}](...args);`
  )).join("\n");
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const env = globalThis.__aiProviderTestEnv;",
      };
    }
    const mockUrl = routeMockModule(specifier);
    if (mockUrl) return { shortCircuit: true, url: mockUrl };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

test("only resolves analysis route mocks while their dependencies are active", () => {
  const previous = globalThis.__analysisGenerateRouteTestDeps;
  try {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
    assert.equal(routeMockModule("@/lib/analysis"), undefined);
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = previous;
  }
});

function createLegacyAiDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE ai_settings (
    user_id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL,
    key_hint TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    eid TEXT NOT NULL,
    slot TEXT NOT NULL,
    kind TEXT NOT NULL,
    framework_id TEXT,
    framework_name TEXT,
    framework_snapshot TEXT,
    source_type TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    result_key TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  database.prepare(`INSERT INTO ai_settings
    (user_id, provider, api_key_cipher, key_hint, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("owner", "deepseek", "legacy-cipher", "•••• 1234", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  database.prepare(`INSERT INTO analysis_results
    (user_id, eid, slot, kind, framework_id, framework_name, framework_snapshot,
     source_type, source_hash, model, result_key, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("owner", "episode", "summary", "summary", null, null, null,
      "current", "legacy-hash", "deepseek-v4-flash", "legacy-result", "2026-01-03T00:00:00.000Z");
  return database;
}

function applyCustomAiMigration(database: DatabaseSync, migration: string) {
  for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    database.exec(statement);
  }
}

function row<T extends SqliteRow>(database: DatabaseSync, query: string, ...values: SQLInputValue[]): T | null {
  const value = database.prepare(query).get(...values) as SqliteRow | undefined;
  return value ? Object.fromEntries(Object.entries(value)) as T : null;
}

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
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `ai_settings_runtime`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `analysis_results_runtime`/);
  assert.match(migration, /INSERT INTO `__new_analysis_results`/);
  assert.match(migration, /DROP TABLE `ai_settings_runtime`/);
  assert.match(migration, /DROP TABLE `analysis_results_runtime`/);
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
  assert.match(source, /ai_settings_runtime/);
  assert.match(source, /analysis_results_runtime/);
  assert.match(source, /ai_provider_schema/);
  assert.match(source, /provider: record\.provider,\s*apiFormat: record\.api_format/);
});

test("migrates legacy provider data in order without changing saved values", async () => {
  const migration = await readFile(new URL("../drizzle/0006_custom_ai_providers.sql", import.meta.url), "utf8");
  const database = createLegacyAiDatabase();
  applyCustomAiMigration(database, migration);

  assert.deepEqual(row(database, `SELECT user_id, provider, api_format, base_url, model, reasoning_effort,
    api_key_cipher, key_hint, connected_at, updated_at FROM ai_settings`), {
    user_id: "owner", provider: "deepseek", api_format: "chat_completions", base_url: null,
    model: "deepseek-v4-flash", reasoning_effort: null, api_key_cipher: "legacy-cipher",
    key_hint: "•••• 1234", connected_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z",
  });
  assert.deepEqual(row(database, "SELECT user_id, active_provider, updated_at FROM ai_preferences"), {
    user_id: "owner", active_provider: "deepseek", updated_at: "2026-01-03T00:00:00.000Z",
  });
  assert.deepEqual(row(database, "SELECT provider, api_format FROM analysis_results WHERE id = 1"), {
    provider: "deepseek", api_format: "chat_completions",
  });
});

test("preserves runtime-staged data and refreshes a warm runtime when 0006 runs later", async () => {
  const migration = await readFile(new URL("../drizzle/0006_custom_ai_providers.sql", import.meta.url), "utf8");
  const database = createLegacyAiDatabase();
  globalThis.__aiProviderTestEnv = { DB: new SqliteD1Database(database) };
  const db = await import(`../lib/db.ts?runtime-migration-${crypto.randomUUID()}`);
  await db.ensureSchema();
  await db.saveAiSetting({
    user_id: "owner", provider: "custom", api_format: "responses", base_url: "https://relay.example/v1",
    model: "gpt-5.6-luna", reasoning_effort: "high", api_key_cipher: "custom-cipher", key_hint: "•••• 9876",
    connected_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-02T00:00:00.000Z",
  });
  await db.setAiPreference("owner", "custom");
  await db.upsertAnalysisResult({
    user_id: "owner", eid: "episode", slot: "summary", kind: "summary", framework_id: null,
    framework_name: null, framework_snapshot: null, source_type: "current", source_hash: "custom-hash",
    model: "gpt-5.6-luna", provider: "custom", api_format: "responses", result_key: "custom-result",
    generated_at: "2026-02-02T00:00:00.000Z",
  });

  assert.doesNotThrow(() => applyCustomAiMigration(database, migration));
  assert.deepEqual(database.prepare("SELECT provider FROM ai_settings WHERE user_id = ? ORDER BY provider")
    .all("owner").map((value) => Object.fromEntries(Object.entries(value))), [
      { provider: "custom" },
      { provider: "deepseek" },
    ]);
  assert.deepEqual(row(database, "SELECT api_format, base_url, model, reasoning_effort, api_key_cipher, key_hint FROM ai_settings WHERE user_id = ? AND provider = ?", "owner", "custom"), {
    api_format: "responses", base_url: "https://relay.example/v1", model: "gpt-5.6-luna",
    reasoning_effort: "high", api_key_cipher: "custom-cipher", key_hint: "•••• 9876",
  });
  assert.deepEqual(row(database, "SELECT active_provider FROM ai_preferences WHERE user_id = ?", "owner"), {
    active_provider: "custom",
  });
  assert.deepEqual(row(database, "SELECT provider, api_format, model, result_key FROM analysis_results WHERE id = 1"), {
    provider: "custom", api_format: "responses", model: "gpt-5.6-luna", result_key: "custom-result",
  });
  assert.equal(row(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_settings_runtime'"), null);
  assert.equal(row(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_results_runtime'"), null);

  await db.saveAiSetting({
    user_id: "owner", provider: "custom", api_format: "responses", base_url: "https://relay.example/v1",
    model: "gpt-5.6-sol", reasoning_effort: "high", api_key_cipher: "custom-cipher", key_hint: "•••• 9876",
    connected_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z",
  });
  assert.equal((await db.getAiSetting("owner", "custom"))?.model, "gpt-5.6-sol");

  await db.upsertAnalysisResult({
    user_id: "owner", eid: "episode", slot: "summary", kind: "summary", framework_id: null,
    framework_name: null, framework_snapshot: null, source_type: "current", source_hash: "custom-hash",
    model: "gpt-5.6-sol", provider: "custom", api_format: "responses", result_key: "post-migration-result",
    generated_at: "2026-03-01T00:00:00.000Z",
  });
  assert.deepEqual(await db.getAnalysisResult("owner", "episode", "summary"), {
    id: 1, user_id: "owner", eid: "episode", slot: "summary", kind: "summary", framework_id: null,
    framework_name: null, framework_snapshot: null, source_type: "current", source_hash: "custom-hash",
    model: "gpt-5.6-sol", provider: "custom", api_format: "responses", result_key: "post-migration-result",
    generated_at: "2026-03-01T00:00:00.000Z",
  });
});

test("normalizes a safe custom API root", () => {
  assert.equal(normalizeCustomBaseUrl(" https://relay.example/v1/ "), "https://relay.example/v1");
});

test("enables strict public routing for global Worker fetches", async () => {
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(
    viteConfig,
    /compatibility_flags:\s*\[\s*"nodejs_compat",\s*"global_fetch_strictly_public"\s*\]/,
  );
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
    "https://intranet/v1",
    "https://router/v1",
    "https://api.lan/v1",
    "https://service.home.arpa/v1",
    "https://api.private/v1",
    "https://api.intranet/v1",
    "https://service.localdomain/v1",
    "https://hidden-service.onion/v1",
    "https://api.internal/v1",
  ]) assert.throws(() => normalizeCustomBaseUrl(value));
});

const PUBLIC_HOST_RESOLVER = async () => ["93.184.216.34"];

test("validates a clean custom AI configuration and rejects unsafe custom keys", async () => {
  const settings = await import("../lib/ai-settings.ts");
  assert.equal(typeof settings.validateCustomAiInput, "function");
  assert.deepEqual(settings.validateCustomAiInput({
    apiKey: "relay-token-1234",
    baseUrl: " https://relay.example/v1/ ",
    model: "  gpt-5.6-luna  ",
    apiFormat: "responses",
    reasoningEffort: "high",
  }), {
    apiKey: "relay-token-1234",
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: "high",
  });
  assert.deepEqual(settings.validateCustomAiInput({
    apiKey: "chat-token-4321",
    baseUrl: "https://relay.example/v1",
    model: "chat-model",
    apiFormat: "chat_completions",
    reasoningEffort: null,
  }), {
    apiKey: "chat-token-4321",
    baseUrl: "https://relay.example/v1",
    model: "chat-model",
    apiFormat: "chat_completions",
    reasoningEffort: null,
  });

  for (const body of [
    {
      apiKey: "has whitespace",
      baseUrl: "https://relay.example/v1",
      model: "model",
      apiFormat: "responses",
      reasoningEffort: null,
    },
    {
      apiKey: "relay-token-1234",
      baseUrl: "https://relay.example/v1",
      model: "model",
      apiFormat: "chat_completions",
      reasoningEffort: "low",
    },
    {
      apiKey: "relay-token-1234",
      baseUrl: "https://relay.example/v1",
      model: "model",
      apiFormat: "responses",
      reasoningEffort: "maximum",
    },
  ]) assert.throws(() => settings.validateCustomAiInput(body), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.doesNotMatch(error.message, /has whitespace|relay-token-1234/);
    return true;
  });
});

test("keeps custom API key validation strict at its eight-character floor", async () => {
  const settings = await import("../lib/ai-settings.ts");
  const validCustomFields = {
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: null,
  };
  for (const apiKey of ["", "1234567", "has whitespace", "safe\u0000key", "x".repeat(501)]) {
    assert.throws(() => settings.validateCustomAiInput({ apiKey, ...validCustomFields }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "INVALID_CUSTOM_AI_KEY");
      return true;
    });
  }
});

test("normalizes an omitted custom Responses reasoning effort to null", async () => {
  const settings = await import("../lib/ai-settings.ts");
  assert.deepEqual(settings.validateCustomAiInput({
    apiKey: "relay-token-1234",
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
  }), {
    apiKey: "relay-token-1234",
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: null,
  });
});

test("stores provider configurations without exposing credentials and preserves the chosen default", async () => {
  const database = new DatabaseSync(":memory:");
  const testKey = Buffer.alloc(32, 9).toString("base64");
  if (globalThis.__aiProviderTestEnv) {
    globalThis.__aiProviderTestEnv.DB = new SqliteD1Database(database);
    globalThis.__aiProviderTestEnv.TOKEN_ENCRYPTION_KEY = testKey;
  } else {
    globalThis.__aiProviderTestEnv = {
      DB: new SqliteD1Database(database),
      TOKEN_ENCRYPTION_KEY: testKey,
    };
  }
  const settings = await import("../lib/ai-settings.ts");
  const db = await import("../lib/db.ts");
  const runtime = await import("../lib/runtime.ts");
  assert.equal(typeof runtime.getRuntimeEnv().TOKEN_ENCRYPTION_KEY, "string");

  const customStatus = await settings.saveAiProvider("settings-owner", {
    provider: "custom",
    apiKey: "relay-token-1234",
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: "medium",
  });
  assert.equal(customStatus.defaultProvider, "custom");
  assert.deepEqual(customStatus.providers.deepseek, {
    provider: "deepseek",
    connected: false,
    model: "deepseek-v4-flash",
    apiFormat: "chat_completions",
    keyHint: null,
    connectedAt: null,
  });
  assert.deepEqual(customStatus.providers.custom, {
    provider: "custom",
    connected: true,
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: "medium",
    keyHint: "•••• 1234",
    connectedAt: customStatus.providers.custom.connectedAt,
  });
  assert.doesNotMatch(JSON.stringify(customStatus), /relay-token-1234|api_key_cipher|Authorization/);
  assert.deepEqual(await settings.readActiveAiConfiguration("settings-owner"), {
    provider: "custom",
    apiKey: "relay-token-1234",
    baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    apiFormat: "responses",
    reasoningEffort: "medium",
  });

  const deepseekStatus = await settings.saveAiProvider("settings-owner", {
    provider: "deepseek",
    apiKey: "sk-0123456789",
  });
  assert.equal(deepseekStatus.defaultProvider, "custom");
  assert.deepEqual(deepseekStatus.providers.deepseek, {
    provider: "deepseek",
    connected: true,
    model: "deepseek-v4-flash",
    apiFormat: "chat_completions",
    keyHint: "•••• 6789",
    connectedAt: deepseekStatus.providers.deepseek.connectedAt,
  });
  assert.deepEqual(JSON.parse((await db.getAiSetting("settings-owner", "deepseek"))?.key_hint ?? ""), {
    version: 1,
    length: "sk-0123456789".length,
    suffix: "6789",
  });
  await assert.rejects(
    () => settings.saveAiProvider("settings-owner", { provider: "deepseek", apiKey: "sk-0123456789", model: "ignored" }),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_AI_PROVIDER_INPUT",
  );

  const switchedStatus = await settings.setDefaultAiProvider("settings-owner", "deepseek");
  assert.equal(switchedStatus.defaultProvider, "deepseek");
  assert.deepEqual(await settings.readActiveAiConfiguration("settings-owner"), {
    provider: "deepseek",
    apiKey: "sk-0123456789",
    baseUrl: null,
    model: "deepseek-v4-flash",
    apiFormat: "chat_completions",
    reasoningEffort: null,
  });
  await assert.rejects(
    () => settings.setDefaultAiProvider("unconfigured-owner", "custom"),
    (error: unknown) => error instanceof HttpError && error.code === "AI_PROVIDER_NOT_CONNECTED",
  );

  const removedStatus = await settings.removeAiProvider("settings-owner", "deepseek");
  assert.equal(removedStatus.defaultProvider, "custom");
  assert.equal(removedStatus.providers.deepseek.connected, false);
  assert.equal(removedStatus.providers.custom.connected, true);

  await assert.rejects(
    () => settings.saveAiProvider("short-key-owner", {
      provider: "custom",
      apiKey: "abcd",
      baseUrl: "https://relay.example/v1",
      model: "gpt-5.6-luna",
      apiFormat: "responses",
      reasoningEffort: null,
    }),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_CUSTOM_AI_KEY",
  );
  assert.equal(await db.getAiSetting("short-key-owner", "custom"), null);

  await db.saveAiSetting({
    user_id: "legacy-key-owner",
    provider: "custom",
    api_format: "responses",
    base_url: "https://relay.example/v1",
    model: "gpt-5.6-luna",
    reasoning_effort: null,
    api_key_cipher: "legacy-cipher",
    key_hint: "•••• abcd",
    connected_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await db.setAiPreference("legacy-key-owner", "custom");
  const legacyStatus = await settings.getAiSettingsStatus("legacy-key-owner");
  assert.equal(legacyStatus.providers.custom.keyHint, "••••");
  assert.doesNotMatch(JSON.stringify(legacyStatus), /abcd/);

  const storedCustom = await db.getAiSetting("settings-owner", "custom");
  assert.ok(storedCustom);
  assert.deepEqual(JSON.parse(storedCustom.key_hint), {
    version: 1,
    length: "relay-token-1234".length,
    suffix: "1234",
  });
});

test("keeps AI provider settings routes safe and provider-aware", async () => {
  const service = await readFile(new URL("../lib/ai-settings.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/ai-settings/route.ts", import.meta.url), "utf8");
  const getRoute = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));

  assert.match(service, /export function validateCustomAiInput\(body: Record<string, unknown>\)/);
  assert.match(service, /export async function getAiSettingsStatus\(userId: string\)/);
  assert.match(service, /export async function saveAiProvider\(userId: string, body: Record<string, unknown>\)/);
  assert.match(service, /export async function setDefaultAiProvider\(userId: string, provider: AiProvider\)/);
  assert.match(service, /export async function removeAiProvider\(userId: string, provider: AiProvider\)/);
  assert.match(service, /export async function readActiveAiConfiguration\(userId: string\)/);
  assert.match(route, /export async function PATCH\(request: Request\)/);
  assert.match(route, /body\.provider/);
  assert.match(route, /setDefaultAiProvider\(/);
  assert.match(route, /requireApiUser\(\{ mutation: true \}\)/);
  assert.match(route, /export async function DELETE\(request: Request\)/);
  assert.match(route, /new URL\(request\.url\)/);
  assert.match(route, /removeAiProvider\(/);
  assert.match(getRoute, /getAiSettingsStatus\(user\.userId\)/);
  assert.doesNotMatch(getRoute, /apiKey|api_key_cipher|Authorization/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)/);
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
  let resolvedHostname = "";
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
  }, async (hostname) => {
    resolvedHostname = hostname;
    return ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  });
  assert.equal(resolvedHostname, "relay.example");
  assert.equal(response.text, "## Result");
  assert.equal(response.provider, "custom");
  assert.equal(response.apiFormat, "responses");
  assert.equal(response.model, "gpt-5.6-luna");
});

test("routes local custom model requests through the signed development proxy", async () => {
  const previousEnv = globalThis.__aiProviderTestEnv;
  const previousFetch = globalThis.fetch;
  const testEnv = previousEnv ?? { DB: new SqliteD1Database(new DatabaseSync(":memory:")) };
  const previousProxyUrl = testEnv.XIAOYUZHOU_DEV_PROXY_URL;
  const previousProxyToken = testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN;
  try {
    globalThis.__aiProviderTestEnv = testEnv;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = "http://127.0.0.1:4567/__xiaoyuzhou_upstream";
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = "local-proxy-token";
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, "http://127.0.0.1:4567/__xiaoyuzhou_upstream");
      assert.equal(request.headers.get("x-xiaoyuzhou-target"), "https://relay.example/v1/responses");
      assert.equal(request.headers.get("x-xiaoyuzhou-token"), "local-proxy-token");
      assert.equal(request.headers.get("authorization"), "Bearer relay-key");
      assert.equal(init?.redirect, "manual");
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "## Result" }] }],
      });
    };

    const response = await requestCustomModel({
      provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
      model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: "medium",
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, globalThis.fetch, PUBLIC_HOST_RESOLVER);
    assert.equal(response.text, "## Result");
  } finally {
    globalThis.fetch = previousFetch;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = previousProxyUrl;
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = previousProxyToken;
    globalThis.__aiProviderTestEnv = previousEnv;
  }
});

test("accepts safe HTTPS custom provider targets in the local proxy", async () => {
  const source = await readFile(new URL("../scripts/dev-upstream-proxy.mjs", import.meta.url), "utf8");
  assert.match(source, /export function isAllowedTarget/);
  assert.match(source, /hostname === "relay\.example"|isPublicHostname/);
  assert.match(source, /target\.protocol !== "https:"/);
  assert.match(source, /target\.username \|\| target\.password/);
  assert.match(source, /127\.0\.0\.1/);
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
  }, PUBLIC_HOST_RESOLVER);
  assert.equal(response.text, "## Result");
  assert.equal(response.apiFormat, "chat_completions");
});

test("maps a custom API credential rejection without leaking its key", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "relay-key", baseUrl: "https://relay.example/v1",
    model: "gpt-5.6-luna", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => new Response("unauthorized", { status: 401 }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
  }, async () => new Response("forbidden", { status: 403 }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
  }, async () => new Response("limited", { status: 429 }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
    }, async () => new Response(null, { status }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
  }, async () => Response.json({ output: [] }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
  }, PUBLIC_HOST_RESOLVER), (error: unknown) => {
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
  }, PUBLIC_HOST_RESOLVER), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AI_UPSTREAM_ERROR");
    assert.doesNotMatch(error.message, /relay-key|connection refused/);
    return true;
  });
});

test("does not trust or expose an HttpError thrown by a custom API fetch", async () => {
  await assert.rejects(requestCustomModel({
    provider: "custom", apiKey: "secret-sentinel", baseUrl: "https://api.public-provider.com/v1",
    model: "public-model", apiFormat: "responses", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => {
    throw new HttpError(418, "UPSTREAM_DETAILS", "secret-sentinel at https://api.public-provider.com/v1");
  }, PUBLIC_HOST_RESOLVER), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AI_UPSTREAM_ERROR");
    assert.doesNotMatch(error.message, /secret-sentinel|public-provider|UPSTREAM_DETAILS/);
    return true;
  });
});

test("rejects any non-public A or AAAA result before the custom API request", async () => {
  const unsafeAddresses = [
    "0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.0.2.1", "192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:10.0.0.1", "2001:db8::1",
    "3fff::1", "fc00::1", "fd00::1", "fe80::1", "ff02::1",
  ];
  for (const address of unsafeAddresses) {
    let providerRequested = false;
    await assert.rejects(requestCustomModel({
      provider: "custom", apiKey: "secret-sentinel", baseUrl: "https://api.public-provider.com/v1",
      model: "public-model", apiFormat: "responses", reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => {
      providerRequested = true;
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "must not run" }] }],
      });
    }, async () => ["93.184.216.34", address]), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "AI_UNSAFE_ENDPOINT");
      assert.doesNotMatch(error.message, /secret-sentinel|public-provider|93\.184|10\.0/);
      return true;
    });
    assert.equal(providerRequested, false, `provider fetch must not run for ${address}`);
  }
});

test("fails closed when public address resolution fails or returns no addresses", async () => {
  for (const resolveHostname of [
    async () => [] as string[],
    async () => { throw new Error("resolver exposed details"); },
  ]) {
    let providerRequested = false;
    await assert.rejects(requestCustomModel({
      provider: "custom", apiKey: "secret-sentinel", baseUrl: "https://api.public-provider.com/v1",
      model: "public-model", apiFormat: "chat_completions", reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => {
      providerRequested = true;
      return Response.json({ choices: [{ message: { content: "must not run" } }] });
    }, resolveHostname), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "AI_UNSAFE_ENDPOINT");
      assert.doesNotMatch(error.message, /secret-sentinel|public-provider|resolver exposed/);
      return true;
    });
    assert.equal(providerRequested, false);
  }
});

test("resolves only a hostname through fixed short-lived DNS-over-HTTPS requests", async () => {
  const aiProvider = await import("../lib/ai-provider.ts") as typeof import("../lib/ai-provider.ts") & {
    resolveHostnameViaDoh?: (hostname: string, fetchImplementation: typeof fetch) => Promise<string[]>;
  };
  assert.equal(typeof aiProvider.resolveHostnameViaDoh, "function");
  const requestedTypes: string[] = [];
  const addresses = await aiProvider.resolveHostnameViaDoh!("api.public-provider.com", async (input, init) => {
    const resolverUrl = new URL(String(input));
    assert.notEqual(resolverUrl.hostname, "api.public-provider.com");
    assert.equal(resolverUrl.searchParams.get("name"), "api.public-provider.com");
    const type = resolverUrl.searchParams.get("type") ?? "";
    requestedTypes.push(type);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("accept"), "application/dns-json");
    return Response.json(type === "A"
      ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }
      : { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] });
  });
  assert.deepEqual(requestedTypes.sort(), ["A", "AAAA"]);
  assert.deepEqual(addresses.sort(), ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
});

test("routes local DNS-over-HTTPS checks through the signed development proxy", async () => {
  const previousEnv = globalThis.__aiProviderTestEnv;
  const previousFetch = globalThis.fetch;
  const testEnv = previousEnv ?? { DB: new SqliteD1Database(new DatabaseSync(":memory:")) };
  const previousProxyUrl = testEnv.XIAOYUZHOU_DEV_PROXY_URL;
  const previousProxyToken = testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN;
  const requests: string[] = [];
  try {
    globalThis.__aiProviderTestEnv = testEnv;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = "http://127.0.0.1:4567/__xiaoyuzhou_upstream";
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = "local-proxy-token";
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, "http://127.0.0.1:4567/__xiaoyuzhou_upstream");
      assert.equal(request.headers.get("x-xiaoyuzhou-token"), "local-proxy-token");
      const target = request.headers.get("x-xiaoyuzhou-target");
      assert.ok(target);
      requests.push(target);
      const targetUrl = new URL(target);
      return Response.json(targetUrl.searchParams.get("type") === "A"
        ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }
        : { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] });
    };

    const addresses = await resolveHostnameViaDoh("api.public-provider.com");
    assert.deepEqual(requests.sort(), [
      "https://cloudflare-dns.com/dns-query?name=api.public-provider.com&type=A",
      "https://cloudflare-dns.com/dns-query?name=api.public-provider.com&type=AAAA",
    ]);
    assert.deepEqual(addresses.sort(), ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  } finally {
    globalThis.fetch = previousFetch;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = previousProxyUrl;
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = previousProxyToken;
    globalThis.__aiProviderTestEnv = previousEnv;
  }
});

test("rejects custom Responses and Chat outputs that echo this request's key or base URL", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1/";
  const leakedValues = [
    apiKey,
    `Bearer ${apiKey}`,
    "https://api.public-provider.com/v1",
    "https://api.public-provider.com/v1/",
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedValue of leakedValues) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: `## Result\n\n${leakedValue}` }] }],
      } : {
        choices: [{ message: { content: `## Result\n\n${leakedValue}` } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        assert.doesNotMatch(error.message, /secret-sentinel|public-provider|Bearer/);
        return true;
      });
    }
  }
});

test("rejects canonical-equivalent custom Base URLs before returning Responses or Chat text", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const leakedUrls = [
    "HTTPS://API.PUBLIC-PROVIDER.COM:443/%76%31",
    "https://api.public-provider.com/v1/diagnostics",
    "https://api.public-provider.com/v1/diagnostics%",
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedUrl of leakedUrls) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: ["## Result", leakedUrl].join("\n\n") }] }],
      } : {
        choices: [{ message: { content: ["## Result", leakedUrl].join("\n\n") } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        assert.doesNotMatch(error.message, /secret-sentinel|public-provider|Bearer/);
        return true;
      });
    }
  }
});

test("rejects custom Base URL echoes with sentence punctuation after a dotted path", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1.";
  const leakedUrl = "https://api.public-provider.com/v1..";
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    await assert.rejects(requestCustomModel({
      provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
      reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => Response.json(apiFormat === "responses" ? {
      output: [{ type: "message", content: [{ type: "output_text", text: ["## Result", leakedUrl].join("\n\n") }] }],
    } : {
      choices: [{ message: { content: ["## Result", leakedUrl].join("\n\n") } }],
    }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
      return true;
    });
  }
});

test("rejects custom Base URL echoes followed by common Chinese punctuation", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const trailingPunctuation = ["）", "】", "”", "！", "，", "；", "：", "？", "》", "」", "…"];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const punctuation of trailingPunctuation) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{
          type: "output_text", text: ["## Result", `${baseUrl}${punctuation}`].join("\n\n"),
        }] }],
      } : {
        choices: [{ message: { content: ["## Result", `${baseUrl}${punctuation}`].join("\n\n") } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        return true;
      });
    }
  }
});

test("does not conflate encoded path separators with literal separators in custom output URLs", async () => {
  const apiKey = "secret-sentinel";
  const baseUrls = [
    "https://api.public-provider.com/api%2Fv1",
    "https://api.public-provider.com/api%5Cv1",
  ];
  const unrelatedUrl = "https://api.public-provider.com/api/v1";
  for (const baseUrl of baseUrls) {
    for (const apiFormat of ["responses", "chat_completions"] as const) {
      const response = await requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: ["## Result", unrelatedUrl].join("\n\n") }] }],
      } : {
        choices: [{ message: { content: ["## Result", unrelatedUrl].join("\n\n") } }],
      }), PUBLIC_HOST_RESOLVER);
      assert.equal(response.text, ["## Result", unrelatedUrl].join("\n\n"));
    }
  }
});

test("rejects custom Base URL echoes hidden by dot-segment normalization", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const leakedUrls = [
    "https://api.public-provider.com/v1/../diagnostics",
    "HTTPS://API.PUBLIC-PROVIDER.COM:443/%76%31/%2e%2e/diagnostics",
    "https://api.public-provider.com/v1\\..\\diagnostics",
    "HTTPS://API.PUBLIC-PROVIDER.COM:443\\%76%31\\%2e%2e\\diagnostics",
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedUrl of leakedUrls) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
      } : {
        choices: [{ message: { content: leakedUrl } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        return true;
      });
    }
  }
});

test("rejects custom Base URL echoes hidden by special URL spellings", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const leakedUrls = [
    "https:/api.public-provider.com/v1",
    "https:\\api.public-provider.com\\v1",
    "https:/\\api.public-provider.com/v1",
    "https:api.public-provider.com/v1",
    "https:////api.public-provider.com/v1",
    "https:/api.public-provider.com/v1/../diagnostics",
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedUrl of leakedUrls) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
      } : {
        choices: [{ message: { content: leakedUrl } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        return true;
      });
    }
  }
});

test("rejects adjacent custom Base URL echoes in either URL order", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const adjacentOutputs = [
    `https://evil.example/x,${baseUrl}`,
    `${baseUrl},https://evil.example/x`,
    `https://evil.example/x，${baseUrl}`,
    `${baseUrl}，https://evil.example/x`,
    `https://evil.example/x${baseUrl}`,
    `${baseUrl}https://evil.example/x`,
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedUrl of adjacentOutputs) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
      } : {
        choices: [{ message: { content: leakedUrl } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        return true;
      });
    }
  }
});

test("rejects custom Base URL echoes before comma-separated prose", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1";
  const leakedUrls = [
    `${baseUrl},continued prose`,
    `${baseUrl}，后续文字`,
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const leakedUrl of leakedUrls) {
      await assert.rejects(requestCustomModel({
        provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
        reasoningEffort: null,
      }, {
        instructions: "system rules", input: "document", maxOutputTokens: 1600,
      }, async () => Response.json(apiFormat === "responses" ? {
        output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
      } : {
        choices: [{ message: { content: leakedUrl } }],
      }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
        return true;
      });
    }
  }
});

test("rejects custom Base URL echoes when its path contains another URL scheme", async () => {
  const apiKey = "secret-sentinel";
  const baseUrls = [
    "https://api.public-provider.com/v1https:foo",
    "https://api.public-provider.com/https://foo",
  ];
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    for (const baseUrl of baseUrls) {
      for (const leakedUrl of [baseUrl, `${baseUrl}/child`]) {
        await assert.rejects(requestCustomModel({
          provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
          reasoningEffort: null,
        }, {
          instructions: "system rules", input: "document", maxOutputTokens: 1600,
        }, async () => Response.json(apiFormat === "responses" ? {
          output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
        } : {
          choices: [{ message: { content: leakedUrl } }],
        }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.status, 502);
          assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
          return true;
        });
      }
    }
  }
});

test("allows a different internal-scheme custom Base URL path", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1https:foo";
  const unrelatedUrl = "https://api.public-provider.com/v1https:bar";
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    const response = await requestCustomModel({
      provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
      reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => Response.json(apiFormat === "responses" ? {
      output: [{ type: "message", content: [{ type: "output_text", text: unrelatedUrl }] }],
    } : {
      choices: [{ message: { content: unrelatedUrl } }],
    }), PUBLIC_HOST_RESOLVER);
    assert.equal(response.text, unrelatedUrl);
  }
});

test("rejects a custom Base URL path ending in a scheme-looking word before prose", async () => {
  const apiKey = "secret-sentinel";
  const baseUrl = "https://api.public-provider.com/v1https";
  const leakedUrl = `${baseUrl}:continued`;
  for (const apiFormat of ["responses", "chat_completions"] as const) {
    await assert.rejects(requestCustomModel({
      provider: "custom", apiKey, baseUrl, model: "public-model", apiFormat,
      reasoningEffort: null,
    }, {
      instructions: "system rules", input: "document", maxOutputTokens: 1600,
    }, async () => Response.json(apiFormat === "responses" ? {
      output: [{ type: "message", content: [{ type: "output_text", text: leakedUrl }] }],
    } : {
      choices: [{ message: { content: leakedUrl } }],
    }), PUBLIC_HOST_RESOLVER), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
      return true;
    });
  }
});

test("rejects a DeepSeek output that echoes its own key", async () => {
  await assert.rejects(requestDeepseekModel({
    provider: "deepseek", apiKey: "secret-sentinel", baseUrl: null,
    model: "deepseek-v4-flash", apiFormat: "chat_completions", reasoningEffort: null,
  }, {
    instructions: "system rules", input: "document", maxOutputTokens: 1600,
  }, async () => ({
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: "## Result\n\nBearer secret-sentinel" } }],
    }) } },
  })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AI_SENSITIVE_OUTPUT");
    assert.doesNotMatch(error.message, /secret-sentinel|Bearer/);
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

test("accepts the current Xiaoyuzhou episode response id field", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      data: {
        id: "67fc60374d8edb5eb86d6026",
        title: "36. 对话 AI 产品经理 Zara",
        podcast: { title: "职场药丸" },
        transcript: { mediaId: "5fc12a24dee9c1e16dfa4090/li6_sY0Z2KSoJDqzOnBGHUdBIIsW.mp4a" },
        duration: 2880,
        pubDate: "2025-04-14T00:00:00.000Z",
      },
    });
    assert.deepEqual(await getOfficialEpisode("67fc60374d8edb5eb86d6026", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      deviceId: "device-id",
    }), {
      eid: "67fc60374d8edb5eb86d6026",
      title: "36. 对话 AI 产品经理 Zara",
      podcastTitle: "职场药丸",
      shownotesHtml: "",
      durationSeconds: 2880,
      publishedAt: "2025-04-14T00:00:00.000Z",
      mediaId: "5fc12a24dee9c1e16dfa4090/li6_sY0Z2KSoJDqzOnBGHUdBIIsW.mp4a",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
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
    provider: "custom", apiFormat: "responses", model: "gpt-5.6-luna",
  });
  assert.match(markdown, /result_type: "summary"/);
  assert.match(markdown, /analysis_source: "current"/);
  assert.match(markdown, /provider: "custom"/);
  assert.match(markdown, /api_format: "responses"/);
  assert.match(markdown, /model: "gpt-5.6-luna"/);
  assert.doesNotMatch(markdown, /relay\.example|relay-secret/);
  assert.match(markdown, /# 如何建立统计直觉｜内容梳理/);
});

test("normalizes only usable Xiaoyuzhou captcha tickets", () => {
  assert.deepEqual(normalizeXiaoyuzhouCaptcha({
    scene: "web",
    verifyParam: "  captcha-token  ",
  }), {
    scene: "web",
    verifyParam: "captcha-token",
  });
  assert.deepEqual(normalizeXiaoyuzhouCaptcha({ scene: "h5", verifyParam: "mobile-token" }), {
    scene: "h5",
    verifyParam: "mobile-token",
  });
  for (const value of [
    null,
    {},
    { scene: "desktop", verifyParam: "token" },
    { scene: "web", verifyParam: "" },
    { scene: "web", verifyParam: "x".repeat(4097) },
  ]) {
    assert.equal(normalizeXiaoyuzhouCaptcha(value), null);
  }
});

test("fails a stalled browser captcha load instead of waiting forever", async () => {
  await assert.rejects(
    withTimeout(new Promise<void>(() => undefined), 5, "安全验证组件加载超时"),
    (error: unknown) => error instanceof Error && error.message === "安全验证组件加载超时",
  );
});

test("builds the current Xiaoyuzhou SMS request shape", () => {
  assert.deepEqual(buildSmsCodeRequestBody("13800138000", "+86", {
    scene: "web",
    verifyParam: "captcha-token",
  }), {
    mobilePhoneNumber: "13800138000",
    areaCode: "+86",
    captcha: { scene: "web", verifyParam: "captcha-token" },
  });
});

test("maps Xiaoyuzhou SMS upstream responses without leaking transport errors", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ code: 1, toast: "验证码验证失败" }, { status: 400 });
    };
    await assert.rejects(
      sendSmsCode("13800138000", "+86", { scene: "web", verifyParam: "captcha-token" }),
      (error: unknown) => error instanceof XiaoyuzhouError
        && error.code === "SEND_CODE_FAILED"
        && error.status === 400
        && error.message === "验证码验证失败",
    );
    assert.equal(request?.url, "https://web-api.xiaoyuzhoufm.com/v1/auth/send-code");
    assert.deepEqual(await request?.json(), {
      mobilePhoneNumber: "13800138000",
      areaCode: "+86",
      captcha: { scene: "web", verifyParam: "captcha-token" },
    });

    globalThis.fetch = async () => { throw new Error("proxy connection refused"); };
    await assert.rejects(
      sendSmsCode("13800138000", "+86", { scene: "web", verifyParam: "captcha-token" }),
      (error: unknown) => error instanceof XiaoyuzhouError
        && error.code === "UPSTREAM_UNREACHABLE"
        && error.status === 503
        && error.message === "小宇宙验证码服务暂时无法连接，请稍后重试",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("将小宇宙英文验证码错误转换为可操作的中文提示", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ message: "wrong sms code" }, { status: 400 });
    await assert.rejects(
      loginWithSms("13800138000", "+86", "123456"),
      (error: unknown) => error instanceof XiaoyuzhouError
        && error.code === "LOGIN_FAILED"
        && error.status === 400
        && error.message === "验证码错误或已过期，请重新发送并输入最新验证码",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("routes local Xiaoyuzhou requests through the signed host proxy", async () => {
  const previousEnv = globalThis.__aiProviderTestEnv;
  const previousFetch = globalThis.fetch;
  const testEnv = previousEnv ?? { DB: new SqliteD1Database(new DatabaseSync(":memory:")) };
  const previousProxyUrl = testEnv.XIAOYUZHOU_DEV_PROXY_URL;
  const previousProxyToken = testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN;
  let request: Request | undefined;
  try {
    globalThis.__aiProviderTestEnv = testEnv;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = "http://127.0.0.1:4567/__xiaoyuzhou_upstream";
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = "local-proxy-token";
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({}, { status: 200 });
    };

    await sendSmsCode("13800138000", "+86", { scene: "web", verifyParam: "captcha-token" });

    assert.equal(request?.url, "http://127.0.0.1:4567/__xiaoyuzhou_upstream");
    assert.equal(request?.headers.get("x-xiaoyuzhou-target"), "https://web-api.xiaoyuzhoufm.com/v1/auth/send-code");
    assert.equal(request?.headers.get("x-xiaoyuzhou-token"), "local-proxy-token");
    assert.equal(request?.headers.get("origin"), "https://podcaster.xiaoyuzhoufm.com");
  } finally {
    globalThis.fetch = previousFetch;
    testEnv.XIAOYUZHOU_DEV_PROXY_URL = previousProxyUrl;
    testEnv.XIAOYUZHOU_DEV_PROXY_TOKEN = previousProxyToken;
    globalThis.__aiProviderTestEnv = previousEnv;
  }
});

test("wires the browser captcha into the Xiaoyuzhou SMS flow", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  const captcha = await readFile(new URL("../app/xiaoyuzhou-captcha.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/account/send-code/route.ts", import.meta.url), "utf8");
  assert.match(workspace, /XiaoyuzhouCaptchaHandle/);
  assert.match(workspace, /requestToken\(\)/);
  assert.match(workspace, /captcha:\s*\{\s*scene:\s*captchaScene/);
  assert.match(captcha, /AliyunCaptcha\.js/);
  assert.match(captcha, /window\.AliyunCaptchaConfig\s*=\s*\{\s*region:\s*"cn",\s*prefix:\s*"kn7vz1"\s*\}/);
  assert.match(captcha, /initAliyunCaptcha/);
  assert.match(captcha, /安全验证组件加载超时/);
  assert.match(captcha, /has-error/);
  assert.match(styles, /\.notice\s*\{[^}]*z-index:\s*140/);
  assert.match(captcha, /80c00qbb/);
  assert.match(captcha, /hdb4s8qu/);
  assert.doesNotMatch(captcha, /console\.(?:log|error|warn).*verifyParam/);
  assert.match(route, /INVALID_CAPTCHA/);
});

test("keeps local Worker development compatible with the configured HTTPS proxy", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: { dev?: string };
  };
  const devRunner = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
  const upstreamProxy = await readFile(new URL("../scripts/dev-upstream-proxy.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.scripts?.dev, "node scripts/dev.mjs");
  assert.match(devRunner, /NODE_USE_ENV_PROXY/);
  assert.match(devRunner, /vinext(?:\.cmd)?/);
  assert.match(upstreamProxy, /content-encoding/);
  assert.match(upstreamProxy, /xyzcdn\.net/);
  assert.match(upstreamProxy, /cloudflare-dns\.com/);
});

test("保存说话人分段时只使用服务器保存的官方正文", async () => {
  const [artifactModule, speakersModule, markdownModule] = await Promise.all([
    import("../lib/transcript-artifact.ts"),
    import("../lib/transcript-speakers.ts"),
    import("../lib/speaker-markdown.ts"),
  ]);
  const originalMarkdown = `---\nsource: "xiaoyuzhou"\n---\n\n# 标题\n\n## 官方文稿\n\n[00:00:00] 官方原文\n`;
  const artifact = artifactModule.buildTranscriptArtifact("episode-id", [{ startMs: 0, endMs: 1_000, text: "官方原文" }], "2026-08-24T00:00:00.000Z");
  let storedMarkdown = "";
  let storedArtifact = "";
  let touchedHash = "";
  globalThis.__analysisGenerateRouteTestDeps = {
    "@/lib/db": {
      getEpisodeRecord: async () => ({
        eid: "episode-id", original_key: "original.md", current_key: "current.md",
        original_hash: "original-hash", duration_seconds: 1,
      }),
      touchCurrentDocument: async (_userId: string, _eid: string, hash: string) => { touchedHash = hash; },
    },
    "@/lib/documents": {
      documentKeys: async () => ({ originalKey: "original.md", currentKey: "current.md", transcriptKey: "transcript.json" }),
      readJson: async () => JSON.stringify(artifact),
      readMarkdown: async (key: string) => key === "original.md" ? originalMarkdown : originalMarkdown,
      putJson: async (_key: string, value: unknown) => { storedArtifact = JSON.stringify(value); },
      putMarkdown: async (_key: string, markdown: string) => { storedMarkdown = markdown; },
    },
    "@/lib/security": { sha256Hex: async (value: string) => value === originalMarkdown ? "original-hash" : "rendered-hash" },
    "@/lib/transcript-artifact": {
      isSpeakerEngine: artifactModule.isSpeakerEngine,
      parseTranscriptArtifact: artifactModule.parseTranscriptArtifact,
    },
    "@/lib/transcript-speakers": {
      normalizeDiarizationTurns: speakersModule.normalizeDiarizationTurns,
      alignTranscriptSpeakers: speakersModule.alignTranscriptSpeakers,
      normalizeSpeakerLabels: speakersModule.normalizeSpeakerLabels,
      applySpeakerOverrides: speakersModule.applySpeakerOverrides,
      SpeakerInputError: speakersModule.SpeakerInputError,
    },
    "@/lib/speaker-markdown": { renderSpeakerMarkdown: markdownModule.renderSpeakerMarkdown },
    "@/lib/user": {
      apiError: (error: unknown) => { throw error; },
      HttpError,
      requireApiUser: async () => ({ userId: "owner" }),
    },
  };
  try {
    const route = await import(`${new URL("../app/api/episodes/[eid]/speakers/route.ts", import.meta.url).href}?speaker-save=${crypto.randomUUID()}`);
    const response = await route.PUT(new Request("https://app.example/api/episodes/episode-id/speakers", {
      method: "PUT",
      body: JSON.stringify({
        turns: [{ startMs: 0, endMs: 1_000, speakerId: "speaker_0" }],
        labels: [{ id: "speaker_0", label: "主持人" }],
        overrides: [],
        engine: "pyannote-wespeaker-voiceprint-v1",
        markdown: "恶意正文",
      }),
    }), { params: Promise.resolve({ eid: "episode-id" }) });
    const payload = await response.json() as { markdown: string };

    assert.equal(response.status, 200);
    assert.match(payload.markdown, /### 主持人[\s\S]*官方原文/);
    assert.doesNotMatch(payload.markdown, /恶意正文/);
    assert.match(payload.markdown, /speaker_source: "pyannote-wespeaker-voiceprint-v1"/);
    assert.equal(storedMarkdown, payload.markdown);
    assert.match(storedArtifact, /pyannote-wespeaker-voiceprint-v1/);
    assert.equal(touchedHash, "rendered-hash");
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
  }
});

test("说话人预览只计算结果，不写入文稿或旁车文件", async () => {
  const [artifactModule, speakersModule, markdownModule] = await Promise.all([
    import("../lib/transcript-artifact.ts"),
    import("../lib/transcript-speakers.ts"),
    import("../lib/speaker-markdown.ts"),
  ]);
  const originalMarkdown = `---\nsource: "xiaoyuzhou"\n---\n\n# 标题\n\n## 官方文稿\n\n[00:00:00] 官方原文\n`;
  const artifact = artifactModule.buildTranscriptArtifact("episode-id", [{ startMs: 0, endMs: 1_000, text: "官方原文" }], "2026-08-24T00:00:00.000Z");
  let writeCount = 0;
  globalThis.__analysisGenerateRouteTestDeps = {
    "@/lib/db": { getEpisodeRecord: async () => ({ eid: "episode-id", duration_seconds: 1 }) },
    "@/lib/documents": {
      documentKeys: async () => ({ originalKey: "original.md", currentKey: "current.md", transcriptKey: "transcript.json" }),
      readJson: async () => JSON.stringify(artifact),
      readMarkdown: async () => originalMarkdown,
      putJson: async () => { writeCount += 1; },
      putMarkdown: async () => { writeCount += 1; },
    },
    "@/lib/transcript-artifact": {
      isSpeakerEngine: artifactModule.isSpeakerEngine,
      parseTranscriptArtifact: artifactModule.parseTranscriptArtifact,
    },
    "@/lib/transcript-speakers": {
      normalizeDiarizationTurns: speakersModule.normalizeDiarizationTurns,
      alignTranscriptSpeakers: speakersModule.alignTranscriptSpeakers,
      normalizeSpeakerLabels: speakersModule.normalizeSpeakerLabels,
      applySpeakerOverrides: speakersModule.applySpeakerOverrides,
      SpeakerInputError: speakersModule.SpeakerInputError,
    },
    "@/lib/speaker-markdown": { renderSpeakerMarkdown: markdownModule.renderSpeakerMarkdown },
    "@/lib/user": { apiError: (error: unknown) => { throw error; }, HttpError, requireApiUser: async () => ({ userId: "owner" }) },
  };
  try {
    const route = await import(`${new URL("../app/api/episodes/[eid]/speakers/preview/route.ts", import.meta.url).href}?speaker-preview=${crypto.randomUUID()}`);
    const response = await route.POST(new Request("https://app.example/api/episodes/episode-id/speakers/preview", {
      method: "POST",
      body: JSON.stringify({
        turns: [{ startMs: 0, endMs: 1_000, speakerId: "speaker_0" }],
        labels: [{ id: "speaker_0", label: "主持人" }],
        engine: "pyannote-wespeaker-voiceprint-v1",
      }),
    }), { params: Promise.resolve({ eid: "episode-id" }) });
    const payload = await response.json() as { preview: { markdown: string; reviewCount: number } };

    assert.equal(response.status, 200);
    assert.match(payload.preview.markdown, /### 主持人/);
    assert.match(payload.preview.markdown, /speaker_source: "pyannote-wespeaker-voiceprint-v1"/);
    assert.equal(payload.preview.reviewCount, 0);
    assert.equal(writeCount, 0);
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
  }
});

test("keeps custom provider credentials out of generated analysis artifacts", async () => {
  const sentinelBaseUrl = "https://relay.example/v1";
  const sentinelApiKey = "relay-secret";
  const config = {
    provider: "custom" as const,
    apiKey: sentinelApiKey,
    baseUrl: sentinelBaseUrl,
    model: "gpt-5.6-luna",
    apiFormat: "responses" as const,
    reasoningEffort: "high" as const,
  };
  const episode = {
    id: 1, user_id: "owner", eid: "episode-id", source_url: "https://www.xiaoyuzhoufm.com/episode/episode-id",
    title: "如何建立统计直觉", podcast_title: "样本播客", published_at: null, duration_seconds: 3600,
    segment_count: 20, original_key: "original.md", current_key: "current.md", original_hash: "original",
    content_hash: "current", created_at: "2026-08-15T00:00:00.000Z", updated_at: "2026-08-15T00:00:00.000Z",
  };
  let generatedConfig: unknown;
  let storedMarkdown = "";
  let storedRecord: Record<string, unknown> | undefined;
  globalThis.__analysisGenerateRouteTestDeps = {
    "@/lib/analysis": {
      buildAnalysisMarkdown,
      generateAnalysisBody: async ({ config: receivedConfig }: { config: unknown }) => {
        generatedConfig = receivedConfig;
        return "## 一句话主旨\n\n建立统计直觉。";
      },
    },
    "@/lib/ai-settings": { readActiveAiConfiguration: async () => config },
    "@/lib/db": {
      acquireAnalysisLease: async () => "lease-id",
      consumeUsage: async () => true,
      getEpisodeRecord: async () => episode,
      getFramework: async () => null,
      publicAnalysis: (record: Record<string, unknown>) => ({
        provider: record.provider, apiFormat: record.api_format, model: record.model,
      }),
      refundUsage: async () => undefined,
      releaseAnalysisLease: async () => undefined,
      setOriginalHash: async () => undefined,
      upsertAnalysisResult: async (record: Record<string, unknown>) => { storedRecord = record; },
    },
    "@/lib/documents": {
      analysisDocumentKey: async () => "analysis.md",
      putMarkdown: async (_key: string, markdown: string) => { storedMarkdown = markdown; },
      readMarkdown: async () => "播客文稿正文",
    },
    "@/lib/frameworks": {
      frameworkForAnalysis: () => SYSTEM_FRAMEWORK,
      SYSTEM_FRAMEWORK_ID: SYSTEM_FRAMEWORK.id,
    },
    "@/lib/security": { sha256Hex: async () => "source-hash" },
    "@/lib/user": {
      apiError: (error: unknown) => { throw error; },
      HttpError,
      requireApiUser: async () => ({ userId: "owner" }),
    },
  };
  try {
    const route = await import(`${new URL("../app/api/episodes/[eid]/analyses/generate/route.ts", import.meta.url).href}?secret-boundary=${crypto.randomUUID()}`);
    const response = await route.POST(new Request("https://app.example/api/episodes/episode-id/analyses/generate", {
      method: "POST",
      body: JSON.stringify({ kind: "summary", source: "current" }),
    }), { params: Promise.resolve({ eid: "episode-id" }) });
    const payload = await response.json() as Record<string, unknown>;

    assert.strictEqual(generatedConfig, config);
    assert.ok(storedRecord);
    assert.match(storedMarkdown, /provider: "custom"/);
    assert.match(storedMarkdown, /api_format: "responses"/);
    assert.match(storedMarkdown, /model: "gpt-5\.6-luna"/);
    assert.deepEqual({
      provider: storedRecord.provider,
      apiFormat: storedRecord.api_format,
      model: storedRecord.model,
    }, { provider: "custom", apiFormat: "responses", model: "gpt-5.6-luna" });
    assert.deepEqual(payload.result, { provider: "custom", apiFormat: "responses", model: "gpt-5.6-luna" });
    for (const artifact of [storedMarkdown, JSON.stringify(storedRecord), JSON.stringify(payload)]) {
      assert.doesNotMatch(artifact, /relay\.example|relay-secret/);
    }
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
  }
});

test("refunds and writes no analysis artifacts when a custom API echoes credentials", async () => {
  const config = {
    provider: "custom" as const,
    apiKey: "secret-sentinel",
    baseUrl: "https://api.public-provider.com/v1",
    model: "public-model",
    apiFormat: "responses" as const,
    reasoningEffort: null,
  };
  const episode = {
    id: 1, user_id: "owner", eid: "episode-id", source_url: "https://www.xiaoyuzhoufm.com/episode/episode-id",
    title: "安全边界测试", podcast_title: "样本播客", published_at: null, duration_seconds: 1800,
    segment_count: 10, original_key: "original.md", current_key: "current.md", original_hash: "original",
    content_hash: "current", created_at: "2026-08-15T00:00:00.000Z", updated_at: "2026-08-15T00:00:00.000Z",
  };
  let refunds = 0;
  let releases = 0;
  let documentWrites = 0;
  let recordWrites = 0;
  globalThis.__analysisGenerateRouteTestDeps = {
    "@/lib/analysis": {
      buildAnalysisMarkdown,
      generateAnalysisBody: async ({ config: receivedConfig }: { config: typeof config }) => (
        await requestCustomModel(receivedConfig, {
          instructions: "system rules", input: "document", maxOutputTokens: 1600,
        }, async () => Response.json({
          output: [{ type: "message", content: [{ type: "output_text", text: "Bearer secret-sentinel" }] }],
        }), PUBLIC_HOST_RESOLVER)
      ).text,
    },
    "@/lib/ai-settings": { readActiveAiConfiguration: async () => config },
    "@/lib/db": {
      acquireAnalysisLease: async () => "lease-id",
      consumeUsage: async () => true,
      getEpisodeRecord: async () => episode,
      getFramework: async () => null,
      publicAnalysis: (record: Record<string, unknown>) => record,
      refundUsage: async () => { refunds += 1; },
      releaseAnalysisLease: async () => { releases += 1; },
      setOriginalHash: async () => undefined,
      upsertAnalysisResult: async () => { recordWrites += 1; },
    },
    "@/lib/documents": {
      analysisDocumentKey: async () => "analysis.md",
      putMarkdown: async () => { documentWrites += 1; },
      readMarkdown: async () => "播客文稿正文",
    },
    "@/lib/frameworks": {
      frameworkForAnalysis: () => SYSTEM_FRAMEWORK,
      SYSTEM_FRAMEWORK_ID: SYSTEM_FRAMEWORK.id,
    },
    "@/lib/security": { sha256Hex: async () => "source-hash" },
    "@/lib/user": {
      apiError: (error: unknown) => error instanceof HttpError
        ? Response.json({ error: error.code, message: error.message }, { status: error.status })
        : Response.json({ error: "INTERNAL_ERROR" }, { status: 500 }),
      HttpError,
      requireApiUser: async () => ({ userId: "owner" }),
    },
  };
  try {
    const route = await import(`${new URL("../app/api/episodes/[eid]/analyses/generate/route.ts", import.meta.url).href}?echo-boundary=${crypto.randomUUID()}`);
    const response = await route.POST(new Request("https://app.example/api/episodes/episode-id/analyses/generate", {
      method: "POST",
      body: JSON.stringify({ kind: "summary", source: "current" }),
    }), { params: Promise.resolve({ eid: "episode-id" }) });
    const payloadText = await response.text();

    assert.equal(response.status, 502);
    assert.match(payloadText, /AI_SENSITIVE_OUTPUT/);
    assert.doesNotMatch(payloadText, /secret-sentinel|public-provider/);
    assert.equal(refunds, 1);
    assert.equal(releases, 1);
    assert.equal(documentWrites, 0);
    assert.equal(recordWrites, 0);
  } finally {
    globalThis.__analysisGenerateRouteTestDeps = undefined;
  }
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
