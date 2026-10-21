/** Real process-death fixture: pause before publication, or after real publication before ack. */
import { getStorage } from "../../src/lib/waveyard/storage";
import { execute } from "../../src/lib/waveyard/conversion/jobs";
const storage = getStorage(), original = storage.putImmutableStream.bind(storage);
storage.putImmutableStream = async (...args) => {
  if (process.argv[3] === "before-publication") {
    const temporary = (args[1] as unknown as { path?: string }).path;
    process.send?.({ event: "before-publication", key: args[0], temporary });
    await new Promise(() => {});
  }
  await original(...args);
  process.send?.({ event: "published", key: args[0] });
  await new Promise(() => {});
};
await execute(process.argv[2]);
