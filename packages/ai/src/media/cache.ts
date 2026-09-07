import { createHash } from "node:crypto";
import type { DerivedTranscript } from "@messenger/contracts";

export interface CachedMediaItem {
  mediaRefId: string;
  mimeType: string;
  byteSize: number;
  buffer: Buffer;
  base64: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  transcript?: DerivedTranscript;
  createdAt: Date;
  expiresAt: Date;
  lastAccessedAt: Date;
}

export interface MediaCacheOptions {
  ttlMs?: number; // Default 24 hours (86,400,000 ms)
  maxBytesTotal?: number; // Default 512 MiB
}

export function generateInternalMediaRef(buffer: Buffer, mimeType: string): string {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `mref_${hash}_${ext}`;
}

export class MediaCache {
  private cache = new Map<string, CachedMediaItem>();
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytesTotal: number;

  constructor(options: MediaCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxBytesTotal = options.maxBytesTotal ?? 512 * 1024 * 1024;
  }

  set(item: Omit<CachedMediaItem, "createdAt" | "expiresAt" | "lastAccessedAt"> & { ttlMs?: number }): CachedMediaItem {
    this.evictExpired();

    // If updating existing entry, subtract previous size
    const existing = this.cache.get(item.mediaRefId);
    if (existing) {
      this.totalBytes -= existing.byteSize;
    }

    // Ensure within total memory quota
    const incomingSize = item.byteSize;
    while (this.totalBytes + incomingSize > this.maxBytesTotal && this.cache.size > 0) {
      // Evict least recently accessed item
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;
      for (const [key, val] of this.cache.entries()) {
        const accessTime = val.lastAccessedAt.getTime();
        if (accessTime < oldestAccess) {
          oldestAccess = accessTime;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        const evicted = this.cache.get(oldestKey);
        if (evicted) this.totalBytes -= evicted.byteSize;
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + (item.ttlMs ?? this.ttlMs));
    const cachedItem: CachedMediaItem = {
      ...item,
      createdAt: existing?.createdAt ?? now,
      expiresAt,
      lastAccessedAt: now,
    };

    this.cache.set(item.mediaRefId, cachedItem);
    this.totalBytes += incomingSize;
    return cachedItem;
  }

  get(mediaRefId: string): CachedMediaItem | undefined {
    const item = this.cache.get(mediaRefId);
    if (!item) return undefined;

    if (item.expiresAt < new Date()) {
      this.totalBytes -= item.byteSize;
      this.cache.delete(mediaRefId);
      return undefined;
    }

    item.lastAccessedAt = new Date();
    return item;
  }

  has(mediaRefId: string): boolean {
    return Boolean(this.get(mediaRefId));
  }

  updateTranscript(mediaRefId: string, transcript: DerivedTranscript): boolean {
    const item = this.get(mediaRefId);
    if (!item) return false;
    item.transcript = transcript;
    item.lastAccessedAt = new Date();
    return true;
  }

  evictExpired(): number {
    const now = new Date();
    let evictedCount = 0;
    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt < now) {
        this.totalBytes -= item.byteSize;
        this.cache.delete(key);
        evictedCount++;
      }
    }
    return evictedCount;
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  getItemCount(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }
}

// Global media cache singleton
export const globalMediaCache = new MediaCache();
