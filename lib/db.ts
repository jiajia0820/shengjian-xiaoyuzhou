import { getRuntimeEnv } from "./runtime";
import type { AiApiFormat, AiProvider, ReasoningEffort } from "./ai-provider";

export type ConnectionRecord = {
  user_id: string;
  phone_hint: string;
  access_token_cipher: string;
  refresh_token_cipher: string;
  device_id: string;
  connected_at: string;
  updated_at: string;
};

export type EpisodeRecord = {
  id: number;
  user_id: string;
  eid: string;
  source_url: string;
  title: string;
  podcast_title: string;
  published_at: string | null;
  duration_seconds: number | null;
  segment_count: number;
  original_key: string;
  current_key: string;
  original_hash: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
};

export type FrameworkRecord = {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  created_at: string;
  updated_at: string;
};

export type AnalysisRecord = {
  id: number;
  user_id: string;
  eid: string;
  slot: string;
  kind: "summary" | "learning_prompt";
  framework_id: string | null;
  framework_name: string | null;
  framework_snapshot: string | null;
  source_type: "original" | "current";
  source_hash: string;
  model: string;
  provider: AiProvider;
  api_format: AiApiFormat;
  result_key: string;
  generated_at: string;
};

export type AiSettingRecord = {
  user_id: string;
  provider: AiProvider;
  api_format: AiApiFormat;
  base_url: string | null;
  model: string;
  reasoning_effort: ReasoningEffort | null;
  api_key_cipher: string;
  key_hint: string;
  connected_at: string;
  updated_at: string;
};

export type AiPreferenceRecord = {
  user_id: string;
  active_provider: AiProvider | null;
  updated_at: string;
};

export type AppUserRecord = {
  id: string;
  verified_email: string;
  role: "admin" | "member";
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
};

export type AuthIdentityRecord = {
  provider: "supabase";
  provider_subject: string;
  user_id: string;
  created_at: string;
  updated_at: string;
};

export type AnonymousSessionRecord = {
  token_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
};

export type UsageRecord = {
  user_id: string;
  usage_date: string;
  import_count: number;
  ai_count: number;
  updated_at: string;
};

