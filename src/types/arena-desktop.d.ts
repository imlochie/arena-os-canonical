/**
 * Renderer-side typing for the desktop bridge, visible to the Next.js
 * compilation (src/). `arenaDesktop` is undefined in the plain browser
 * build — desktop features must always be capability-detected
 * (`window.arenaDesktop?.getInfo()`), never assumed.
 *
 * The desktop shell's own declaration lives in desktop/preload.d.ts; this
 * copy exists because the root tsconfig never included that file and src
 * components (DesktopRuntimeStatus) need the global Window augmentation.
 */

import type { ArenaDesktopApi } from "../../desktop/preload";

declare global {
  interface Window {
    arenaDesktop?: ArenaDesktopApi;
  }
}

export {};
