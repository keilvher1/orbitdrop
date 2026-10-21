import { z } from 'zod';
import { ICON_IDS } from './actions';
import { ActionIdSchema, Id, LocaleSchema, MenuKeySchema, ModifierCombo, WheelModeSchema } from './schemas';

/**
 * Protocol between Electron main and the native drag helper
 * (native/macos Swift, native/windows C++).
 *
 * Transport: the helper is spawned by main; messages are UTF-8 JSON objects,
 * one per line ("\n"), on the helper's stdin (main → helper) and stdout
 * (helper → main). stderr is free-form diagnostics. No sockets or ports.
 *
 * Every message carries `v` (protocol version) and `type`. Receivers must
 * reject lines longer than HELPER_MAX_LINE_BYTES, unknown types, wrong field
 * types and unknown action ids. The helper exits when stdin reaches EOF
 * (parent gone) after hiding any wheel.
 *
 * String length limits are counted in Unicode code points (zod 4 semantics),
 * not UTF-16 units; native implementations count the same way. Lines with a
 * duplicated JSON key are rejected by the helpers (JSON.parse keeps the last
 * value, Foundation the first, and JSON.stringify never emits duplicates).
 *
 * Session flow (owned by the helper):
 *   Idle → PotentialDrag → AwaitingPayload → WheelActive → (drop | cancelled) → Idle
 * `drop` is sent at most once per sessionId and only for a real OS drop on an
 * enabled sector. Main ignores duplicate or late messages for a sessionId.
 *
 * A sessionId is unique for the lifetime of the app and is never reused, not
 * even by a restarted helper (e.g. `<pid>-<counter>`): main ignores messages
 * whose sessionId it already saw from a previous helper process. A `state`
 * message with `Idle` ends the session; no drop follows it.
 */
export const HELPER_PROTOCOL_VERSION = 1 as const;
export const HELPER_MAX_LINE_BYTES = 1_048_576;
export const HELPER_MAX_FILES = 200;
/** Long Windows paths can reach 32767 UTF-16 units. */
export const HELPER_MAX_PATH_LENGTH = 32_767;

const v = z.literal(HELPER_PROTOCOL_VERSION);

export const WheelSectorSchema = z.strictObject({
  actionId: ActionIdSchema,
  label: z.string().min(1).max(32),
  icon: z.enum(ICON_IDS).nullable(),
  enabled: z.boolean(),
  reason: z.string().max(120).optional(),
  batch: z.boolean(),
});

export const HelperMenuSchema = z.strictObject({
  key: MenuKeySchema,
  convert: z.array(WheelSectorSchema).max(12),
  tools: z.array(WheelSectorSchema).max(12),
});

export const WheelGeometrySchema = z.strictObject({
  diameter: z.number().min(200).max(600),
  minDiameter: z.number().min(160).max(600),
  ringWidth: z.number().min(0).max(8),
  ringInset: z.number().min(0).max(40),
  innerRadiusRatio: z.number().min(0.15).max(0.6),
  sectorGap: z.number().min(0).max(24),
  sectorCornerRadius: z.number().min(0).max(40),
  capsuleWidth: z.number().min(40).max(200),
  capsuleHeight: z.number().min(20).max(100),
  startAngleDeg: z.number().min(-360).max(360),
  windowMargin: z.number().min(0).max(80),
  edgePadding: z.number().min(0).max(80),
  armDistance: z.number().min(0).max(40),
});

const ColorHex8 = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

/** Subset of design-tokens.json the helper needs to draw the wheel. */
export const WheelTokensSchema = z.strictObject({
  wheelDisc: ColorHex8,
  wheelRing: ColorHex8,
  wheelShadow: ColorHex8,
  sector: ColorHex8,
  sectorHover: ColorHex8,
  sectorText: ColorHex8,
  sectorIcon: ColorHex8,
  sectorDisabled: ColorHex8,
  sectorDisabledText: ColorHex8,
  sectorActive: ColorHex8,
  sectorActiveText: ColorHex8,
  capsule: ColorHex8,
  capsuleText: ColorHex8,
  capsuleReject: ColorHex8,
  labelSize: z.number().min(8).max(32),
  labelWeight: z.number().int().min(100).max(900),
  iconSize: z.number().min(8).max(48),
  capsuleTextSize: z.number().min(8).max(32),
  appearMs: z.number().min(0).max(1000),
  disappearMs: z.number().min(0).max(1000),
});
export type WheelTokens = z.infer<typeof WheelTokensSchema>;

// ---------------------------------------------------------------- main → helper

export const HelperConfigureSchema = z.strictObject({
  v,
  type: z.literal('configure'),
  /** When false the helper observes nothing and never shows a wheel. */
  enabled: z.boolean(),
  locale: LocaleSchema,
  geometry: WheelGeometrySchema,
  tokens: WheelTokensSchema,
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
  modifiers: z.strictObject({ convert: ModifierCombo, tools: ModifierCombo }),
  /** Lower-case extension with dot → menu key of a single file of that type ('pdf' | 'image/<fmt>'). */
  extensions: z.record(z.string().regex(/^\.[a-z0-9]{1,8}$/), MenuKeySchema),
  menus: z.array(HelperMenuSchema).max(32),
  strings: z.strictObject({
    /** Center text while waiting for the drag to enter (neutral state). */
    dropHint: z.string().max(60),
    /** Center text when the dragged items are not supported files. */
    unsupported: z.string().max(60),
    /** Center text on a non-batch sector during a multi-file drag. */
    multiFileUnsupported: z.string().max(60),
    /** "{n} files" — {n} is replaced by the count. */
    fileCount: z.string().max(60),
  }),
});

