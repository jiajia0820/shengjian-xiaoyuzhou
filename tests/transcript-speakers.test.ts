import assert from "node:assert/strict";
import test from "node:test";
import {
  alignTranscriptSpeakers,
  applySpeakerOverrides,
  normalizeDiarizationTurns,
  normalizeSpeakerLabels,
} from "../lib/transcript-speakers.ts";

test("按累计重叠选择说话人，并标记跨越两位说话人的片段", () => {
  const result = alignTranscriptSpeakers([
    { startMs: 0, endMs: null, text: "甲" },
    { startMs: 10_000, endMs: 12_000, text: "乙" },
  ], [
    { startMs: 0, endMs: 8_000, speakerId: "speaker_0" },
    { startMs: 8_000, endMs: 12_000, speakerId: "speaker_1" },
  ], 12_000);

  assert.deepEqual(result.segments.map(({ speakerId, speakerConfidence, speakerNeedsReview }) => ({
    speakerId, speakerConfidence, speakerNeedsReview,
  })), [
    { speakerId: "speaker_0", speakerConfidence: 0.8, speakerNeedsReview: true },
    { speakerId: "speaker_1", speakerConfidence: 1, speakerNeedsReview: false },
  ]);
});

test("低覆盖率和无重叠的片段均需要人工确认", () => {
  const result = alignTranscriptSpeakers([
    { startMs: 0, endMs: 10_000, text: "甲" },
    { startMs: 10_000, endMs: 12_000, text: "乙" },
  ], [{ startMs: 4_000, endMs: 8_000, speakerId: "speaker_0" }], 12_000);

  assert.deepEqual(result.segments.map(({ speakerId, speakerConfidence, speakerNeedsReview }) => ({
    speakerId, speakerConfidence, speakerNeedsReview,
  })), [
    { speakerId: "speaker_0", speakerConfidence: 0.4, speakerNeedsReview: true },
    { speakerId: null, speakerConfidence: null, speakerNeedsReview: true },
  ]);
});

test("拒绝倒置、相交和乱序的本地时间区间", () => {
  assert.throws(() => normalizeDiarizationTurns([{ startMs: 9, endMs: 2, speakerId: "speaker_0" }]));
  assert.throws(() => normalizeDiarizationTurns([
    { startMs: 0, endMs: 3, speakerId: "speaker_0" },
    { startMs: 2, endMs: 4, speakerId: "speaker_1" },
  ]));
  assert.throws(() => normalizeDiarizationTurns([
    { startMs: 5, endMs: 8, speakerId: "speaker_0" },
    { startMs: 0, endMs: 4, speakerId: "speaker_1" },
  ]));
});

test("补齐匿名标签，并仅接受已识别说话人的唯一名称", () => {
  assert.deepEqual(normalizeSpeakerLabels(undefined, ["speaker_0", "speaker_1"]), [
    { id: "speaker_0", label: "说话人 1" },
    { id: "speaker_1", label: "说话人 2" },
  ]);
  assert.throws(() => normalizeSpeakerLabels([
    { id: "speaker_0", label: "主持人" },
    { id: "speaker_9", label: "嘉宾" },
  ], ["speaker_0", "speaker_1"]));
});

test("只允许按片段索引修正已识别的说话人", () => {
  const segments = alignTranscriptSpeakers([
    { startMs: 0, endMs: 1_000, text: "甲" },
  ], [{ startMs: 0, endMs: 1_000, speakerId: "speaker_0" }], 1_000).segments;

  assert.deepEqual(applySpeakerOverrides(segments, [{ index: 0, speakerId: null }], ["speaker_0"])[0], {
    ...segments[0], speakerId: null, speakerNeedsReview: true,
  });
  assert.throws(() => applySpeakerOverrides(segments, [{ index: 3, speakerId: "speaker_0" }], ["speaker_0"]));
});
