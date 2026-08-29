import assert from "node:assert/strict";
import test from "node:test";
import { cleanupProgressLabel, consumeCleanupResponse } from "../lib/transcript-cleanup-client.ts";

test("JSON cleanup fallback reports processing progress before returning payload", async () => {
  const payload = {
    markdown: "clean",
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    stats: { processedBlocks: 1, changedBlocks: 1, fillerRemoved: 1, repetitionsMerged: 0, typosFixed: 0, unprocessedBlocks: 0 },
  };
  const progress: unknown[] = [];
  const result = await consumeCleanupResponse(
    new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
    (event) => progress.push(event),
  );
  assert.deepEqual(result, payload);
  assert.deepEqual(progress, [{ stage: "processing" }]);
});

test("cleanup progress labels include the first zero-based batch", () => {
  assert.match(cleanupProgressLabel({ stage: "batch", batchIndex: 0, batchCount: 3 }), /第 1\/3 批/);
});
