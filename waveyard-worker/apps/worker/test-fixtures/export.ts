// Separate worker process: actual isolated package dependencies, SQL and files.
import { processExport } from "../src/export";
import { getPool } from "../../../packages/database/src/index";
async function main() {
try {
  await processExport(JSON.parse(process.env.REMOTE_EXPORT_PAYLOAD!), async (stage) => { console.log("REMOTE_STAGE", stage); });
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { await getPool().end(); }

}
void main();
