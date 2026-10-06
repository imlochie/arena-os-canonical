/**
 * Arena desktop IPC contracts — the single typed allowlist.
 *
 * Every channel the renderer may invoke lives here, with its request and
 * response shapes zod-validated. Nothing else is bridged. Adding desktop
 * surface means adding a channel here first — the preload exposes only
 * these, and the main process registers only these.
 */

import { z } from "zod";

/** Channel: renderer → main, app identity/runtime info. */
export const DESKTOP_INFO_CHANNEL = "app:getInfo" as const;

/** The complete allowlist of invokable IPC channels. */
export const IPC_CHANNELS = [DESKTOP_INFO_CHANNEL] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return (
    typeof value === "string" &&
    (IPC_CHANNELS as readonly unknown[]).includes(value)
  );
}

export const DesktopAppInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  dataDir: z.string().min(1),
  portable: z.boolean(),
  channel: z.enum(["dev", "stable", "beta"]),
});

export type DesktopAppInfo = z.infer<typeof DesktopAppInfoSchema>;
