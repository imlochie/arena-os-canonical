/**
 * drizzle-kit config for the DESKTOP canonical schema snapshot only.
 *
 * Dev keeps `drizzle.config.ts` (push against the dev database). This config
 * generates the packaged runtime's SQL migrations: `npx drizzle-kit generate
 * --config=drizzle.desktop.config.ts` writes desktop-migrations/ from the
 * full schema (Arena OS core + Waveyard), which desktop/runtime/migrate.ts
 * applies with a plain pg client — no drizzle-kit at runtime.
 */
import type { Config } from "drizzle-kit";

export default {
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/waveyardSchema.ts", "./src/db/college.ts"],
  out: "./desktop-migrations",
} satisfies Config;
