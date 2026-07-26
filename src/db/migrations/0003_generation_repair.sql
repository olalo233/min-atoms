DROP INDEX "generation_jobs_one_active_project_idx";
--> statement-breakpoint
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_status_check";
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_status_check" CHECK ("status" in ('queued', 'planning', 'generating', 'validating', 'repairing', 'completed', 'failed'));
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_one_active_project_idx" ON "generation_jobs" USING btree ("project_id") WHERE "status" in ('queued', 'planning', 'generating', 'validating', 'repairing');
