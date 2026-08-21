import { createClient } from "@supabase/supabase-js";
import { createAppIdentity, getAppUserByIdentity, refreshAppUserEmail } from "./db";
import { HttpError } from "./http-error";
import { getRuntimeEnv } from "./runtime";

export type VerifiedSupabaseIdentity = {
  subject: string;
  email: string;
};

function serverAuthConfig(): { url: string; publishableKey: string } {
  const env = getRuntimeEnv();
  const url = env.SUPABASE_URL?.trim() ?? "";
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!url || !publishableKey) throw new HttpError(503, "AUTH_NOT_CONFIGURED", "旧登录会话服务未配置");
  return { url, publishableKey };
}

function serverAuthClient() {
  const config = serverAuthConfig();
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function revokeSupabaseSession(accessToken: string): Promise<void> {
  const config = serverAuthConfig();
  await fetch(`${config.url}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => undefined);
}

export async function verifySupabaseAccessToken(token: string): Promise<VerifiedSupabaseIdentity> {
  const supabase = serverAuthClient();
  const { data, error } = await supabase.auth.getClaims(token);
  const claims = data?.claims as Record<string, unknown> | undefined;
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  const email = typeof claims?.email === "string" ? claims.email.trim().toLocaleLowerCase("en-US") : "";
  if (error || !subject || !email) throw new HttpError(401, "AUTH_INVALID", "旧登录会话已失效，请刷新后继续使用当前浏览器账户");
  return { subject, email };
}

export async function resolveSupabaseUser(identity: VerifiedSupabaseIdentity) {
  let user = await getAppUserByIdentity(identity.subject);
  if (!user) {
    try {
      user = await createAppIdentity(identity.subject, identity.email);
    } catch {
      throw new HttpError(409, "EMAIL_ALREADY_BOUND", "该邮箱已绑定其他身份，请联系管理员处理");
    }
  } else if (user.verified_email !== identity.email) {
    try {
      await refreshAppUserEmail(user.id, identity.email);
      user = { ...user, verified_email: identity.email };
    } catch {
      throw new HttpError(409, "EMAIL_ALREADY_BOUND", "该邮箱已绑定其他身份，请联系管理员处理");
    }
  }
  if (user.status !== "active") throw new HttpError(403, "ACCOUNT_SUSPENDED", "此账号已暂停使用");
  return user;
}

export async function deleteSupabaseAuthUser(subject: string): Promise<void> {
  const env = getRuntimeEnv();
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new HttpError(503, "ACCOUNT_DELETE_NOT_CONFIGURED", "账号删除服务尚未完成配置");
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await admin.auth.admin.deleteUser(subject);
  if (error) throw new HttpError(502, "AUTH_DELETE_FAILED", "暂时无法删除登录身份，请稍后重试");
}
