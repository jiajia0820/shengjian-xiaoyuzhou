CREATE TABLE `ai_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`api_key_cipher` text NOT NULL,
	`key_hint` text NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL
);
