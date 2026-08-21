import { issueAnonymousSession, resolveAnonymousToken } from "@/lib/anonymous-auth";
import { consumeAuthRateLimit, type AnonymousSessionRecord } from "@/lib/db";
import {
  ANONYMOUS_COOKIE, appendAnonymousCookie, clientAddress, DEVICE_COOKIE,
  requestCookies, requestUsesHttps, requireMutationSecurity,
} from "@/lib/request-security";
import { sha256Hex } from "@/lib/security";
import { apiError, HttpError, publicApiUser, type ApiUser } from "@/lib/user";

function anonymousApiUser(session: AnonymousSessionRecord): ApiUser {
  return {
    userId: session.user_id,
    displayName: "匿名用户",
    email: null,
    role: "member",
    authMode: "anonymous",
    providerSubject: null,
  };
}

async function enforceCreationLimit(scope: string, value: string, limit: number, windowSeconds: number) {
  const bucket = await sha256Hex(`anonymous-create:${scope}:${value}`);
  if (!await consumeAuthRateLimit(bucket, limit, windowSeconds)) {
    throw new HttpError(429, "ANONYMOUS_RATE_LIMITED", "此设备创建账户过于频繁，请稍后再试");
  }
}

export async function POST() {
  try {
    await requireMutationSecurity();
    const cookies = await requestCookies();
    const existingToken = cookies[ANONYMOUS_COOKIE];
    if (existingToken) {
      const existing = await resolveAnonymousToken(existingToken);
      if (existing) {
        return appendAnonymousCookie(
          Response.json({ user: await publicApiUser(anonymousApiUser(existing)) }),
          existingToken,
          await requestUsesHttps(),
        );
      }
    }

    const device = cookies[DEVICE_COOKIE] || "unknown";
    await enforceCreationLimit("device", device, 3, 24 * 60 * 60);
    await enforceCreationLimit("ip", await clientAddress(), 20, 60 * 60);
    const issued = await issueAnonymousSession();
    return appendAnonymousCookie(
      Response.json({ user: await publicApiUser(anonymousApiUser(issued.session)) }, { status: 201 }),
      issued.token,
      await requestUsesHttps(),
    );
  } catch (error) {
    return apiError(error);
  }
}
