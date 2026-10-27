// Client-side privacy settings: Local Mode + Ephemeral Mode.
// Persisted in localStorage only (never sent anywhere except as
// per-request flags the server enforces).

"use client";

import { useEffect, useState } from "react";

const K_LOCAL = "af_local_mode";
const K_EPHEM = "af_ephemeral";

export interface PrivacySettings {
  localMode: boolean;
  ephemeral: boolean;
  online: boolean;
}

function read(): { localMode: boolean; ephemeral: boolean } {
  if (typeof window === "undefined") return { localMode: false, ephemeral: false };
  try {
    return {
      localMode: localStorage.getItem(K_LOCAL) === "1",
      ephemeral: localStorage.getItem(K_EPHEM) === "1",
    };
  } catch {
    return { localMode: false, ephemeral: false };
  }
}

export function getPrivacySettings(): PrivacySettings {
  const s = read();
  return { ...s, online: typeof navigator === "undefined" ? true : navigator.onLine };
}

/** Flags to spread into every AI fetch body — server enforces them. */
export function privacyFlags(): { localOnly: boolean; ephemeral: boolean } {
  const s = read();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return { localOnly: s.localMode || offline, ephemeral: s.ephemeral };
}

function emit() {
  try {
    window.dispatchEvent(new CustomEvent("af-privacy"));
  } catch {}
}

export function setLocalMode(v: boolean) {
  try {
    localStorage.setItem(K_LOCAL, v ? "1" : "0");
  } catch {}
  emit();
}

export function setEphemeral(v: boolean) {
  try {
    localStorage.setItem(K_EPHEM, v ? "1" : "0");
  } catch {}
  emit();
}

export function usePrivacySettings(): PrivacySettings {
  const [s, setS] = useState<PrivacySettings>({ localMode: false, ephemeral: false, online: true });
  useEffect(() => {
    const update = () => setS(getPrivacySettings());
    update();
    window.addEventListener("af-privacy", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("af-privacy", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return s;
}
