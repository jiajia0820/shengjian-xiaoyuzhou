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
};

export type AiRuntimeConfig = DeepseekAiRuntimeConfig | CustomAiRuntimeConfig;

export type ModelResponse = {
  text: string;
  provider: AiProvider;
  apiFormat: AiApiFormat;
  model: string;
};

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MODEL_TIMEOUT_MS = 120_000;

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
};

export function normalizeCustomBaseUrl(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 2_048) throw new Error("INVALID_CUSTOM_BASE_URL");
  const url = new URL(clean);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const isIpv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);
  const isIpv6 = hostname.startsWith("[") || hostname.includes(":");
  const isPrivateName = hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname === "local" || hostname.endsWith(".local")
    || hostname === "internal" || hostname.endsWith(".internal");
  if (url.protocol !== "https:" || !hostname || url.username || url.password || url.search || url.hash
    || isIpv4 || isIpv6 || isPrivateName) throw new Error("INVALID_CUSTOM_BASE_URL");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
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

function buildDeepseekModelRequest(request: ModelRequest): DeepseekRequest {
  return {
    model: DEEPSEEK_MODEL,
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
    const response = await client.chat.completions.create(buildDeepseekModelRequest(request));
    const text = cleanModelMarkdown(chatCompletionText(response));
    if (!text) throw new HttpError(502, "AI_EMPTY_OUTPUT", "AI 没有返回可用内容，请稍后重试");
    return {
      text,
      provider: "deepseek",
      apiFormat: "chat_completions",
      model: DEEPSEEK_MODEL,
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
): Promise<ModelResponse> {
  const prepared = buildCustomModelRequest(config, request);
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
    if (error instanceof HttpError) throw error;
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
  return { text, provider: "custom", apiFormat: config.apiFormat, model: config.model };
}

export async function executeModelRequest(
  config: AiRuntimeConfig,
  request: ModelRequest,
  options: ModelExecutionOptions = {},
): Promise<ModelResponse> {
  if (config.provider === "custom") {
    return requestCustomModel(config, request, options.fetchImplementation);
  }
  return requestDeepseekModel(config, request, options.createDeepseekClient);
}
