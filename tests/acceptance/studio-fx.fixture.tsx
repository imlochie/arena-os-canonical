// Actual Studio. Only the HTML mount and project/remix IDs belong to the harness.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ArtifactsPage from "../../src/app/artifacts/page";
import { StudioCore } from "../../src/components/waveyard/StudioCore";
function App() {
  const [project, setProject] = useState<any>(null);
  const ids = new URLSearchParams(location.search);
  const projectId = ids.get("project")!;
  useEffect(() => { void fetch(`/api/waveyard/projects/${projectId}`).then((response) => response.json()).then(setProject); }, [projectId]);
  return project ? <StudioCore projectId={ids.get("project")!} remixSessionId={ids.get("remix")} stems={project.stems} sources={project.sources} /> : <p>Loading actual project…</p>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("room") === "artifacts" ? <ArtifactsPage /> : <App />);
