import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const connections = sqliteTable("connections", {
  userId: text("user_id").primaryKey(),
  phoneHint: text("phone_hint").notNull(),
  accessTokenCipher: text("access_token_cipher").notNull(),
  refreshTokenCipher: text("refresh_token_cipher").notNull(),
  deviceId: text("device_id").notNull(),
  connectedAt: text("connected_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const episodes = sqliteTable("episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  eid: text("eid").notNull(),
  sourceUrl: text("source_url").notNull(),
  title: text("title").notNull(),
  podcastTitle: text("podcast_title").notNull(),
  publishedAt: text("published_at"),
  durationSeconds: integer("duration_seconds"),
  segmentCount: integer("segment_count").notNull(),
  originalKey: text("original_key").notNull(),
  currentKey: text("current_key").notNull(),
  originalHash: text("original_hash").notNull().default(""),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_episodes_user_eid").on(table.userId, table.eid),
  index("idx_episodes_user_updated").on(table.userId, table.updatedAt),
]);

export const analysisFrameworks = sqliteTable("analysis_frameworks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_analysis_frameworks_user_name").on(table.userId, table.name),
  index("idx_analysis_frameworks_user_updated").on(table.userId, table.updatedAt),
]);

export const analysisResults = sqliteTable("analysis_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  eid: text("eid").notNull(),
  slot: text("slot").notNull(),
  kind: text("kind").notNull(),
  frameworkId: text("framework_id"),
  frameworkName: text("framework_name"),
  frameworkSnapshot: text("framework_snapshot"),
  sourceType: text("source_type").notNull(),
  sourceHash: text("source_hash").notNull(),
  model: text("model").notNull(),
  resultKey: text("result_key").notNull(),
  generatedAt: text("generated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_analysis_results_user_episode_slot").on(table.userId, table.eid, table.slot),
  index("idx_analysis_results_user_episode").on(table.userId, table.eid),
]);

export const aiSettings = sqliteTable("ai_settings", {
  userId: text("user_id").primaryKey(),
  provider: text("provider").notNull(),
  apiKeyCipher: text("api_key_cipher").notNull(),
  keyHint: text("key_hint").notNull(),
  connectedAt: text("connected_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  verifiedEmail: text("verified_email").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_app_users_verified_email").on(table.verifiedEmail),
]);

export const authIdentities = sqliteTable("auth_identities", {
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_auth_identities_provider_subject").on(table.provider, table.providerSubject),
  index("idx_auth_identities_user").on(table.userId),
]);

export const anonymousSessions = sqliteTable("anonymous_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  index("idx_anonymous_sessions_user").on(table.userId),
  index("idx_anonymous_sessions_expires").on(table.expiresAt),
]);

export const usageCounters = sqliteTable("usage_counters", {
  userId: text("user_id").notNull(),
  usageDate: text("usage_date").notNull(),
  importCount: integer("import_count").notNull().default(0),
  aiCount: integer("ai_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_usage_counters_user_date").on(table.userId, table.usageDate),
]);
export const authRateLimits = sqliteTable("auth_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  count: integer("count").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const captchaTickets = sqliteTable("captcha_tickets", {
  ticketHash: text("ticket_hash").primaryKey(),
  consumedAt: text("consumed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});


export const analysisLeases = sqliteTable("analysis_leases", {
  userId: text("user_id").primaryKey(),
  leaseId: text("lease_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
