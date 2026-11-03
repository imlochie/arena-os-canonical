export type DisconnectableAudioNode = {
  disconnect(): void;
  buffer?: AudioBuffer | null;
};

export function clearArrangementPreviewGraph(nodes: Set<DisconnectableAudioNode>) {
  for (const node of nodes) {
    try {
      if (node.buffer !== undefined) node.buffer = null;
    } catch {
      // Some platform nodes may expose a non-writable buffer property.
    }
    try {
      node.disconnect();
    } catch {
      // A node may already have been detached by its ended callback.
    }
  }
  nodes.clear();
}
