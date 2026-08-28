import assert from "node:assert/strict";
import test from "node:test";
import { consumeAudioRelayTicket, issueAudioRelayTicket } from "../lib/audio-relay-ticket.ts";

function createFakeD1() {
  const rows = new Map<string, { value: string; updated_at: string }>();
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = { value: string }>() {
              if (sql.includes("SELECT value FROM app_state WHERE key = ?")) {
                const row = rows.get(String(args[0]));
                return row ? ({ value: row.value } as T) : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("DELETE FROM app_state WHERE key LIKE ?")) {
                const prefix = String(args[0]).replace(/%$/, "");
                const cutoff = String(args[1]);
                for (const [key, row] of rows) {
                  if (key.startsWith(prefix) && row.updated_at < cutoff) rows.delete(key);
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("INSERT INTO app_state")) {
                rows.set(String(args[0]), { value: String(args[1]), updated_at: String(args[2]) });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM app_state WHERE key = ? AND value = ?")) {
                const key = String(args[0]);
                const row = rows.get(key);
                if (row && row.value === String(args[1])) {
                  rows.delete(key);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              throw new Error(`未覆盖的 D1 测试语句: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

test("relay ticket is bound to user and episode and can be consumed once", async () => {
  const db = createFakeD1();
  const ticket = await issueAudioRelayTicket(db, { userId: "user-a", eid: "episode-a", ttlSeconds: 90 });
  assert.deepEqual(await consumeAudioRelayTicket(db, ticket, "episode-a"), { userId: "user-a", eid: "episode-a" });
  assert.equal(await consumeAudioRelayTicket(db, ticket, "episode-a"), null);
  assert.equal(await consumeAudioRelayTicket(db, ticket, "episode-b"), null);
});
