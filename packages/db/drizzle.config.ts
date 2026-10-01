import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // ALL tables: the chassis half (which re-exports the Better Auth tables from
  // its auth-schema.ts) + the tool's half (./src/schema.ts). The migration
  // history is one history, starting at 0000_chassis_baseline.
  schema: ['../chassis-db/src/schema.ts', './src/schema.ts'],
  out: './drizzle',
  dbCredentials: {
    // Only needed for drizzle-kit push/studio against a live DB; migrations
    // are generated offline from the schema and applied by the app at boot.
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/app'
  },
  verbose: true,
  strict: true
});
