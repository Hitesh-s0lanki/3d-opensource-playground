CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"stage" text,
	"error" text,
	"options" jsonb NOT NULL,
	"image_key" text NOT NULL,
	"image_name" text NOT NULL,
	"image_bytes" bigint,
	"image_width" integer,
	"image_height" integer,
	"modal_call_id" text,
	"run_slug" text,
	"log" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"crop_key" text,
	"crop_bytes" bigint,
	"mesh_key" text,
	"mesh_bytes" bigint,
	"position" jsonb,
	"size" jsonb,
	"rotation_z" real DEFAULT 0 NOT NULL,
	"auto_orient" boolean,
	"box" jsonb,
	"box_from" text,
	"score" real,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"photo_key" text,
	"photo_name" text,
	"photo_bytes" bigint,
	"photo_width" integer,
	"photo_height" integer,
	"render_key" text,
	"render_bytes" bigint,
	"render_sha256" text,
	"spec" jsonb,
	"room" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_user_queued" ON "jobs" USING btree ("user_id","queued_at");--> statement-breakpoint
CREATE INDEX "jobs_user_state" ON "jobs" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "run_items_run_id_name" ON "run_items" USING btree ("run_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_slug" ON "runs" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "runs_user_updated" ON "runs" USING btree ("user_id","updated_at");