import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleCleanupDocument,
  parseCleanupDocument,
  parseCleanupModelResult,
  splitCleanupBlocks,
  validateCleanupModelResult,
} from "../lib/transcript-cleanup.ts";

const fixture = `---
title: "测试节目"
---

# 节目标题

## Show Notes

这里是 Show Notes，不应被清理。

## 官方文稿

### 主播

[00:00:01] 大家好，今天我们聊聊天气。
这是第二行，仍然属于主播。

[00:00:08] 嘉宾说：我觉得不错。
这是嘉宾的补充。

### 嘉宾

[00:00:15] 最后一段内容。

## 附加说明

这里也不应被清理。
`;

test("解析第一个官方文稿区域中的说话人、时间戳和多行正文", () => {
  const document = parseCleanupDocument(fixture);

  assert.equal(document.sourceMarkdown, fixture);
  assert.deepEqual(document.blocks, [
    {
      id: "seg-000001",
      speakerLabel: "主播",
      timestampText: "00:00:01",
      text: "大家好，今天我们聊聊天气。\n这是第二行，仍然属于主播。",
      ordinal: 0,
    },
    {
      id: "seg-000002",
      speakerLabel: "主播",
      timestampText: "00:00:08",
      text: "嘉宾说：我觉得不错。\n这是嘉宾的补充。",
      ordinal: 1,
    },
    {
      id: "seg-000003",
      speakerLabel: "嘉宾",
      timestampText: "00:00:15",
      text: "最后一段内容。",
      ordinal: 2,
    },
  ]);
  assert.equal(document.immutableSkeleton.length, document.blocks.length + 1);
});

test("解析只处理第一个官方文稿区域，没有块时给出稳定错误码", () => {
  const withSecondSection = `${fixture}\n## 官方文稿\n[00:99:99] 不应扫描\n`;
  assert.equal(parseCleanupDocument(withSecondSection).blocks.length, 3);
  assert.throws(
    () => parseCleanupDocument("# 标题\n\n## 官方文稿\n\n## 附加说明\n"),
    (error: unknown) => error instanceof Error && /CLEANUP_NO_BLOCKS/.test(error.message) && (error as Error & { code?: string }).code === "CLEANUP_NO_BLOCKS",
  );
});

test("assembler 只替换正文并逐字节保留元数据、空行和其它区域", () => {
  const document = parseCleanupDocument(fixture);
  const output = assembleCleanupDocument(document, new Map([
    ["seg-000001", "大家好，今天我们聊聊雨天。\n这是改写后的第二行。"],
    ["seg-000002", ""],
  ]));

  assert.match(output, /### 主播\n\n\[00:00:01\] 大家好，今天我们聊聊雨天。\n这是改写后的第二行。/);
  assert.match(output, /\[00:00:08\] 嘉宾说：我觉得不错。\n这是嘉宾的补充。/);
  assert.equal(output.split("## Show Notes")[1].split("## 官方文稿")[0], fixture.split("## Show Notes")[1].split("## 官方文稿")[0]);
  assert.equal(output.split("## 附加说明")[1], fixture.split("## 附加说明")[1]);
  assert.throws(() => assembleCleanupDocument(document, new Map([["unknown", "x"]])), /unknown|CLEANUP_UNKNOWN_ID/);
  assert.throws(() => assembleCleanupDocument(document, new Map([["seg-000001", "[00:00:22] unsafe"]])), /unsafe|CLEANUP_UNSAFE_REPLACEMENT/);
  assert.throws(() => assembleCleanupDocument(document, new Map([["seg-000001", "### heading"]])), /unsafe|CLEANUP_UNSAFE_REPLACEMENT/);
  assert.throws(() => assembleCleanupDocument(document, new Map([["seg-000001", "###"]])), /unsafe|CLEANUP_UNSAFE_REPLACEMENT/);
  assert.throws(() => assembleCleanupDocument(document, new Map([["seg-000001", "~~~json\n{}\n~~~"]])), /unsafe|CLEANUP_UNSAFE_REPLACEMENT/);
  const ordinary = assembleCleanupDocument(document, new Map([["seg-000001", "普通文本 ### 内联"]])).includes("普通文本 ### 内联");
  assert.equal(ordinary, true);
});

test("按块边界分块，超大块独占且不复制或丢失", () => {
  const blocks = parseCleanupDocument(fixture).blocks;
  const chunks = splitCleanupBlocks(blocks, 55);
  assert.deepEqual(chunks.flat().map((block) => block.id), blocks.map((block) => block.id));
  assert.ok(chunks.every((chunk) => chunk.length === 1 || chunk.reduce((total, block) => total + block.text.length, 0) <= 55));
  assert.equal(splitCleanupBlocks(blocks, 1000).length, 1);
  assert.throws(() => splitCleanupBlocks(blocks, 0), /maxChars|positive/i);
});

test("解析纯 JSON 和可选 json 代码围栏，拒绝解释文字与不合法结构", () => {
  const valid = JSON.stringify({
    schemaVersion: 1,
    segments: [{ id: "seg-000001", text: "改写", changes: [{ type: "typo", from: "错", to: "对", confidence: 0.99 }] }],
  });
  assert.deepEqual(parseCleanupModelResult(valid), JSON.parse(valid));
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal(parseCleanupModelResult(`${fence}json\n${valid}\n${fence}`).schemaVersion, 1);
  assert.throws(() => parseCleanupModelResult(`${valid}\n说明文字`), /JSON|trailing|尾随/i);
  assert.throws(() => parseCleanupModelResult(JSON.stringify({ schemaVersion: 2, segments: [] })), /schemaVersion/i);
  assert.throws(() => parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "x", text: "x", changes: [{ type: "typo", from: "x", to: "y", confidence: 1.2 }] }] })), /confidence/i);
  assert.throws(() => parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "x", text: "x", changes: [{ type: "other", from: "x", to: "y", confidence: 1 }] }] })), /type/i);
  assert.throws(() => parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "x", text: "x", changes: [{ type: ["typo"], from: "x", to: "y", confidence: 0.5 }] }] })), /type/i);
});

