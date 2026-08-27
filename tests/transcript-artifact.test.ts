import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptArtifact, parseTranscriptArtifact } from "../lib/transcript-artifact.ts";

test("将官方片段保存为 v2，并补齐空的说话人字段", () => {
  const artifact = buildTranscriptArtifact("episode", [{
    startMs: 0,
    endMs: 800,
    text: "原文",
  }], "2026-08-24T00:00:00.000Z");

  assert.equal(artifact.schemaVersion, 2);
  assert.deepEqual(artifact.speakerLayout, null);
  assert.deepEqual(artifact.segments[0], {
    startMs: 0,
    endMs: 800,
    text: "原文",
    speakerId: null,
    speakerConfidence: null,
    speakerNeedsReview: false,
  });
});

test("拒绝不合法的说话人覆盖率", () => {
  const parsed = parseTranscriptArtifact(JSON.stringify({
    schemaVersion: 2,
    source: "xiaoyuzhou",
    episodeId: "episode",
    capturedAt: "2026-08-24T00:00:00.000Z",
    speakerLayout: null,
    segments: [{
      startMs: 0,
      endMs: null,
      text: "原文",
      speakerId: "speaker_0",
      speakerConfidence: 2,
      speakerNeedsReview: false,
    }],
  }));

  assert.equal(parsed, null);
});

test("读取旧 v1 旁车文件时升级并补齐说话人字段", () => {
  const parsed = parseTranscriptArtifact(JSON.stringify({
    schemaVersion: 1,
    source: "xiaoyuzhou",
    episodeId: "episode",
    capturedAt: "2026-08-24T00:00:00.000Z",
    segments: [{ startMs: 0, text: "原文" }],
  }));

  assert.equal(parsed?.schemaVersion, 2);
  assert.deepEqual(parsed?.segments[0], {
    startMs: 0,
    endMs: null,
    text: "原文",
    speakerId: null,
    speakerConfidence: null,
    speakerNeedsReview: false,
  });
});

test("读取并保留两人声纹来源", () => {
  const parsed = parseTranscriptArtifact(JSON.stringify({
    schemaVersion: 2,
    source: "xiaoyuzhou",
    episodeId: "episode",
    capturedAt: "2026-08-24T00:00:00.000Z",
    speakerLayout: {
      engine: "pyannote-wespeaker-voiceprint-v1",
      generatedAt: "2026-08-24T00:00:01.000Z",
      currentMarkdownHash: "hash",
      labels: [{ id: "speaker_0", label: "主持人" }],
    },
    segments: [{ startMs: 0, text: "原文" }],
  }));

  assert.equal(parsed?.speakerLayout?.engine, "pyannote-wespeaker-voiceprint-v1");
});
