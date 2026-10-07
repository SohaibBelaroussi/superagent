-- pgvector lives in `public` so Mastra's PgVector never installs it into its own schema
-- (which would also make it rewrite search_path on its connections).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS mastra;
