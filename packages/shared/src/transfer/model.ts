/**
 * V2 Transfer Engine — unified Transfer model.
 *
 * Abstracts file transfers (download / upload / preview) into a single
 * state machine with a common interface. Consumers (server, desktop, web)
 * implement the transport layer; this module defines the contract.
 */

import { TransferState, CmdCancelTransferPayload } from '../ws-types';
export { TransferState };
export type { CmdCancelTransferPayload };
// ===== Transfer direction =====

export type TransferDirection = 'download' | 'upload' | 'preview';

// ===== Transfer record (transport-agnostic core) =====

export interface TransferRecord {
  /** Unique transfer ID (UUID) */
  transferId: string;
  /** Transfer direction/type */
  direction: TransferDirection;
  /** Current state */
  state: TransferState;
  /** File name (display-only for download/preview, used for save path in upload) */
  fileName: string;
  /** MIME type */
  mimeType: string;
  /** Total expected bytes (0 if unknown) */
  totalBytes: number;
  /** Transferred bytes so far */
  transferredBytes: number;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last activity timestamp (ms) — for idle timeout */
  lastActivityAt: number;
  /** Error message (FAILED state) */
  errorMessage?: string;
  /** Error code (FAILED state) */
  errorCode?: string;
  /** Cancel reason (CANCELLED state) */
  cancelReason?: CmdCancelTransferPayload['reason'];
  /** Session ID (for session-scoped cleanup) */
  sessionId?: string;
  /** Client ID (who initiated the transfer) */
  clientId?: string;
  /** Host ID (target host for download/preview) */
  hostId?: string;
  /** Category for upload (images/videos/documents/archives/markdown) */
  category?: string;
}

// ===== Events emitted by a TransferManager =====

export type TransferEvent =
  | { type: 'state'; transferId: string; state: TransferState; previous: TransferState }
  | { type: 'progress'; transferId: string; transferredBytes: number; totalBytes: number }
  | { type: 'chunk'; transferId: string; data: Buffer }
  | { type: 'error'; transferId: string; error: string; code?: string }
  | { type: 'complete'; transferId: string };

export type TransferEventHandler = (event: TransferEvent) => void;

// ===== TransferManager interface (implemented per-platform) =====

export interface ITransferManager {
  /** Begin a transfer. Returns the transferId. */
  begin(record: Omit<TransferRecord, 'createdAt' | 'lastActivityAt' | 'transferredBytes' | 'state'> & { state?: TransferState }): string;
  /** Get a transfer record by ID */
  get(transferId: string): TransferRecord | undefined;
  /** Get all active (non-terminal) transfers */
  getActive(): TransferRecord[];
  /** Get transfers by session ID */
  getBySession(sessionId: string): TransferRecord[];
  /** Update progress */
  recordBytes(transferId: string, byteCount: number): void;
  /** Mark a transfer as streaming */
  markStreaming(transferId: string): void;
  /** Complete a transfer */
  complete(transferId: string): void;
  /** Fail a transfer */
  fail(transferId: string, error: string, code?: string): void;
  /** Cancel a transfer */
  cancel(transferId: string, reason?: CmdCancelTransferPayload['reason']): boolean;
  /** Cancel all transfers for a session */
  cancelSession(sessionId: string, reason?: CmdCancelTransferPayload['reason']): number;
  /** Subscribe to transfer events */
  on(handler: TransferEventHandler): void;
  /** Unsubscribe from transfer events */
  off(handler: TransferEventHandler): void;
  /** Active transfer count */
  activeCount(): number;
}

// ===== Defaults =====

export const DEFAULT_TRANSFER_IDLE_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_TRANSFERS = 10;
