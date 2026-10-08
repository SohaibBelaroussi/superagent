CREATE TABLE "app"."model_prices" (
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"input_usd" numeric(12, 6) NOT NULL,
	"cached_input_usd" numeric(12, 6),
	"output_usd" numeric(12, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_provider_id_model_id_pk" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "app"."usage_events" (
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"task_id" uuid,
	"department_id" uuid,
	"agent" text,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(16, 8),
	CONSTRAINT "usage_events_trace_id_span_id_pk" PRIMARY KEY("trace_id","span_id")
);
--> statement-breakpoint
ALTER TABLE "app"."model_prices" ADD CONSTRAINT "model_prices_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_task_idx" ON "app"."usage_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "usage_events_occurred_idx" ON "app"."usage_events" USING btree ("occurred_at");