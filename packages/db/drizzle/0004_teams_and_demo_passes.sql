CREATE TABLE "demo_pass_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"pass_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"target_path" text DEFAULT '/' NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_teams_role_check" CHECK ("project_teams"."role" IN ('manager', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspace_team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hub_team_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_pass_sessions" ADD CONSTRAINT "demo_pass_sessions_pass_id_demo_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."demo_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_id_workspace_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."workspace_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_team_members" ADD CONSTRAINT "workspace_team_members_team_id_workspace_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."workspace_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_team_members" ADD CONSTRAINT "workspace_team_members_member_id_workspace_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_team_members" ADD CONSTRAINT "workspace_team_members_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_teams" ADD CONSTRAINT "workspace_teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_teams" ADD CONSTRAINT "workspace_teams_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_passes_secret_hash_uniq" ON "demo_passes" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "demo_passes_workspace_created_idx" ON "demo_passes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_teams_project_team_uniq" ON "project_teams" USING btree ("project_id","team_id");--> statement-breakpoint
CREATE INDEX "project_teams_team_idx" ON "project_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "project_teams_project_created_id_idx" ON "project_teams" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_team_members_team_member_uniq" ON "workspace_team_members" USING btree ("team_id","member_id");--> statement-breakpoint
CREATE INDEX "workspace_team_members_member_idx" ON "workspace_team_members" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_teams_hub_team_uniq" ON "workspace_teams" USING btree ("hub_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_teams_workspace_slug_local_uniq" ON "workspace_teams" USING btree ("workspace_id","slug") WHERE "workspace_teams"."hub_team_id" IS NULL;--> statement-breakpoint
CREATE INDEX "workspace_teams_workspace_idx" ON "workspace_teams" USING btree ("workspace_id");