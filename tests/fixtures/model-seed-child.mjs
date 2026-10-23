// Controlled subprocess for real process-death/cross-process seeding tests.
import { seedModelFile } from '../../src/lib/waveyard/separation/seed.ts';
const { spec, dir } = JSON.parse(process.argv[2]);
try {
  const result = await seedModelFile(spec, { dir, onProgress: (progress) => process.send?.({ progress }) });
  process.send?.({ result });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { process.disconnect?.(); }
