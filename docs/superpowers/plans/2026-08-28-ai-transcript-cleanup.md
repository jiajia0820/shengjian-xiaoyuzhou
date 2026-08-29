# AI Transcript Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add a safe AI cleanup operation that removes unnecessary spoken fillers and repeated phrases, applies only high-confidence typo corrections to the current transcript, preserves timestamps and speaker labels, and supports one-click undo.

**Architecture:** Pure TypeScript modules parse and reassemble Markdown and validate model JSON. A server cleanup service reuses the existing DeepSeek/custom provider in bounded batches. Route handlers own authentication, leases, quotas, snapshots, and current-document writes; the React workspace starts cleanup, displays progress/statistics, and exposes hash-protected undo.

**Tech Stack:** TypeScript, React 19, Vinext/Next route handlers, R2-compatible document storage, \`executeModelRequest\`, SHA-256, Node test runner with \`--experimental-strip-types\`, ESLint, and TypeScript.

---

## File map and boundaries

- Create \`lib/transcript-cleanup.ts\`: parser, immutable skeleton, chunking, model JSON validation, diff checks, and reassembly.
- Create \`lib/transcript-cleanup-ai.ts\`: Chinese cleanup prompt, provider calls, one retry per batch, progress callbacks, and statistics.
- Create \`app/api/episodes/[eid]/cleanup/route.ts\`: authenticated cleanup, hash/lease/quota checks, snapshot, current write, and progress-stream/JSON response.
- Create \`app/api/episodes/[eid]/cleanup/undo/route.ts\`: authenticated hash-protected snapshot restore.
- Modify \`lib/documents.ts\`: add the fixed latest-cleanup snapshot key.
- Modify \`lib/transcript-artifact.ts\`: add a helper that updates only speaker-layout current Markdown hash.
- Modify \`app/workspace.tsx\` and \`app/globals.css\`: controls, progress, statistics, undo, and styles.
- Create \`tests/transcript-cleanup.test.ts\`, \`tests/transcript-cleanup-ai.test.ts\`, and \`tests/transcript-cleanup-routes.test.ts\`.
- Modify \`tests/transcript-artifact.test.ts\`, \`tests/rendered-html.test.mjs\`, \`package.json\`, and \`README.md\`.

No database migration is needed. \`episodes.content_hash\` remains the current-version marker; the latest undo snapshot is an object-storage JSON key deleted with the episode prefix.

### Task 1: Build the pure Markdown cleanup core

**Files:** create \`lib/transcript-cleanup.ts\` and \`tests/transcript-cleanup.test.ts\`; modify the \`npm test\` list in \`package.json\`.

- [ ] **Step 1: Write failing parser and assembler tests**

Use a fixture containing frontmatter, Show Notes, \`## 官方文稿\`, \`### 主播\`, \`### 嘉宾\`, two timestamped blocks, and a later \`## 附加说明\` section.

~~~ts
test("parses timestamp blocks and read-only speaker context", () => {
  const document = parseCleanupDocument(fixtureMarkdown);
  assert.deepEqual(document.blocks.map((block) => ({
    id: block.id,
    speakerLabel: block.speakerLabel,
    timestampText: block.timestampText,
    text: block.text,
  })), [
    { id: "seg-000001", speakerLabel: "主播", timestampText: "[00:10:39]", text: "嗯这个其实其实方法呢，应该是比较重要的。" },
    { id: "seg-000002", speakerLabel: "嘉宾", timestampText: "[00:10:52]", text: "这个例子不能说明全部问题。" },
  ]);
});

test("reassembles replacements without touching Markdown metadata", () => {
  const document = parseCleanupDocument(fixtureMarkdown);
  const result = assembleCleanupDocument(document, new Map([
    ["seg-000001", "这个方法应该是比较重要的。"],
  ]));
  assert.match(result, /### 主播\n\n\[00:10:39\] 这个方法应该是比较重要的。/);
  assert.match(result, /### 嘉宾\n\n\[00:10:52\] 这个例子不能说明全部问题。/);
  assert.match(result, /## 附加说明\n\n不要处理这里的内容。/);
});
~~~

Run: \`node --experimental-strip-types --test tests/transcript-cleanup.test.ts\`.

Expected: FAIL because the module exports do not exist.

- [ ] **Step 2: Define the pure API and parser**

Export:

~~~ts
export type CleanupBlock = {
  id: string;
  speakerLabel: string | null;
  timestampText: string | null;
  text: string;
  ordinal: number;
};
export type CleanupDocument = {
  sourceMarkdown: string;
  immutableSkeleton: string[];
  blocks: CleanupBlock[];
};
export type CleanupChange = {
  type: "filler" | "repetition" | "typo" | "punctuation";
  from: string;
  to: string;
  confidence: number;
};
export type CleanupModelResult = {
  schemaVersion: 1;
  segments: Array<{ id: string; text: string; changes: CleanupChange[] }>;
};

export function parseCleanupDocument(markdown: string): CleanupDocument;
export function assembleCleanupDocument(
  document: CleanupDocument,
  replacements: ReadonlyMap<string, string>,
): string;
export function splitCleanupBlocks(
  blocks: readonly CleanupBlock[],
  maxChars: number,
): CleanupBlock[][];
export function parseCleanupModelResult(value: string): CleanupModelResult;
export function validateCleanupModelResult(
  document: CleanupDocument,
  result: CleanupModelResult,
  allowedIds?: ReadonlySet<string>,
): {
  replacements: Map<string, string>;
  changes: CleanupChange[];
  rejectedIds: string[];
};
~~~

Scan only the official-transcript section (after the first \`## 官方文稿\`, before the next \`## \`), retain original line endings/content in \`sourceMarkdown\`, assign IDs by document order, and let a block span multiple lines until the next timestamp, speaker heading, same-level section, or end. Throw \`CLEANUP_NO_BLOCKS\` when no editable block exists.

- [ ] **Step 3: Implement the immutable assembler**

The assembler must verify replacement IDs, reuse the original skeleton, keep frontmatter/headings/labels/timestamps/blank lines/non-transcript sections byte-for-byte unchanged, reject replacement text containing timestamps, headings, YAML delimiters, or code fences, keep the original block if replacement is empty, and never create an empty timestamp block.

- [ ] **Step 4: Implement chunking and result validation**

Split only between blocks, target 12,000 Unicode characters, and put an oversized block in its own batch. JSON parsing accepts plain JSON or one optional JSON fence, rejects trailing prose, requires schema version 1, validates change types and confidence in [0, 1], and rejects duplicate/missing/extra IDs. Reject typo changes below 0.90 confidence, unsafe markers, empty output, expansion above 1.5x, or deletion of over half the non-whitespace text unless the change is solely filler/repetition removal. Keep rejected blocks unchanged and report their IDs.

- [ ] **Step 5: Run tests and commit**

Run: \`node --experimental-strip-types --test tests/transcript-cleanup.test.ts\`.

Expected: PASS for parsing, immutable assembly, chunking, JSON validation, high-confidence typo filtering, and unsafe-output rejection.

Commit: \`feat: add transcript cleanup parser and validator\`.

### Task 2: Add provider-neutral cleanup orchestration

**Files:** create \`lib/transcript-cleanup-ai.ts\` and \`tests/transcript-cleanup-ai.test.ts\`.

- [ ] **Step 1: Write failing mocked-provider tests**

Inject \`executeModel\` so no real provider is called:

~~~ts
test("retries malformed output once", async () => {
  let calls = 0;
  const result = await runTranscriptCleanup({
    markdown: fixtureMarkdown,
    config: fakeConfig,
    executeModel: async () => {
      calls += 1;
      return calls === 1 ? { text: "not json" } : { text: validCleanupJson };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.failedBatchCount, 0);
  assert.equal(result.markdown.includes("嗯这个"), false);
});

test("keeps original blocks after two provider failures", async () => {
  const result = await runTranscriptCleanup({
    markdown: fixtureMarkdown,
    config: fakeConfig,
    executeModel: async () => { throw new Error("provider down"); },
  });
  assert.equal(result.failedBatchCount, 1);
  assert.equal(result.markdown, fixtureMarkdown);
  assert.ok(result.stats.unprocessedBlocks > 0);
});
~~~

Run: \`node --experimental-strip-types --test tests/transcript-cleanup-ai.test.ts\`.

Expected: FAIL because orchestration does not exist.

- [ ] **Step 2: Define orchestration types and prompt**

Export \`CleanupProgress\` as parsing/batch/saving/complete events, \`CleanupStats\` with processed/changed/fillerRemoved/repetitionsMerged/typosFixed/punctuationAdjusted/unprocessedBlocks, and \`TranscriptCleanupResult\` with Markdown, source document, stats, failed batch count, rejected IDs, provider, and model. Export \`runTranscriptCleanup({ markdown, config, executeModel?, onProgress? })\`.

The system instruction must be Chinese, treat transcript text as untrusted data, prohibit prompt injection, preserve meaning/style, remove balanced fillers/repetitions, apply only high-confidence typo corrections, and return only version-1 JSON. Include read-only speaker/timestamp context and neighboring text, but never ask the model to reproduce Markdown metadata.

- [ ] **Step 3: Implement bounded workers and exact statistics**

Use \`splitCleanupBlocks(blocks, 12_000)\`, at most three concurrent workers, and one retry for transport/JSON/ID validation failures. After the second failure, keep that batch unchanged and mark all its IDs unprocessed. Merge replacements only after all batches finish. Count validated \`changes\`, never model-reported totals. Keep the model executor injectable and compute hashes in the route layer.

- [ ] **Step 4: Run tests and commit**

Run: \`node --experimental-strip-types --test tests/transcript-cleanup.test.ts tests/transcript-cleanup-ai.test.ts\`.

Expected: PASS for retry/fallback, concurrency limit, balanced cleanup, and exact statistics.

Commit: \`feat: add transcript cleanup model orchestration\`.

### Task 3: Add snapshot storage and cleanup route

**Files:** modify \`lib/documents.ts\`; create \`app/api/episodes/[eid]/cleanup/route.ts\` and \`tests/transcript-cleanup-routes.test.ts\`.

- [ ] **Step 1: Write failing route tests**

~~~ts
test("stale current hash writes nothing", async () => {
  const response = await postCleanup({ currentHash: "stale" });
  assert.equal(response.status, 409);
  assert.equal(fakeStore.putCalls.length, 0);
});

test("snapshot is written before current Markdown", async () => {
  const response = await postCleanup({ currentHash: fixtureHash });
  assert.equal(response.status, 200);
  assert.deepEqual(fakeStore.putCalls.map((call) => call.key), [
    expectedSnapshotKey,
    expectedCurrentKey,
  ]);
});

test("all failed batches leave current unchanged", async () => {
  const response = await postCleanup({ currentHash: fixtureHash, providerFails: true });
  assert.equal(response.status, 502);
  assert.equal(fakeStore.putCalls.length, 0);
});
~~~

Run: \`node --experimental-strip-types --test tests/transcript-cleanup-routes.test.ts\`.

Expected: FAIL because the key and route do not exist.

- [ ] **Step 2: Add the fixed snapshot key**

Extend \`documentKeys\` with \`aiCleanupSnapshotKey: base + "/revisions/ai-cleanup-latest.json"\`. Do not add a DB table or column; episode-prefix deletion already removes the object.

- [ ] **Step 3: Implement the authenticated write path**

Use \`requireApiUser({ mutation: true })\`, load the owned episode, parse a non-empty \`currentHash\`, read current Markdown, and reject a stale hash with 409 before any write. Consume one AI quota unit using the existing \`consumeUsage(userId, "ai", 20)\`; acquire the existing analysis lease and refund quota on lease conflict. Read \`readActiveAiConfiguration\`, call \`runTranscriptCleanup\`, and return 502 without writes when every batch fails.

Before current write, save a \`CleanupSnapshot\` JSON containing schema version, episode ID, before/after hashes, timestamp, before Markdown, provider/model, and server-computed statistics. Then write current Markdown, call \`touchCurrentDocument\`, and return Markdown, hashes, statistics, failed batches, and \`undoAvailable\`. Release the lease in \`finally\`; never write the official original key.

- [ ] **Step 4: Add streaming and JSON fallback**

Extract \`performCleanup(onProgress)\`. For \`Accept: text/event-stream\`, return a \`ReadableStream\` with sanitized progress events and one final completion payload; otherwise return the same payload through \`Response.json\`. Do not stream Markdown or secrets before the final write. Provider errors must leave current unchanged and expose only safe error codes/messages.

- [ ] **Step 5: Run tests and commit**

Run: \`node --experimental-strip-types --test tests/transcript-cleanup.test.ts tests/transcript-cleanup-ai.test.ts tests/transcript-cleanup-routes.test.ts\`.

Expected: PASS for auth, stale hash, quota/lease conflicts, snapshot order, all-batch failure, JSON response, and stream response.

Commit: \`feat: add AI transcript cleanup endpoint\`.

### Task 4: Add hash-protected undo

**Files:** create \`app/api/episodes/[eid]/cleanup/undo/route.ts\`; modify \`tests/transcript-cleanup-routes.test.ts\`.

- [ ] **Step 1: Write failing undo tests**

~~~ts
test("undo restores before Markdown and deletes snapshot", async () => {
  seedSnapshot({ beforeHash: "before", afterHash: "after", beforeMarkdown: fixtureMarkdown });
  seedCurrent("after", cleanedMarkdown);
  const response = await postUndo({ currentHash: "after" });
  assert.equal(response.status, 200);
  assert.equal(fakeStore.currentMarkdown, fixtureMarkdown);
  assert.equal(fakeEpisode.content_hash, "before");
  assert.equal(fakeStore.snapshot, null);
});

test("undo refuses a manual edit", async () => {
  seedSnapshot({ beforeHash: "before", afterHash: "after", beforeMarkdown: fixtureMarkdown });
  seedCurrent("manual", "用户的新编辑");
  const response = await postUndo({ currentHash: "manual" });
  assert.equal(response.status, 409);
  assert.equal(fakeStore.currentMarkdown, "用户的新编辑");
});
~~~

Run: \`node --experimental-strip-types --test tests/transcript-cleanup-routes.test.ts\`.

Expected: FAIL because the undo route does not exist.

- [ ] **Step 2: Implement undo**

Require mutation authentication, a valid current hash, the owned episode, and the latest snapshot. Return 404 \`CLEANUP_SNAPSHOT_NOT_FOUND\` when absent. Verify the request hash, freshly computed current hash, and snapshot \`afterHash\` all match; mismatch returns 409 without writes/deletion. On success write \`beforeMarkdown\`, update \`content_hash\` to \`beforeHash\`, delete the snapshot, and return restored Markdown/hash.

- [ ] **Step 3: Run tests and commit**

Run: \`node --experimental-strip-types --test tests/transcript-cleanup-routes.test.ts\`.

Expected: PASS for success, missing snapshot, stale hash, manual-edit conflict, and cleanup-after-undo.

Commit: \`feat: add AI transcript cleanup undo\`.

### Task 5: Preserve voiceprint metadata

**Files:** modify \`lib/transcript-artifact.ts\`, \`app/api/episodes/[eid]/cleanup/route.ts\`, \`tests/transcript-artifact.test.ts\`, and \`tests/transcript-cleanup-routes.test.ts\`.

- [ ] **Step 1: Write failing metadata test**

~~~ts
test("cleanup changes only speaker-layout current hash", async () => {
  const before = readArtifact();
  await runSuccessfulCleanup();
  const after = readArtifact();
  assert.equal(after.speakerLayout?.currentMarkdownHash, expectedAfterHash);
  assert.deepEqual(after.segments.map(({ startMs, endMs, speakerId, speakerConfidence }) => ({
    startMs, endMs, speakerId, speakerConfidence,
  })), before.segments.map(({ startMs, endMs, speakerId, speakerConfidence }) => ({
    startMs, endMs, speakerId, speakerConfidence,
  })));
  assert.deepEqual(after.speakerLayout?.labels, before.speakerLayout?.labels);
});
~~~

Run: \`node --experimental-strip-types --test tests/transcript-artifact.test.ts tests/transcript-cleanup-routes.test.ts\`.

Expected: FAIL because no hash-only helper exists.

- [ ] **Step 2: Implement and integrate the narrow helper**

Export \`withCurrentMarkdownHash(artifact, currentMarkdownHash): TranscriptArtifact\`. Return a new artifact while preserving every segment/label field. During cleanup, parse \`transcriptKey\` only when its speaker-layout hash equals the cleanup source hash; after current write, update only that hash to \`afterHash\` and write the artifact. If parsing/synchronization fails, keep the cleaned Markdown and return \`speakerLayoutStale: true\` without changing artifact metadata.

- [ ] **Step 3: Run tests and commit**

Run: \`node --experimental-strip-types --test tests/transcript-artifact.test.ts tests/transcript-cleanup-routes.test.ts\`.

Expected: PASS proving timestamps, speaker IDs, confidence, labels, and Markdown remain safe.

Commit: \`fix: preserve voiceprint metadata during transcript cleanup\`.

### Task 6: Integrate workspace controls

**Files:** modify \`app/workspace.tsx\`, \`app/globals.css\`, and \`tests/rendered-html.test.mjs\`.

- [ ] **Step 1: Write failing UI/request tests**

Assert rendered HTML contains “AI 清理文稿” and “撤销 AI 清理”; request mocks must prove the current hash is sent and the returned Markdown/stats are applied.

Run: \`node --test tests/rendered-html.test.mjs\`.

Expected: FAIL because controls and handlers do not exist.

- [ ] **Step 2: Add state and cleanup request**

Add:

~~~ts
const [cleanupProcessing, setCleanupProcessing] = useState(false);
const [cleanupProgress, setCleanupProgress] = useState("准备处理文稿…");
const [cleanupStats, setCleanupStats] = useState<CleanupStats | null>(null);
const [cleanupUndoAvailable, setCleanupUndoAvailable] = useState(false);
~~~

Implement \`cleanupTranscript\`: hash the loaded current Markdown, POST to the selected episode cleanup path with JSON body and \`Accept: text/event-stream\`, parse progress events, fall back to JSON, then update Markdown/stats/undo state. On error leave displayed Markdown unchanged and use the existing notice. Clear busy state in \`finally\`.

- [ ] **Step 3: Wire disabled states and undo**

Disable cleanup, save, restore, download, delete, analysis generation, tab switching, close, and \`SpeakerDiarizationPanel\` while cleanup runs. Keep “恢复原稿” as the official-original action. Implement \`undoCleanup\` against the undo route, using the current hash; on success update Markdown and clear stats/undo, while a 409 leaves the UI content unchanged and asks for refresh.

- [ ] **Step 4: Add status styles and run UI tests**

Show stage/batch progress, processed/changed/filler/repetition/typo/unprocessed counts, and a visible undo action without exposing provider JSON or keys. Use existing toolbar/notice tokens and keyboard-accessible disabled states.

Run: \`node --test tests/rendered-html.test.mjs\`.

Expected: PASS for labels, busy states, status summary, undo action, and existing rendering.

Commit: \`feat: add transcript cleanup controls\`.

### Task 7: Integrate standard verification and documentation

**Files:** modify \`package.json\` and \`README.md\`.

- [ ] **Step 1: Add cleanup tests to \`npm test\`**

Keep all existing test files and add \`tests/transcript-cleanup.test.ts\`, \`tests/transcript-cleanup-ai.test.ts\`, and \`tests/transcript-cleanup-routes.test.ts\`.

- [ ] **Step 2: Document behavior**

Add a concise Chinese README section: cleanup uses current draft only; balanced filler/repetition removal and high-confidence typo fixes; timestamps/speakers/original unchanged; long documents are batched; failed batches stay original; “撤销 AI 清理” differs from “恢复原稿”; a connected provider is required; transcript content is sent to the selected provider while the API key remains server-side.

- [ ] **Step 3: Run complete verification**

From \`E:\\vibe-coding\\小宇宙-逐字稿\\shengjian-xiaoyuzhou-main\\.worktrees\\ai-transcript-cleanup\`, run:

~~~powershell
npm test
npm run lint
npx tsc --noEmit
git diff --check
~~~

Expected: all tests pass, lint and TypeScript exit 0, and diff check reports no errors. Fix failures before committing.

- [ ] **Step 4: Commit documentation**

Commit: \`docs: document AI transcript cleanup workflow\`.

## Final implementation review checklist

- [ ] \`feature/two-speaker-voiceprint\` remains untouched and recoverable; this branch contains only cleanup work.
- [ ] Cleanup and undo never write \`original.md\`.
- [ ] Stale hashes, missing configuration, quota/lease conflicts, malformed model output, and provider failures cannot overwrite current Markdown.
- [ ] Every accepted replacement maps to exactly one original block ID.
- [ ] Timecodes, speaker headings/IDs, confidence values, labels, frontmatter, and non-transcript Markdown remain unchanged.
- [ ] Snapshot is written before current Markdown and deleted only after successful undo.
- [ ] Undo refuses to overwrite a manual edit made after cleanup.
- [ ] Failed batches remain visible in statistics and retain original text.
- [ ] UI never exposes API keys or raw provider output.
- [ ] Existing analysis, two-speaker voiceprint, auth, and download tests still pass.
