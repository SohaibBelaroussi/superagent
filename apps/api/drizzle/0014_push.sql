CREATE TABLE "app"."push_config" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"client_email" text NOT NULL,
	"service_account_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."push_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"push_token_enc" text NOT NULL,
	"key_enc" text NOT NULL,
	"kinds" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "push_devices_token_id_unique" UNIQUE("token_id")
);
--> statement-breakpoint
ALTER TABLE "app"."push_devices" ADD CONSTRAINT "push_devices_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "app"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;