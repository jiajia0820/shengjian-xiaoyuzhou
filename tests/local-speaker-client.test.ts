import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalSpeakerJob,
  getLocalSpeakerHealth,
  getLocalSpeakerJob,
} from "../lib/local-speaker-client.ts";

test("本地服务请求带专用请求头且不携带站点认证 cookie", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ service: "ok", ffmpegAvailable: true, model: "ready" });
    };

    await getLocalSpeakerHealth();

    assert.equal(request?.url, "http://127.0.0.1:8765/health");
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

    assert.equal(request?.url, "http://127.0.0.1:8765/jobs");
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

test("本地服务只返回受限结构并将模型配置错误翻译为中文", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ detail: "HF_TOKEN_MISSING" }, { status: 422 });
    await assert.rejects(getLocalSpeakerJob("job"), /运行 hf auth login/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
