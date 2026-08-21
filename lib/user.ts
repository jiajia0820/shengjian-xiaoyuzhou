import { getChatGPTUser } from "@/app/chatgpt-auth";
import { resolveAnonymousToken } from "./anonymous-auth";
import { bootstrapIsOpen, getUsage, hasOwnedData } from "./db";
import { HttpError } from "./http-error";
import { ACCESS_COOKIE, ANONYMOUS_COOKIE, requestCookies, requireMutationSecurity } from "./request-security";
import { resolveSupabaseUser, verifySupabaseAccessToken } from "./supabase-auth";

export { HttpError };

export type ApiUser = {
  userId: string;
  displayName: string;
  email: string | null;
  role: "admin" | "member";
  authMode: "supabase" | "legacy" | "anonymous";
  providerSubject: string | null;
};

export async function requireApiUser(options: { mutation?: boolean } = {}): Promise<ApiUser> {
  if (options.mutation) await requireMutationSecurity();
  const cookies = await requestCookies();
  const accessToken = cookies[ACCESS_COOKIE];
  let accessError: unknown = null;
  if (accessToken) {
    try {
      const identity = await verifySupabaseAccessToken(accessToken);
      const user = await resolveSupabaseUser(identity);
      return {
        userId: user.id, displayName: identity.email, email: identity.email, role: user.role,
        authMode: "supabase", providerSubject: identity.subject,
      };
    } catch (error) {
      accessError = error;
    }
  }

  const legacy = await getChatGPTUser();
  if (legacy && await bootstrapIsOpen() && await hasOwnedData(legacy.userId)) {
    return {
      userId: legacy.userId,
      displayName: legacy.displayName,
      email: legacy.email,
      role: "admin",
      authMode: "legacy",
      providerSubject: null,
    };
  }

  const anonymousToken = cookies[ANONYMOUS_COOKIE];
  if (anonymousToken) {
    const session = await resolveAnonymousToken(anonymousToken);
    if (session) {
      return {
        userId: session.user_id, displayName: "匿名用户", email: null, role: "member",
        authMode: "anonymous", providerSubject: null,
      };
    }
  }
  if (accessError) throw accessError;
  throw new HttpError(401, "AUTH_REQUIRED", "正在为此浏览器创建独立账户");
}

export async function publicApiUser(user: ApiUser) {
  const usage = await getUsage(user.userId);
  return {
    id: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    authMode: user.authMode,
    bootstrapEligible: user.authMode === "legacy",
    usage: {
      date: usage.usage_date,
      imports: { used: usage.import_count, limit: 30 },
      ai: { used: usage.ai_count, limit: 20 },
    },
  };
}

export function apiError(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  const upstream = error as { status?: number; code?: string; message?: string };
  if (upstream?.code && upstream?.message) {
    return Response.json(
      { error: upstream.code, message: upstream.message },
      { status: upstream.status && upstream.status >= 400 ? upstream.status : 502 },
    );
  }
  return Response.json({ error: "INTERNAL_ERROR", message: "处理请求时出现问题，请稍后重试" }, { status: 500 });
}
