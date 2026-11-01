/**
 * Retry a failed desktop shutdown until services stop cleanly or the user
 * explicitly accepts the risk of forcing the application to exit.
 */
export async function stopDesktopServices({ stopNative, stopServices }) {
  const errors = [];
  try { await stopNative(); } catch (error) { errors.push(error); }
  // Service cleanup must run even if an optional native supervisor times out.
  // stopServices itself owns the API-before-database ordering.
  try { await stopServices(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
}
export async function stopBeforeQuit({ stop, askBeforeForceQuit, quit, log = () => {} }) {
  while (true) {
    try {
      await stop();
      quit();
      return "clean";
    } catch (error) {
      log(error);
      const forceQuit = await askBeforeForceQuit(error);
      if (forceQuit) {
        quit();
        return "forced";
      }
    }
  }
}
