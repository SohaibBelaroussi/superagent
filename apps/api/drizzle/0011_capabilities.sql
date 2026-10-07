CREATE TABLE "app"."mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"plugin_id" uuid,
	"key" text,
	"transport" text NOT NULL,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"runtime" text,
	"package" text,
	"command" jsonb,
	"cwd" text,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."plugin_files" (
	"plugin_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mode" integer NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "plugin_files_plugin_id_path_pk" PRIMARY KEY("plugin_id","path")
);
--> statement-breakpoint
CREATE TABLE "app"."plugins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"version" text,
	"description" text DEFAULT '' NOT NULL,
	"format" text NOT NULL,
	"source" jsonb NOT NULL,
	"sha" text,
	"license" text,
	"status" text NOT NULL,
	"status_detail" text,
	"network" text NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "app"."secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"value_enc" text NOT NULL,
	"plugin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "app"."skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"dir" text NOT NULL,
	"license" text,
	"compatibility" text,
	"file_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD COLUMN "mcp" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."departments" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."departments" ADD COLUMN "mcp" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "app"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "app"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "app"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."skills" ADD CONSTRAINT "skills_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "app"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_plugin_name" ON "app"."skills" USING btree ("plugin_id","name");