CREATE TABLE `visual_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`spec_id` text,
	`asset_id` text,
	`kind` text NOT NULL,
	`scene_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`negative_prompt` text,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`seed` text,
	`generation_status` text NOT NULL,
	`text_validation_status` text,
	`text_validation_json` text,
	`error_message` text,
	`is_visible` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spec_id`) REFERENCES `visual_specs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visual_assets_work_kind_scene_version` ON `visual_assets` (`work_id`,`kind`,`scene_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_visual_assets_work_active_visible` ON `visual_assets` (`work_id`,`is_active`,`is_visible`);--> statement-breakpoint
CREATE INDEX `idx_visual_assets_asset_id` ON `visual_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `visual_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`profile_id` text,
	`kind` text NOT NULL,
	`scene_id` text,
	`source_sentence_ids_json` text,
	`source_text` text,
	`spec_json` text NOT NULL,
	`version` integer NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `work_visual_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visual_specs_work_kind_scene_version` ON `visual_specs` (`work_id`,`kind`,`scene_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_visual_specs_work_active` ON `visual_specs` (`work_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `work_visual_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`version` integer NOT NULL,
	`profile_json` text NOT NULL,
	`director_provider` text NOT NULL,
	`director_model` text NOT NULL,
	`is_locked` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_work_visual_profiles_work_version` ON `work_visual_profiles` (`work_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_work_visual_profiles_work_active` ON `work_visual_profiles` (`work_id`,`is_active`);