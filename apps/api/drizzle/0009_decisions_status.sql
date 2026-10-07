-- Decisions are recorded as pending before they are applied, and deleted if Mastra refuses them.
-- Rows from the earlier "failed" status had no effect: drop them.
DELETE FROM "app"."decisions" WHERE "status" = 'failed';--> statement-breakpoint
ALTER TABLE "app"."decisions" DROP COLUMN "error";
