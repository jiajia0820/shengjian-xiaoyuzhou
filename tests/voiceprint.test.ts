import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceprintTimestamp, validateVoiceprintReferences } from "../lib/voiceprint.ts";

test("解析两人声纹参考位置的分秒格式", () => {
  assert.equal(parseVoiceprintTimestamp("10:39"), 639_000);
  assert.equal(parseVoiceprintTimestamp("90:05"), 5_405_000);
  assert.equal(parseVoiceprintTimestamp("10：39"), 639_000);
  assert.equal(parseVoiceprintTimestamp("10分39秒"), 639_000);
  assert.equal(parseVoiceprintTimestamp("10:60"), null);
  assert.equal(parseVoiceprintTimestamp("10"), null);
});

test("浏览器端接受 5–30 秒参考并拒绝过短、超时和重叠", () => {
  assert.equal(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 5_000 },
    speaker_1: { startMs: 20_000, endMs: 30_000 },
  }, 60_000), null);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 4_999 },
    speaker_1: { startMs: 20_000, endMs: 30_000 },
  }, 60_000) ?? "", /5 秒/);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 5_000, endMs: 20_000 },
  }, 60_000) ?? "", /重叠/);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 55_000, endMs: 65_000 },
  }, 60_000) ?? "", /时长/);
});
