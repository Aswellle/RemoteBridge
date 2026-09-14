
/**
 * V2 Transfer Engine — web client transfer manager.
 *
 * Browser-side transfer state manager built on the shared BaseTransferManager.
 * Integrates with the Zustand store via event handlers to keep the UI in sync
 * with transfer lifecycle (pending → streaming → completed | failed | cancelled).
 */

import { BaseTransferManager } from '@remotebridge/shared';
import type { TransferRecord, TransferEvent, TransferState } from '@remotebridge/shared';

// Re-export shared types
export type { TransferRecord, TransferEvent, TransferState };

// ===== Web-specific extensions =====

export interface WebTransferRecord extends TransferRecord {
  /** Download URL (for download transfers, set when RESP_DOWNLOAD_READY arrives) */
  downloadUrl?: string;
  /** Preview URL (for preview transfers, sandboxed Blob URL) */
  previewUrl?: string;
  /** AbortController for in-flight fetch */
  abortController?: AbortController;
}

export class WebTransferManager extends BaseTransferManager {
  /** Extended records with web-specific fields */
  private webRecords = new Map<string, WebTransferRecord>();

  override begin(
    record: Omit<TransferRecord, 'createdAt' | 'lastActivityAt' | 'transferredBytes' | 'state'> & { state?: TransferState }
  ): string {
    const id = super.begin(record);
    const webRecord: WebTransferRecord = {
      ...this.get(id)!,
      downloadUrl: undefined,
      previewUrl: undefined,
    };
    this.webRecords.set(id, webRecord);
    return id;
  }

  /** Get the web-extended record */
  getWebRecord(transferId: string): WebTransferRecord | undefined {
    return this.webRecords.get(transferId);
  }

  /** Set download URL for a transfer */
  setDownloadUrl(transferId: string, url: string): void {
    const record = this.webRecords.get(transferId);
    if (record) record.downloadUrl = url;
  }

  /** Set preview URL for a transfer */
  setPreviewUrl(transferId: string, url: string): void {
    const record = this.webRecords.get(transferId);
    if (record) record.previewUrl = url;
  }

  /** Set AbortController for a transfer */
  setAbortController(transferId: string, controller: AbortController): void {
    const record = this.webRecords.get(transferId);
    if (record) record.abortController = controller;
  }

  /** Abort a transfer's in-flight fetch */
  abort(transferId: string): void {
    const record = this.webRecords.get(transferId);
    if (record?.abortController) {
      record.abortController.abort();
    }
  }

  /** Override cancel to also abort fetch */
  override cancel(transferId: string, reason?: string): boolean {
    this.abort(transferId);
    return super.cancel(transferId, reason as any);
  }

  /** Override complete to clean up web record */
  override complete(transferId: string): void {
    super.complete(transferId);
    this.webRecords.delete(transferId);
  }

  /** Override fail to clean up web record */
  override fail(transferId: string, error: string, code?: string): void {
    super.fail(transferId, error, code);
    this.webRecords.delete(transferId);
  }

  /** Clean up preview URL Blob */
  revokePreviewUrl(transferId: string): void {
    const record = this.webRecords.get(transferId);
    if (record?.previewUrl) {
      URL.revokeObjectURL(record.previewUrl);
      record.previewUrl = undefined;
    }
  }
}

/** Singleton web transfer manager */
export const webTransferManager = new WebTransferManager({ idleTimeoutMs: 60000 });
