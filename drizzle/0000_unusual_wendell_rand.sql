CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`kind` text NOT NULL,
	`storage_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`duration_ms` integer,
	`checksum` text NOT NULL,
	`provider` text DEFAULT 'upload' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assets_storage_key` ON `assets` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_assets_work_id_kind` ON `assets` (`work_id`,`kind`);--> statement-breakpoint
CREATE TABLE `audio_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`control_spec_version_id` text NOT NULL,
	`audio_asset_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`voice_id` text,
	`prompt_text` text NOT NULL,
	`timeline_json` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`candidate_state` text DEFAULT 'candidate' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`control_spec_version_id`) REFERENCES `control_spec_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`audio_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_audio_versions_work_id_created_at` ON `audio_versions` (`work_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `control_spec_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`version` integer NOT NULL,
	`schema_version` text DEFAULT '1.0' NOT NULL,
	`source` text NOT NULL,
	`spec_json` text NOT NULL,
	`validation_state` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_control_spec_versions_work_version` ON `control_spec_versions` (`work_id`,`version`);--> statement-breakpoint
CREATE TABLE `processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_processing_jobs_idempotency_key` ON `processing_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_work_id_status` ON `processing_jobs` (`work_id`,`status`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`slug` text NOT NULL,
	`control_spec_version_id` text NOT NULL,
	`audio_version_id` text NOT NULL,
	`state` text DEFAULT 'published' NOT NULL,
	`published_at` text NOT NULL,
	`withdrawn_at` text,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`control_spec_version_id`) REFERENCES `control_spec_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`audio_version_id`) REFERENCES `audio_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publications_slug` ON `publications` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_publications_work_id_published_at` ON `publications` (`work_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`genre` text NOT NULL,
	`language` text DEFAULT 'zh-CN' NOT NULL,
	`source_text` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_spec_version_id` text,
	`published_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_works_slug` ON `works` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_works_status_updated_at` ON `works` (`status`,`updated_at`);--> statement-breakpoint
PRAGMA optimize;
