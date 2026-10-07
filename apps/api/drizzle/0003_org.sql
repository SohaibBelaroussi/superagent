CREATE TABLE "app"."agent_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"department_id" uuid NOT NULL,
	"active_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "agent_definitions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_versions" (
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"model" jsonb,
	"tools" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "app"."departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"auto_close" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "departments_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "app"."agent_definitions" ADD CONSTRAINT "agent_definitions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agent_definitions_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definitions_one_active_lead" ON "app"."agent_definitions" USING btree ("department_id") WHERE "app"."agent_definitions"."role" = 'lead' and "app"."agent_definitions"."archived_at" is null;