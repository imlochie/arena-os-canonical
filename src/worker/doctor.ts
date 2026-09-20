import { sql } from "drizzle-orm";
import { db } from "@/db";
import { run } from "@/lib/stems/audio";
import { getStemQueueConnection } from "@/lib/stems/queue";
import { getStemStorage } from "@/lib/stems/storage";

async function main() {
  await db.execute(sql`select 1`);
  const redis = getStemQueueConnection();
  if (await redis.ping() !== "PONG") throw new Error("Redis did not return PONG.");
  await getStemStorage().healthcheck();
  await run(process.env.PYTHON_BIN ?? "python3", ["-c", "import demucs, torch; print(demucs.__version__)"]);
  console.info("Arena stem worker dependencies are healthy.");
  await redis.quit();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
