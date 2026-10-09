import { defineConfig } from "drizzle-kit";

/**
 * Single source of truth for the database connection is .env
 * (DATABASE_URL). The previous drizzle.config.json carried a second,
 * hardcoded URL that silently diverged from .env; this config reads the
 * same variable the app uses, with the same local default as
 * .env.example. scripts/db-setup.mjs loads .env before invoking
 * drizzle-kit, so `npm run db:setup` works end to end.
 */
const url =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/waveyardSchema.ts", "./src/db/college.ts"],
  dbCredentials: { url },
});
