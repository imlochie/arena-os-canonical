// Mount production components; requests go to real route handlers in the test.
// This does not substitute audio, conversion, session state, or export logic.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ConversionWorkbench from "../../src/components/waveyard/library/ConversionWorkbench";
import SessionExperience from "../../src/components/waveyard/library/SessionExperience";
import { TrackPlayer } from "../../src/components/waveyard/library/TrackPlayer";
import { StudioCore } from "../../src/components/waveyard/StudioCore";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

type ProjectAudio = Pick<React.ComponentProps<typeof StudioCore>, "stems" | "sources">;
function Studio({ projectId }: { projectId: string }) {
  const [audio, setAudio] = useState<ProjectAudio | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void fetch(`/api/waveyard/projects/${projectId}`).then(async response => {
      if (!response.ok) throw new Error("Project audio unavailable");
      const data: ProjectAudio = await response.json();
      if (active) setAudio(data);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [projectId]);
  return audio ? <StudioCore projectId={projectId} {...audio} /> : <p>{error || "Loading actual project…"}</p>;
}
const sessionId = location.pathname.match(/^\/waveyard\/session\/([^/]+)$/)?.[1];
const projectId = location.pathname.match(/^\/waveyard\/projects\/([^/]+)$/)?.[1];
const trackId = location.pathname.match(/^\/waveyard\/play\/([^/]+)$/)?.[1];
const router = {
  push: (url: string) => location.assign(url), replace: (url: string) => location.replace(url),
  back: () => history.back(), forward: () => history.forward(), refresh: () => location.reload(),
  prefetch: async () => {}, hmrRefresh: () => {},
};
createRoot(document.getElementById("root")!).render(
  <AppRouterContext.Provider value={router}>
    {sessionId ? <SessionExperience sessionId={sessionId} /> :
      trackId ? <TrackPlayer trackId={trackId} /> :
        projectId ? <Studio projectId={projectId} /> : <ConversionWorkbench />}
  </AppRouterContext.Provider>,
);
