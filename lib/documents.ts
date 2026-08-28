import { getRuntimeEnv } from "./runtime";
import { sha256Hex } from "./security";
import { HttpError } from "./user";

export async function documentKeys(userId: string, eid: string) {
  const owner = (await sha256Hex(userId)).slice(0, 24);
  const base = `users/${owner}/episodes/${eid}`;
  return {
    originalKey: `${base}/original.md`,
    currentKey: `${base}/current.md`,
    transcriptKey: `${base}/transcript.json`,
    aiCleanupSnapshotKey: `${base}/revisions/ai-cleanup-latest.json`,
  };
}

export async function analysisDocumentKey(userId: string, eid: string, slot: string): Promise<string> {
  const owner = (await sha256Hex(userId)).slice(0, 24);
  const safeSlot = slot.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  return `users/${owner}/episodes/${eid}/analyses/${safeSlot}.md`;
}

export async function putMarkdown(key: string, markdown: string): Promise<void> {
  await getRuntimeEnv().DOCUMENTS.put(key, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
}

export async function putJson(key: string, value: unknown): Promise<void> {
  await getRuntimeEnv().DOCUMENTS.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function deleteDocument(key: string): Promise<void> {
  await getRuntimeEnv().DOCUMENTS.delete(key);
}

export async function readMarkdown(key: string): Promise<string> {
  const object = await getRuntimeEnv().DOCUMENTS.get(key);
  if (!object) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "文稿文件不存在");
  return object.text();
}

export async function readJson(key: string): Promise<string> {
  const object = await getRuntimeEnv().DOCUMENTS.get(key);
  if (!object) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "文稿结构文件不存在");
  return object.text();
}

export async function deleteEpisodeDocuments(userId: string, eid: string): Promise<void> {
  const owner = (await sha256Hex(userId)).slice(0, 24);
  const prefix = `users/${owner}/episodes/${eid}/`;
  let cursor: string | undefined;
  do {
    const page = await getRuntimeEnv().DOCUMENTS.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await getRuntimeEnv().DOCUMENTS.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteUserDocuments(userId: string): Promise<void> {
  const owner = (await sha256Hex(userId)).slice(0, 24);
  const prefix = `users/${owner}/`;
  let cursor: string | undefined;
  do {
    const page = await getRuntimeEnv().DOCUMENTS.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await getRuntimeEnv().DOCUMENTS.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
