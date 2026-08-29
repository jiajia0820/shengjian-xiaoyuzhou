import assert from "node:assert/strict";
import test from "node:test";
import { isOfficialTarget, streamUpstreamResponse } from "../scripts/dev-upstream-proxy.mjs";

function fakeHttpResponse() {
  const chunks = [];
  return {
    chunks,
    headers: undefined,
    status: undefined,
    ended: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("official media responses stream without arrayBuffer and accept more than 32MB", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024));
      controller.enqueue(new Uint8Array(20 * 1024 * 1024));
      controller.close();
    },
  });
  const upstream = {
    status: 200,
    headers: new Headers({ "content-type": "audio/mp4" }),
    body,
    async arrayBuffer() {
      throw new Error("official media must never be buffered");
    },
  };
  const response = fakeHttpResponse();
  await streamUpstreamResponse(upstream, response, true);
  assert.equal(response.status, 200);
  assert.equal(response.ended, true);
  assert.equal(response.destroyed, false);
  assert.equal(response.chunks.reduce((sum, chunk) => sum + chunk.length, 0), 40 * 1024 * 1024);
});

test("ordinary upstream responses retain the 32MB cap", async () => {
  const response = fakeHttpResponse();
  let read = false;
  const upstream = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    async arrayBuffer() {
      read = true;
      return new Uint8Array(32 * 1024 * 1024 + 1).buffer;
    },
  };
  await streamUpstreamResponse(upstream, response, false);
  assert.equal(read, true);
  assert.equal(response.status, 502);
  assert.equal(response.ended, true);
  assert.match(response.chunks[0].toString(), /RESPONSE_TOO_LARGE/);
});

test("official target detection only marks Xiaoyuzhou media and API hosts", () => {
  assert.equal(isOfficialTarget(new URL("https://media.xyzcdn.net/test.m4a")), true);
  assert.equal(isOfficialTarget(new URL("https://api.xiaoyuzhoufm.com/v1/episode/get")), true);
  assert.equal(isOfficialTarget(new URL("https://example.com/audio.m4a")), false);
});
