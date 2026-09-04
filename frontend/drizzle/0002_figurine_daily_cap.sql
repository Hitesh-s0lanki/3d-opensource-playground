ALTER TABLE "credits" ADD COLUMN "stylized_on" date;--> statement-breakpoint
ALTER TABLE "credits" ADD COLUMN "stylized_count" integer DEFAULT 0 NOT NULL;