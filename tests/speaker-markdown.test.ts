import assert from "node:assert/strict";
import test from "node:test";
import { renderSpeakerMarkdown } from "../lib/speaker-markdown.ts";

const OFFICIAL_MARKDOWN = `---
source: "xiaoyuzhou"
transcript_layout: "semantic-v2"
organization_mode: "ai-boundaries"
---

# 测试节目

## Show Notes

保留这里。

## 官方文稿

[00:00:00] 你好

[00:00:02] 世界

[00:00:04] 回应
`;

test("仅在说话人变化时新建标题，保留每轮开头时间戳", () => {
  const markdown = renderSpeakerMarkdown(OFFICIAL_MARKDOWN, [
    { startMs: 0, endMs: 2_000, text: "你好", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
    { startMs: 2_000, endMs: 4_000, text: "世界", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
    { startMs: 4_000, endMs: 6_000, text: "回应", speakerId: "speaker_1", speakerConfidence: 1, speakerNeedsReview: false },
  ], [{ id: "speaker_0", label: "主持人" }, { id: "speaker_1", label: "嘉宾" }]);

  assert.match(markdown, /source: "xiaoyuzhou"/);
  assert.match(markdown, /transcript_layout: "speaker-v1"/);
  assert.match(markdown, /speaker_source: "pyannote-community-1"/);
  assert.doesNotMatch(markdown, /organization_mode|semantic-v2/);
  assert.match(markdown, /## Show Notes\n\n保留这里。/);
  assert.match(markdown, /### 主持人\n\n\[00:00:00\] 你好世界\n\n### 嘉宾\n\n\[00:00:04\] 回应/);
});

test("英文片段之间补空格，未确认片段不伪造身份", () => {
  const markdown = renderSpeakerMarkdown(OFFICIAL_MARKDOWN, [
    { startMs: 0, endMs: 2_000, text: "hello", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
    { startMs: 2_000, endMs: 4_000, text: "world", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
    { startMs: 4_000, endMs: 6_000, text: "不确定", speakerId: null, speakerConfidence: null, speakerNeedsReview: true },
  ], [{ id: "speaker_0", label: "说话人 1" }]);

  assert.match(markdown, /\[00:00:00\] hello world/);
  assert.match(markdown, /### 待确认\n\n\[00:00:04\] 不确定/);
});

test("声纹来源写入受限的 Markdown frontmatter", () => {
  const markdown = renderSpeakerMarkdown(OFFICIAL_MARKDOWN, [
    { startMs: 0, endMs: 2_000, text: "你好", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
  ], [{ id: "speaker_0", label: "主持人" }], "pyannote-wespeaker-voiceprint-v1");

  assert.match(markdown, /speaker_source: "pyannote-wespeaker-voiceprint-v1"/);
});
