/**
 * Retry a failed desktop shutdown until services stop cleanly or the user
 * explicitly accepts the risk of forcing the application to exit.
 */
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
