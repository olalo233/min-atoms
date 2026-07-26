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
DO $$
DECLARE
  role_name text;
  table_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH table_name IN ARRAY ARRAY[
        'users',
        'sessions',
        'projects',
        'build_requests',
        'generation_jobs',
        'generation_events',
        'artifact_versions',
        'generated_app_data'
      ] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'min_atoms_app') THEN
    CREATE ROLE min_atoms_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO min_atoms_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO min_atoms_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO min_atoms_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO min_atoms_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO min_atoms_app;--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "users" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "sessions" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "projects" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "build_requests" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "generation_jobs" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "generation_events" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "artifact_versions" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY min_atoms_app_access ON "generated_app_data" FOR ALL TO min_atoms_app USING (true) WITH CHECK (true);
