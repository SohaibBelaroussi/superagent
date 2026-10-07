CREATE TABLE "app"."department_notes" (
	"department_id" uuid PRIMARY KEY NOT NULL,
	"notes" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."owner_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."department_notes" ADD CONSTRAINT "department_notes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id") ON DELETE no action ON UPDATE no action;