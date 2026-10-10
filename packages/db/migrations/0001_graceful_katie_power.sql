CREATE TABLE "screening_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"scores" jsonb NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screening_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "annotation" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "screening_events" ADD CONSTRAINT "screening_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_events" ADD CONSTRAINT "screening_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screening_events_user_created_idx" ON "screening_events" USING btree ("user_id","created_at");
