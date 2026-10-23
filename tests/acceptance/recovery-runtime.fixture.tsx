// Real components; the browser harness controls only HTTP responses.
import React from "react";
import { createRoot } from "react-dom/client";
import ArcadeForge from "../../src/components/ArcadeForge";
import ArtifactsPage from "../../src/app/artifacts/page";
createRoot(document.getElementById("root")!).render(location.pathname === "/artifacts" ? <ArtifactsPage /> : <ArcadeForge />);
