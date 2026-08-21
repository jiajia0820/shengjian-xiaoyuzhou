import { getConnection, saveConnection } from "./db";
import { decryptSecret, encryptSecret, phoneHint } from "./security";
import { getRuntimeEnv } from "./runtime";
import { HttpError } from "./user";
import { refreshTokens, XiaoyuzhouError, type XiaoyuzhouTokens } from "./xiaoyuzhou";

export async function persistTokens(
  userId: string,
  phone: string,
  tokens: XiaoyuzhouTokens,
  phoneIsAlreadyMasked = false,
): Promise<void> {
  const now = new Date().toISOString();
  const key = getRuntimeEnv().TOKEN_ENCRYPTION_KEY;
  if (!key) throw new HttpError(500, "SERVER_NOT_CONFIGURED", "网站尚未配置安全密钥");
  const existing = await getConnection(userId);
  await saveConnection({
    user_id: userId,
    phone_hint: phoneIsAlreadyMasked ? phone : phoneHint(phone),
    access_token_cipher: await encryptSecret(tokens.accessToken, key),
    refresh_token_cipher: await encryptSecret(tokens.refreshToken, key),
    device_id: tokens.deviceId,
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  });
}

export async function loadTokens(userId: string): Promise<{ tokens: XiaoyuzhouTokens; phoneHint: string }> {
  const connection = await getConnection(userId);
  if (!connection) throw new HttpError(409, "ACCOUNT_NOT_CONNECTED", "请先连接小宇宙账号");
  const key = getRuntimeEnv().TOKEN_ENCRYPTION_KEY;
  if (!key) throw new HttpError(500, "SERVER_NOT_CONFIGURED", "网站尚未配置安全密钥");
  try {
    return {
      phoneHint: connection.phone_hint,
      tokens: {
        accessToken: await decryptSecret(connection.access_token_cipher, key),
        refreshToken: await decryptSecret(connection.refresh_token_cipher, key),
        deviceId: connection.device_id,
      },
    };
  } catch {
    throw new HttpError(500, "CREDENTIALS_UNREADABLE", "已保存的授权无法读取，请重新连接账号");
  }
}

export async function withFreshTokens<T>(userId: string, operation: (tokens: XiaoyuzhouTokens) => Promise<T>): Promise<T> {
  const loaded = await loadTokens(userId);
  try {
    return await operation(loaded.tokens);
  } catch (error) {
    if (!(error instanceof XiaoyuzhouError) || error.code !== "AUTH_EXPIRED") throw error;
    const refreshed = await refreshTokens(loaded.tokens);
    await persistTokens(userId, loaded.phoneHint, refreshed, true);
    return operation(refreshed);
  }
}
