import {
  buildSmsCodeRequestBody,
  type XiaoyuzhouCaptcha,
} from "./xiaoyuzhou-auth.ts";

const API_BASE = "https://api.xiaoyuzhoufm.com";
const PODCASTER_BASE = "https://web-api.xiaoyuzhoufm.com";
const APP_USER_AGENT = "Xiaoyuzhou/2.99.1(android 28)";

export type XiaoyuzhouTokens = {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
};

export type OfficialEpisode = {
  eid: string;
  title: string;
  podcastTitle: string;
  shownotesHtml: string;
  durationSeconds: number | null;
  publishedAt: string | null;
  mediaId: string | null;
};

export type TranscriptSegment = {
  startMs: number;
  endMs?: number | null;
  text: string;
  speakerId?: string | null;
  speakerConfidence?: number | null;
  speakerNeedsReview?: boolean;
};

export class XiaoyuzhouError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function localTime(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(" ", "T");
  return `${parts}.000+0800`;
}

function appHeaders(tokens?: Partial<XiaoyuzhouTokens>): HeadersInit {
  const headers: Record<string, string> = {
    os: "android",
    "os-version": "28",
    manufacturer: "Xiaomi",
    model: "MI 6",
    resolution: "1080x1920",
    market: "xiaomi",
    applicationid: "app.podcast.cosmos",
    "app-version": "2.99.1",
    "app-buildno": "1362",
    webviewversion: "138.0.7204.179",
    "user-agent": APP_USER_AGENT,
    "app-permissions": "100100",
    wificonnected: "false",
    timezone: "Asia/Shanghai",
    "local-time": localTime(),
    "content-type": "application/json;charset=utf-8",
  };
  if (tokens?.accessToken) headers["x-jike-access-token"] = tokens.accessToken;
  if (tokens?.refreshToken) headers["x-jike-refresh-token"] = tokens.refreshToken;
  if (tokens?.deviceId) headers["x-jike-device-id"] = tokens.deviceId;
  return headers;
}

const webHeaders: HeadersInit = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json;charset=UTF-8",
  origin: "https://podcaster.xiaoyuzhoufm.com",
  referer: "https://podcaster.xiaoyuzhoufm.com/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function responseMessage(body: Record<string, unknown>, fallback: string): string {
  for (const key of ["message", "toast", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      const message = value.trim();
      if (/^(?:wrong|invalid|incorrect)\s+(?:sms|verification)\s+code$/i.test(message)
        || /^(?:sms|verification)\s+code\s+(?:is\s+)?(?:wrong|invalid|incorrect|expired)$/i.test(message)) {
        return "验证码错误或已过期，请重新发送并输入最新验证码";
      }
      return message.slice(0, 240);
    }
  }
  return fallback;
}

async function fetchUpstream(
  input: string | URL,
  init: RequestInit,
  code: string,
  message: string,
): Promise<Response> {
  try {
    // Keep this import lazy: the same module is also exercised by the Node test
    // runner, where the Cloudflare-only `cloudflare:workers` specifier is
    // installed by a test hook after static imports have been evaluated.
    const { getRuntimeEnv } = await import("./runtime.ts");
    const proxyUrl = getRuntimeEnv().XIAOYUZHOU_DEV_PROXY_URL?.trim();
    const proxyToken = getRuntimeEnv().XIAOYUZHOU_DEV_PROXY_TOKEN?.trim();
    if (!proxyUrl || !proxyToken) return await fetch(input, init);

    let proxy: URL;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      return await fetch(input, init);
    }
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return await fetch(input, init);
    if (!(proxy.hostname === "localhost" || proxy.hostname === "127.0.0.1" || proxy.hostname === "::1")) {
      return await fetch(input, init);
    }

    const headers = new Headers(init.headers);
    headers.set("x-xiaoyuzhou-target", input.toString());
    headers.set("x-xiaoyuzhou-token", proxyToken);
    return await fetch(proxy, { ...init, headers });
  } catch {
    throw new XiaoyuzhouError(code, message, 503);
  }
}

