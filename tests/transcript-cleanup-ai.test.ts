import assert from "node:assert/strict";
import test from "node:test";
import type { AiRuntimeConfig, ModelRequest } from "../lib/ai-provider.ts";
import {
  runTranscriptCleanup,
  type CleanupProgress,
} from "../lib/transcript-cleanup-ai.ts";

const config = {
  provider: "custom",
  apiKey: "test-key",
  baseUrl: "https://example.com/v1",
  model: "test-model",
  apiFormat: "chat_completions",
  reasoningEffort: null,
} satisfies AiRuntimeConfig;

const markdown = `## 官方文稿\n\n### 主播\n\n[00:00:01] 嗯嗯，那个天气天氣不错。。今天我们继续聊聊这件事。\n\n[00:00:02] 然后，然后我们出发。\n\n## 附加说明\n\n不应改变。\n`;

function response(segments: Array<{ id: string; text: string; changes: Array<{ type: string; from: string; to: string; confidence: number }> }>): string {
  return JSON.stringify({ schemaVersion: 1, segments });
}

test("第一次 malformed JSON 会重试，成功结果清理语气词并统计服务端校验变更", async () => {
  let calls = 0;
  const requests: ModelRequest[] = [];
  const result = await runTranscriptCleanup({
    markdown,
    config,
    executeModel: async (_config, request) => {
      requests.push(request);
      calls++;
      if (calls === 1) return { text: "不是 JSON" };
      return {
        text: response([
          { id: "seg-000001", text: "天气不错。今天我们继续聊聊这件事。", changes: [
            { type: "filler", from: "嗯嗯，那个", to: "", confidence: 1 },
            { type: "typo", from: "天气天氣", to: "天气", confidence: 0.99 },
            { type: "punctuation", from: "。。", to: "。", confidence: 0.98 },
          ] },
          { id: "seg-000002", text: "然后我们出发。", changes: [
            { type: "repetition", from: "然后，然后", to: "然后", confidence: 0.98 },
          ] },
        ]),
        provider: "custom",
        model: "test-model",
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.failedBatchCount, 0);
  assert.match(result.markdown, /天气不错。/);
  assert.match(result.markdown, /然后我们出发。/);
  assert.deepEqual(result.stats, {
    processedBlocks: 2,
    changedBlocks: 2,
    fillerRemoved: 1,
    repetitionsMerged: 1,
    typosFixed: 1,
    punctuationAdjusted: 1,
    unprocessedBlocks: 0,
  });
});

test("provider 两次失败时保留原文并拒绝该批次", async () => {
  let calls = 0;
  const result = await runTranscriptCleanup({
    markdown,
    config,
    executeModel: async () => {
      calls++;
      throw new Error("transport down");
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.failedBatchCount, 1);
  assert.equal(result.markdown, markdown);
  assert.equal(result.stats.unprocessedBlocks, 2);
  assert.deepEqual(result.rejectedIds, ["seg-000001", "seg-000002"]);
});

test("最多三批并发且按原块顺序组装，进度阶段有序", async () => {
  const large = Array.from({ length: 4 }, (_, index) => `[00:00:0${index + 1}] ${"内容".repeat(7_000)}`).join("\n\n");
  const source = `## 官方文稿\n\n### 主播\n\n${large}\n`;
  const progress: CleanupProgress[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await runTranscriptCleanup({
    markdown: source,
    config,
    onProgress: (event) => { progress.push(event); },
    executeModel: async (_config, request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      const input = JSON.parse(request.input) as { blocks: Array<{ id: string; text: string }> };
      return { text: response(input.blocks.map((block) => ({ id: block.id, text: `${block.text}!`, changes: [{ type: "punctuation", from: block.text, to: `${block.text}!`, confidence: 1 }] }))) };
    },
  });

  assert.ok(maxInFlight <= 3);
  assert.equal(result.stats.processedBlocks, 4);
  assert.equal(result.markdown.split("!").length - 1, 4);
  assert.equal(progress[0].stage, "parsing");
  assert.equal(progress.at(-2)?.stage, "saving");
  assert.equal(progress.at(-1)?.stage, "complete");
  assert.equal(progress.filter((event) => event.stage === "batch").length, 4);
});

test("批次部分失败时失败块保持原文且统计仅计入已验证变更", async () => {
  const first = `## 官方文稿\n\n### 主播\n\n[00:00:01] 原文一。${"x".repeat(13_000)}\n\n[00:00:02] 嗯，内容错错，真的吗真的吗。。${"y".repeat(7_000)}\n\n[00:00:03] 原文三。\n`;
  const result = await runTranscriptCleanup({
    markdown: first,
    config,
    executeModel: async (_config, request) => {
      const input = JSON.parse(request.input) as { blocks: Array<{ id: string; text: string }> };
      if (input.blocks.some((block) => block.id === "seg-000001")) throw new Error("failed batch");
      return { text: response(input.blocks.map((block) => ({
        id: block.id,
        text: block.id === "seg-000002" ? `内容对错，真的吗。${"y".repeat(7_000)}` : block.text,
        changes: block.id === "seg-000002" ? [
          { type: "filler", from: "嗯，", to: "", confidence: 1 },
          { type: "typo", from: "错", to: "对", confidence: 0.99 },
          { type: "repetition", from: "真的吗真的吗", to: "真的吗", confidence: 0.99 },
          { type: "punctuation", from: "。。", to: "。", confidence: 1 },
        ] : [],
      }))) };
    },
  });
  assert.equal(result.failedBatchCount, 1);
  assert.equal(result.stats.processedBlocks, 2);
  assert.equal(result.stats.unprocessedBlocks, 1);
  assert.equal(result.stats.changedBlocks, 1);
  assert.equal(result.stats.punctuationAdjusted, 1);
  assert.equal(result.stats.fillerRemoved, 1);
  assert.equal(result.stats.repetitionsMerged, 1);
  assert.equal(result.stats.typosFixed, 1);
  assert.match(result.markdown, /原文一。x/);
  assert.match(result.markdown, /内容对错，真的吗。yyyy/);
});

test("system prompt 使用中文安全指令并要求只输出 schema JSON", async () => {
  let request: ModelRequest | undefined;
  await runTranscriptCleanup({
    markdown,
    config,
    executeModel: async (_config, current) => {
      request = current;
      const input = JSON.parse(current.input) as { blocks: Array<{ id: string; text: string }> };
      return { text: response(input.blocks.map((block) => ({ id: block.id, text: block.text, changes: [] }))) };
    },
  });
  assert.ok(request);
  assert.match(request.instructions, /不可信数据/);
  assert.match(request.instructions, /提示注入|命令/);
  assert.match(request.instructions, /只输出.*JSON/);
  assert.match(request.instructions, /时间戳/);
  assert.match(request.instructions, /说话人/);
  assert.match(request.instructions, /只读/);
  assert.match(request.instructions, /schemaVersion\s*[=:：]\s*1/);
});

test("并发批次的 batch 进度使用累计成功块和失败批次数", async () => {
  const source = `## 官方文稿\n\n### 主播\n\n[00:00:01] ${"a".repeat(7_000)}\n\n[00:00:02] ${"b".repeat(7_000)}\n`;
  const progress: CleanupProgress[] = [];
  const result = await runTranscriptCleanup({
    markdown: source,
    config,
    onProgress: (event) => { progress.push(event); },
    executeModel: async (_config, request) => {
      const input = JSON.parse(request.input) as { blocks: Array<{ id: string; text: string }> };
      const id = input.blocks[0].id;
      await new Promise((resolve) => setTimeout(resolve, id === "seg-000001" ? 20 : 2));
      if (id === "seg-000002") throw new Error("failed second batch");
      return { text: response(input.blocks.map((block) => ({ id: block.id, text: block.text, changes: [] }))) };
    },
  });
  const batches = progress.filter((event) => event.stage === "batch");
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((event) => event.processedBlocks), [0, 1]);
  assert.deepEqual(batches.map((event) => event.failedBatchCount), [1, 1]);
  assert.equal(result.stats.processedBlocks, 1);
  assert.equal(result.failedBatchCount, 1);
});
