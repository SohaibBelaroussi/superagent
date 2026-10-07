CREATE TABLE "app"."knowledge_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"content" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."knowledge_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"department_id" uuid,
	"object_key" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."knowledge_documents" ADD CONSTRAINT "knowledge_documents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search_idx" ON "app"."knowledge_chunks" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_document_seq_idx" ON "app"."knowledge_chunks" USING btree ("document_id","seq");--> statement-breakpoint
CREATE INDEX "knowledge_documents_department_idx" ON "app"."knowledge_documents" USING btree ("department_id");