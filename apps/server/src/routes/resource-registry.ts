/**
 * Opaque Resource Handle registry.
 *
 * Maps opaque UUIDs to file resource metadata (filePath, session, host).
 * Prevents filePath exposure in URLs and provides a traversal-safe
 * indirection layer for file access.
 */

import { randomUUID } from 'node:crypto';

export interface ResourceRecord {
  resourceId: string;
  filePath: string;
  sessionId: string;
  hostId: string;
  clientId: string;
  mode: 'download' | 'preview';
  createdAt: number;
}

export class ResourceRegistry {
  private resources = new Map<string, ResourceRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Create an opaque resource ID for a file path. Returns the resourceId. */
  create(
    filePath: string,
    sessionId: string,
    hostId: string,
    clientId: string,
    mode: 'download' | 'preview',
  ): string {
    const resourceId = randomUUID();
    this.resources.set(resourceId, {
      resourceId,
      filePath,
      sessionId,
      hostId,
      clientId,
      mode,
      createdAt: Date.now(),
    });
    return resourceId;
  }

  /** Look up a resource by its opaque ID. Returns undefined if not found or expired. */
  resolve(resourceId: string): ResourceRecord | undefined {
    const record = this.resources.get(resourceId);
    if (!record) return undefined;
    // TTL check
    if (Date.now() - record.createdAt > this.ttlMs) {
      this.resources.delete(resourceId);
      return undefined;
    }
    return record;
  }

  /** Consume a resource (one-time use for download). */
  consume(resourceId: string): ResourceRecord | undefined {
    const record = this.resolve(resourceId);
    if (record) {
      this.resources.delete(resourceId);
    }
    return record;
  }

  /** Clean up expired resources. Returns number cleaned. */
  cleanup(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, record] of this.resources) {
      if (now - record.createdAt > this.ttlMs) {
        this.resources.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Resource count (for monitoring). */
  get size(): number {
    return this.resources.size;
  }
}

/** Singleton resource registry */
export const resourceRegistry = new ResourceRegistry();
