/**
 * V2 Transfer Engine — server-side transfer registry.
 *
 * Wraps the shared BaseTransferManager to provide a server-scoped
 * singleton with typed event handling. Existing file-tunnel logic in
 * file-tunnel.ts remains the transport layer; this module is the
 * state-machine abstraction seam.
 */

import { BaseTransferManager } from '@remotebridge/shared';
import type { TransferRecord, TransferEvent, TransferState } from '@remotebridge/shared';

/** Server-scoped transfer manager singleton */
class ServerTransferManager extends BaseTransferManager {
  constructor() {
    super({ idleTimeoutMs: 30000, maxConcurrent: 10 });
  }
}

export const transferRegistry = new ServerTransferManager();

// Re-export shared types for convenience
export type { TransferRecord, TransferEvent, TransferState };
export { TransferState as TransferStateEnum } from '@remotebridge/shared';
