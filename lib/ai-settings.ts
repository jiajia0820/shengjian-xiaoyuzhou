import {
  deleteAiSetting,
  getAiPreference,
  getAiSetting,
  getAiSettings,
  saveAiSetting,
  setAiPreference,
  type AiSettingRecord,
} from "./db";
import {
  normalizeCustomBaseUrl,
  type AiApiFormat,
  type AiProvider,
  type AiRuntimeConfig,
  type ReasoningEffort,
} from "./ai-provider";
import { HttpError } from "./http-error";
import { getRuntimeEnv } from "./runtime";
import { decryptSecret, encryptSecret } from "./security";

const DEEPSEEK_MODEL = "deepseek-v4-flash" as const;
const DEEPSEEK_API_FORMAT = "chat_completions" as const;
const MAX_API_KEY_LENGTH = 500;
const MAX_MODEL_LENGTH = 200;
const CUSTOM_ONLY_FIELDS = ["baseUrl", "model", "apiFormat", "reasoningEffort"] as const;

export type CustomAiInput = {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiFormat: AiApiFormat;
  reasoningEffort: ReasoningEffort | null;
};

type DeepseekProviderStatus = {
  provider: "deepseek";
  connected: boolean;
  model: typeof DEEPSEEK_MODEL;
  apiFormat: typeof DEEPSEEK_API_FORMAT;
  keyHint: string | null;
  connectedAt: string | null;
};

type CustomProviderStatus = {
  provider: "custom";
  connected: boolean;
  baseUrl: string | null;
  model: string | null;
  apiFormat: AiApiFormat | null;
  reasoningEffort: ReasoningEffort | null;
  keyHint: string | null;
  connectedAt: string | null;
};

export type AiSettingsStatus = {
  defaultProvider: AiProvider | null;
  providers: {
    deepseek: DeepseekProviderStatus;
    custom: CustomProviderStatus;
  };
};

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function invalidInput(code: string, message: string): never {
  throw new HttpError(400, code, message);
}

function assertAiProvider(value: unknown): AiProvider {
  if (value === "deepseek" || value === "custom") return value;
  return invalidInput("INVALID_AI_PROVIDER", "请选择有效的 AI 服务");
}

function validateCustomApiKey(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_API_KEY_LENGTH || /[\s\p{Cc}]/u.test(value)) {
    return invalidInput("INVALID_CUSTOM_AI_KEY", "请输入有效的自定义 API Key");
  }
  return value;
}

function validateCustomBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return invalidInput("INVALID_CUSTOM_AI_BASE_URL", "请输入有效的自定义 API 地址");
  }
  try {
    return normalizeCustomBaseUrl(value);
  } catch {
    return invalidInput("INVALID_CUSTOM_AI_BASE_URL", "请输入有效的自定义 API 地址");
  }
}

function validateCustomModel(value: unknown): string {
  if (typeof value !== "string") {
    return invalidInput("INVALID_CUSTOM_AI_MODEL", "请输入有效的模型名称");
  }
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_LENGTH) {
    return invalidInput("INVALID_CUSTOM_AI_MODEL", "请输入有效的模型名称");
  }
  return model;
}

function validateCustomApiFormat(value: unknown): AiApiFormat {
  if (value === "responses" || value === "chat_completions") return value;
  return invalidInput("INVALID_CUSTOM_AI_FORMAT", "请选择兼容的 API 格式");
}

function validateReasoningEffort(value: unknown, apiFormat: AiApiFormat): ReasoningEffort | null {
  const reasoningEffort = value ?? null;
  if (reasoningEffort !== null && reasoningEffort !== "low" && reasoningEffort !== "medium" && reasoningEffort !== "high") {
    return invalidInput("INVALID_CUSTOM_AI_REASONING", "请选择有效的推理强度");
  }
  if (apiFormat === "chat_completions" && reasoningEffort !== null) {
    return invalidInput("INVALID_CUSTOM_AI_REASONING", "Chat Completions 不支持推理强度");
  }
  return reasoningEffort;
}

