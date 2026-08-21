CREATE TABLE IF NOT EXISTS `ai_settings_runtime` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`api_format` text NOT NULL,
	`base_url` text,
	`model` text NOT NULL,
	`reasoning_effort` text,
	`api_key_cipher` text NOT NULL,
	`key_hint` text NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `analysis_results_runtime` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`eid` text NOT NULL,
	`slot` text NOT NULL,
	`kind` text NOT NULL,
	`framework_id` text,
	`framework_name` text,
	`framework_snapshot` text,
	`source_type` text NOT NULL,
	`source_hash` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`api_format` text NOT NULL,
	`result_key` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_analysis_results_runtime_user_episode_slot` ON `analysis_results_runtime` (`user_id`,`eid`,`slot`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_analysis_results_runtime_user_episode` ON `analysis_results_runtime` (`user_id`,`eid`);--> statement-breakpoint
CREATE TABLE `__new_ai_settings` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`api_format` text NOT NULL,
	`base_url` text,
	`model` text NOT NULL,
	`reasoning_effort` text,
	`api_key_cipher` text NOT NULL,
	`key_hint` text NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
INSERT INTO `__new_ai_settings` (`user_id`, `provider`, `api_format`, `base_url`, `model`, `reasoning_effort`, `api_key_cipher`, `key_hint`, `connected_at`, `updated_at`)
SELECT `user_id`, 'deepseek', 'chat_completions', NULL, 'deepseek-v4-flash', NULL, `api_key_cipher`, `key_hint`, `connected_at`, `updated_at`
FROM `ai_settings`
WHERE NOT EXISTS (
	SELECT 1 FROM `app_state` WHERE `key` = 'ai_provider_schema' AND `value` = 'runtime_staged'
);
--> statement-breakpoint
INSERT OR REPLACE INTO `__new_ai_settings` (`user_id`, `provider`, `api_format`, `base_url`, `model`, `reasoning_effort`, `api_key_cipher`, `key_hint`, `connected_at`, `updated_at`)
SELECT `user_id`, `provider`, `api_format`, `base_url`, `model`, `reasoning_effort`, `api_key_cipher`, `key_hint`, `connected_at`, `updated_at`
FROM `ai_settings_runtime`;
--> statement-breakpoint
DROP TABLE `ai_settings`;
--> statement-breakpoint
ALTER TABLE `__new_ai_settings` RENAME TO `ai_settings`;
--> statement-breakpoint
CREATE TABLE `__new_analysis_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`eid` text NOT NULL,
	`slot` text NOT NULL,
	`kind` text NOT NULL,
	`framework_id` text,
	`framework_name` text,
	`framework_snapshot` text,
	`source_type` text NOT NULL,
	`source_hash` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`api_format` text NOT NULL,
	`result_key` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_analysis_results` (`id`, `user_id`, `eid`, `slot`, `kind`, `framework_id`, `framework_name`, `framework_snapshot`, `source_type`, `source_hash`, `model`, `provider`, `api_format`, `result_key`, `generated_at`)
SELECT `id`, `user_id`, `eid`, `slot`, `kind`, `framework_id`, `framework_name`, `framework_snapshot`, `source_type`, `source_hash`, `model`, 'deepseek', 'chat_completions', `result_key`, `generated_at`
FROM `analysis_results`
WHERE NOT EXISTS (
	SELECT 1 FROM `app_state` WHERE `key` = 'ai_provider_schema' AND `value` = 'runtime_staged'
);
--> statement-breakpoint
INSERT OR REPLACE INTO `__new_analysis_results` (`id`, `user_id`, `eid`, `slot`, `kind`, `framework_id`, `framework_name`, `framework_snapshot`, `source_type`, `source_hash`, `model`, `provider`, `api_format`, `result_key`, `generated_at`)
SELECT `id`, `user_id`, `eid`, `slot`, `kind`, `framework_id`, `framework_name`, `framework_snapshot`, `source_type`, `source_hash`, `model`, `provider`, `api_format`, `result_key`, `generated_at`
FROM `analysis_results_runtime`;
--> statement-breakpoint
DROP TABLE `analysis_results`;
--> statement-breakpoint
ALTER TABLE `__new_analysis_results` RENAME TO `analysis_results`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_analysis_results_user_episode_slot` ON `analysis_results` (`user_id`,`eid`,`slot`);--> statement-breakpoint
CREATE INDEX `idx_analysis_results_user_episode` ON `analysis_results` (`user_id`,`eid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_provider` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `ai_preferences` (`user_id`, `active_provider`, `updated_at`)
SELECT `user_id`, 'deepseek', `updated_at` FROM `ai_settings` WHERE `provider` = 'deepseek';
--> statement-breakpoint
DROP TABLE `ai_settings_runtime`;
--> statement-breakpoint
DROP TABLE `analysis_results_runtime`;
--> statement-breakpoint
INSERT INTO `app_state` (`key`, `value`, `updated_at`) VALUES ('ai_provider_schema', '0006', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = excluded.`updated_at`;
