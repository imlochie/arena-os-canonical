"use client";

import type { RemixVersionSummary } from "./types";

export function VersionHistory({
  versions,
  onRestore,
}: {
  versions: RemixVersionSummary[];
  onRestore: (id: string) => void;
}) {
  if (!versions.length) return null;
  return (
    <div className="versions">
      <b>Versions</b>
      {versions.map((version) => (
        <button
          key={version.id}
          className="button secondary"
          onClick={() => onRestore(version.id)}
        >
          {version.name}
        </button>
      ))}
    </div>
  );
}
