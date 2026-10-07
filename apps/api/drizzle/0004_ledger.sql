CREATE TABLE "app"."artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."task_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"phase" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "app"."tasks_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"department_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"phase" text NOT NULL,
	"priority" text NOT NULL,
	"source" text NOT NULL,
	"lead_agent_id" uuid,
	"thread_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" integer,
	"result" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tasks_number_unique" UNIQUE("number"),
	CONSTRAINT "tasks_thread_id_unique" UNIQUE("thread_id"),
	CONSTRAINT "tasks_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "app"."artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_lead_agent_id_agent_definitions_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "app"."agent_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task" ON "app"."task_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "tasks_department_phase" ON "app"."tasks" USING btree ("department_id","phase");