import {
  ACCESS_COOKIE, clearSessionCookies, requestCookies, requestUsesHttps, requireMutationSecurity,
} from "@/lib/request-security";
import { revokeSupabaseSession } from "@/lib/supabase-auth";
import { apiError } from "@/lib/user";

export async function POST() {
  try {
    await requireMutationSecurity();
    const accessToken = (await requestCookies())[ACCESS_COOKIE];
    if (accessToken) await revokeSupabaseSession(accessToken);
    return clearSessionCookies(Response.json({ signedOut: true }), await requestUsesHttps());
  } catch (error) {
    return apiError(error);
  }
}