test("validate 只接受高置信 typo，拒绝低置信、危险、异常长度和空输出", () => {
  const document = parseCleanupDocument(fixture);
  const result = parseCleanupModelResult(JSON.stringify({
    schemaVersion: 1,
    segments: [
      { id: "seg-000001", text: "大家好，今天我们聊聊雨天。\n这是第二行，仍然属于主播。", changes: [{ type: "typo", from: "天气", to: "雨天", confidence: 0.95 }] },
      { id: "seg-000002", text: "低置信修改", changes: [{ type: "typo", from: "不错", to: "很好", confidence: 0.5 }] },
      { id: "seg-000003", text: "[00:00:99] 恶意元数据", changes: [{ type: "punctuation", from: "。", to: "！", confidence: 1 }] },
    ],
  }));
  const validated = validateCleanupModelResult(document, result);
  assert.equal(validated.replacements.get("seg-000001"), "大家好，今天我们聊聊雨天。\n这是第二行，仍然属于主播。");
  assert.equal(validated.replacements.get("seg-000002"), undefined);
  assert.equal(validated.replacements.get("seg-000003"), undefined);
  assert.deepEqual(validated.rejectedIds, ["seg-000002", "seg-000003"]);

  const oneId = new Set(["seg-000001"]);
  const empty = validateCleanupModelResult(document, parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "seg-000001", text: "   ", changes: [] }] })), oneId);
  assert.equal(empty.replacements.has("seg-000001"), false);
  const long = validateCleanupModelResult(document, parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "seg-000001", text: "x".repeat(300), changes: [] }] })), oneId);
  assert.ok(long.rejectedIds.includes("seg-000001"));
  const fakeRemoval = validateCleanupModelResult(document, parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "seg-000001", text: "x", changes: [{ type: "filler", from: "a", to: "x", confidence: 1 }] }] })), oneId);
  assert.ok(fakeRemoval.rejectedIds.includes("seg-000001"));
  const fenced = validateCleanupModelResult(document, parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "seg-000001", text: "###", changes: [] }] })), oneId);
  assert.ok(fenced.rejectedIds.includes("seg-000001"));
  assert.throws(() => validateCleanupModelResult(document, parseCleanupModelResult(JSON.stringify({ schemaVersion: 1, segments: [{ id: "seg-000001", text: "x", changes: [] }] })), new Set(["seg-000001", "extra"])), /missing|extra|ID/i);
});
