import exifReader from 'exif-reader';
import type { ExifSummary } from '@orbitdrop/contracts';

/**
 * EXIF → ExifSummary (read-only display in the Metadata editor). Values are
 * shown to the user; they are never written to logs.
 */

type Tags = Record<string, unknown>;

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\u0000+$/g, '').trim();
  return t.length > 0 ? t.slice(0, 120) : undefined;
}

function finite(value: unknown): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** exif-reader returns EXIF wall-clock dates as UTC Date objects; print them back as wall-clock time. */
function formatDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  return str(value);
}

export function formatExposure(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !(seconds > 0)) return undefined;
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}`;
}

function dms(value: unknown, ref: unknown, negative: string): number | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const [d = 0, m = 0, s = 0] = value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN));
  if (![d, m, s].every(Number.isFinite)) return null;
  const deg = d + m / 60 + s / 3600;
  const sign = typeof ref === 'string' && ref.trim().toUpperCase().startsWith(negative) ? -1 : 1;
  return Math.round(sign * deg * 1e7) / 1e7;
}

export function gpsFromTags(gps: Tags | undefined): { latitude: number; longitude: number } | null {
  if (!gps) return null;
  const latitude = dms(gps.GPSLatitude, gps.GPSLatitudeRef, 'S');
  const longitude = dms(gps.GPSLongitude, gps.GPSLongitudeRef, 'W');
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

const SUMMARIZED = new Set([
  'Make',
  'Model',
  'LensModel',
  'Software',
  'DateTimeOriginal',
  'ExposureTime',
  'FNumber',
  'ISOSpeedRatings',
  'PhotographicSensitivity',
  'FocalLength',
  // Structural pointers / offsets are not useful to people.
  'ExifTag',
  'GPSTag',
  'InteroperabilityTag',
  'JPEGInterchangeFormat',
  'JPEGInterchangeFormatLength',
  'StripOffsets',
  'StripByteCounts',
]);

function otherTags(groups: readonly (Tags | undefined)[]): { tag: string; value: string }[] {
  const out: { tag: string; value: string }[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const [tag, value] of Object.entries(group)) {
      if (SUMMARIZED.has(tag) || /^\d+$/.test(tag) || tag.startsWith('GPS')) continue;
      let text: string | undefined;
      if (typeof value === 'string') text = str(value);
      else if (typeof value === 'number' && Number.isFinite(value)) text = String(Number(value.toFixed(4)));
      else if (value instanceof Date) text = formatDate(value);
      if (text !== undefined && text.length <= 64) out.push({ tag, value: text });
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/** Parse raw EXIF (as returned by sharp's metadata().exif). Null when unreadable. */
export function summarizeExif(raw: Buffer | undefined): ExifSummary | null {
  if (!raw || raw.length < 8) return null;
  let parsed: ReturnType<typeof exifReader>;
  try {
    parsed = exifReader(raw);
  } catch {
    return null;
  }
  const image = (parsed.Image ?? {}) as Tags;
  const photo = (parsed.Photo ?? {}) as Tags;
  const gps = parsed.GPSInfo as Tags | undefined;
  const thumb = parsed.Thumbnail as Tags | undefined;
  const other = otherTags([image, photo]);
  if (thumb && (typeof thumb.JPEGInterchangeFormat === 'number' || typeof thumb.StripOffsets !== 'undefined')) {
    other.unshift({ tag: 'EmbeddedThumbnail', value: 'yes' });
  }
  const summary: ExifSummary = {
    ...(str(image.Make) === undefined ? {} : { make: str(image.Make)! }),
    ...(str(image.Model) === undefined ? {} : { model: str(image.Model)! }),
    ...(str(photo.LensModel) === undefined ? {} : { lens: str(photo.LensModel)! }),
    ...(str(image.Software) === undefined ? {} : { software: str(image.Software)! }),
    ...(formatDate(photo.DateTimeOriginal ?? image.DateTime) === undefined ? {} : { dateTimeOriginal: formatDate(photo.DateTimeOriginal ?? image.DateTime)! }),
    ...(formatExposure(finite(photo.ExposureTime)) === undefined ? {} : { exposureTime: formatExposure(finite(photo.ExposureTime))! }),
    ...(finite(photo.FNumber) === undefined ? {} : { fNumber: finite(photo.FNumber)! }),
    ...(finite(photo.ISOSpeedRatings ?? photo.PhotographicSensitivity) === undefined ? {} : { iso: finite(photo.ISOSpeedRatings ?? photo.PhotographicSensitivity)! }),
    ...(finite(photo.FocalLength) === undefined ? {} : { focalLength: finite(photo.FocalLength)! }),
    gps: gpsFromTags(gps),
    other,
  };
  return summary;
}
