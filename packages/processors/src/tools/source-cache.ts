import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { ProcessingLimits, ProcessorInput } from '@orbitdrop/contracts';
import { mapFsError } from '@orbitdrop/core/node';
import { loadImage, throwIfCancelled, toRaw, toToolError, type LoadedImage, type RawImage } from './common';

/**
 * Small LRU caches for editor previews. A preview request decodes the source
 * once at (at most) the preview size; while the user drags a slider the same
 * downscaled source is reused instead of decoding a 24 MP JPEG every time.
 * Entries are keyed by path + size + mtime, so an edited file is decoded again.
 */
export class Lru<V> {
  private readonly map = new Map<string, { value: V; cost: number }>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxCost: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, cost = 1): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.cost;
      this.map.delete(key);
    }
    if (cost > this.maxCost) return;
    this.map.set(key, { value, cost });
    this.total += cost;
    while (this.map.size > this.maxEntries || this.total > this.maxCost) {
      const oldest = this.map.keys().next().value as string;
      this.total -= this.map.get(oldest)?.cost ?? 0;
      this.map.delete(oldest);
    }
  }

  entries(): IterableIterator<[string, V]> {
    const iter = this.map.entries();
    return (function* () {
      for (const [k, v] of iter) yield [k, v.value] as [string, V];
    })();
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Oriented, sRGB, RGBA pixels of a source, downscaled to fit a preview. */
export interface ScaledSource extends RawImage {
  readonly channels: 4;
  /** Oriented full size of the source. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** The source declares an alpha channel. */
  readonly sourceHasAlpha: boolean;
}

interface FileIdentity {
  readonly key: string;
}

async function identify(input: ProcessorInput): Promise<FileIdentity> {
  try {
    const info = await stat(input.path);
    return { key: `${input.path}\u0000${info.size}\u0000${info.mtimeMs}` };
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
}

const sourceCache = new Lru<ScaledSource>(8, 160 * 1024 * 1024);
const sizeCache = new Lru<{ width: number; height: number; hasAlpha: boolean }>(64, 64);

function cacheKey(id: FileIdentity, edge: number): string {
  return `${id.key}\u0000${edge}`;
}

/** Decodes in progress, shared by concurrent requests for the same file and size. */
const inflight = new Map<string, Promise<ScaledSource>>();

async function decodeScaled(
  input: ProcessorInput,
  limits: ProcessingLimits,
  id: FileIdentity,
  size: { width: number; height: number; hasAlpha: boolean },
  edge: number,
  preloaded: LoadedImage | null,
): Promise<ScaledSource> {
  // A cached decode of the same file at a larger size is much cheaper to shrink than the original.
  let best: ScaledSource | null = null;
  for (const [key, value] of sourceCache.entries()) {
    if (!key.startsWith(`${id.key}\u0000`)) continue;
    if (Math.max(value.width, value.height) >= edge && (!best || value.width < best.width)) best = value;
  }
  let raw: RawImage;
  if (best) {
    raw = await toRaw(
      sharp(best.data, { raw: { width: best.width, height: best.height, channels: 4 } }).resize({
        width: edge,
        height: edge,
        fit: 'inside',
        withoutEnlargement: true,
      }),
    );
  } else {
    const loaded = preloaded ?? (await loadImage(input, limits));
    raw = await toRaw(
      loaded
        .open()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .ensureAlpha(),
    );
  }
  const result: ScaledSource = {
    data: raw.data,
    width: raw.width,
    height: raw.height,
    channels: 4,
    sourceWidth: size.width,
    sourceHeight: size.height,
    sourceHasAlpha: size.hasAlpha,
  };
  // Cached even if the requester was cancelled meanwhile: the next preview (usually the newer one) needs it.
  sourceCache.set(cacheKey(id, edge), result, raw.data.length);
  return result;
}

/**
 * Oriented RGBA pixels of `input` whose longest edge is `edgeFor(fullW, fullH)`
 * (clamped to the natural size: never upscaled). Reuses a cached decode of the
 * same file when one at least as large exists; concurrent requests share one decode.
 */
export async function getScaledSource(
  input: ProcessorInput,
  limits: ProcessingLimits,
  edgeFor: (fullWidth: number, fullHeight: number) => number,
  signal?: AbortSignal,
): Promise<ScaledSource> {
  const id = await identify(input);
  throwIfCancelled(signal);
  let size = sizeCache.get(id.key);
  let loaded: LoadedImage | null = null;
  if (!size) {
    loaded = await loadImage(input, limits, signal);
    size = { width: loaded.width, height: loaded.height, hasAlpha: loaded.hasAlpha };
    sizeCache.set(id.key, size);
  }
  const natural = Math.max(size.width, size.height);
  const edge = Math.max(1, Math.min(natural, Math.ceil(edgeFor(size.width, size.height))));
  const key = cacheKey(id, edge);
  const exact = sourceCache.get(key);
  if (exact) return exact;
  throwIfCancelled(signal);

  let pending = inflight.get(key);
  if (!pending) {
    pending = decodeScaled(input, limits, id, size, edge, loaded).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  try {
    const result = await pending;
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    throw toToolError(error, signal);
  }
}

/** Drop all cached decodes (tests, memory pressure). */
export function clearPreviewCaches(): void {
  sourceCache.clear();
  sizeCache.clear();
}