export async function sendSmsCode(phone: string, areaCode: string, captcha: XiaoyuzhouCaptcha): Promise<void> {
  const response = await fetchUpstream(
    `${PODCASTER_BASE}/v1/auth/send-code`,
    {
      method: "POST",
      headers: webHeaders,
      body: JSON.stringify(buildSmsCodeRequestBody(phone, areaCode, captcha)),
    },
    "UPSTREAM_UNREACHABLE",
    "小宇宙验证码服务暂时无法连接，请稍后重试",
  );
  if (!response.ok) {
    const body = await safeJson(response);
    throw new XiaoyuzhouError("SEND_CODE_FAILED", responseMessage(body, "验证码发送失败，请检查手机号或稍后重试"), 400);
  }
}

export async function loginWithSms(phone: string, areaCode: string, verifyCode: string): Promise<XiaoyuzhouTokens> {
  const response = await fetchUpstream(
    `${PODCASTER_BASE}/v1/auth/login-with-sms`,
    {
      method: "POST",
      headers: webHeaders,
      body: JSON.stringify({ mobilePhoneNumber: phone, areaCode, verifyCode }),
    },
    "UPSTREAM_UNREACHABLE",
    "小宇宙登录服务暂时无法连接，请稍后重试",
  );
  if (!response.ok) {
    const body = await safeJson(response);
    throw new XiaoyuzhouError("LOGIN_FAILED", responseMessage(body, "验证码错误或已过期"), 400);
  }
  const accessToken = response.headers.get("x-jike-access-token");
  const refreshToken = response.headers.get("x-jike-refresh-token");
  if (!accessToken || !refreshToken) {
    throw new XiaoyuzhouError("LOGIN_RESPONSE_INVALID", "小宇宙登录成功，但没有返回可用授权信息");
  }
  return { accessToken, refreshToken, deviceId: crypto.randomUUID() };
}

export async function refreshTokens(tokens: XiaoyuzhouTokens): Promise<XiaoyuzhouTokens> {
  const response = await fetchUpstream(
    `${API_BASE}/app_auth_tokens.refresh`,
    {
      method: "POST",
      headers: appHeaders({ refreshToken: tokens.refreshToken, deviceId: tokens.deviceId }),
    },
    "UPSTREAM_UNREACHABLE",
    "小宇宙授权服务暂时无法连接，请稍后重试",
  );
  if (!response.ok) throw new XiaoyuzhouError("AUTH_EXPIRED", "小宇宙授权已失效，请重新连接账号", 401);
  const body = await safeJson(response);
  const accessToken = response.headers.get("x-jike-access-token") || (body["x-jike-access-token"] as string | undefined);
  const refreshToken = response.headers.get("x-jike-refresh-token") || (body["x-jike-refresh-token"] as string | undefined) || tokens.refreshToken;
  if (!accessToken) throw new XiaoyuzhouError("AUTH_EXPIRED", "小宇宙授权刷新失败，请重新连接账号", 401);
  return { accessToken, refreshToken, deviceId: tokens.deviceId };
}

