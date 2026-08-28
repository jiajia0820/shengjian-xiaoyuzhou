import { sha256Hex } from "./security.ts";

const AUDIO_RELAY_PREFIX = "audio-relay:";
const DEFAULT_TTL_SECONDS = 90;
const MAX_TTL_SECONDS = 5 * 60;

type AudioRelayTicketPayload = {
  userId: string;
  eid: string;
  expiresAt: string;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function newTicket(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export async function issueAudioRelayTicket(
  db: D1Database,
  input: { userId: string; eid: string; ttlSeconds?: number },
): Promise<string> {
  if (!validIdentity(input.userId) || !validIdentity(input.eid)) throw new Error("invalid relay ticket identity");
  const requestedTtl = Number(input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.max(1, Math.min(MAX_TTL_SECONDS, Math.floor(requestedTtl)))
    : DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  await db.prepare("DELETE FROM app_state WHERE key LIKE ? AND updated_at < ?")
    .bind(`${AUDIO_RELAY_PREFIX}%`, new Date().toISOString()).run();

  const ticket = newTicket();
  const ticketHash = await sha256Hex(ticket);
  const payload: AudioRelayTicketPayload = { userId: input.userId, eid: input.eid, expiresAt };
  await db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(`${AUDIO_RELAY_PREFIX}${ticketHash}`, JSON.stringify(payload), expiresAt).run();
  return ticket;
}

export async function consumeAudioRelayTicket(
  db: D1Database,
  ticket: string,
  eid: string,
): Promise<{ userId: string; eid: string } | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(ticket) || !validIdentity(eid)) return null;
  const ticketHash = await sha256Hex(ticket);
  const key = `${AUDIO_RELAY_PREFIX}${ticketHash}`;
  const row = await db.prepare("SELECT value FROM app_state WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;

  let payload: AudioRelayTicketPayload;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (!validIdentity(parsed.userId) || !validIdentity(parsed.eid)
      || typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt))) return null;
    payload = { userId: parsed.userId, eid: parsed.eid, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
  if (payload.eid !== eid || Date.parse(payload.expiresAt) <= Date.now()) return null;

  const deleted = await db.prepare("DELETE FROM app_state WHERE key = ? AND value = ?")
    .bind(key, row.value).run();
  return deleted.meta.changes === 1 ? { userId: payload.userId, eid: payload.eid } : null;
}
