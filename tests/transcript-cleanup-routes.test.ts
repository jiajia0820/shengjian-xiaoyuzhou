import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

type Deps = Record<string, Record<string, unknown>>;
type ErrorLike = { code?: string; message?: string; status?: number };
class TestHttpError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
declare global { var __cleanupRouteDeps: Deps | undefined; }

const exportsMap: Record<string, string> = {
  "@/lib/ai-settings": "readActiveAiConfiguration",
  "@/lib/db": "acquireAnalysisLease,consumeUsage,getEpisodeRecord,refundUsage,releaseAnalysisLease,touchCurrentDocument",
  "@/lib/documents": "documentKeys,putJson,putMarkdown,readMarkdown",
  "@/lib/security": "sha256Hex",
  "@/lib/transcript-cleanup-ai": "runTranscriptCleanup",
  "@/lib/user": "apiError,HttpError,requireApiUser",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env = {};" };
    const names = exportsMap[specifier];
    if (!names || !globalThis.__cleanupRouteDeps) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      return nextResolve(specifier, context);
    }
    const source = names.split(",").map((name) => name === "HttpError"
      ? `export const HttpError = globalThis.__cleanupRouteDeps[${JSON.stringify(specifier)}].HttpError;`
      : `export const ${name} = (...args) => globalThis.__cleanupRouteDeps[${JSON.stringify(specifier)}][${JSON.stringify(name)}](...args);`).join("\n");
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  },
});

const beforeMarkdown = "# 标题\n\n[00:00:01] 嗯嗯 这是正文。\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const episode = { eid: "ep-1", current_key: "current.md", original_key: "original.md", content_hash: hash(beforeMarkdown) };
const baseDeps = () => {
  const putCalls: Array<{ kind: string; key: string; value: unknown }> = [];
  let current = beforeMarkdown;
  let touched = "";
  const deps: Deps = {
    "@/lib/user": { HttpError: TestHttpError, requireApiUser: async () => ({ userId: "u1" }), apiError: (error: ErrorLike) => Response.json({ error: error.code ?? "INTERNAL_ERROR", message: error.message }, { status: error.status ?? 500 }) },
    "@/lib/db": { getEpisodeRecord: async () => ({ ...episode, content_hash: hash(current) }), consumeUsage: async () => true, refundUsage: async () => undefined, acquireAnalysisLease: async () => "lease", releaseAnalysisLease: async () => undefined, touchCurrentDocument: async (_u: string, _e: string, h: string) => { touched = h; } },
    "@/lib/documents": { documentKeys: async () => ({ originalKey: "original.md", currentKey: "current.md", transcriptKey: "transcript.json", aiCleanupSnapshotKey: "snapshot.json" }), readMarkdown: async (key: string) => { assert.equal(key, "current.md"); return current; }, putJson: async (key: string, value: unknown) => { putCalls.push({ kind: "json", key, value }); }, putMarkdown: async (key: string, value: string) => { putCalls.push({ kind: "markdown", key, value }); current = value; } },
    "@/lib/security": { sha256Hex: async (value: string) => hash(value) },
    "@/lib/ai-settings": { readActiveAiConfiguration: async () => ({ provider: "custom", model: "test-model", apiKey: "secret", baseUrl: "https://secret.example", apiFormat: "responses", reasoningEffort: null }) },
    "@/lib/transcript-cleanup-ai": { runTranscriptCleanup: async ({ markdown, onProgress }: { markdown: string; onProgress?: (progress: { stage: string }) => void }) => { await onProgress?.({ stage: "parsing" }); const cleaned = markdown.replace("嗯嗯 ", ""); return { markdown: cleaned, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 1, changedBlocks: cleaned === markdown ? 0 : 1, fillerRemoved: 1, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 0 }, failedBatchCount: 0, rejectedIds: [], provider: "custom", model: "test-model" }; } },
  };
  return { deps, putCalls, get current() { return current; }, get touched() { return touched; } };
};

async function loadRoute(deps: Deps) {
  globalThis.__cleanupRouteDeps = deps;
  return import(`${new URL("../app/api/episodes/[eid]/cleanup/route.ts", import.meta.url).href}?t=${crypto.randomUUID()}`);
}

test("stale current hash returns 409 without writes", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/db"].getEpisodeRecord = async () => ({ ...episode, content_hash: "0".repeat(64) });
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
  assert.equal(setup.putCalls.length, 0);
});

test("successful cleanup writes snapshot before current and returns hashes", async () => {
  const setup = baseDeps();
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  const payload = await response.json() as { beforeHash: string; afterHash: string; markdown: string; undoAvailable: boolean };
  assert.equal(response.status, 200);
  assert.deepEqual(setup.putCalls.map((call) => call.kind), ["json", "markdown"]);
  assert.equal(payload.beforeHash, hash(beforeMarkdown));
  assert.equal(payload.afterHash, hash(payload.markdown));
  assert.equal(setup.touched, payload.afterHash);
  assert.equal(payload.undoAvailable, true);
});

test("all provider batch failures return 502 and do not write", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/transcript-cleanup-ai"].runTranscriptCleanup = async () => ({ markdown: beforeMarkdown, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 0, changedBlocks: 0, fillerRemoved: 0, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 1 }, failedBatchCount: 1, rejectedIds: ["b1"], provider: "custom", model: "test-model" });
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(setup.putCalls.length, 0);
});

test("quota exhaustion and lease conflict are safe errors", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/db"].consumeUsage = async () => false;
  const route = await loadRoute(setup.deps);
  let response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 429);
  setup.deps["@/lib/db"].consumeUsage = async () => true;
  setup.deps["@/lib/db"].acquireAnalysisLease = async () => null;
  response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
});

test("SSE fallback emits progress and complete without secrets", async () => {
  const setup = baseDeps();
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", headers: { Accept: "text/event-stream" }, body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  const body = await response.text();
  assert.match(body, /progress/);
  assert.match(body, /complete/);
  assert.doesNotMatch(body, /secret|secret\.example/);
});

test("authentication and configuration failures are sanitized", async () => {
  const setup = baseDeps();
  const HttpError = setup.deps["@/lib/user"].HttpError as typeof TestHttpError;
  setup.deps["@/lib/user"].requireApiUser = async () => { throw new HttpError(401, "AUTH_REQUIRED", "请先登录"); };
  const route = await loadRoute(setup.deps);
  let response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 401);
  setup.deps["@/lib/user"].requireApiUser = async () => ({ userId: "u1" });
  setup.deps["@/lib/ai-settings"].readActiveAiConfiguration = async () => { throw new Error("provider secret-api-key"); };
  response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.doesNotMatch(body, /secret-api-key/);
});
