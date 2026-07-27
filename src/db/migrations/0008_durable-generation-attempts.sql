CREATE TABLE "generation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"candidate_files" jsonb,
	"repair_patch" jsonb,
	"diagnostic" text,
	"provider_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_attempts_kind_check" CHECK ("generation_attempts"."kind" in ('generate', 'repair')),
	CONSTRAINT "generation_attempts_outcome_check" CHECK ("generation_attempts"."outcome" in ('provider_failed', 'rejected')),
	CONSTRAINT "generation_attempts_payload_check" CHECK ((
        ("generation_attempts"."outcome" = 'provider_failed' and "generation_attempts"."provider_error" is not null)
        or
        ("generation_attempts"."outcome" = 'rejected' and "generation_attempts"."candidate_files" is not null and "generation_attempts"."diagnostic" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_attempts_job_id_idx" ON "generation_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_attempts_job_sequence_idx" ON "generation_attempts" USING btree ("job_id","sequence");--> statement-breakpoint
ALTER TABLE "generation_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "generation_attempts" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "generation_attempts" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'min_atoms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "generation_attempts" TO min_atoms_app;
    CREATE POLICY "min_atoms_app_access" ON "generation_attempts"
      FOR ALL TO min_atoms_app
      USING (true)
      WITH CHECK (true);
  END IF;
END
$$;