let schemaReady = false;

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const db = getRuntimeEnv().DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT PRIMARY KEY NOT NULL,
      phone_hint TEXT NOT NULL,
      access_token_cipher TEXT NOT NULL,
      refresh_token_cipher TEXT NOT NULL,
      device_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      eid TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      podcast_title TEXT NOT NULL,
      published_at TEXT,
      duration_seconds INTEGER,
      segment_count INTEGER NOT NULL,
      original_key TEXT NOT NULL,
      current_key TEXT NOT NULL,
      original_hash TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS analysis_frameworks (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      eid TEXT NOT NULL,
      slot TEXT NOT NULL,
      kind TEXT NOT NULL,
      framework_id TEXT,
      framework_name TEXT,
      framework_snapshot TEXT,
      source_type TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_format TEXT NOT NULL,
      result_key TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_settings (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_format TEXT NOT NULL,
      base_url TEXT,
      model TEXT NOT NULL,
      reasoning_effort TEXT,
      api_key_cipher TEXT NOT NULL,
      key_hint TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_preferences (
      user_id TEXT PRIMARY KEY NOT NULL,
      active_provider TEXT,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY NOT NULL,
      verified_email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_identities (
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS anonymous_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage_counters (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      import_count INTEGER NOT NULL DEFAULT 0,
      ai_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
      bucket_key TEXT PRIMARY KEY NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS captcha_tickets (
      ticket_hash TEXT PRIMARY KEY NOT NULL,
      consumed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS analysis_leases (
      user_id TEXT PRIMARY KEY NOT NULL,
      lease_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_user_eid ON episodes(user_id, eid)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_episodes_user_updated ON episodes(user_id, updated_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_frameworks_user_name ON analysis_frameworks(user_id, name)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_frameworks_user_updated ON analysis_frameworks(user_id, updated_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_results_user_episode_slot ON analysis_results(user_id, eid, slot)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_results_user_episode ON analysis_results(user_id, eid)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_verified_email ON app_users(verified_email)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_subject ON auth_identities(provider, provider_subject)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_anonymous_sessions_user ON anonymous_sessions(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_anonymous_sessions_expires ON anonymous_sessions(expires_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_counters_user_date ON usage_counters(user_id, usage_date)"),
  ]);

  await db.prepare(
    "INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES ('bootstrap', 'open', ?)",
  ).bind(new Date().toISOString()).run();

  const episodeColumns = await db.prepare("PRAGMA table_info(episodes)").all<{ name: string }>();
  if (!episodeColumns.results.some((column) => column.name === "original_hash")) {
    await db.prepare("ALTER TABLE episodes ADD COLUMN original_hash TEXT NOT NULL DEFAULT ''").run();
  }

  const aiSettingColumns = await db.prepare("PRAGMA table_info(ai_settings)").all<{ name: string }>();
  if (!aiSettingColumns.results.some((column) => column.name === "api_format")) {
    await db.batch([
      db.prepare(`CREATE TABLE __new_ai_settings (
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_format TEXT NOT NULL,
        base_url TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        api_key_cipher TEXT NOT NULL,
        key_hint TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      )`),
      db.prepare(`INSERT INTO __new_ai_settings
        (user_id, provider, api_format, base_url, model, reasoning_effort, api_key_cipher, key_hint, connected_at, updated_at)
        SELECT user_id, 'deepseek', 'chat_completions', NULL, 'deepseek-v4-flash', NULL,
          api_key_cipher, key_hint, connected_at, updated_at
        FROM ai_settings`),
      db.prepare("DROP TABLE ai_settings"),
      db.prepare("ALTER TABLE __new_ai_settings RENAME TO ai_settings"),
      db.prepare(`INSERT OR IGNORE INTO ai_preferences (user_id, active_provider, updated_at)
        SELECT user_id, 'deepseek', updated_at FROM ai_settings`),
    ]);
  }

  const analysisResultColumns = await db.prepare("PRAGMA table_info(analysis_results)").all<{ name: string }>();
  if (!analysisResultColumns.results.some((column) => column.name === "provider")) {
    await db.prepare("ALTER TABLE analysis_results ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek'").run();
  }
  if (!analysisResultColumns.results.some((column) => column.name === "api_format")) {
    await db.prepare("ALTER TABLE analysis_results ADD COLUMN api_format TEXT NOT NULL DEFAULT 'chat_completions'").run();
  }
  schemaReady = true;
}

export async function getConnection(userId: string): Promise<ConnectionRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare("SELECT * FROM connections WHERE user_id = ?")
    .bind(userId).first<ConnectionRecord>();
}

export async function saveConnection(record: ConnectionRecord): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(`INSERT INTO connections
    (user_id, phone_hint, access_token_cipher, refresh_token_cipher, device_id, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      phone_hint = excluded.phone_hint,
      access_token_cipher = excluded.access_token_cipher,
      refresh_token_cipher = excluded.refresh_token_cipher,
      device_id = excluded.device_id,
      updated_at = excluded.updated_at`)
    .bind(record.user_id, record.phone_hint, record.access_token_cipher, record.refresh_token_cipher,
      record.device_id, record.connected_at, record.updated_at).run();
}

export async function deleteConnection(userId: string): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare("DELETE FROM connections WHERE user_id = ?").bind(userId).run();
}

export async function listEpisodes(userId: string): Promise<EpisodeRecord[]> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "SELECT * FROM episodes WHERE user_id = ? ORDER BY updated_at DESC",
  ).bind(userId).all<EpisodeRecord>();
  return result.results;
}

export async function getEpisodeRecord(userId: string, eid: string): Promise<EpisodeRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare("SELECT * FROM episodes WHERE user_id = ? AND eid = ?")
    .bind(userId, eid).first<EpisodeRecord>();
}

export async function deleteEpisodeRecords(userId: string, eid: string): Promise<boolean> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  const results = await db.batch([
    db.prepare("DELETE FROM analysis_results WHERE user_id = ? AND eid = ?").bind(userId, eid),
    db.prepare("DELETE FROM episodes WHERE user_id = ? AND eid = ?").bind(userId, eid),
  ]);
  return Boolean(results[1]?.meta.changes);
}

export async function upsertEpisode(record: Omit<EpisodeRecord, "id">): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(`INSERT INTO episodes
    (user_id, eid, source_url, title, podcast_title, published_at, duration_seconds, segment_count,
     original_key, current_key, original_hash, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, eid) DO UPDATE SET
      source_url = excluded.source_url,
      title = excluded.title,
      podcast_title = excluded.podcast_title,
      published_at = excluded.published_at,
      duration_seconds = excluded.duration_seconds,
      segment_count = excluded.segment_count,
      original_key = excluded.original_key,
      original_hash = excluded.original_hash,
      updated_at = excluded.updated_at`)
    .bind(record.user_id, record.eid, record.source_url, record.title, record.podcast_title,
      record.published_at, record.duration_seconds, record.segment_count, record.original_key,
      record.current_key, record.original_hash, record.content_hash, record.created_at, record.updated_at).run();
}

