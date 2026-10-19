// Actual Studio. Only the HTML mount and project/remix IDs belong to the harness.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import OrchestratorWorkbench from "../../src/components/OrchestratorWorkbench";
import ProjectPage from "../../src/app/projects/[id]/page";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import ArtifactsPage from "../../src/app/artifacts/page";
import { StudioCore } from "../../src/components/waveyard/StudioCore";
function App() {
  const [project, setProject] = useState<any>(null);
  const ids = new URLSearchParams(location.search);
  const projectId = ids.get("project")!;
  useEffect(() => { void fetch(`/api/waveyard/projects/${projectId}`).then((response) => response.json()).then(setProject); }, [projectId]);
  return project ? <StudioCore projectId={ids.get("project")!} remixSessionId={ids.get("remix")} stems={project.stems} sources={project.sources} /> : <p>Loading actual project…</p>;
}
const params = new URLSearchParams(location.search);
const view = params.get("room") === "artifacts" ? <ArtifactsPage /> : params.get("room") === "orchestrator" ? <OrchestratorWorkbench /> : params.get("room") === "project" ? <PathParamsContext.Provider value={{ id: params.get("project")! }}><ProjectPage /></PathParamsContext.Provider> : <App />;
createRoot(document.getElementById("root")!).render(view);
