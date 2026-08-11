ALTER TABLE `assets` ADD `source_asset_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `metadata_json` text;--> statement-breakpoint
CREATE INDEX `idx_assets_work_kind_source` ON `assets` (`work_id`,`kind`,`source_asset_id`);--> statement-breakpoint
ALTER TABLE `works` ADD `audio_sync_status` text DEFAULT 'pending' NOT NULL;