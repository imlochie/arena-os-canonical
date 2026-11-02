export type DisconnectableAudioNode = {
  disconnect(): void;
};

export function clearArrangementPreviewGraph(nodes: Set<DisconnectableAudioNode>) {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // A node may already have been detached by its ended callback.
    }
  }
  nodes.clear();
}
