import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_PATH = "/__xiaoyuzhou_upstream";
const TARGET_HEADER = "x-xiaoyuzhou-target";
const TOKEN_HEADER = "x-xiaoyuzhou-token";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  // Node's fetch transparently decompresses upstream bodies. Do not forward
  // the stale encoding marker with the now-plain response bytes.
  "content-encoding",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sameToken(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const PRIVATE_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
  "intranet",
  "localdomain",
  "onion",
];

function isPublicIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part < 0 || part > 255)) return false;
  const [a, b, c] = bytes;
  return !(a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 31 && c === 196
    || a === 192 && b === 52 && c === 193
    || a === 192 && b === 88 && c === 99
    || a === 192 && b === 168
    || a === 192 && b === 175 && c === 48
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224);
}

function isPublicIpv6(value) {
  const hostname = value.replace(/^\[|\]$/g, "").toLowerCase();
  // Only global unicast space (2000::/3) is accepted. This rejects localhost,
  // link-local, unique-local, multicast, documentation and other special ranges.
  const first = Number.parseInt(hostname.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first) || (first & 0xe000) !== 0x2000) return false;
  const second = Number.parseInt(hostname.split(":", 2)[1] || "0", 16);
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

export function isPublicHostname(value) {
  const hostname = String(value).toLowerCase().replace(/\.+$/, "");
  if (!hostname) return false;
  const normalizedIp = hostname.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalizedIp);
  if (ipVersion === 4) return isPublicIpv4(hostname);
  if (ipVersion === 6) return isPublicIpv6(hostname);
  if (!hostname.includes(".")) return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ))) return false;
  return true;
}

export function isAllowedTarget(value) {
  let target;
  try {
    target = new URL(typeof value === "string" ? value : "");
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.username || target.password) return null;
  if (!isPublicHostname(target.hostname)) return null;
  return target;
}

function isOfficialTarget(target) {
  const hostname = target.hostname.toLowerCase().replace(/\.+$/, "");
  return hostname === "xiaoyuzhoufm.com" || hostname.endsWith(".xiaoyuzhoufm.com")
    || hostname === "xyzcdn.net" || hostname.endsWith(".xyzcdn.net")
    || hostname === "cloudflare-dns.com" || hostname.endsWith(".cloudflare-dns.com");
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === TARGET_HEADER || lower === TOKEN_HEADER) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

async function forwardRequest(request, response, token) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname !== PROXY_PATH) {
    writeJson(response, 404, { error: "NOT_FOUND" });
    return;
  }
  const presentedToken = typeof request.headers[TOKEN_HEADER] === "string" ? request.headers[TOKEN_HEADER] : "";
  if (!sameToken(presentedToken, token)) {
    writeJson(response, 403, { error: "FORBIDDEN" });
    return;
  }
  const target = isAllowedTarget(request.headers[TARGET_HEADER]);
  if (!target) {
    writeJson(response, 400, { error: "INVALID_TARGET" });
    return;
  }
  const body = await readBody(request);
  if (body === null) {
    writeJson(response, 413, { error: "REQUEST_TOO_LARGE" });
    return;
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardHeaders(request),
      body: body.length && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
      // Official Xiaoyuzhou/CDN/DoH requests may follow their normal redirects.
      // Custom providers stay manual so a response cannot redirect this relay
      // to a private or otherwise unvalidated destination.
      redirect: isOfficialTarget(target) ? "follow" : "manual",
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (payload.length > MAX_RESPONSE_BYTES) {
      writeJson(response, 502, { error: "RESPONSE_TOO_LARGE" });
      return;
    }
    response.writeHead(upstream.status, responseHeaders(upstream));
    response.end(payload);
  } catch {
    writeJson(response, 502, { error: "UPSTREAM_UNREACHABLE" });
  }
}

export async function startXiaoyuzhouDevProxy() {
  const token = randomBytes(32).toString("hex");
  const configuredProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (configuredProxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      noProxy: process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1,::1",
    }));
  }

  const server = http.createServer((request, response) => {
    void forwardRequest(request, response, token).catch(() => writeJson(response, 502, { error: "UPSTREAM_UNREACHABLE" }));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("本地小宇宙代理启动失败");
  }
  return {
    url: `http://127.0.0.1:${address.port}${PROXY_PATH}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const devProxyPath = PROXY_PATH;
