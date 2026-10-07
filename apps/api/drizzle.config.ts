import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Only our schema. Mastra creates and migrates its own tables in `mastra`.
  schemaFilter: ['app'],
});
