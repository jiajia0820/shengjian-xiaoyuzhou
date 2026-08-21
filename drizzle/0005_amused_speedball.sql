CREATE TABLE `anonymous_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_anonymous_sessions_user` ON `anonymous_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_anonymous_sessions_expires` ON `anonymous_sessions` (`expires_at`);