export function parseCookieHeader(value: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (value ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(raw); } catch { cookies[name] = ""; }
  }
  return cookies;
}

export function serializeCookie(input: {
  name: string;
  value: string;
  maxAge: number;
  secure: boolean;
  httpOnly?: boolean;
}): string {
  const attributes = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(input.maxAge))}`,
    "SameSite=Lax",
  ];
  if (input.secure) attributes.push("Secure");
  if (input.httpOnly !== false) attributes.push("HttpOnly");
  return attributes.join("; ");
}

export function isAllowedOrigin(origin: string | null, forwardedHost: string, expectedHost?: string): boolean {
  if (!origin) return !expectedHost;
  try {
    const parsed = new URL(origin);
    const allowedHost = expectedHost || forwardedHost;
    return parsed.protocol === (allowedHost.startsWith("localhost") ? "http:" : "https:") && parsed.host === allowedHost;
  } catch {
    return false;
  }
}