export async function touchCurrentDocument(userId: string, eid: string, contentHash: string): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(
    "UPDATE episodes SET content_hash = ?, updated_at = ? WHERE user_id = ? AND eid = ?",
  ).bind(contentHash, new Date().toISOString(), userId, eid).run();
}

export async function setOriginalHash(userId: string, eid: string, hash: string): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(
    "UPDATE episodes SET original_hash = ? WHERE user_id = ? AND eid = ?",
  ).bind(hash, userId, eid).run();
}

export async function listFrameworks(userId: string): Promise<FrameworkRecord[]> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "SELECT * FROM analysis_frameworks WHERE user_id = ? ORDER BY updated_at DESC",
  ).bind(userId).all<FrameworkRecord>();
  return result.results;
}

export async function getFramework(userId: string, id: string): Promise<FrameworkRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare(
    "SELECT * FROM analysis_frameworks WHERE user_id = ? AND id = ?",
  ).bind(userId, id).first<FrameworkRecord>();
}

export async function createFramework(record: FrameworkRecord): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(`INSERT INTO analysis_frameworks
    (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(record.id, record.user_id, record.name, record.instructions, record.created_at, record.updated_at).run();
}

export async function updateFramework(userId: string, id: string, name: string, instructions: string): Promise<boolean> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "UPDATE analysis_frameworks SET name = ?, instructions = ?, updated_at = ? WHERE user_id = ? AND id = ?",
  ).bind(name, instructions, new Date().toISOString(), userId, id).run();
  return Boolean(result.meta.changes);
}

export async function deleteFramework(userId: string, id: string): Promise<boolean> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "DELETE FROM analysis_frameworks WHERE user_id = ? AND id = ?",
  ).bind(userId, id).run();
  return Boolean(result.meta.changes);
}

export async function listAnalysisResults(userId: string, eid: string): Promise<AnalysisRecord[]> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "SELECT * FROM analysis_results WHERE user_id = ? AND eid = ? ORDER BY generated_at DESC",
  ).bind(userId, eid).all<AnalysisRecord>();
  return result.results;
}

export async function getAnalysisResult(userId: string, eid: string, slot: string): Promise<AnalysisRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare(
    "SELECT * FROM analysis_results WHERE user_id = ? AND eid = ? AND slot = ?",
  ).bind(userId, eid, slot).first<AnalysisRecord>();
}

export async function upsertAnalysisResult(record: Omit<AnalysisRecord, "id">): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(`INSERT INTO analysis_results
    (user_id, eid, slot, kind, framework_id, framework_name, framework_snapshot,
     source_type, source_hash, model, provider, api_format, result_key, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, eid, slot) DO UPDATE SET
      kind = excluded.kind,
      framework_id = excluded.framework_id,
      framework_name = excluded.framework_name,
      framework_snapshot = excluded.framework_snapshot,
      source_type = excluded.source_type,
      source_hash = excluded.source_hash,
      model = excluded.model,
      provider = excluded.provider,
      api_format = excluded.api_format,
      result_key = excluded.result_key,
      generated_at = excluded.generated_at`)
    .bind(record.user_id, record.eid, record.slot, record.kind, record.framework_id,
      record.framework_name, record.framework_snapshot, record.source_type, record.source_hash,
      record.model, record.provider, record.api_format, record.result_key, record.generated_at).run();
}

export async function getAiSettings(userId: string): Promise<AiSettingRecord[]> {
  await ensureSchema();
  const result = await getRuntimeEnv().DB.prepare(
    "SELECT * FROM ai_settings WHERE user_id = ? ORDER BY provider",
  ).bind(userId).all<AiSettingRecord>();
  return result.results;
}

export async function getAiSetting(userId: string, provider: AiProvider): Promise<AiSettingRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare("SELECT * FROM ai_settings WHERE user_id = ? AND provider = ?")
    .bind(userId, provider).first<AiSettingRecord>();
}

export async function saveAiSetting(record: AiSettingRecord): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare(`INSERT INTO ai_settings
    (user_id, provider, api_format, base_url, model, reasoning_effort, api_key_cipher, key_hint, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      api_format = excluded.api_format,
      base_url = excluded.base_url,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      api_key_cipher = excluded.api_key_cipher,
      key_hint = excluded.key_hint,
      updated_at = excluded.updated_at`)
    .bind(record.user_id, record.provider, record.api_format, record.base_url, record.model,
      record.reasoning_effort, record.api_key_cipher, record.key_hint, record.connected_at, record.updated_at).run();
}

export async function getAiPreference(userId: string): Promise<AiPreferenceRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare("SELECT * FROM ai_preferences WHERE user_id = ?")
    .bind(userId).first<AiPreferenceRecord>();
}

export async function setAiPreference(userId: string, provider: AiProvider | null): Promise<void> {
  await ensureSchema();
  const updatedAt = new Date().toISOString();
  await getRuntimeEnv().DB.prepare(`INSERT INTO ai_preferences
    (user_id, active_provider, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      active_provider = excluded.active_provider,
      updated_at = excluded.updated_at`)
    .bind(userId, provider, updatedAt).run();
}

export async function deleteAiSetting(userId: string, provider: AiProvider): Promise<void> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  await db.batch([
    db.prepare(`UPDATE ai_preferences
      SET active_provider = (
        SELECT provider FROM ai_settings
        WHERE user_id = ? AND provider <> ?
        ORDER BY provider
        LIMIT 1
      ), updated_at = ?
      WHERE user_id = ? AND active_provider = ?`)
      .bind(userId, provider, new Date().toISOString(), userId, provider),
    db.prepare("DELETE FROM ai_settings WHERE user_id = ? AND provider = ?").bind(userId, provider),
  ]);
}

export async function getAppUser(userId: string): Promise<AppUserRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare("SELECT * FROM app_users WHERE id = ?")
    .bind(userId).first<AppUserRecord>();
}

export async function getAppUserByIdentity(providerSubject: string): Promise<AppUserRecord | null> {
  await ensureSchema();
  return getRuntimeEnv().DB.prepare(`SELECT u.* FROM app_users u
    JOIN auth_identities i ON i.user_id = u.id
    WHERE i.provider = 'supabase' AND i.provider_subject = ?`)
    .bind(providerSubject).first<AppUserRecord>();
}

export async function createAppIdentity(providerSubject: string, verifiedEmail: string): Promise<AppUserRecord> {
  await ensureSchema();
  const now = new Date().toISOString();
  const record: AppUserRecord = {
    id: crypto.randomUUID(), verified_email: verifiedEmail, role: "member", status: "active",
    created_at: now, updated_at: now,
  };
  await getRuntimeEnv().DB.batch([
    getRuntimeEnv().DB.prepare(`INSERT INTO app_users
      (id, verified_email, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)`)
      .bind(record.id, record.verified_email, now, now),
    getRuntimeEnv().DB.prepare(`INSERT INTO auth_identities
      (provider, provider_subject, user_id, created_at, updated_at) VALUES ('supabase', ?, ?, ?, ?)`)
      .bind(providerSubject, record.id, now, now),
  ]);
  return record;
}

export async function refreshAppUserEmail(userId: string, verifiedEmail: string): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare("UPDATE app_users SET verified_email = ?, updated_at = ? WHERE id = ?")
    .bind(verifiedEmail, new Date().toISOString(), userId).run();
}

export async function createAnonymousSession(input: {
  tokenHash: string;
  userId: string;
  now?: Date;
}): Promise<AnonymousSessionRecord> {
  await ensureSchema();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await getRuntimeEnv().DB.prepare(`INSERT INTO anonymous_sessions
    (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.tokenHash, input.userId, expiresAt, nowIso, nowIso).run();
  return {
    token_hash: input.tokenHash,
    user_id: input.userId,
    expires_at: expiresAt,
    created_at: nowIso,
    last_seen_at: nowIso,
  };
}

export async function getActiveAnonymousSession(
  tokenHash: string,
  now = new Date(),
): Promise<AnonymousSessionRecord | null> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  const nowIso = now.toISOString();
  const record = await db.prepare(
    "SELECT * FROM anonymous_sessions WHERE token_hash = ? AND expires_at > ?",
  ).bind(tokenHash, nowIso).first<AnonymousSessionRecord>();
  if (!record) return null;
  const refreshBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (record.last_seen_at <= refreshBefore) {
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare(`UPDATE anonymous_sessions SET expires_at = ?, last_seen_at = ?
      WHERE token_hash = ? AND last_seen_at <= ?`)
      .bind(expiresAt, nowIso, tokenHash, refreshBefore).run();
    return { ...record, expires_at: expiresAt, last_seen_at: nowIso };
  }
  return record;
}

export async function bootstrapIsOpen(): Promise<boolean> {
  await ensureSchema();
  const row = await getRuntimeEnv().DB.prepare("SELECT value FROM app_state WHERE key = 'bootstrap'")
    .first<{ value: string }>();
  return row?.value === "open";
}

export async function hasOwnedData(userId: string): Promise<boolean> {
  await ensureSchema();
  const row = await getRuntimeEnv().DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM connections WHERE user_id = ?) OR
    EXISTS(SELECT 1 FROM episodes WHERE user_id = ?) OR
    EXISTS(SELECT 1 FROM analysis_frameworks WHERE user_id = ?) OR
    EXISTS(SELECT 1 FROM analysis_results WHERE user_id = ?) OR
    EXISTS(SELECT 1 FROM ai_settings WHERE user_id = ?) AS owns_data`)
    .bind(userId, userId, userId, userId, userId).first<{ owns_data: number }>();
  return Boolean(row?.owns_data);
}

export async function claimLegacyOwner(input: {
  legacyUserId: string;
  providerSubject: string;
  verifiedEmail: string;
}): Promise<AppUserRecord> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  const existingIdentity = await db.prepare(
    "SELECT user_id FROM auth_identities WHERE provider = 'supabase' AND provider_subject = ?",
  ).bind(input.providerSubject).first<{ user_id: string }>();
  if (existingIdentity && existingIdentity.user_id !== input.legacyUserId) {
    if (await hasOwnedData(existingIdentity.user_id)) throw new Error("IDENTITY_ALREADY_HAS_DATA");
    await db.batch([
      db.prepare("DELETE FROM auth_identities WHERE user_id = ?").bind(existingIdentity.user_id),
      db.prepare("DELETE FROM app_users WHERE id = ?").bind(existingIdentity.user_id),
    ]);
  }
  const now = new Date().toISOString();
  const claim = await db.prepare(
    "UPDATE app_state SET value = 'claimed', updated_at = ? WHERE key = 'bootstrap' AND value = 'open'",
  ).bind(now).run();
  if (!claim.meta.changes) throw new Error("BOOTSTRAP_CLOSED");
  await db.batch([
    db.prepare(`INSERT INTO app_users (id, verified_email, role, status, created_at, updated_at)
      VALUES (?, ?, 'admin', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET verified_email = excluded.verified_email, role = 'admin',
        status = 'active', updated_at = excluded.updated_at`)
      .bind(input.legacyUserId, input.verifiedEmail, now, now),
    db.prepare(`INSERT INTO auth_identities (provider, provider_subject, user_id, created_at, updated_at)
      VALUES ('supabase', ?, ?, ?, ?)
      ON CONFLICT(provider, provider_subject) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`)
      .bind(input.providerSubject, input.legacyUserId, now, now),
  ]);
  return (await getAppUser(input.legacyUserId))!;
}

export async function getUsage(userId: string, usageDate = new Date().toISOString().slice(0, 10)): Promise<UsageRecord> {
  await ensureSchema();
  const row = await getRuntimeEnv().DB.prepare(
    "SELECT * FROM usage_counters WHERE user_id = ? AND usage_date = ?",
  ).bind(userId, usageDate).first<UsageRecord>();
  return row ?? { user_id: userId, usage_date: usageDate, import_count: 0, ai_count: 0, updated_at: new Date().toISOString() };
}

export async function consumeUsage(userId: string, kind: "import" | "ai", limit: number): Promise<boolean> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO usage_counters
    (user_id, usage_date, import_count, ai_count, updated_at) VALUES (?, ?, 0, 0, ?)`)
    .bind(userId, day, now).run();
  const column = kind === "import" ? "import_count" : "ai_count";
  const result = await db.prepare(
    `UPDATE usage_counters SET ${column} = ${column} + 1, updated_at = ?
     WHERE user_id = ? AND usage_date = ? AND ${column} < ?`,
  ).bind(now, userId, day, limit).run();
  return Boolean(result.meta.changes);
}

