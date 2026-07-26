CREATE INDEX "artifact_versions_job_id_idx" ON "artifact_versions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "build_requests_project_id_idx" ON "build_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_build_request_id_idx" ON "generation_jobs" USING btree ("build_request_id");--> statement-breakpoint
CREATE INDEX "projects_owner_id_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "projects_active_artifact_version_id_idx" ON "projects" USING btree ("active_artifact_version_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "build_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifact_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generated_app_data" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "users" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "sessions" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "projects" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "build_requests" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "generation_jobs" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "generation_events" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "artifact_versions" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "generated_app_data" FROM anon, authenticated;
