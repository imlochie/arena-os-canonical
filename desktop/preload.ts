/**
 * Arena desktop preload bridge — the only thing the renderer can touch.
 *
 * Hardened surface: contextIsolation on, nodeIntegration off, sandbox on.
 * Every capability is a typed function over an allowlisted IPC channel
 * defined in contracts.ts. No Node APIs, no remote, no arbitraryinvoke.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { DesktopAppInfo } from "./contracts";

const api = {
  /** App identity + runtime info (see DesktopAppInfo in contracts.ts). */
  getInfo: (): Promise<DesktopAppInfo> =>
    ipcRenderer.invoke("app:getInfo") as Promise<DesktopAppInfo>,
};

export type ArenaDesktopApi = typeof api;

contextBridge.exposeInMainWorld("arenaDesktop", api);
