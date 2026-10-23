/**
 * Test reporter that explains a non-exiting test process.
 *
 * `node --test` prints its summary and then, if a handle is still referenced,
 * the process stays alive with no further output. That is exactly what the
 * Windows desktop suite does, and it produces no evidence about *why*.
 *
 * This reporter passes every event through unchanged and, once the run's event
 * stream has ended, waits a moment and prints the still-active resources and
 * handles. If everything exited normally, the process is already gone and the
 * dump never appears.
 *
 * Wire it alongside the normal reporter:
 *   --test-reporter=spec --test-reporter-destination=stdout \
 *   --test-reporter=./scripts/test-handle-reporter.mjs --test-reporter-destination=stderr
 */
const DUMP_DELAY_MS = 4000;

function describeHandle(handle) {
  const name = handle?.constructor?.name ?? typeof handle;
  const details = [];
  if (typeof handle?.pid === "number") details.push(`pid=${handle.pid}`);
  if (handle?.spawnfile) details.push(`spawnfile=${handle.spawnfile}`);
  if (typeof handle?.remoteAddress === "string") details.push(`remote=${handle.remoteAddress}:${handle.remotePort ?? ""}`);
  if (typeof handle?.localAddress === "string") details.push(`local=${handle.localAddress}:${handle.localPort ?? ""}`);
  if (handle?._onTimeout) details.push("timer");
  if (typeof handle?.path === "string") details.push(`path=${handle.path}`);
  if (typeof handle?.fd === "number") details.push(`fd=${handle.fd}`);
  return details.length > 0 ? `${name}(${details.join(" ")})` : name;
}

function dump(label) {
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  const resources = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
  const described = handles.map(describeHandle);
  const counts = resources.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});
  console.error(`[handle-reporter] ${label}`);
  console.error(`[handle-reporter] resources: ${JSON.stringify(counts)}`);
  console.error(`[handle-reporter] handles: ${described.length === 0 ? "(none)" : described.join(", ")}`);
}

export default async function* handleReporter(source) {
  try {
    // Consume only: the normal reporter owns the visible output. Yielding raw
    // events here would write objects to a byte stream (ERR_INVALID_ARG_TYPE).
    for await (const event of source) {
      if (event.type === "test:fail") {
        const name = event.data?.name ?? "unknown";
        console.error(`[handle-reporter] failing test: ${name}`);
      }
    }
    yield "";
  } finally {
    // The run's stream is finished; anything still referenced below is what
    // keeps this process alive after the summary.
    const timer = setTimeout(() => {
      dump(`still alive ${DUMP_DELAY_MS} ms after the test stream ended`);
    }, DUMP_DELAY_MS);
    timer.unref();
    // A referenced short timer guarantees the dump runs before exit when the
    // loop is genuinely empty, without holding the process open for long.
    await new Promise((resolve) => setTimeout(resolve, DUMP_DELAY_MS + 50));
    dump("post-summary snapshot");
  }
}
