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
