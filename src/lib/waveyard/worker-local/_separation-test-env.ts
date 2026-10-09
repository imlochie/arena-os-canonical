/** Must be the first import of separation.test.ts: modules in the handler
 *  graph (waveform.ts via index.ts) statically import @/db, which requires
 *  DATABASE_URL at load time. The tests below never connect — a PGlite
 *  instance is injected — so a placeholder URL suffices. */
process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder";
if (process.env.REDIS_URL) delete process.env.REDIS_URL;
