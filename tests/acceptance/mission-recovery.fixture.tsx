// Actual workbench panel. This fixture supplies only its existing space ID.
import React from "react";
import { createRoot } from "react-dom/client";
import { MissionPanel } from "../../src/components/SpacesWorkbench";
createRoot(document.getElementById("root")!).render(<MissionPanel spaceId={new URLSearchParams(location.search).get("space")!} />);
