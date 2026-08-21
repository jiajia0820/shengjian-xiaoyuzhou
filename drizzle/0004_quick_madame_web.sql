CREATE TABLE `auth_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `captcha_tickets` (
	`ticket_hash` text PRIMARY KEY NOT NULL,
	`consumed_at` text NOT NULL,
	`expires_at` text NOT NULL
);
