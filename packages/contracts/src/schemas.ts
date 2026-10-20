import { z } from 'zod';
import { ACTION_IDS, WHEEL_MODES, type ActionId } from './actions';
import { FILE_FORMATS } from './formats';
import { MENU_KEYS } from './menus';

/** Reusable zod building blocks. */

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');
export const Quality = z.number().int().min(1).max(100);
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected an opaque id');

export const ActionIdSchema = z.enum(ACTION_IDS as unknown as [ActionId, ...ActionId[]]);
export const WheelModeSchema = z.enum(WHEEL_MODES as unknown as ['convert', 'tools']);
export const FileFormatSchema = z.enum(FILE_FORMATS as unknown as ['jpeg', ...string[]]);
export const MenuKeySchema = z.enum(MENU_KEYS as unknown as ['pdf', ...string[]]);
export const LocaleSchema = z.enum(['ko', 'en']);

/** Integer pixel rectangle in oriented image coordinates (after EXIF orientation). */
export const PixelRect = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type PixelRect = z.infer<typeof PixelRect>;

export const ModifierKeySchema = z.enum(['shift', 'alt', 'control', 'command']);
export type ModifierKey = z.infer<typeof ModifierKeySchema>;

/** A modifier combination, e.g. ['shift'] or ['alt', 'shift']. 'alt' is Option on macOS. */
export const ModifierCombo = z
  .array(ModifierKeySchema)
  .min(1)
  .max(3)
  .refine((keys) => new Set(keys).size === keys.length, 'duplicate modifier');
export type ModifierCombo = z.infer<typeof ModifierCombo>;