export async function refundUsage(userId: string, kind: "import" | "ai"): Promise<void> {
  await ensureSchema();
  const day = new Date().toISOString().slice(0, 10);
  const column = kind === "import" ? "import_count" : "ai_count";
  await getRuntimeEnv().DB.prepare(
    `UPDATE usage_counters SET ${column} = MAX(0, ${column} - 1), updated_at = ? WHERE user_id = ? AND usage_date = ?`,
  ).bind(new Date().toISOString(), userId, day).run();
}

export async function consumeAuthRateLimit(bucketKey: string, limit: number, windowSeconds: number): Promise<boolean> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();
  const result = await db.prepare(`INSERT INTO auth_rate_limits
    (bucket_key, count, expires_at, updated_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      count = CASE WHEN auth_rate_limits.expires_at <= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
      expires_at = CASE WHEN auth_rate_limits.expires_at <= ? THEN excluded.expires_at ELSE auth_rate_limits.expires_at END,
      updated_at = excluded.updated_at
    WHERE auth_rate_limits.expires_at <= ? OR auth_rate_limits.count < ?`)
    .bind(bucketKey, expiresAt, nowIso, nowIso, nowIso, nowIso, limit).run();
  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM auth_rate_limits WHERE expires_at < ?").bind(nowIso).run();
  }
  return Boolean(result.meta.changes);
}

