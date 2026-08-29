import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { fetchOfficialAudio } from "../lib/xiaoyuzhou.ts";

type RouteDeps = Record<string, Record<string, unknown>>;

declare global {
  var __audioRouteTestDeps: RouteDeps | undefined;
  var __audioRouteTestEnv: Record<string, unknown> | undefined;
}

class TestHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function routeMockModule(specifier: string): string | undefined {
  const deps = globalThis.__audioRouteTestDeps;
  if (!deps) return undefined;
  const exports: Record<string, string> = {
    "@/lib/connection": "withFreshTokens",
    "@/lib/db": "getEpisodeRecord",
    "@/lib/runtime": "getRuntimeEnv",
    "@/lib/user": "apiError,HttpError,requireApiUser",
    "@/lib/xiaoyuzhou": "XiaoyuzhouError,fetchOfficialAudio,getOfficialEpisode,validateOfficialAudioUrl",
    "@/lib/audio-relay-ticket": "consumeAudioRelayTicket,issueAudioRelayTicket",
  };
  const names = exports[specifier];
  if (!names || !deps[specifier]) return undefined;
  const source = names.split(",").map((name) => {
    if (name === "HttpError" || name === "XiaoyuzhouError") {
      return `export const ${name} = globalThis.__audioRouteTestDeps[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`;
    }
    return `export const ${name} = (...args) => globalThis.__audioRouteTestDeps[${JSON.stringify(specifier)}][${JSON.stringify(name)}](...args);`;
  }).join("\n");
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export const env = globalThis.__audioRouteTestEnv;" };
    }
    const mockUrl = routeMockModule(specifier);
    if (mockUrl) return { shortCircuit: true, url: mockUrl };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

function baseDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const deps: RouteDeps = {
    "@/lib/connection": {
      withFreshTokens: async (_userId: string, operation: (tokens: object) => Promise<unknown>) => operation({ accessToken: "access", refreshToken: "refresh", deviceId: "device" }),
    },
    "@/lib/db": {
      getEpisodeRecord: async () => ({ eid: "episode-a", duration_seconds: 120 }),
    },
    "@/lib/runtime": { getRuntimeEnv: () => ({ DB: {} }) },
    "@/lib/user": {
      HttpError: TestHttpError,
      requireApiUser: async () => ({ userId: "user-a" }),
      apiError: (error: unknown) => {
        const typed = error as { status?: number; code?: string; message?: string };
        return Response.json(
          { error: typed.code ?? "INTERNAL_ERROR", message: typed.message ?? "处理请求时出现问题，请稍后重试" },
          { status: typed.status ?? 500 },
        );
      },
    },
    "@/lib/xiaoyuzhou": {
      XiaoyuzhouError: class extends Error {},
      getOfficialEpisode: async () => ({
        eid: "episode-a", title: "测试单集", podcastTitle: "测试节目", shownotesHtml: "",
        durationSeconds: 120, publishedAt: null, mediaId: "media", audioUrl: "https://media.xyzcdn.net/test.m4a", audioMimeType: "audio/mp4",
      }),
      validateOfficialAudioUrl: (url: string) => url,
      fetchOfficialAudio: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("audio"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "audio/mp4", "content-length": "5", "accept-ranges": "bytes", "x-private": "do-not-copy" } }),
    },
    "@/lib/audio-relay-ticket": {
      issueAudioRelayTicket: async () => "relay-ticket",
      consumeAudioRelayTicket: async () => ({ userId: "user-a", eid: "episode-a" }),
    },
  };
  for (const [specifier, values] of Object.entries(overrides)) deps[specifier] = { ...deps[specifier], ...values };
  return deps;
}

async function loadRoute(path: "audio-source" | "audio-relay") {
  const suffix = `${path}-${crypto.randomUUID()}`;
  return import(`${new URL(`../app/api/episodes/[eid]/${path}/route.ts`, import.meta.url).href}?test=${suffix}`);
}

test("audio source route refuses an episode that is not owned by the current user", async () => {
  globalThis.__audioRouteTestDeps = baseDeps({ "@/lib/db": { getEpisodeRecord: async () => null } });
  try {
    const route = await loadRoute("audio-source");
    const response = await route.GET(new Request("https://app.example/api/episodes/episode-a/audio-source"), { params: Promise.resolve({ eid: "episode-a" }) });
    assert.equal(response.status, 404);
  } finally {
    globalThis.__audioRouteTestDeps = undefined;
  }
});

