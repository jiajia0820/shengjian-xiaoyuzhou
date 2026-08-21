import { headers } from "next/headers";
import { ANONYMOUS_COOKIE_MAX_AGE } from "./anonymous-auth";
import { HttpError } from "./http-error";
import { getRuntimeEnv } from "./runtime";
import { isAllowedOrigin, parseCookieHeader, serializeCookie } from "./request-security-core";

export { isAllowedOrigin, parseCookieHeader, serializeCookie } from "./request-security-core";


export const ACCESS_COOKIE = "sj_access";
export const REFRESH_COOKIE = "sj_refresh";
export const CSRF_COOKIE = "sj_csrf";
export const DEVICE_COOKIE = "sj_device";
export const ANONYMOUS_COOKIE = "sj_anonymous";


export async function requestCookies(): Promise<Record<string, string>> {
  return parseCookieHeader((await headers()).get("cookie"));
}

export async function requestUsesHttps(): Promise<boolean> {
  const requestHeaders = await headers();
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";
  const host = requestHeaders.get("host") ?? "";
  return !host.startsWith("localhost") && !host.startsWith("127.0.0.1");
}

export async function requireMutationSecurity(): Promise<void> {
  const requestHeaders = await headers();
  const cookies = parseCookieHeader(requestHeaders.get("cookie"));
  const csrfHeader = requestHeaders.get("x-csrf-token") ?? "";
  if (!csrfHeader || !cookies[CSRF_COOKIE] || csrfHeader !== cookies[CSRF_COOKIE]) {
    throw new HttpError(403, "CSRF_INVALID", "页面安全状态已过期，请刷新后重试");
  }
  const forwardedHost = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "")
    .split(",")[0]?.trim();
  const expectedHost = getRuntimeEnv().APP_PUBLIC_HOST?.trim();
  if (!isAllowedOrigin(requestHeaders.get("origin"), forwardedHost, expectedHost)) {
    throw new HttpError(403, "ORIGIN_INVALID", "请求来源不受信任，请从声笺官网重新打开");
  }
}

export async function clientAddress(): Promise<string> {
  const requestHeaders = await headers();
  return requestHeaders.get("x-real-client-ip")?.trim()
    || requestHeaders.get("cf-connecting-ip")?.trim()
    || requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

export function appendSessionCookies(response: Response, session: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}, secure: boolean): Response {
  response.headers.append("Set-Cookie", serializeCookie({
    name: ACCESS_COOKIE, value: session.access_token, maxAge: session.expires_in ?? 3600, secure,
  }));
  response.headers.append("Set-Cookie", serializeCookie({
    name: REFRESH_COOKIE, value: session.refresh_token, maxAge: 30 * 24 * 60 * 60, secure,
  }));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function appendAnonymousCookie(response: Response, token: string, secure: boolean): Response {
  response.headers.append("Set-Cookie", serializeCookie({
    name: ANONYMOUS_COOKIE, value: token, maxAge: ANONYMOUS_COOKIE_MAX_AGE, secure,
  }));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function clearSessionCookies(response: Response, secure: boolean): Response {
  response.headers.append("Set-Cookie", serializeCookie({ name: ACCESS_COOKIE, value: "", maxAge: 0, secure }));
  response.headers.append("Set-Cookie", serializeCookie({ name: REFRESH_COOKIE, value: "", maxAge: 0, secure }));
  response.headers.set("Cache-Control", "no-store");
  response.headers.append("Set-Cookie", serializeCookie({ name: ANONYMOUS_COOKIE, value: "", maxAge: 0, secure }));
  return response;
}
