CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_request_id" uuid NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_build_request_id_build_requests_id_fk" FOREIGN KEY ("build_request_id") REFERENCES "public"."build_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_status_check" CHECK ("status" in ('queued', 'planning', 'generating', 'validating', 'completed', 'failed'));
--> statement-breakpoint
ALTER TABLE "generation_events" ADD CONSTRAINT "generation_events_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "generation_jobs_project_id_idx" ON "generation_jobs" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_one_active_project_idx" ON "generation_jobs" USING btree ("project_id") WHERE "status" in ('queued', 'planning', 'generating', 'validating');
--> statement-breakpoint
CREATE INDEX "generation_events_job_id_idx" ON "generation_events" USING btree ("job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_events_job_sequence_idx" ON "generation_events" USING btree ("job_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_project_version_idx" ON "artifact_versions" USING btree ("project_id", "version");
