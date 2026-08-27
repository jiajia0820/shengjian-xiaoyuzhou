import assert from "node:assert/strict";
import test from "node:test";
import { validateVoiceprintReferences } from "../lib/voiceprint.ts";

test("浏览器端接受两段有效参考并拒绝空范围、超时和重叠", () => {
  assert.equal(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 20_000, endMs: 30_000 },
  }, 60_000), null);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 9_999 },
    speaker_1: { startMs: 20_000, endMs: 30_000 },
  }, 60_000) ?? "", /10 秒/);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 5_000, endMs: 20_000 },
  }, 60_000) ?? "", /重叠/);
  assert.match(validateVoiceprintReferences({
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 55_000, endMs: 65_000 },
  }, 60_000) ?? "", /时长/);
});
