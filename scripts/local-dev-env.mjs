import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENV_FILE_NAME = ".env.local";
const KEY_NAME = "TOKEN_ENCRYPTION_KEY";

function isValidEncryptionKey(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false;
  const decoded = Buffer.from(normalized, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === normalized;
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("\\'", "'");
  }
  return value;
}

function readEncryptionKey(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TOKEN_ENCRYPTION_KEY\s*=\s*(.*?)\s*$/);
    if (match) return unquote(match[1]);
  }
  return undefined;
}

function upsertEncryptionKey(content, key) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const keyLine = `${KEY_NAME}=${key}`;
  const existingIndex = lines.findIndex((line) => /^\s*(?:export\s+)?TOKEN_ENCRYPTION_KEY\s*=/.test(line));

  if (existingIndex >= 0) {
    lines[existingIndex] = keyLine;
  } else if (lines.length === 1 && lines[0] === "") {
    lines[0] = keyLine;
  } else if (lines.at(-1) === "") {
    lines.splice(lines.length - 1, 0, keyLine);
  } else {
    lines.push(keyLine);
  }
  return lines.join(newline);
}

async function readLocalEnvFile(cwd) {
  try {
    return await readFile(resolve(cwd, ENV_FILE_NAME), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Ensures the local development process has a key for encrypting credentials.
 * An explicitly supplied process value always wins and is never written out.
 */
export async function ensureLocalDevEncryptionKey(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configured = env[KEY_NAME];
  if (typeof configured === "string" && configured.trim()) return configured;

  const envPath = resolve(cwd, ENV_FILE_NAME);
  const content = await readLocalEnvFile(cwd);
  const persisted = readEncryptionKey(content);
  if (isValidEncryptionKey(persisted)) {
    env[KEY_NAME] = persisted.trim();
    return env[KEY_NAME];
  }

  const generated = randomBytes(32).toString("base64");
  env[KEY_NAME] = generated;
  await writeFile(envPath, upsertEncryptionKey(content, generated), { encoding: "utf8", mode: 0o600 });
  return generated;
}

