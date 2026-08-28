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
  "@/lib/db": "acquireAnalysisLease,consumeUsage,getEpisodeRecord,refundUsage,releaseAnalysisLease,touchCurrentDocument,touchCurrentDocumentIfHash",
  "@/lib/documents": "deleteDocument,documentKeys,putJson,putMarkdown,putMarkdownIfEtag,readJson,readMarkdown,readMarkdownWithEtag",
  "@/lib/security": "sha256Hex",
  "@/lib/transcript-cleanup-ai": "runTranscriptCleanup",
  "@/lib/transcript-cleanup": "parseCleanupDocument",
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
    "@/lib/db": { getEpisodeRecord: async () => ({ ...episode }), consumeUsage: async () => true, refundUsage: async () => undefined, acquireAnalysisLease: async () => "lease", releaseAnalysisLease: async () => undefined, touchCurrentDocument: async (_u: string, _e: string, h: string) => { touched = h; }, touchCurrentDocumentIfHash: async (_u: string, _e: string, expected: string, next: string) => { if (expected !== episode.content_hash) return false; touched = next; return true; } },
    "@/lib/documents": { documentKeys: async () => ({ originalKey: "original.md", currentKey: "current.md", transcriptKey: "transcript.json", aiCleanupSnapshotKey: "snapshot.json" }), readJson: async () => { throw new TestHttpError(404, "DOCUMENT_NOT_FOUND", "missing"); }, readMarkdown: async (key: string) => { assert.equal(key, "current.md"); return current; }, readMarkdownWithEtag: async () => ({ markdown: current, etag: "etag-1" }), putJson: async (key: string, value: unknown) => { putCalls.push({ kind: "json", key, value }); }, putMarkdown: async (key: string, value: string) => { putCalls.push({ kind: "markdown", key, value }); current = value; }, putMarkdownIfEtag: async (key: string, value: string) => { await (deps["@/lib/documents"].putMarkdown as (k: string, v: string) => Promise<void>)(key, value); return `etag-${putCalls.length}`; }, deleteDocument: async (key: string) => { putCalls.push({ kind: "delete", key, value: undefined }); } },
    "@/lib/security": { sha256Hex: async (value: string) => hash(value) },
    "@/lib/ai-settings": { readActiveAiConfiguration: async () => ({ provider: "custom", model: "test-model", apiKey: "secret", baseUrl: "https://secret.example", apiFormat: "responses", reasoningEffort: null }) },
    "@/lib/transcript-cleanup-ai": { runTranscriptCleanup: async ({ markdown, onProgress }: { markdown: string; onProgress?: (progress: { stage: string }) => void }) => { await onProgress?.({ stage: "parsing" }); const cleaned = markdown.replace("嗯嗯 ", ""); return { markdown: cleaned, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 1, changedBlocks: cleaned === markdown ? 0 : 1, fillerRemoved: 1, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 0 }, failedBatchCount: 0, rejectedIds: [], provider: "custom", model: "test-model" }; } },
    "@/lib/transcript-cleanup": { parseCleanupDocument: (markdown: string) => ({ blocks: markdown ? [{ id: "b1" }] : [] }) },
  };
  return { deps, putCalls, get current() { return current; }, set current(value: string) { current = value; }, get touched() { return touched; } };
};

async function loadRoute(deps: Deps) {
  globalThis.__cleanupRouteDeps = deps;
  return import(`${new URL("../app/api/episodes/[eid]/cleanup/route.ts", import.meta.url).href}?t=${crypto.randomUUID()}`);
}

async function loadUndoRoute(deps: Deps) {
  globalThis.__cleanupRouteDeps = deps;
  return import(`${new URL("../app/api/episodes/[eid]/cleanup/undo/route.ts", import.meta.url).href}?t=${crypto.randomUUID()}`);
}

test.afterEach(() => { globalThis.__cleanupRouteDeps = undefined; });

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

