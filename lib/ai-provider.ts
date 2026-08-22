import { HttpError } from "./http-error.ts";

export type AiProvider = "deepseek" | "custom";
export type AiApiFormat = "chat_completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high";

export type ModelRequest = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
};

export type CustomAiRuntimeConfig = {
  provider: "custom";
  apiKey: string;
  baseUrl: string;
  model: string;
  apiFormat: AiApiFormat;
  reasoningEffort: ReasoningEffort | null;
};

export type DeepseekAiRuntimeConfig = {
  provider: "deepseek";
  apiKey: string;
  baseUrl: null;
  model: "deepseek-v4-flash";
  apiFormat: "chat_completions";
  reasoningEffort: null;
};

export type AiRuntimeConfig = DeepseekAiRuntimeConfig | CustomAiRuntimeConfig;

export type ModelResponse = {
  text: string;
  provider: AiProvider;
  apiFormat: AiApiFormat;
  model: string;
};

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MODEL_TIMEOUT_MS = 120_000;
const DNS_TIMEOUT_MS = 5_000;
const DNS_OVER_HTTPS_URL = "https://cloudflare-dns.com/dns-query";

type DeepseekClientOptions = {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
};

type DeepseekRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  stream: false;
  max_tokens: number;
  thinking: { type: "disabled" };
};

type DeepseekClient = {
  chat: {
    completions: {
      create(request: DeepseekRequest): Promise<unknown>;
    };
  };
};

type DeepseekClientFactory = (options: DeepseekClientOptions) => Promise<DeepseekClient>;

export type ModelExecutionOptions = {
  fetchImplementation?: typeof fetch;
  createDeepseekClient?: DeepseekClientFactory;
  resolveHostname?: HostnameResolver;
};

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

const PRIVATE_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
  "intranet",
  "localdomain",
  "onion",
] as const;

export function normalizeCustomBaseUrl(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 2_048 || clean.includes("?") || clean.includes("#")) {
    throw new Error("INVALID_CUSTOM_BASE_URL");
  }
  const url = new URL(clean);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const isIpv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);
  const isIpv6 = hostname.startsWith("[") || hostname.includes(":");
  const isPrivateName = !hostname.includes(".") || PRIVATE_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (url.protocol !== "https:" || !hostname || url.username || url.password || url.search || url.hash
    || isIpv4 || isIpv6 || isPrivateName) throw new Error("INVALID_CUSTOM_BASE_URL");
  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((part) => part >= 0 && part <= 255) ? bytes : null;
}

function isPublicIpv4(value: string): boolean {
  const bytes = ipv4Bytes(value);
  if (!bytes) return false;
  const [a, b, c] = bytes;
  return !(a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 31 && c === 196
    || a === 192 && b === 52 && c === 193
    || a === 192 && b === 88 && c === 99
    || a === 192 && b === 168
    || a === 192 && b === 175 && c === 48
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224);
}

