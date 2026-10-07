import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  schemaFilter: ['app'],
  migrations: { schema: 'app', table: '__drizzle_migrations' },
});
