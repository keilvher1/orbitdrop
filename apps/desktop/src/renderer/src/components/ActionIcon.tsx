import type { IconId } from '@orbitdrop/contracts';
import { Crop, EyeOff, Image, Minimize2, PenLine, SlidersHorizontal, Sparkles, Tag, type LucideIcon } from 'lucide-react';

/**
 * Abstract IconId (contracts) → Lucide icon (ISC). macOS maps the same ids to
 * SF Symbols and Windows to Segoe Fluent Icons; the shapes were picked to read
 * the same: compress = arrows in, metadata = tag, edit = sliders, annotate =
 * pen, background = picture, crop = crop marks, redact = crossed-out eye,
 * analyze (Claude analysis) = sparkles.
 */
export const ACTION_ICONS: Readonly<Record<IconId, LucideIcon>> = {
  compress: Minimize2,
  metadata: Tag,
  edit: SlidersHorizontal,
  annotate: PenLine,
  background: Image,
  crop: Crop,
  redact: EyeOff,
  analyze: Sparkles,
};

export function ActionIcon({ icon, size = 18 }: { readonly icon: IconId; readonly size?: number }) {
  const Icon = ACTION_ICONS[icon];
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}