test("all rejected blocks return 502 even when provider batches completed", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/transcript-cleanup-ai"].runTranscriptCleanup = async () => ({ markdown: beforeMarkdown, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 0, changedBlocks: 0, fillerRemoved: 0, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 1 }, failedBatchCount: 0, rejectedIds: ["b1"], provider: "custom", model: "test-model" });
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

test("current write failure compensates snapshot and refunds", async () => {
  const setup = baseDeps();
  let refunds = 0;
  setup.deps["@/lib/db"].refundUsage = async () => { refunds++; };
  let firstWrite = true;
  setup.deps["@/lib/documents"].putMarkdown = async () => {
    if (firstWrite) { firstWrite = false; throw new Error("write failed"); }
  };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(refunds, 1);
  assert.equal(setup.putCalls.some((call) => call.kind === "delete" && call.key === "snapshot.json"), false);
});

test("touch failure restores current markdown and hash", async () => {
  const setup = baseDeps();
  let touchCalls = 0;
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async (_u: string, _e: string, _expected: string, h: string) => {
    touchCalls++;
    if (touchCalls === 1) throw new Error("db failed");
    assert.equal(h, hash(beforeMarkdown));
    return true;
  };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(touchCalls, 2);
  assert.equal(setup.current, beforeMarkdown);
  assert.ok(setup.putCalls.some((call) => call.kind === "delete" && call.key === "snapshot.json"));
});

test("failed compensation retains snapshot for recovery", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/documents"].putMarkdown = async () => { throw new Error("storage unavailable"); };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(setup.putCalls.some((call) => call.kind === "delete"), false);
});

test("SSE starts streaming progress before model completion", async () => {
  const setup = baseDeps();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  setup.deps["@/lib/transcript-cleanup-ai"].runTranscriptCleanup = async ({ onProgress }: { onProgress?: (progress: { stage: string }) => void }) => {
    onProgress?.({ stage: "parsing" });
    await pending;
    return { markdown: beforeMarkdown, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 1, changedBlocks: 0, fillerRemoved: 0, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 0 }, failedBatchCount: 0, rejectedIds: [], provider: "custom", model: "test-model" };
  };
  const route = await loadRoute(setup.deps);
  const responsePromise = route.POST(new Request("https://app.test", { method: "POST", headers: { Accept: "text/event-stream" }, body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  const response = await responsePromise;
  const reader = response.body!.getReader();
  const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no progress")), 200))]);
  assert.match(new TextDecoder().decode(first.value), /"type":"progress"/);
  release();
  while (!(await reader.read()).done) { /* drain completion */ }
});

test("rejects unsafe episode ids and mismatched current keys without writes", async () => {
  const setup = baseDeps();
  let reads = 0;
  setup.deps["@/lib/db"].getEpisodeRecord = async () => { reads++; return episode; };
  const route = await loadRoute(setup.deps);
  let response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "../bad" }) });
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
  setup.deps["@/lib/db"].getEpisodeRecord = async () => ({ ...episode, current_key: "other.md" });
  response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
  assert.equal(setup.putCalls.length, 0);
});

test("CAS touch conflict returns stale error and never success", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async () => false;
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "CLEANUP_STALE_HASH");
});

test("CAS conflict preserves cleaned current and snapshot evidence", async () => {
  const setup = baseDeps();
  let observedCurrent = beforeMarkdown;
  setup.deps["@/lib/documents"].readMarkdown = async () => observedCurrent;
  setup.deps["@/lib/documents"].putMarkdown = async (_key: string, value: string) => { observedCurrent = value; };
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async () => false;
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
  assert.notEqual(observedCurrent, beforeMarkdown);
  assert.equal(setup.putCalls.some((call) => call.kind === "delete"), false);
});

test("rejects oversized documents before quota or lease", async () => {
  for (const oversized of ["x".repeat(5_000_001), Array.from({ length: 400_001 }, () => "😀").join("")]) {
    const setup = baseDeps();
    setup.deps["@/lib/documents"].readMarkdown = async () => oversized;
    setup.deps["@/lib/documents"].readMarkdownWithEtag = async () => ({ markdown: oversized, etag: "etag-1" });
    setup.deps["@/lib/db"].getEpisodeRecord = async () => ({ ...episode, content_hash: hash(oversized) });
    let consumed = 0; let leased = 0;
    setup.deps["@/lib/db"].consumeUsage = async () => { consumed++; return true; };
    setup.deps["@/lib/db"].acquireAnalysisLease = async () => { leased++; return "lease"; };
    const route = await loadRoute(setup.deps);
    const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(oversized) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
    assert.equal(response.status, 413);
    assert.equal(consumed, 0); assert.equal(leased, 0); assert.equal(setup.putCalls.length, 0);
  }
});

test("returns clear 400 when cleanup document has no editable blocks", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/transcript-cleanup"].parseCleanupDocument = () => ({ blocks: [] });
  setup.deps["@/lib/transcript-cleanup-ai"].runTranscriptCleanup = async () => ({ markdown: beforeMarkdown, document: { blocks: [] }, sourceDocument: { blocks: [] }, stats: { processedBlocks: 0, changedBlocks: 0, fillerRemoved: 0, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 0 }, failedBatchCount: 0, rejectedIds: [], provider: "custom", model: "test-model" });
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 400);
  assert.equal(setup.putCalls.length, 0);
});