export async function consumeCaptchaTicket(ticketHash: string): Promise<boolean> {
  await ensureSchema();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const result = await getRuntimeEnv().DB.prepare(`INSERT OR IGNORE INTO captcha_tickets
    (ticket_hash, consumed_at, expires_at) VALUES (?, ?, ?)`)
    .bind(ticketHash, nowIso, expiresAt).run();
  if (Math.random() < 0.02) {
    await getRuntimeEnv().DB.prepare("DELETE FROM captcha_tickets WHERE expires_at < ?").bind(nowIso).run();
  }
  return Boolean(result.meta.changes);
}

export async function acquireAnalysisLease(userId: string): Promise<string | null> {
  await ensureSchema();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const result = await getRuntimeEnv().DB.prepare(`INSERT INTO analysis_leases
    (user_id, lease_id, expires_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lease_id = excluded.lease_id,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at
    WHERE analysis_leases.expires_at < ?`)
    .bind(userId, leaseId, expiresAt, nowIso, nowIso).run();
  return result.meta.changes ? leaseId : null;
}

export async function releaseAnalysisLease(userId: string, leaseId: string): Promise<void> {
  await ensureSchema();
  await getRuntimeEnv().DB.prepare("DELETE FROM analysis_leases WHERE user_id = ? AND lease_id = ?")
    .bind(userId, leaseId).run();
}

