import {
  CSRF_COOKIE, DEVICE_COOKIE, requestCookies, requestUsesHttps, serializeCookie,
} from "@/lib/request-security";

export async function GET() {
  const cookies = await requestCookies();
  const csrfToken = cookies[CSRF_COOKIE] || crypto.randomUUID();
  const deviceId = cookies[DEVICE_COOKIE] || crypto.randomUUID();
  const secure = await requestUsesHttps();
  const response = Response.json({ csrfToken }, {
    headers: { "Cache-Control": "no-store" },
  });
  response.headers.append("Set-Cookie", serializeCookie({
    name: CSRF_COOKIE, value: csrfToken, maxAge: 12 * 60 * 60, secure,
  }));
  response.headers.append("Set-Cookie", serializeCookie({
    name: DEVICE_COOKIE, value: deviceId, maxAge: 365 * 24 * 60 * 60, secure,
  }));
  return response;
}