test("audio source route returns a no-store direct URL and relay URL", async () => {
  let issued: { userId: string; eid: string; ttlSeconds: number } | undefined;
  globalThis.__audioRouteTestDeps = baseDeps({
    "@/lib/audio-relay-ticket": {
      issueAudioRelayTicket: async (_db: unknown, input: { userId: string; eid: string; ttlSeconds: number }) => { issued = input; return "relay-ticket"; },
    },
  });
  try {
    const route = await loadRoute("audio-source");
    const response = await route.GET(new Request("https://app.example/api/episodes/episode-a/audio-source"), { params: Promise.resolve({ eid: "episode-a" }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as Record<string, unknown>;
    assert.deepEqual({ ...payload, expiresAt: undefined }, {
      audioUrl: "https://media.xyzcdn.net/test.m4a",
      relayUrl: "https://app.example/api/episodes/episode-a/audio-relay?ticket=relay-ticket",
      mimeType: "audio/mp4",
      durationSeconds: 120,
      expiresAt: undefined,
    });
    assert.match(String(payload.expiresAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(issued, { userId: "user-a", eid: "episode-a", ttlSeconds: 90 });
  } finally {
    globalThis.__audioRouteTestDeps = undefined;
  }
});

test("audio source route reports a missing official audio URL", async () => {
  globalThis.__audioRouteTestDeps = baseDeps({ "@/lib/xiaoyuzhou": {
    getOfficialEpisode: async () => ({ audioUrl: null, audioMimeType: null, durationSeconds: null }),
  } });
  try {
    const route = await loadRoute("audio-source");
    const response = await route.GET(new Request("https://app.example/api/episodes/episode-a/audio-source"), { params: Promise.resolve({ eid: "episode-a" }) });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "NO_AUDIO", message: "该单集没有可用官方音频" });
  } finally {
    globalThis.__audioRouteTestDeps = undefined;
  }
});

test("audio relay consumes a valid ticket and streams only safe upstream headers", async () => {
  let fetchedUrl = "";
  globalThis.__audioRouteTestDeps = baseDeps({ "@/lib/xiaoyuzhou": {
    fetchOfficialAudio: async (url: string) => { fetchedUrl = url; return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("audio")); controller.close(); },
    }), { status: 200, headers: { "content-type": "audio/mp4", "content-length": "5", "accept-ranges": "bytes", "x-private": "no" } }); },
  } });
  try {
    const route = await loadRoute("audio-relay");
    const response = await route.GET(new Request("https://app.example/api/episodes/episode-a/audio-relay?ticket=relay-ticket"), { params: Promise.resolve({ eid: "episode-a" }) });
    assert.equal(response.status, 200);
    assert.equal(fetchedUrl, "https://media.xyzcdn.net/test.m4a");
    assert.equal(await response.text(), "audio");
    assert.equal(response.headers.get("content-type"), "audio/mp4");
    assert.equal(response.headers.get("content-length"), "5");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.has("x-private"), false);
  } finally {
    globalThis.__audioRouteTestDeps = undefined;
  }
});

test("audio relay rejects an expired or already consumed ticket", async () => {
  globalThis.__audioRouteTestDeps = baseDeps({ "@/lib/audio-relay-ticket": { consumeAudioRelayTicket: async () => null } });
  try {
    const route = await loadRoute("audio-relay");
    const response = await route.GET(new Request("https://app.example/api/episodes/episode-a/audio-relay?ticket=expired"), { params: Promise.resolve({ eid: "episode-a" }) });
    assert.equal(response.status, 410);
  } finally {
    globalThis.__audioRouteTestDeps = undefined;
  }
});

test("official audio fetch refuses a redirect to a non-official host", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.__audioRouteTestEnv = {};
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://example.com/private.m4a" } });
    };
    await assert.rejects(
      fetchOfficialAudio("https://media.xyzcdn.net/test.m4a"),
      (error: unknown) => (error as { code?: string }).code === "AUDIO_REDIRECT_NOT_ALLOWED",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__audioRouteTestEnv = undefined;
  }
});
