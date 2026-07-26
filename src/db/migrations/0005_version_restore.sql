ALTER TABLE "build_requests" ADD COLUMN "base_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "base_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "active_artifact_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "build_requests" ADD CONSTRAINT "build_requests_base_version_id_artifact_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_base_version_id_artifact_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
UPDATE "projects"
SET "active_artifact_version_id" = (
  SELECT "id"
  FROM "artifact_versions"
  WHERE "artifact_versions"."project_id" = "projects"."id"
  ORDER BY "version" DESC
  LIMIT 1
)
WHERE "active_artifact_version_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_active_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("active_artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "build_requests_base_version_id_idx" ON "build_requests" USING btree ("base_version_id");
--> statement-breakpoint
CREATE INDEX "generation_jobs_base_version_id_idx" ON "generation_jobs" USING btree ("base_version_id");
