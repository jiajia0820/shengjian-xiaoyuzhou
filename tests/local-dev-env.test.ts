import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureLocalDevEncryptionKey } from "../scripts/local-dev-env.mjs";

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shengjian-local-dev-"));
}

test("没有配置密钥时生成并持久化可用的 32 字节密钥", async () => {
  const cwd = await createTempProject();
  const env: Record<string, string | undefined> = {};

  const key = await ensureLocalDevEncryptionKey({ cwd, env });
  const decoded = Buffer.from(key, "base64");
  const persisted = await readFile(join(cwd, ".env.local"), "utf8");

  assert.equal(decoded.byteLength, 32);
  assert.equal(env.TOKEN_ENCRYPTION_KEY, key);
  assert.match(persisted, new RegExp(`^TOKEN_ENCRYPTION_KEY=${key.replace(/[+/=]/g, "\\$&")}$`, "m"));
});

test("第二次启动复用 .env.local 中的密钥", async () => {
  const cwd = await createTempProject();
  const firstEnv: Record<string, string | undefined> = {};
  const firstKey = await ensureLocalDevEncryptionKey({ cwd, env: firstEnv });
  const secondEnv: Record<string, string | undefined> = {};

  const secondKey = await ensureLocalDevEncryptionKey({ cwd, env: secondEnv });

  assert.equal(secondKey, firstKey);
  assert.equal(secondEnv.TOKEN_ENCRYPTION_KEY, firstKey);
  assert.equal((await readFile(join(cwd, ".env.local"), "utf8")).match(/TOKEN_ENCRYPTION_KEY=/g)?.length, 1);
});

test("尊重进程中已有的密钥且不覆盖 .env.local", async () => {
  const cwd = await createTempProject();
  const configured = Buffer.alloc(32, 7).toString("base64");
  const fileKey = Buffer.alloc(32, 8).toString("base64");
  await writeFile(join(cwd, ".env.local"), `OTHER=value\nTOKEN_ENCRYPTION_KEY=${fileKey}\n`, "utf8");
  const env: Record<string, string | undefined> = { TOKEN_ENCRYPTION_KEY: configured };

  const key = await ensureLocalDevEncryptionKey({ cwd, env });

  assert.equal(key, configured);
  assert.equal(env.TOKEN_ENCRYPTION_KEY, configured);
  assert.equal(await readFile(join(cwd, ".env.local"), "utf8"), `OTHER=value\nTOKEN_ENCRYPTION_KEY=${fileKey}\n`);
});

test("忽略 .env.local 中无效的密钥并保留其它配置", async () => {
  const cwd = await createTempProject();
  await writeFile(join(cwd, ".env.local"), "OTHER=value\nTOKEN_ENCRYPTION_KEY=invalid\n", "utf8");
  const env: Record<string, string | undefined> = {};

  const key = await ensureLocalDevEncryptionKey({ cwd, env });
  const persisted = await readFile(join(cwd, ".env.local"), "utf8");

  assert.equal(Buffer.from(key, "base64").byteLength, 32);
  assert.match(persisted, /^OTHER=value$/m);
  assert.match(persisted, new RegExp(`^TOKEN_ENCRYPTION_KEY=${key.replace(/[+/=]/g, "\\$&")}$`, "m"));
});
