import {
  ANONYMOUS_COOKIE, appendAnonymousCookie, requestCookies, requestUsesHttps,
} from "@/lib/request-security";
import { apiError, publicApiUser, requireApiUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireApiUser();
    const response = Response.json({ user: await publicApiUser(user) });
    if (user.authMode === "anonymous") {
      const token = (await requestCookies())[ANONYMOUS_COOKIE];
      if (token) {
        return appendAnonymousCookie(response, token, await requestUsesHttps());
      }
    }
    return response;
  } catch (error) {
    return apiError(error);
  }
}
