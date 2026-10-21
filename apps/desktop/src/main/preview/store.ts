import { PREVIEW_PROTOCOL } from '@orbitdrop/contracts';
import { newToken } from '../util/ids';

/**
 * In-memory store for editor preview images, served to the renderer through
 * `orbit-preview://p/<token>`. Tokens are random capability strings; entries
 * expire after `ttlMs` without access and the store is bounded by total bytes
 * and entry count (least recently used entries go first). Pinned entries (an
 * editor's source image) survive the TTL until their owner releases them.
 */

export interface PreviewEntry {
  readonly data: Uint8Array;
  readonly mime: string;
  readonly owner: string | null;
  readonly pinned: boolean;
  readonly createdAt: number;
  lastAccess: number;
}

export interface PreviewStoreOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function previewUrl(token: string): string {
  return `${PREVIEW_PROTOCOL}://p/${token}`;
}

/** Token from an orbit-preview URL, or null if the URL is not one of ours. */
export function tokenFromPreviewUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PREVIEW_PROTOCOL}:` || parsed.hostname !== 'p') return null;
  const token = parsed.pathname.replace(/^\/+/, '');
  return TOKEN_PATTERN.test(token) ? token : null;
}

export class PreviewStore {
  private readonly entries = new Map<string, PreviewEntry>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PreviewStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? 192 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  put(data: Uint8Array, mime: string, owner: string | null = null, pinned = false): string {
    const token = newToken();
    const now = this.now();
    this.entries.set(token, { data, mime, owner, pinned, createdAt: now, lastAccess: now });
    this.bytes += data.byteLength;
    this.evict(token);
    return token;
  }

  get(token: string): PreviewEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (!entry.pinned && this.now() - entry.lastAccess > this.ttlMs) {
      this.delete(token);
      return undefined;
    }
    entry.lastAccess = this.now();
    this.entries.delete(token);
    this.entries.set(token, entry);
    return entry;
  }

  has(token: string): boolean {
    return this.entries.has(token);
  }

  release(token: string): void {
    this.delete(token);
  }

  /** Drop every entry of `owner` except the tokens in `keep`. */
  releaseOwner(owner: string, keep: ReadonlySet<string> = new Set()): void {
    for (const [token, entry] of [...this.entries]) {
      if (entry.owner === owner && !keep.has(token)) this.delete(token);
    }
  }

  /** Remove expired entries (called periodically). */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [token, entry] of [...this.entries]) {
      if (!entry.pinned && now - entry.lastAccess > this.ttlMs) {
        this.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  private delete(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.bytes -= entry.data.byteLength;
  }

  private evict(protect: string): void {
    const over = (): boolean => this.bytes > this.maxBytes || this.entries.size > this.maxEntries;
    if (!over()) return;
    // First unpinned entries (LRU order), then pinned ones; never the entry just added.
    for (const pass of [false, true]) {
      for (const [token, entry] of [...this.entries]) {
        if (!over()) return;
        if (token === protect || entry.pinned !== pass) continue;
        this.delete(token);
      }
    }
  }
}

/** Response for a request to the preview protocol (pure; the protocol handler wraps it). */
export function previewResponse(store: PreviewStore, method: string, url: string): Response {
  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 });
  const token = tokenFromPreviewUrl(url);
  const entry = token ? store.get(token) : undefined;
  if (!entry) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const headers = {
    'Content-Type': entry.mime,
    'Content-Length': String(entry.data.byteLength),
    // Tokens are never reused for different content, so the image may be cached.
    'Cache-Control': 'private, max-age=3600, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  return new Response(method === 'HEAD' ? null : (entry.data as Uint8Array<ArrayBuffer>), { status: 200, headers });
}
