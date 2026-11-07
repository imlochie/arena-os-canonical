/** Run a Python module while this executor owns its stdin pipe.
 * EOF (including abrupt Node death) terminates this Python process itself;
 * no persisted PID lookup, age heuristic, or signal to a potentially reused PID.
 * Callers MUST spawn with stdin:'pipe' and retain that pipe without ending it.
 */
const bootstrap = `
import os, sys, threading, runpy

def watch_owner():
    try:
        while os.read(0, 1):
            pass
    finally:
        os._exit(130)

threading.Thread(target=watch_owner, daemon=True).start()
if sys.argv[1] != '-m':
    raise RuntimeError('Expected an owned Python module')
module = sys.argv[2]
sys.argv = sys.argv[2:]
runpy.run_module(module, run_name='__main__', alter_sys=True)
`;

export function ownedPythonModuleArgs(module: string, args: string[], startGate = false): string[] {
  const code = startGate ? bootstrap.replace("def watch_owner():", "if os.read(0, 1) != b\"S\":\n    os._exit(130)\n\ndef watch_owner():") : bootstrap;
  return ["-c", code, "-m", module, ...args];
}
