CREATE TABLE "project_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"mode" text NOT NULL,
	"content" text NOT NULL,
	"build_request_id" uuid,
	"artifact_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_messages_role_check" CHECK ("project_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "project_messages_mode_check" CHECK ("project_messages"."mode" in ('chat', 'build'))
);
--> statement-breakpoint
ALTER TABLE "project_messages" ADD CONSTRAINT "project_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_messages" ADD CONSTRAINT "project_messages_build_request_id_build_requests_id_fk" FOREIGN KEY ("build_request_id") REFERENCES "public"."build_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_messages" ADD CONSTRAINT "project_messages_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_messages_project_id_idx" ON "project_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_messages_build_request_id_idx" ON "project_messages" USING btree ("build_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_messages_project_sequence_idx" ON "project_messages" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "project_messages_build_request_user_idx" ON "project_messages" USING btree ("build_request_id") WHERE "project_messages"."role" = 'user' and "project_messages"."build_request_id" is not null;--> statement-breakpoint
INSERT INTO "project_messages" (
	"project_id",
	"sequence",
	"role",
	"mode",
	"content",
	"build_request_id",
	"created_at"
)
SELECT
	"project_id",
	row_number() OVER (
		PARTITION BY "project_id"
		ORDER BY "created_at", "id"
	)::integer,
	'user',
	'build',
	"content",
	"id",
	"created_at"
FROM "build_requests";--> statement-breakpoint
ALTER TABLE "project_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON TABLE "project_messages" FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON TABLE "project_messages" FROM authenticated;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'min_atoms_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "project_messages" TO min_atoms_app;
		CREATE POLICY "min_atoms_app_access" ON "project_messages"
			FOR ALL TO min_atoms_app
			USING (true)
			WITH CHECK (true);
	END IF;
END
$$;
