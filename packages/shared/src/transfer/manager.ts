/**
 * V2 Transfer Engine — reference TransferManager implementation.
 *
 * Platform-agnostic core logic. Concrete implementations (server, desktop, web)
 * extend this class and wire up transport-specific behavior via hooks.
 */

import { randomUUID } from 'node:crypto';
import {
  ITransferManager,
  TransferRecord,
  TransferEvent,
  TransferEventHandler,
  TransferState,
  DEFAULT_TRANSFER_IDLE_TIMEOUT_MS,
  type CmdCancelTransferPayload,
} from './model';

export interface TransferManagerOptions {
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  /** Called when a transfer times out */
  onTimeout?: (transferId: string, record: TransferRecord) => void;
}

export class BaseTransferManager implements ITransferManager {
  protected transfers = new Map<string, TransferRecord>();
  protected handlers = new Array<TransferEventHandler>();
  protected readonly idleTimeoutMs: number;
  protected readonly maxConcurrent: number;
  protected readonly onTimeout?: (transferId: string, record: TransferRecord) => void;

  constructor(options: TransferManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TRANSFER_IDLE_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.onTimeout = options.onTimeout;
  }

  begin(
    record: Omit<TransferRecord, 'createdAt' | 'lastActivityAt' | 'transferredBytes' | 'state'> & { state?: TransferState }
  ): string {
    const now = Date.now();
    const full: TransferRecord = {
      ...record,
      state: record.state ?? TransferState.PENDING,
      transferredBytes: 0,
      createdAt: now,
      lastActivityAt: now,
    };
    this.transfers.set(full.transferId, full);
    this.emit({ type: 'state', transferId: full.transferId, state: full.state, previous: full.state });
    return full.transferId;
  }

  get(transferId: string): TransferRecord | undefined {
    return this.transfers.get(transferId);
  }

  getActive(): TransferRecord[] {
    const terminal = new Set([TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED]);
    return [...this.transfers.values()].filter((t) => !terminal.has(t.state));
  }

  getBySession(sessionId: string): TransferRecord[] {
    return [...this.transfers.values()].filter((t) => t.sessionId === sessionId);
  }

  recordBytes(transferId: string, byteCount: number): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    t.transferredBytes += byteCount;
    t.lastActivityAt = Date.now();
    this.emit({ type: 'progress', transferId, transferredBytes: t.transferredBytes, totalBytes: t.totalBytes });
  }

  markStreaming(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const prev = t.state;
    t.state = TransferState.STREAMING;
    t.lastActivityAt = Date.now();
    this.emit({ type: 'state', transferId, state: t.state, previous: prev });
  }

  complete(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const prev = t.state;
    t.state = TransferState.COMPLETED;
    t.lastActivityAt = Date.now();
    this.emit({ type: 'state', transferId, state: t.state, previous: prev });
    this.emit({ type: 'complete', transferId });
  }

  fail(transferId: string, error: string, code?: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const prev = t.state;
    t.state = TransferState.FAILED;
    t.errorMessage = error;
    t.errorCode = code;
    t.lastActivityAt = Date.now();
    this.emit({ type: 'state', transferId, state: t.state, previous: prev });
    this.emit({ type: 'error', transferId, error, code });
  }

  cancel(transferId: string, reason?: CmdCancelTransferPayload['reason']): boolean {
    const t = this.transfers.get(transferId);
    if (!t) return false;
    if (t.state === TransferState.COMPLETED || t.state === TransferState.FAILED || t.state === TransferState.CANCELLED) {
      return false;
    }
    const prev = t.state;
    t.state = TransferState.CANCELLED;
    t.cancelReason = reason;
    t.lastActivityAt = Date.now();
    this.emit({ type: 'state', transferId, state: t.state, previous: prev });
    return true;
  }

  cancelSession(sessionId: string, reason?: CmdCancelTransferPayload['reason']): number {
    let count = 0;
    for (const [id, t] of this.transfers) {
      if (t.sessionId === sessionId) {
        if (this.cancel(id, reason)) count++;
      }
    }
    return count;
  }

  on(handler: TransferEventHandler): void {
    this.handlers.push(handler);
  }

  off(handler: TransferEventHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx >= 0) this.handlers.splice(idx, 1);
  }

  activeCount(): number {
    return this.getActive().length;
  }

  protected emit(event: TransferEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // handlers must not throw
      }
    }
  }
}