export function validateCustomAiInput(body: Record<string, unknown>): CustomAiInput {
  const apiFormat = validateCustomApiFormat(body.apiFormat);
  return {
    apiKey: validateCustomApiKey(body.apiKey),
    baseUrl: validateCustomBaseUrl(body.baseUrl),
    model: validateCustomModel(body.model),
    apiFormat,
    reasoningEffort: validateReasoningEffort(body.reasoningEffort, apiFormat),
  };
}

function validateDeepseekInput(body: Record<string, unknown>): string {
  if (CUSTOM_ONLY_FIELDS.some((field) => hasOwn(body, field))) {
    return invalidInput("INVALID_AI_PROVIDER_INPUT", "DeepSeek 不接受自定义 API 配置");
  }
  if (typeof body.apiKey !== "string") {
    return invalidInput("INVALID_DEEPSEEK_KEY", "请输入有效的 DeepSeek API Key");
  }
  const apiKey = body.apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(apiKey) || apiKey.length > MAX_API_KEY_LENGTH) {
    return invalidInput("INVALID_DEEPSEEK_KEY", "请输入有效的 DeepSeek API Key");
  }
  return apiKey;
}

function keyHint(value: string): string {
  const hint: { version: 1; length: number; suffix?: string } = {
    version: 1,
    length: value.length,
  };
  if (value.length >= 5) hint.suffix = value.slice(-4);
  return JSON.stringify(hint);
}

function safeKeyHint(value: string): string {
  try {
    const hint: unknown = JSON.parse(value);
    if (typeof hint !== "object" || hint === null || !Object.prototype.hasOwnProperty.call(hint, "version")
      || !Object.prototype.hasOwnProperty.call(hint, "length")) return "••••";
    const { version, length, suffix } = hint as { version?: unknown; length?: unknown; suffix?: unknown };
    if (version !== 1 || !Number.isSafeInteger(length) || length < 1 || length > MAX_API_KEY_LENGTH) return "••••";
    if (length <= 4) return "••••";
    if (typeof suffix !== "string" || suffix.length !== 4 || /[\s\p{Cc}]/u.test(suffix)) return "••••";
    return `•••• ${suffix}`;
  } catch {
    return "••••";
  }
}

function toDeepseekStatus(setting: AiSettingRecord | undefined): DeepseekProviderStatus {
  return {
    provider: "deepseek",
    connected: Boolean(setting),
    model: DEEPSEEK_MODEL,
    apiFormat: DEEPSEEK_API_FORMAT,
    keyHint: setting ? safeKeyHint(setting.key_hint) : null,
    connectedAt: setting?.connected_at ?? null,
  };
}

function toCustomStatus(setting: AiSettingRecord | undefined): CustomProviderStatus {
  if (!setting) {
    return {
      provider: "custom",
      connected: false,
      baseUrl: null,
      model: null,
      apiFormat: null,
      reasoningEffort: null,
      keyHint: null,
      connectedAt: null,
    };
  }
  return {
    provider: "custom",
    connected: true,
    baseUrl: setting.base_url,
    model: setting.model,
    apiFormat: setting.api_format,
    reasoningEffort: setting.reasoning_effort,
    keyHint: safeKeyHint(setting.key_hint),
    connectedAt: setting.connected_at,
  };
}

export async function getAiSettingsStatus(userId: string): Promise<AiSettingsStatus> {
  const [settings, preference] = await Promise.all([getAiSettings(userId), getAiPreference(userId)]);
  const deepseek = settings.find((setting) => setting.provider === "deepseek");
  const custom = settings.find((setting) => setting.provider === "custom");
  const defaultProvider = preference?.active_provider === "deepseek" && deepseek
    ? "deepseek"
    : preference?.active_provider === "custom" && custom
      ? "custom"
      : null;

  return {
    defaultProvider,
    providers: {
      deepseek: toDeepseekStatus(deepseek),
      custom: toCustomStatus(custom),
    },
  };
}

