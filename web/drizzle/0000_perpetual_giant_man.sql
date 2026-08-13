CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"local_id" text NOT NULL,
	"kind" text NOT NULL,
	"image" text NOT NULL,
	"options" jsonb NOT NULL,
	"state" text NOT NULL,
	"stage" text,
	"error" text,
	"returncode" integer,
	"run_id" text,
	"log" jsonb,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"crop_path" text,
	"crop_bytes" bigint,
	"mesh_path" text,
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
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"photo_name" text,
	"photo_width" integer,
	"photo_height" integer,
	"render_path" text,
	"render_bytes" bigint,
	"render_mtime" timestamp with time zone,
	"render_sha256" text,
	"spec_path" text,
	"room" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_items_run_id_name" ON "run_items" USING btree ("run_id","name");