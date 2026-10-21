// Actual session controller and shared transport. Only HTTP data is controlled
// by the isolated harness; HTML media and Web Audio execute in the browser.
import React from "react";
import { createRoot } from "react-dom/client";
import SessionExperience from "../../src/components/waveyard/library/SessionExperience";
createRoot(document.getElementById("root")!).render(<SessionExperience sessionId={location.pathname.slice(1)} />);