export const HelperCancelSessionSchema = z.strictObject({
  v,
  type: z.literal('cancelSession'),
  sessionId: Id,
});

export const HelperPingSchema = z.strictObject({ v, type: z.literal('ping'), nonce: z.number().int().nonnegative() });
export const HelperShutdownSchema = z.strictObject({ v, type: z.literal('shutdown') });

/** Ask the helper to report what it needs (macOS: whether any permission is missing). */
export const HelperQueryPermissionsSchema = z.strictObject({ v, type: z.literal('queryPermissions') });

export const MainToHelperSchema = z.discriminatedUnion('type', [
  HelperConfigureSchema,
  HelperCancelSessionSchema,
  HelperPingSchema,
  HelperShutdownSchema,
  HelperQueryPermissionsSchema,
]);
export type MainToHelperMessage = z.infer<typeof MainToHelperSchema>;
export type HelperConfigureMessage = z.infer<typeof HelperConfigureSchema>;

// ---------------------------------------------------------------- helper → main

export const HelperReadySchema = z.strictObject({
  v,
  type: z.literal('ready'),
  helperVersion: z.string().max(32),
  platform: z.enum(['darwin', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  osVersion: z.string().max(64),
  pid: z.number().int().positive(),
  globalDrag: z.strictObject({
    available: z.boolean(),
    /** Why global drag cannot work (e.g. missing permission), developer-facing. */
    reason: z.string().max(200).optional(),
  }),
});

export const HELPER_SESSION_STATES = ['PotentialDrag', 'AwaitingPayload', 'WheelActive', 'Idle'] as const;

export const HelperStateSchema = z.strictObject({
  v,
  type: z.literal('state'),
  sessionId: Id,
  state: z.enum(HELPER_SESSION_STATES),
  mode: WheelModeSchema.optional(),
  menuKey: MenuKeySchema.nullable().optional(),
  fileCount: z.number().int().min(0).max(100000).optional(),
});

export const HelperDropSchema = z.strictObject({
  v,
  type: z.literal('drop'),
  sessionId: Id,
  actionId: ActionIdSchema,
  mode: WheelModeSchema,
  /** Absolute file-system paths copied out of the drag data before the drop callback returned. */
  files: z.array(z.string().min(1).max(HELPER_MAX_PATH_LENGTH)).min(1).max(HELPER_MAX_FILES),
  /** The helper only ever accepts a drop as Copy. */
  dropEffect: z.literal('copy'),
});

export const HELPER_CANCEL_REASONS = [
  'escape',
  'dragEnded',
  'invalidPayload',
  'outsideRing',
  'disabledSector',
  'parentRequest',
  'sleep',
  'permissionLost',
  'error',
] as const;

export const HelperCancelledSchema = z.strictObject({
  v,
  type: z.literal('cancelled'),
  sessionId: Id,
  reason: z.enum(HELPER_CANCEL_REASONS),
});

export const HelperPongSchema = z.strictObject({ v, type: z.literal('pong'), nonce: z.number().int().nonnegative() });

export const HelperPermissionsSchema = z.strictObject({
  v,
  type: z.literal('permissions'),
  /** Each permission the chosen observation method needs, with its status. Empty if none needed. */
  items: z
    .array(
      z.strictObject({
        name: z.enum(['accessibility', 'inputMonitoring']),
        required: z.boolean(),
        granted: z.boolean(),
      }),
    )
    .max(4),
});

export const HelperLogSchema = z.strictObject({
  v,
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  /** Must not contain file paths or file contents. */
  message: z.string().max(2000),
});

export const HelperErrorSchema = z.strictObject({
  v,
  type: z.literal('error'),
  code: z.string().max(64),
  message: z.string().max(2000),
  fatal: z.boolean(),
});

export const HelperToMainSchema = z.discriminatedUnion('type', [
  HelperReadySchema,
  HelperStateSchema,
  HelperDropSchema,
  HelperCancelledSchema,
  HelperPongSchema,
  HelperPermissionsSchema,
  HelperLogSchema,
  HelperErrorSchema,
]);
export type HelperToMainMessage = z.infer<typeof HelperToMainSchema>;
export type HelperDropMessage = z.infer<typeof HelperDropSchema>;
export type HelperReadyMessage = z.infer<typeof HelperReadySchema>;

/** UTF-8 byte length without relying on Node's Buffer (contracts are also bundled for the renderer). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Parse one line from the helper. Returns null for anything invalid (caller logs and drops it). */
export function parseHelperLine(line: string): HelperToMainMessage | null {
  if (utf8ByteLength(line) > HELPER_MAX_LINE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = HelperToMainSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
