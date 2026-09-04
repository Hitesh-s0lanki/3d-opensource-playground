CREATE TABLE "credits" (
	"user_id" text PRIMARY KEY NOT NULL,
	"granted" integer DEFAULT 5 NOT NULL,
	"spent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "credit_refunded" boolean DEFAULT false NOT NULL;