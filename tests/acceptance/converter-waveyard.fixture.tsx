// Mount production components; requests go to real route handlers in the test.
// This does not substitute audio, conversion, session state, or export logic.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ConversionWorkbench from "../../src/components/waveyard/library/ConversionWorkbench";
import SessionExperience from "../../src/components/waveyard/library/SessionExperience";
import { StudioCore } from "../../src/components/waveyard/StudioCore";

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
createRoot(document.getElementById("root")!).render(
  sessionId ? <SessionExperience sessionId={sessionId} /> :
    projectId ? <Studio projectId={projectId} /> : <ConversionWorkbench />,
);
