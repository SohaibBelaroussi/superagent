CREATE TABLE "app"."pairing_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"token_id" uuid,
	CONSTRAINT "pairing_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."pairing_codes" ADD CONSTRAINT "pairing_codes_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "app"."api_tokens"("id") ON DELETE set null ON UPDATE no action;