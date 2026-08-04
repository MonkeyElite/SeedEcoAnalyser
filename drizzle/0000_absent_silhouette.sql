CREATE TABLE `pricing_saves` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`dataset_fingerprint` text NOT NULL,
	`schema_version` integer NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pricing_saves_name` ON `pricing_saves` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `idx_pricing_saves_updated_at` ON `pricing_saves` (`updated_at`);