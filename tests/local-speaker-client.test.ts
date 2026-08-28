import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalSpeakerJob,
  getLocalSpeakerHealth,
  getLocalSpeakerJob,
  localSpeakerErrorMessage,
} from "../lib/local-speaker-client.ts";

test("长音频限制提示为 2 小时和 1GB", () => {
  assert.match(localSpeakerErrorMessage("AUDIO_TOO_LONG"), /2 小时/);
  assert.match(localSpeakerErrorMessage("AUDIO_TOO_LARGE"), /1GB/);
  assert.match(localSpeakerErrorMessage("AUDIO_DECODE_FAILED"), /解码/);
});

test("本地服务请求带专用请求头且不携带站点认证 cookie", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ service: "ok", ffmpegAvailable: true, model: "ready" });
    };

    await getLocalSpeakerHealth();

    assert.equal(request?.url, "http://localhost:8765/health");
    assert.equal(request?.headers.get("x-speaker-client-version"), "1");
    assert.equal(request?.credentials, "omit");
    assert.equal(request?.headers.has("cookie"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("创建本地任务只发送音频和说话人数", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ jobId: "local-job", status: "queued" }, { status: 202 });
    };
    const file = new File(["audio"], "dialogue.wav", { type: "audio/wav" });

    await createLocalSpeakerJob(file, 2);

    assert.equal(request?.url, "http://localhost:8765/jobs");
    assert.equal(request?.method, "POST");
    assert.equal(request?.credentials, "omit");
    const form = await request?.formData();
    assert.equal((form?.get("audio") as File).name, "dialogue.wav");
    assert.equal(form?.get("expectedSpeakers"), "2");
    assert.equal(form?.has("markdown"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("创建两人声纹任务发送模式和参考区间", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ jobId: "voiceprint-job", status: "queued" }, { status: 202 });
    };
    const file = new File(["audio"], "dialogue.wav", { type: "audio/wav" });
    await createLocalSpeakerJob(file, {
      mode: "voiceprint",
      references: {
        speaker_0: { startMs: 0, endMs: 10_000 },
        speaker_1: { startMs: 20_000, endMs: 30_000 },
      },
    });

    const form = await request?.formData();
    assert.equal(form?.get("mode"), "voiceprint");
    assert.deepEqual(JSON.parse(String(form?.get("references"))), {
      speaker_0: { startMs: 0, endMs: 10_000 },
      speaker_1: { startMs: 20_000, endMs: 30_000 },
    });
    assert.equal(form?.has("expectedSpeakers"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("翻译声纹任务错误码而不暴露服务端原文", () => {
  assert.match(localSpeakerErrorMessage("VOICEPRINT_REFERENCES_INVALID"), /参考/);
  assert.match(localSpeakerErrorMessage("VOICEPRINT_MODEL_UNAVAILABLE"), /声纹模型/);
  assert.match(localSpeakerErrorMessage("VOICEPRINT_LOW_CONFIDENCE"), /置信度/);
  assert.match(localSpeakerErrorMessage("VOICEPRINT_FAILED"), /声纹/);
});

test("创建远程音频声纹任务只发送源地址和参考区间", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ jobId: "remote-job", status: "queued" }, { status: 202 });
    };
    await createLocalSpeakerJob(
      { sourceUrl: "https://media.xyzcdn.net/a.m4a", fallbackUrl: "http://localhost:3000/api/episodes/e/audio-relay?ticket=t" },
      {
        mode: "voiceprint",
        references: {
          speaker_0: { startMs: 0, endMs: 10_000 },
          speaker_1: { startMs: 20_000, endMs: 30_000 },
        },
      },
    );

    const form = await request?.formData();
    assert.equal(form?.get("sourceUrl"), "https://media.xyzcdn.net/a.m4a");
    assert.equal(form?.get("fallbackUrl"), "http://localhost:3000/api/episodes/e/audio-relay?ticket=t");
    assert.equal(form?.get("mode"), "voiceprint");
    assert.deepEqual(JSON.parse(String(form?.get("references"))), {
      speaker_0: { startMs: 0, endMs: 10_000 },
      speaker_1: { startMs: 20_000, endMs: 30_000 },
    });
    assert.equal(form?.has("audio"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("远程音频下载错误映射为可重试中文提示", () => {
  assert.match(localSpeakerErrorMessage("AUDIO_DOWNLOAD_FAILED"), /下载失败/);
  assert.match(localSpeakerErrorMessage("AUDIO_HOST_NOT_ALLOWED"), /地址/);
  assert.match(localSpeakerErrorMessage("AUDIO_REDIRECT_NOT_ALLOWED"), /跳转/);
});

test("本地服务只返回受限结构并将模型配置错误翻译为中文", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ detail: "HF_TOKEN_MISSING" }, { status: 422 });
    await assert.rejects(getLocalSpeakerJob("job"), /Scripts\\hf\.exe auth login/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
