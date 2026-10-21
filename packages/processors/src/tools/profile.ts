import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharpFromRaw, toRaw, type LoadedImage, type RawImage } from './common';
import { iccDescription, isSrgbProfile } from './icc';

/**
 * Overlay colours (#RRGGBB from the editors, the annotation canvas) are sRGB.
 * When a same-image tool keeps a wide-gamut profile (Display P3, Adobe RGB…),
 * writing those numbers straight into the stored pixels would display a
 * different colour than requested — and than the editor preview, which works
 * in sRGB (P3-tagged #3366CC shows as (27,103,211) instead of (51,102,204)).
 * Overlay pixels are therefore converted into the image's own profile first.
 *
 * sharp only accepts output profiles as built-in names or file paths, so the
 * embedded profile is written to a private temp folder for the duration of
 * the call and removed afterwards (no user folder is touched).
 */

export function needsProfileConversion(image: LoadedImage): boolean {
  return image.keepIcc && image.meta.icc !== undefined && !isSrgbProfile(iccDescription(image.meta.icc));
}

export async function withProfileFile<T>(icc: Buffer, fn: (profilePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'orbitdrop-icc-'));
  try {
    const path = join(dir, 'profile.icc');
    await writeFile(path, icc);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** sRGB RGBA pixels → RGB values of the profile at `profilePath` (alpha untouched). */
export async function srgbToProfile(raw: RawImage, profilePath: string): Promise<RawImage> {
  return toRaw(sharpFromRaw(raw).withIccProfile(profilePath, { attach: false }).ensureAlpha());
}

/** Convert a list of sRGB colours into the profile (one tiny transform for all of them). */
export async function srgbColoursToProfile(colours: readonly (readonly [number, number, number])[], profilePath: string): Promise<[number, number, number][]> {
  if (colours.length === 0) return [];
  const data = Buffer.alloc(colours.length * 4);
  colours.forEach((c, i) => data.set([c[0], c[1], c[2], 255], i * 4));
  const out = await srgbToProfile({ data, width: colours.length, height: 1, channels: 4 }, profilePath);
  return colours.map((_, i) => [out.data[i * out.channels]!, out.data[i * out.channels + 1]!, out.data[i * out.channels + 2]!]);
}
