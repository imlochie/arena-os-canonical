/** Real process-death fixture: publish actual encoded bytes, then die before ack. */
import { getStorage } from "../../src/lib/waveyard/storage";
import { execute } from "../../src/lib/waveyard/conversion/jobs";
const storage = getStorage(), original = storage.putImmutableStream.bind(storage);
storage.putImmutableStream = async (...args) => { await original(...args); process.send?.({ event: "published", key: args[0] }); await new Promise(() => {}); };
await execute(process.argv[2]);