test("maps parser CLEANUP_NO_BLOCKS error to 400", async () => {
  const setup = baseDeps();
  setup.deps["@/lib/transcript-cleanup"].parseCleanupDocument = () => { const error = new Error("none"); Object.assign(error, { code: "CLEANUP_NO_BLOCKS" }); throw error; };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 400);
});

test("rejects oversized model result before writing", async () => {
  const setup = baseDeps();
  const huge = "x".repeat(5_000_001);
  setup.deps["@/lib/transcript-cleanup-ai"].runTranscriptCleanup = async () => ({ markdown: huge, document: { blocks: [{ id: "b1" }] }, sourceDocument: { blocks: [{ id: "b1" }] }, stats: { processedBlocks: 1, changedBlocks: 1, fillerRemoved: 0, repetitionsMerged: 0, typosFixed: 0, punctuationAdjusted: 0, unprocessedBlocks: 0 }, failedBatchCount: 0, rejectedIds: [], provider: "custom", model: "test-model" });
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 413);
  assert.equal(setup.putCalls.length, 0);
});

test("conditional write exception preserves concurrent current and snapshot", async () => {
  const setup = baseDeps(); let current = beforeMarkdown;
  setup.deps["@/lib/documents"].readMarkdown = async () => current;
  setup.deps["@/lib/documents"].putMarkdownIfEtag = async () => { current = "并发编辑"; throw new Error("unknown write state"); };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502); assert.equal(current, "并发编辑"); assert.equal(setup.putCalls.some((c) => c.kind === "delete"), false);
});

test("release failure does not change successful cleanup response", async () => {
  const setup = baseDeps(); let releases = 0;
  setup.deps["@/lib/db"].releaseAnalysisLease = async () => { releases++; throw new Error("release failed"); };
  const route = await loadRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(beforeMarkdown) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 200); assert.equal(releases, 1);
});

test("undo restores before Markdown and deletes snapshot", async () => {
  const setup = baseDeps();
  const cleanedMarkdown = "# 标题\n\n[00:00:01] 这是正文。\n";
  const beforeHash = hash(beforeMarkdown);
  const afterHash = hash(cleanedMarkdown);
  setup.current = cleanedMarkdown;
  let snapshot: unknown = { schemaVersion: 1, episodeId: "ep-1", beforeHash, afterHash, createdAt: new Date().toISOString(), beforeMarkdown, provider: "custom", model: "test-model", stats: {} };
  setup.deps["@/lib/documents"].readJson = async () => JSON.stringify(snapshot);
  const fakeEpisode = { ...episode, content_hash: afterHash };
  setup.deps["@/lib/db"].getEpisodeRecord = async () => fakeEpisode;
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async (_u: string, _e: string, expected: string, next: string) => {
    if (fakeEpisode.content_hash !== expected) return false;
    fakeEpisode.content_hash = next;
    return true;
  };
  setup.deps["@/lib/documents"].deleteDocument = async () => { snapshot = null; };
  const route = await loadUndoRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: afterHash }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 200);
  assert.equal(setup.current, beforeMarkdown);
  assert.equal(fakeEpisode.content_hash, beforeHash);
  assert.equal(snapshot, null);
});

test("undo refuses a manual edit", async () => {
  const setup = baseDeps();
  const cleanedMarkdown = "# 标题\n\n[00:00:01] 这是正文。\n";
  const beforeHash = hash(beforeMarkdown);
  const afterHash = hash(cleanedMarkdown);
  setup.current = "用户的新编辑";
  let snapshot: unknown = { schemaVersion: 1, episodeId: "ep-1", beforeHash, afterHash, createdAt: new Date().toISOString(), beforeMarkdown, provider: "custom", model: "test-model", stats: {} };
  setup.deps["@/lib/documents"].readJson = async () => JSON.stringify(snapshot);
  const fakeEpisode = { ...episode, content_hash: afterHash };
  setup.deps["@/lib/db"].getEpisodeRecord = async () => fakeEpisode;
  setup.deps["@/lib/documents"].deleteDocument = async () => { snapshot = null; };
  const route = await loadUndoRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: hash(setup.current) }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 409);
  assert.equal(setup.current, "用户的新编辑");
  assert.notEqual(snapshot, null);
});

