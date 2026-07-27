import {
  index,
  pgTable,
  jsonb,
  integer,
  check,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { GeneratedAppDataValue } from "@/lib/generated-app-data/contract";
import type {
  ArtifactFiles,
  ArtifactRepairPatch,
  GenerationStage,
} from "@/lib/generation/types";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    activeArtifactVersionId: uuid("active_artifact_version_id").references(
      (): AnyPgColumn => artifactVersions.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("projects_owner_id_idx").on(table.ownerId),
    index("projects_active_artifact_version_id_idx").on(
      table.activeArtifactVersionId,
    ),
  ],
);

export const buildRequests = pgTable(
  "build_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    baseVersionId: uuid("base_version_id").references(
      (): AnyPgColumn => artifactVersions.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("build_requests_project_id_idx").on(table.projectId),
    index("build_requests_base_version_id_idx").on(table.baseVersionId),
  ],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    buildRequestId: uuid("build_request_id")
      .notNull()
      .references(() => buildRequests.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id").references(
      (): AnyPgColumn => artifactVersions.id,
      { onDelete: "restrict" },
    ),
    status: text("status").$type<GenerationStage>().notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "generation_jobs_status_check",
      sql`${table.status} in ('queued', 'planning', 'generating', 'validating', 'repairing', 'completed', 'failed', 'cancelled')`,
    ),
    index("generation_jobs_project_id_idx").on(table.projectId),
    index("generation_jobs_build_request_id_idx").on(table.buildRequestId),
    index("generation_jobs_base_version_id_idx").on(table.baseVersionId),
    uniqueIndex("generation_jobs_one_active_project_idx")
      .on(table.projectId)
      .where(
        sql`${table.status} in ('queued', 'planning', 'generating', 'validating', 'repairing')`,
      ),
  ],
);

export const generationEvents = pgTable(
  "generation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stage: text("stage").$type<GenerationStage>().notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("generation_events_job_id_idx").on(table.jobId),
    uniqueIndex("generation_events_job_sequence_idx").on(
      table.jobId,
      table.sequence,
    ),
  ],
);

export const generationAttempts = pgTable(
  "generation_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<"generate" | "repair">().notNull(),
    outcome: text("outcome")
      .$type<"provider_failed" | "rejected">()
      .notNull(),
    candidateFiles: jsonb("candidate_files").$type<ArtifactFiles>(),
    repairPatch: jsonb("repair_patch").$type<ArtifactRepairPatch>(),
    diagnostic: text("diagnostic"),
    providerError: text("provider_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "generation_attempts_kind_check",
      sql`${table.kind} in ('generate', 'repair')`,
    ),
    check(
      "generation_attempts_outcome_check",
      sql`${table.outcome} in ('provider_failed', 'rejected')`,
    ),
    check(
      "generation_attempts_payload_check",
      sql`(
        (${table.outcome} = 'provider_failed' and ${table.providerError} is not null)
        or
        (${table.outcome} = 'rejected' and ${table.candidateFiles} is not null and ${table.diagnostic} is not null)
      )`,
    ),
    index("generation_attempts_job_id_idx").on(table.jobId),
    uniqueIndex("generation_attempts_job_sequence_idx").on(
      table.jobId,
      table.sequence,
    ),
  ],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    files: jsonb("files").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("artifact_versions_job_id_idx").on(table.jobId),
    uniqueIndex("artifact_versions_project_version_idx").on(
      table.projectId,
      table.version,
    ),
  ],
);

export const projectMessages = pgTable(
  "project_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    mode: text("mode").$type<"chat" | "build">().notNull(),
    content: text("content").notNull(),
    buildRequestId: uuid("build_request_id").references(
      () => buildRequests.id,
      { onDelete: "set null" },
    ),
    artifactVersionId: uuid("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "project_messages_role_check",
      sql`${table.role} in ('user', 'assistant')`,
    ),
    check(
      "project_messages_mode_check",
      sql`${table.mode} in ('chat', 'build')`,
    ),
    index("project_messages_project_id_idx").on(table.projectId),
    index("project_messages_build_request_id_idx").on(table.buildRequestId),
    uniqueIndex("project_messages_project_sequence_idx").on(
      table.projectId,
      table.sequence,
    ),
    uniqueIndex("project_messages_build_request_user_idx")
      .on(table.buildRequestId)
      .where(sql`${table.role} = 'user' and ${table.buildRequestId} is not null`),
  ],
);

export const generatedAppData = pgTable(
  "generated_app_data",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<GeneratedAppDataValue>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("generated_app_data_project_key_idx").on(table.projectId, table.key),
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type BuildRequest = typeof buildRequests.$inferSelect;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type GenerationEvent = typeof generationEvents.$inferSelect;
export type GenerationAttempt = typeof generationAttempts.$inferSelect;
export type ArtifactVersion = typeof artifactVersions.$inferSelect;
export type ProjectMessage = typeof projectMessages.$inferSelect;
export type GeneratedAppData = typeof generatedAppData.$inferSelect;