function ipv6Segments(value: string): number[] | null {
  if (!value || value.includes("%") || value.indexOf("::") !== value.lastIndexOf("::")) return null;
  const ipv4Index = value.lastIndexOf(":");
  let normalized = value;
  if (value.includes(".")) {
    if (ipv4Index < 0) return null;
    const bytes = ipv4Bytes(value.slice(ipv4Index + 1));
    if (!bytes) return null;
    normalized = `${value.slice(0, ipv4Index)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const compressed = normalized.includes("::");
  const [left = "", right = ""] = normalized.split("::");
  const parseSide = (side: string) => side ? side.split(":").map((part) => (
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN
  )) : [];
  const leftSegments = parseSide(left);
  const rightSegments = parseSide(right);
  if ([...leftSegments, ...rightSegments].some(Number.isNaN)) return null;
  if (!compressed) return leftSegments.length === 8 ? leftSegments : null;
  const missing = 8 - leftSegments.length - rightSegments.length;
  if (missing < 1) return null;
  return [...leftSegments, ...Array<number>(missing).fill(0), ...rightSegments];
}

function isPublicIpv6(value: string): boolean {
  const segments = ipv6Segments(value);
  if (!segments) return false;
  const [first, second] = segments;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

function isPublicIpAddress(value: string): boolean {
  return value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
}

type DnsJsonResponse = {
  Status?: unknown;
  Answer?: Array<{ type?: unknown; data?: unknown }>;
};

export async function resolveHostnameViaDoh(
  hostname: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string[]> {
  const lookup = async (recordType: "A" | "AAAA", answerType: 1 | 28) => {
    const resolverUrl = new URL(DNS_OVER_HTTPS_URL);
    resolverUrl.searchParams.set("name", hostname);
    resolverUrl.searchParams.set("type", recordType);
    const response = await fetchImplementation(resolverUrl, {
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("DNS_RESOLUTION_FAILED");
    const payload = await response.json() as DnsJsonResponse;
    if (payload.Status !== 0) return [];
    return (payload.Answer ?? []).flatMap((answer) => (
      answer.type === answerType && typeof answer.data === "string" ? [answer.data] : []
    ));
  };
  const [ipv4, ipv6] = await Promise.all([lookup("A", 1), lookup("AAAA", 28)]);
  return [...ipv4, ...ipv6];
}

async function assertPublicHostname(hostname: string, resolveHostname: HostnameResolver): Promise<void> {
  try {
    const addresses = await resolveHostname(hostname);
    if (addresses.length > 0 && addresses.every(isPublicIpAddress)) return;
  } catch {
    // Resolution details can contain the configured hostname; map all failures below.
  }
  throw new HttpError(400, "AI_UNSAFE_ENDPOINT", "自定义 API 地址未通过公网安全检查");
}

export function buildCustomModelRequest(config: CustomAiRuntimeConfig, request: ModelRequest) {
  if (config.apiFormat === "chat_completions") {
    return {
      url: new URL("chat/completions", `${config.baseUrl}/`).toString(),
      body: {
        model: config.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
        stream: false,
        max_tokens: request.maxOutputTokens,
      },
    };
  }
  const url = new URL("responses", `${config.baseUrl}/`).toString();
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: request.instructions,
    input: request.input,
    max_output_tokens: request.maxOutputTokens,
  };
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
  return {
    url,
    body,
  };
}

function cleanModelMarkdown(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function assertSafeModelOutput(text: string, sensitiveValues: readonly string[]): void {
  if (sensitiveValues.some((value) => value.length > 0 && text.includes(value))) {
    throw new HttpError(502, "AI_SENSITIVE_OUTPUT", "AI 返回内容未通过安全检查，请稍后重试");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function responseOutputText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) return "";
  return value.output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return [];
    return item.content.flatMap((content) => (
      isRecord(content) && content.type === "output_text" && typeof content.text === "string"
        ? [content.text]
        : []
    ));
  }).join("\n");
}

function chatCompletionText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) return "";
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  return typeof choice.message.content === "string" ? choice.message.content : "";
}

async function createDeepseekClient(options: DeepseekClientOptions): Promise<DeepseekClient> {
  const { default: OpenAI } = await import("openai");
  return new OpenAI(options) as unknown as DeepseekClient;
}

function buildDeepseekModelRequest(
  request: ModelRequest,
  model: DeepseekAiRuntimeConfig["model"],
): DeepseekRequest {
  return {
    model,
    messages: [
      { role: "system", content: request.instructions },
      { role: "user", content: request.input },
    ],
    stream: false,
    max_tokens: request.maxOutputTokens,
    thinking: { type: "disabled" },
  };
}

export async function requestDeepseekModel(
  config: DeepseekAiRuntimeConfig,
  request: ModelRequest,
  clientFactory: DeepseekClientFactory = createDeepseekClient,
): Promise<ModelResponse> {
  try {
    const client = await clientFactory({
      apiKey: config.apiKey,
      baseURL: DEEPSEEK_BASE_URL,
      timeout: MODEL_TIMEOUT_MS,
      maxRetries: 1,
    });
    const response = await client.chat.completions.create(buildDeepseekModelRequest(request, config.model));
    const text = cleanModelMarkdown(chatCompletionText(response));
    if (!text) throw new HttpError(502, "AI_EMPTY_OUTPUT", "AI 没有返回可用内容，请稍后重试");
    assertSafeModelOutput(text, [config.apiKey, `Bearer ${config.apiKey}`]);
    return {
      text,
      provider: "deepseek",
      apiFormat: config.apiFormat,
      model: config.model,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
    if (status === 401 || status === 403) {
      throw new HttpError(400, "AI_CREDENTIAL_ERROR", "DeepSeek API Key 无效，请在 AI 设置中重新填写");
    }
    if (status === 402 || status === 429) {
      throw new HttpError(status, "AI_RATE_LIMITED", "DeepSeek 余额不足或调用过于频繁，请检查账户后重试");
    }
    if (status >= 500) {
      throw new HttpError(502, "AI_UPSTREAM_ERROR", "AI 服务暂时不可用，请稍后重试");
    }
    throw new HttpError(504, "AI_TIMEOUT", "DeepSeek 分析超时，请稍后重试");
  }
}

export async function requestCustomModel(
  config: CustomAiRuntimeConfig,
  request: ModelRequest,
  fetchImplementation: typeof fetch = fetch,
  resolveHostname: HostnameResolver = resolveHostnameViaDoh,
): Promise<ModelResponse> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeCustomBaseUrl(config.baseUrl);
  } catch {
    throw new HttpError(400, "AI_UNSAFE_ENDPOINT", "自定义 API 地址未通过公网安全检查");
  }
  const runtimeConfig = { ...config, baseUrl: normalizedBaseUrl };
  // Workers Fetch cannot pin the TLS connection to this preflight result. Re-resolve for every
  // request, reject mixed public/private answers, and keep the provider fetch on manual redirects.
  await assertPublicHostname(new URL(normalizedBaseUrl).hostname, resolveHostname);
  const prepared = buildCustomModelRequest(runtimeConfig, request);
  let response: Response;
  try {
    response = await fetchImplementation(prepared.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(prepared.body),
      redirect: "manual",
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new HttpError(504, "AI_TIMEOUT", "自定义 API 分析超时，请稍后重试");
    }
    throw new HttpError(502, "AI_UPSTREAM_ERROR", "自定义 API 服务暂时不可用或不兼容，请稍后重试");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(400, "AI_CREDENTIAL_ERROR", "自定义 API Key 无效，请在 AI 设置中重新填写");
  }
  if (response.status === 402 || response.status === 429) {
    throw new HttpError(response.status, "AI_RATE_LIMITED", "自定义 API 余额不足或调用过于频繁，请检查账户后重试");
  }
  if (!response.ok) {
    throw new HttpError(502, "AI_UPSTREAM_ERROR", "自定义 API 服务暂时不可用或不兼容，请稍后重试");
  }
  const payload = await response.json().catch(() => null);
  const rawText = config.apiFormat === "responses" ? responseOutputText(payload) : chatCompletionText(payload);
  const text = cleanModelMarkdown(rawText);
  if (!text) {
    throw new HttpError(502, "AI_EMPTY_OUTPUT", "自定义 API 没有返回可用内容，请稍后重试");
  }
  assertSafeModelOutput(text, [
    runtimeConfig.apiKey,
    `Bearer ${runtimeConfig.apiKey}`,
    runtimeConfig.baseUrl,
    `${runtimeConfig.baseUrl}/`,
  ]);
  return { text, provider: "custom", apiFormat: config.apiFormat, model: config.model };
}

export async function executeModelRequest(
  config: AiRuntimeConfig,
  request: ModelRequest,
  options: ModelExecutionOptions = {},
): Promise<ModelResponse> {
  if (config.provider === "custom") {
    return requestCustomModel(config, request, options.fetchImplementation, options.resolveHostname);
  }
  return requestDeepseekModel(config, request, options.createDeepseekClient);
}
