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
SELECT `user_id`, 'deepseek', 'chat_completions', NULL, 'deepseek-v4-flash', NULL, `api_key_cipher`, `key_hint`, `connected_at`, `updated_at` FROM `ai_settings`;
--> statement-breakpoint
DROP TABLE `ai_settings`;
--> statement-breakpoint
ALTER TABLE `__new_ai_settings` RENAME TO `ai_settings`;
--> statement-breakpoint
CREATE TABLE `ai_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_provider` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `ai_preferences` (`user_id`, `active_provider`, `updated_at`)
SELECT `user_id`, 'deepseek', `updated_at` FROM `ai_settings`;
--> statement-breakpoint
ALTER TABLE `analysis_results` ADD `provider` text DEFAULT 'deepseek' NOT NULL;
--> statement-breakpoint
ALTER TABLE `analysis_results` ADD `api_format` text DEFAULT 'chat_completions' NOT NULL;
