CREATE TABLE "app"."decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"task_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "app"."schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"priority" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	"next_fire_at" timestamp with time zone,
	"last_fire_at" timestamp with time zone,
	"last_task_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."schedules" ADD CONSTRAINT "schedules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "app"."schedules" USING btree ("status","next_fire_at");