async function encryptApiKey(apiKey: string): Promise<string> {
  try {
    return await encryptSecret(apiKey, getRuntimeEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new HttpError(500, "AI_CREDENTIAL_ERROR", "AI 凭据无法安全保存，请稍后重试");
  }
}

async function hasSavedActiveProvider(userId: string): Promise<boolean> {
  const preference = await getAiPreference(userId);
  if (!preference?.active_provider) return false;
  return Boolean(await getAiSetting(userId, preference.active_provider));
}

export async function saveAiProvider(userId: string, body: Record<string, unknown>): Promise<AiSettingsStatus> {
  const provider = assertAiProvider(body.provider);
  const custom = provider === "custom" ? validateCustomAiInput(body) : null;
  const apiKey = custom?.apiKey ?? validateDeepseekInput(body);
  const existing = await getAiSetting(userId, provider);
  const now = new Date().toISOString();

  await saveAiSetting({
    user_id: userId,
    provider,
    api_format: custom?.apiFormat ?? DEEPSEEK_API_FORMAT,
    base_url: custom?.baseUrl ?? null,
    model: custom?.model ?? DEEPSEEK_MODEL,
    reasoning_effort: custom?.reasoningEffort ?? null,
    api_key_cipher: await encryptApiKey(apiKey),
    key_hint: keyHint(apiKey),
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  });

  if (!await hasSavedActiveProvider(userId)) {
    await setAiPreference(userId, provider);
  }
  return getAiSettingsStatus(userId);
}

export async function setDefaultAiProvider(userId: string, provider: AiProvider): Promise<AiSettingsStatus> {
  const selectedProvider = assertAiProvider(provider);
  if (!await getAiSetting(userId, selectedProvider)) {
    throw new HttpError(400, "AI_PROVIDER_NOT_CONNECTED", "请先连接该 AI 服务");
  }
  await setAiPreference(userId, selectedProvider);
  return getAiSettingsStatus(userId);
}

export async function removeAiProvider(userId: string, provider: AiProvider): Promise<AiSettingsStatus> {
  await deleteAiSetting(userId, assertAiProvider(provider));
  return getAiSettingsStatus(userId);
}

async function decryptApiKey(cipher: string): Promise<string> {
  try {
    return await decryptSecret(cipher, getRuntimeEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new HttpError(500, "AI_CREDENTIAL_ERROR", "已保存的 AI 凭据无法读取，请重新填写");
  }
}

function notConfigured(): never {
  throw new HttpError(400, "AI_NOT_CONFIGURED", "请先在 AI 设置中连接可用的 AI 服务");
}

export async function readActiveAiConfiguration(userId: string): Promise<AiRuntimeConfig> {
  const preference = await getAiPreference(userId);
  const provider = preference?.active_provider;
  if (provider !== "deepseek" && provider !== "custom") return notConfigured();
  const setting = await getAiSetting(userId, provider);
  if (!setting) return notConfigured();
  const apiKey = await decryptApiKey(setting.api_key_cipher);

  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      apiKey,
      baseUrl: null,
      model: DEEPSEEK_MODEL,
      apiFormat: DEEPSEEK_API_FORMAT,
      reasoningEffort: null,
    };
  }

  const custom = validateCustomAiInput({
    apiKey,
    baseUrl: setting.base_url,
    model: setting.model,
    apiFormat: setting.api_format,
    reasoningEffort: setting.reasoning_effort,
  });
  return { provider: "custom", ...custom };
}

// Analysis generation still reads the saved DeepSeek credential until it becomes provider-aware.
export async function readDeepseekApiKey(userId: string): Promise<string> {
  const setting = await getAiSetting(userId, "deepseek");
  if (!setting) return notConfigured();
  return decryptApiKey(setting.api_key_cipher);
}
