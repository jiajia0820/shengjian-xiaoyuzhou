const API_BASE = "https://api.xiaoyuzhoufm.com";
const PODCASTER_BASE = "https://podcaster-api.xiaoyuzhoufm.com";
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

export type TranscriptSegment = { startMs: number; text: string };

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
  return typeof body.message === "string" && body.message ? body.message : fallback;
}

export async function sendSmsCode(phone: string, areaCode: string): Promise<void> {
  const response = await fetch(`${PODCASTER_BASE}/v1/auth/send-code`, {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({ mobilePhoneNumber: phone, areaCode }),
  });
  if (!response.ok) {
    const body = await safeJson(response);
    throw new XiaoyuzhouError("SEND_CODE_FAILED", responseMessage(body, "验证码发送失败，请检查手机号或稍后重试"), 400);
  }
}

export async function loginWithSms(phone: string, areaCode: string, verifyCode: string): Promise<XiaoyuzhouTokens> {
  const response = await fetch(`${PODCASTER_BASE}/v1/auth/login-with-sms`, {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({ mobilePhoneNumber: phone, areaCode, verifyCode }),
  });
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
  const response = await fetch(`${API_BASE}/app_auth_tokens.refresh`, {
    method: "POST",
    headers: appHeaders({ refreshToken: tokens.refreshToken, deviceId: tokens.deviceId }),
  });
  if (!response.ok) throw new XiaoyuzhouError("AUTH_EXPIRED", "小宇宙授权已失效，请重新连接账号", 401);
  const body = await safeJson(response);
  const accessToken = response.headers.get("x-jike-access-token") || (body["x-jike-access-token"] as string | undefined);
  const refreshToken = response.headers.get("x-jike-refresh-token") || (body["x-jike-refresh-token"] as string | undefined) || tokens.refreshToken;
  if (!accessToken) throw new XiaoyuzhouError("AUTH_EXPIRED", "小宇宙授权刷新失败，请重新连接账号", 401);
  return { accessToken, refreshToken, deviceId: tokens.deviceId };
}

async function authenticatedRequest(path: string, tokens: XiaoyuzhouTokens, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: appHeaders(tokens) });
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
  const podcast = objectValue(episode.podcast);
  const media = objectValue(episode.media);
  const transcript = objectValue(episode.transcript);
  const mediaId = episode.transcriptMediaId || transcript.mediaId || media.id;
  if (!episode.eid || !episode.title) throw new XiaoyuzhouError("EPISODE_NOT_FOUND", "没有找到这个小宇宙单集", 404);
  return {
    eid: String(episode.eid),
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
  const transcriptResponse = await fetch(url, { headers: { "user-agent": APP_USER_AGENT }, redirect: "follow" });
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
    return [{ startMs: Number.isFinite(startMs) && startMs >= 0 ? Math.floor(startMs) : 0, text }];
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
