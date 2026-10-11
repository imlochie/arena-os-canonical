/**
 * Desktop runtime public surface — what main.ts consumes.
 */

export { ArenaRuntimeSupervisor, type RuntimeStatus, type RuntimePhase, type SupervisorLogger } from "./supervisor";
export { EmbeddedPostgres, type PostgresStatus } from "./embedded-postgres";
export { applyMigrations, MIGRATIONS_TABLE } from "./migrate";
export { resolveRuntimeConfig, pickFreePort, type ArenaRuntimeConfig, type RuntimeConfigInputs } from "./config";