test("undo touch failure rolls DB hash back after conditional content restore", async () => {
  const setup = baseDeps();
  const cleanedMarkdown = "# 标题\n\n[00:00:01] 这是正文。\n";
  const beforeHash = hash(beforeMarkdown);
  const afterHash = hash(cleanedMarkdown);
  setup.current = cleanedMarkdown;
  let snapshot: unknown = { schemaVersion: 1, episodeId: "ep-1", beforeHash, afterHash, createdAt: new Date().toISOString(), beforeMarkdown, provider: "custom", model: "test-model", stats: {} };
  setup.deps["@/lib/documents"].readJson = async () => JSON.stringify(snapshot);
  const fakeEpisode = { ...episode, content_hash: afterHash };
  setup.deps["@/lib/db"].getEpisodeRecord = async () => fakeEpisode;
  let touchCalls = 0;
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async (_u: string, _e: string, expected: string, next: string) => {
    touchCalls++;
    if (touchCalls === 1) { fakeEpisode.content_hash = beforeHash; throw new Error("db state unknown"); }
    if (fakeEpisode.content_hash !== expected) return false;
    fakeEpisode.content_hash = next;
    return true;
  };
  setup.deps["@/lib/documents"].deleteDocument = async () => { snapshot = null; };
  const route = await loadUndoRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: afterHash }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(setup.current, cleanedMarkdown);
  assert.equal(fakeEpisode.content_hash, afterHash);
  assert.notEqual(snapshot, null);
});

test("undo touch failure does not overwrite a concurrent object edit", async () => {
  const setup = baseDeps();
  const cleanedMarkdown = "# 标题\n\n[00:00:01] 这是正文。\n";
  const beforeHash = hash(beforeMarkdown);
  const afterHash = hash(cleanedMarkdown);
  setup.current = cleanedMarkdown;
  let snapshot: unknown = { schemaVersion: 1, episodeId: "ep-1", beforeHash, afterHash, createdAt: new Date().toISOString(), beforeMarkdown, provider: "custom", model: "test-model", stats: {} };
  setup.deps["@/lib/documents"].readJson = async () => JSON.stringify(snapshot);
  const fakeEpisode = { ...episode, content_hash: afterHash };
  setup.deps["@/lib/db"].getEpisodeRecord = async () => fakeEpisode;
  let touchCalls = 0;
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async () => {
    touchCalls++;
    fakeEpisode.content_hash = beforeHash;
    throw new Error("db state unknown");
  };
  setup.deps["@/lib/documents"].putMarkdownIfEtag = async () => {
    if (touchCalls === 0) { setup.current = beforeMarkdown; return "undo-etag"; }
    setup.current = "并发编辑";
    return null;
  };
  setup.deps["@/lib/documents"].deleteDocument = async () => { snapshot = null; };
  const route = await loadUndoRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: afterHash }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(setup.current, "并发编辑");
  assert.notEqual(snapshot, null);
});

test("undo write exception after object commit reconciles DB hash", async () => {
  const setup = baseDeps();
  const cleanedMarkdown = "# 标题\n\n[00:00:01] 这是正文。\n";
  const beforeHash = hash(beforeMarkdown);
  const afterHash = hash(cleanedMarkdown);
  setup.current = cleanedMarkdown;
  let snapshot: unknown = { schemaVersion: 1, episodeId: "ep-1", beforeHash, afterHash, createdAt: new Date().toISOString(), beforeMarkdown, provider: "custom", model: "test-model", stats: {} };
  setup.deps["@/lib/documents"].readJson = async () => JSON.stringify(snapshot);
  const fakeEpisode = { ...episode, content_hash: afterHash };
  setup.deps["@/lib/db"].getEpisodeRecord = async () => fakeEpisode;
  setup.deps["@/lib/documents"].putMarkdownIfEtag = async () => {
    setup.current = beforeMarkdown;
    throw new Error("write committed then failed");
  };
  setup.deps["@/lib/documents"].readMarkdownWithEtag = async () => ({ markdown: setup.current, etag: "observed-before-etag" });
  setup.deps["@/lib/db"].touchCurrentDocumentIfHash = async (_u: string, _e: string, expected: string, next: string) => {
    if (fakeEpisode.content_hash !== expected) return false;
    fakeEpisode.content_hash = next;
    return true;
  };
  setup.deps["@/lib/documents"].deleteDocument = async () => { snapshot = null; };
  const route = await loadUndoRoute(setup.deps);
  const response = await route.POST(new Request("https://app.test", { method: "POST", body: JSON.stringify({ currentHash: afterHash }) }), { params: Promise.resolve({ eid: "ep-1" }) });
  assert.equal(response.status, 502);
  assert.equal(setup.current, beforeMarkdown);
  assert.equal(fakeEpisode.content_hash, beforeHash);
  assert.notEqual(snapshot, null);
});
