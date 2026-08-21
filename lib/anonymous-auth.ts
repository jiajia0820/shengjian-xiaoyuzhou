import {
  createAnonymousSession, getActiveAnonymousSession, type AnonymousSessionRecord,
} from "./db";
import { anonymousTokenHash, createAnonymousToken } from "./anonymous-auth-core";

export const ANONYMOUS_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export { anonymousTokenHash, createAnonymousToken } from "./anonymous-auth-core";

export async function resolveAnonymousToken(token: string): Promise<AnonymousSessionRecord | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return getActiveAnonymousSession(await anonymousTokenHash(token));
}

export async function issueAnonymousSession(now = new Date()): Promise<{
  token: string;
  session: AnonymousSessionRecord;
}> {
  const token = createAnonymousToken();
  const session = await createAnonymousSession({
    tokenHash: await anonymousTokenHash(token),
    userId: crypto.randomUUID(),
    now,
  });
  return { token, session };
}
