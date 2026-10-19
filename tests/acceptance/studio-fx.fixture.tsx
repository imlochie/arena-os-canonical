import "./studio-preparation.fixture";
import SessionExperience from "../../src/components/waveyard/library/SessionExperience";
import ArcadeForge from "../../src/components/ArcadeForge";
import BattleArena from "../../src/components/BattleArena";
import CollabLab from "../../src/components/CollabLab";
import CouncilLab from "../../src/components/CouncilLab";
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
const room = params.get("room") ?? (location.pathname === "/collab" ? "collab" : location.pathname === "/council" ? "council" : params.has("source") ? "battle" : null);
const view = room === "listening" ? <SessionExperience sessionId={params.get("session")!} /> : room === "arcade" ? <ArcadeForge /> : room === "preparation" ? <p>Production preparation profile</p> : room === "battle" ? <BattleArena /> : room === "collab" ? <CollabLab /> : room === "council" ? <CouncilLab /> : room === "artifacts" ? <ArtifactsPage /> : room === "orchestrator" ? <OrchestratorWorkbench /> : room === "project" ? <PathParamsContext.Provider value={{ id: params.get("project")! }}><ProjectPage /></PathParamsContext.Provider> : <App />;
createRoot(document.getElementById("root")!).render(view);
