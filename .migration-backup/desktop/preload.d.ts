/**
 * Renderer-side typing for the desktop bridge. `arenaDesktop` is undefined
 * in the plain browser build — desktop features must always be
 * capability-detected (`window.arenaDesktop?.getInfo()`), never assumed.
 */

import type { ArenaDesktopApi } from "./preload";

declare global {
  interface Window {
    arenaDesktop?: ArenaDesktopApi;
  }
}

export {};
