import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, bigserial, boolean, check, index, integer, jsonb,
  pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const previewHosts = pgTable("preview_hosts", {
  label: text("label").primaryKey(),
  projectId: uuid("project_id").unique().references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  previewLabel: text("preview_label").notNull().unique().references(() => previewHosts.label),
  currentVersionId: uuid("current_version_id").references((): AnyPgColumn => versions.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  mode: text("mode").$type<"chat" | "build">().notNull(),
  content: text("content").notNull(),
  runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
  versionId: uuid("version_id").references((): AnyPgColumn => versions.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("messages_project_seq_idx").on(table.projectId, table.seq),
  check("messages_role_check", sql`${table.role} in ('user', 'assistant')`),
  check("messages_mode_check", sql`${table.mode} in ('chat', 'build')`),
]);

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  mode: text("mode").$type<"chat" | "build">().notNull(),
  status: text("status").$type<"queued" | "running" | "succeeded" | "failed" | "cancelled">().notNull(),
  error: text("error"),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
  check("runs_mode_check", sql`${table.mode} in ('chat', 'build')`),
  check("runs_status_check", sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
]);

export const runEvents = pgTable("run_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("run_events_run_seq_idx").on(table.runId, table.seq),
  index("run_events_project_id_idx").on(table.projectId, table.id),
]);

export const versions = pgTable("versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  commitSha: text("commit_sha").notNull(),
  summary: text("summary").notNull(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  screenshot: boolean("screenshot").default(false).notNull(),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("versions_project_number_idx").on(table.projectId, table.number)]);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type PreviewHost = typeof previewHosts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEventRecord = typeof runEvents.$inferSelect;
export type Version = typeof versions.$inferSelect;
