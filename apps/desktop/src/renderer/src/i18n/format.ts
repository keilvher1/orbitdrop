import type { Locale, Platform } from '@orbitdrop/contracts';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human file size. macOS (Finder) uses decimal units, Windows (Explorer) binary
 * units with the same labels, so sizes match what the user sees in the OS.
 */
export function formatBytes(bytes: number, locale: Locale, platform: Platform = 'darwin'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const base = platform === 'win32' ? 1024 : 1000;
  let value = bytes;
  let unit = 0;
  while (value >= base && unit < UNITS.length - 1) {
    value /= base;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  return `${number} ${UNITS[unit]}`;
}

export function formatNumber(value: number, locale: Locale, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

/** Percentage change from `from` to `to`, rounded to an integer (positive = larger). */
export function percentChange(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.round(((to - from) / from) * 100);
}

export function formatTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}
