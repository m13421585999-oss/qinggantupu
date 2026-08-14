import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const works = sqliteTable(
  "works",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    genre: text("genre").notNull(),
    language: text("language").notNull().default("zh-CN"),
    sourceText: text("source_text").notNull(),
    status: text("status").notNull().default("draft"),
    audioSourceType: text("audio_source_type").notNull().default("human_reference"),
    audioSyncStatus: text("audio_sync_status").notNull().default("pending"),
    currentSpecVersionId: text("current_spec_version_id"),
    publishedRevisionId: text("published_revision_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_works_slug").on(table.slug),
    index("idx_works_status_updated_at").on(table.status, table.updatedAt),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    durationMs: integer("duration_ms"),
    checksum: text("checksum").notNull(),
    provider: text("provider").notNull().default("upload"),
    sourceAssetId: text("source_asset_id"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_assets_storage_key").on(table.storageKey),
    index("idx_assets_work_id_kind").on(table.workId, table.kind),
    index("idx_assets_work_kind_source").on(table.workId, table.kind, table.sourceAssetId),
  ],
);

export const controlSpecVersions = sqliteTable(
  "control_spec_versions",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    schemaVersion: text("schema_version").notNull().default("1.0"),
    source: text("source").notNull(),
    specJson: text("spec_json").notNull(),
    validationState: text("validation_state").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_control_spec_versions_work_version").on(
      table.workId,
      table.version,
    ),
  ],
);

export const audioVersions = sqliteTable(
  "audio_versions",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    controlSpecVersionId: text("control_spec_version_id")
      .notNull()
      .references(() => controlSpecVersions.id, { onDelete: "restrict" }),
    audioAssetId: text("audio_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    voiceId: text("voice_id"),
    promptText: text("prompt_text").notNull(),
    promptTraceJson: text("prompt_trace_json"),
    timelineJson: text("timeline_json").notNull(),
    durationMs: integer("duration_ms").notNull(),
    candidateState: text("candidate_state").notNull().default("candidate"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_audio_versions_work_id_created_at").on(
      table.workId,
      table.createdAt,
    ),
  ],
);

export const publications = sqliteTable(
  "publications",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    controlSpecVersionId: text("control_spec_version_id")
      .notNull()
      .references(() => controlSpecVersions.id, { onDelete: "restrict" }),
    audioVersionId: text("audio_version_id")
      .notNull()
      .references(() => audioVersions.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("published"),
    publishedAt: text("published_at").notNull(),
    withdrawnAt: text("withdrawn_at"),
  },
  (table) => [
    uniqueIndex("idx_publications_slug").on(table.slug),
    index("idx_publications_work_id_published_at").on(
      table.workId,
      table.publishedAt,
    ),
  ],
);

export const processingJobs = sqliteTable(
  "processing_jobs",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    inputJson: text("input_json").notNull(),
    outputJson: text("output_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_processing_jobs_idempotency_key").on(table.idempotencyKey),
    index("idx_processing_jobs_work_id_status").on(table.workId, table.status),
  ],
);

export const workVisualProfiles = sqliteTable(
  "work_visual_profiles",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    profileJson: text("profile_json").notNull(),
    directorProvider: text("director_provider").notNull(),
    directorModel: text("director_model").notNull(),
    isLocked: integer("is_locked", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_work_visual_profiles_work_version").on(table.workId, table.version),
    index("idx_work_visual_profiles_work_active").on(table.workId, table.isActive),
  ],
);

export const visualSpecs = sqliteTable(
  "visual_specs",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    profileId: text("profile_id").references(() => workVisualProfiles.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    sceneId: text("scene_id"),
    sourceSentenceIdsJson: text("source_sentence_ids_json"),
    sourceText: text("source_text"),
    specJson: text("spec_json").notNull(),
    version: integer("version").notNull(),
    state: text("state").notNull().default("ready"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_visual_specs_work_kind_scene_version").on(
      table.workId,
      table.kind,
      table.sceneId,
      table.version,
    ),
    index("idx_visual_specs_work_active").on(table.workId, table.isActive),
  ],
);

export const visualAssets = sqliteTable(
  "visual_assets",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    specId: text("spec_id").references(() => visualSpecs.id, { onDelete: "set null" }),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    sceneId: text("scene_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    seed: text("seed"),
    generationStatus: text("generation_status").notNull(),
    textValidationStatus: text("text_validation_status"),
    textValidationJson: text("text_validation_json"),
    errorMessage: text("error_message"),
    isVisible: integer("is_visible", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_visual_assets_work_kind_scene_version").on(
      table.workId,
      table.kind,
      table.sceneId,
      table.version,
    ),
    index("idx_visual_assets_work_active_visible").on(
      table.workId,
      table.isActive,
      table.isVisible,
    ),
    index("idx_visual_assets_asset_id").on(table.assetId),
  ],
);
