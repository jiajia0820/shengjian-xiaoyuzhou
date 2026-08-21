CREATE TABLE `analysis_frameworks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_analysis_frameworks_user_name` ON `analysis_frameworks` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_analysis_frameworks_user_updated` ON `analysis_frameworks` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `analysis_results` (
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
	`result_key` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_analysis_results_user_episode_slot` ON `analysis_results` (`user_id`,`eid`,`slot`);--> statement-breakpoint
CREATE INDEX `idx_analysis_results_user_episode` ON `analysis_results` (`user_id`,`eid`);--> statement-breakpoint
ALTER TABLE `episodes` ADD `original_hash` text DEFAULT '' NOT NULL;