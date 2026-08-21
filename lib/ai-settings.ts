import { getAiSetting, saveAiSetting } from "./db";
import { getRuntimeEnv } from "./runtime";
import { decryptSecret, encryptSecret } from "./security";
import { HttpError } from "./http-error";
import { ANALYSIS_MODEL } from "./analysis-format";

export const AI_PROVIDER = "deepseek";
export const AI_MODEL = ANALYSIS_MODEL;

export async function readDeepseekApiKey(userId: string): Promise<string> {
  const setting = await getAiSetting(userId);
  if (!setting) {
    throw new HttpError(400, "AI_NOT_CONFIGURED", "请先在 AI 设置中填写 DeepSeek API Key");
  }
  try {
    return await decryptSecret(setting.api_key_cipher, getRuntimeEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new HttpError(500, "AI_CREDENTIAL_ERROR", "DeepSeek API Key 无法解密，请重新填写");
  }
}

export async function persistDeepseekApiKey(userId: string, apiKey: string): Promise<void> {
  const clean = apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(clean) || clean.length > 500) {
    throw new HttpError(400, "INVALID_DEEPSEEK_KEY", "请输入有效的 DeepSeek API Key");
  }
  const existing = await getAiSetting(userId);
  const now = new Date().toISOString();
  await saveAiSetting({
    user_id: userId,
    provider: AI_PROVIDER,
    api_key_cipher: await encryptSecret(clean, getRuntimeEnv().TOKEN_ENCRYPTION_KEY),
    key_hint: `•••• ${clean.slice(-4)}`,
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  });
}
