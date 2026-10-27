/**
 * Optional boundary between LUMA and Arena.
 *
 * LUMA is fully usable without an implementation of this interface. The
 * processing engine, storage, and renderer must never import Arena or call a
 * network service. An Arena host may inject an adapter at the application
 * boundary when it needs provenance/context integration.
 */
import type { EditRecipe } from '../engine/types';

export interface ArenaMediaBridge {
  createMediaRecord(input: {
    source: 'capture' | 'import';
    original: {
      /** Host-managed asset location; not an Arena identity. */
      uri: string;
      capturedAt?: string;
    };
    derivative?: {
      uri: string;
      recipe: EditRecipe;
    };
  }): Promise<{ mediaId: string }>;

  attachToContext(input: {
    mediaId: string;
    contextType: string;
    contextId: string;
  }): Promise<void>;
}

/** Safe default for standalone LUMA builds and offline sessions. */
export const noopArenaMediaBridge: ArenaMediaBridge = {
  async createMediaRecord() {
    throw new Error('Arena integration is not configured for this LUMA session.');
  },
  async attachToContext() {
    throw new Error('Arena integration is not configured for this LUMA session.');
  },
};