async function authenticatedRequest(path: string, tokens: XiaoyuzhouTokens, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchUpstream(
    `${API_BASE}${path}`,
    { ...init, headers: appHeaders(tokens) },
    "UPSTREAM_UNREACHABLE",
    "小宇宙接口暂时无法连接，请稍后重试",
  );
  if (response.status === 401) throw new XiaoyuzhouError("AUTH_EXPIRED", "小宇宙授权已过期", 401);
  if (!response.ok) throw new XiaoyuzhouError("UPSTREAM_ERROR", `小宇宙接口暂时不可用（${response.status}）`);
  return safeJson(response);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getOfficialEpisode(eid: string, tokens: XiaoyuzhouTokens): Promise<OfficialEpisode> {
  const response = await authenticatedRequest(`/v1/episode/get?eid=${encodeURIComponent(eid)}`, tokens, { method: "GET" });
  const episode = objectValue(response.data);
  const episodeId = episode.eid || episode.id;
  const podcast = objectValue(episode.podcast);
  const media = objectValue(episode.media);
  const transcript = objectValue(episode.transcript);
  const mediaId = episode.transcriptMediaId || transcript.mediaId || media.id;
  if (!episodeId || !episode.title) throw new XiaoyuzhouError("EPISODE_NOT_FOUND", "没有找到这个小宇宙单集", 404);
  return {
    eid: String(episodeId),
    title: String(episode.title),
    podcastTitle: String(podcast.title || "未知节目"),
    shownotesHtml: typeof episode.shownotes === "string" ? episode.shownotes : "",
    durationSeconds: Number.isFinite(Number(episode.duration)) ? Number(episode.duration) : null,
    publishedAt: typeof episode.pubDate === "string" ? episode.pubDate : null,
    mediaId: typeof mediaId === "string" && mediaId ? mediaId : null,
  };
}

export async function getTranscriptSegments(eid: string, mediaId: string, tokens: XiaoyuzhouTokens): Promise<TranscriptSegment[]> {
  const response = await authenticatedRequest("/v1/episode-transcript/get", tokens, {
    method: "POST",
    body: JSON.stringify({ eid, mediaId }),
  });
  let inner = objectValue(response.data);
  if (inner.data && typeof inner.data === "object") inner = objectValue(inner.data);
  const transcriptUrl = inner.transcriptUrl;
  if (typeof transcriptUrl !== "string" || !transcriptUrl) {
    throw new XiaoyuzhouError("NO_TRANSCRIPT", "该单集暂无小宇宙官方文稿", 404);
  }
  let url: URL;
  try { url = new URL(transcriptUrl); } catch { throw new XiaoyuzhouError("TRANSCRIPT_URL_INVALID", "小宇宙返回了无效的文稿地址"); }
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new XiaoyuzhouError("TRANSCRIPT_URL_INVALID", "小宇宙返回了不安全的文稿地址");
  }
  const transcriptResponse = await fetchUpstream(
    url,
    { headers: { "user-agent": APP_USER_AGENT }, redirect: "follow" },
    "TRANSCRIPT_FETCH_FAILED",
    "官方文稿下载服务暂时无法连接，请稍后重试",
  );
  if (!transcriptResponse.ok) {
    throw new XiaoyuzhouError("TRANSCRIPT_FETCH_FAILED", `官方文稿下载失败（${transcriptResponse.status}）`);
  }
  const raw = await transcriptResponse.json() as unknown;
  const list = Array.isArray(raw) ? raw : Array.isArray(objectValue(raw).data) ? objectValue(raw).data as unknown[] : null;
  if (!list) throw new XiaoyuzhouError("TRANSCRIPT_INVALID", "官方文稿格式发生变化，暂时无法解析");
  return list.slice(0, 100_000).flatMap((item) => {
    const segment = objectValue(item);
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) return [];
    const startMs = Number(segment.startMs);
    const normalizedStartMs = Number.isFinite(startMs) && startMs >= 0 ? Math.floor(startMs) : 0;
    const rawEndMs = Number(segment.endMs);
    const endMs = Number.isFinite(rawEndMs) && rawEndMs >= normalizedStartMs ? Math.floor(rawEndMs) : null;
    return [{ startMs: normalizedStartMs, endMs, text }];
  });
}

export function parseEpisodeUrl(value: string): { eid: string; canonicalUrl: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new XiaoyuzhouError("INVALID_URL", "请输入有效的小宇宙单集链接", 400); }
  const host = url.hostname.toLowerCase();
  if (!(["xiaoyuzhoufm.com", "www.xiaoyuzhoufm.com"].includes(host)) || url.protocol !== "https:") {
    throw new XiaoyuzhouError("INVALID_URL", "仅支持 https://www.xiaoyuzhoufm.com/episode/... 链接", 400);
  }
  const match = url.pathname.match(/^\/episode\/([a-f0-9]{24})\/?$/i);
  if (!match) throw new XiaoyuzhouError("INVALID_URL", "链接中没有有效的小宇宙单集 ID", 400);
  const eid = match[1].toLowerCase();
  return { eid, canonicalUrl: `https://www.xiaoyuzhoufm.com/episode/${eid}` };
}
