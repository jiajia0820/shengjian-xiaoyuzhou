CREATE TABLE `connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`phone_hint` text NOT NULL,
	`access_token_cipher` text NOT NULL,
	`refresh_token_cipher` text NOT NULL,
	`device_id` text NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`eid` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`podcast_title` text NOT NULL,
	`published_at` text,
	`duration_seconds` integer,
	`segment_count` integer NOT NULL,
	`original_key` text NOT NULL,
	`current_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_episodes_user_eid` ON `episodes` (`user_id`,`eid`);--> statement-breakpoint
CREATE INDEX `idx_episodes_user_updated` ON `episodes` (`user_id`,`updated_at`);