export async function deleteAllUserRecords(userId: string): Promise<void> {
  await ensureSchema();
  const db = getRuntimeEnv().DB;
  await db.batch([
    db.prepare("DELETE FROM anonymous_sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM connections WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM episodes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM analysis_frameworks WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM analysis_results WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM ai_preferences WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM ai_settings WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM usage_counters WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM analysis_leases WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM auth_identities WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM app_users WHERE id = ?").bind(userId),
  ]);
}

export function publicEpisode(record: EpisodeRecord) {
  return {
    eid: record.eid,
    sourceUrl: record.source_url,
    title: record.title,
    podcastTitle: record.podcast_title,
    publishedAt: record.published_at,
    durationSeconds: record.duration_seconds,
    segmentCount: record.segment_count,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function publicFramework(record: FrameworkRecord) {
  return {
    id: record.id,
    name: record.name,
    instructions: record.instructions,
    isSystem: false,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function publicAnalysis(record: AnalysisRecord, episode: EpisodeRecord) {
  const currentHash = record.source_type === "original" ? episode.original_hash : episode.content_hash;
  return {
    slot: record.slot,
    kind: record.kind,
    frameworkId: record.framework_id,
    frameworkName: record.framework_name,
    sourceType: record.source_type,
    sourceHash: record.source_hash,
    model: record.model,
    provider: record.provider,
    apiFormat: record.api_format,
    generatedAt: record.generated_at,
    stale: !currentHash || currentHash !== record.source_hash,
  };
}
