import type { ActionId, LocalizedText } from './actions';
import type { FileFormat, InputKind } from './formats';

export type Platform = 'darwin' | 'win32' | 'linux';
export type Arch = 'arm64' | 'x64';

/** Engine that implements a format direction in this build. */
export type FormatEngine = 'sharp' | 'pdfjs' | 'pdf-lib' | 'docx' | 'builtin-bmp' | 'imageio' | 'text' | 'none';

export interface FormatSupport {
  readonly input: boolean;
  readonly output: boolean;
  readonly inputEngine: FormatEngine;
  readonly outputEngine: FormatEngine;
  /** Why a direction is unavailable (developer-facing, English). */
  readonly note?: string;
}

/**
 * What the bundled engines can actually do, measured at runtime by
 * @orbitdrop/processors `probeEngines()` (e.g. by encoding a 1×1 image with
 * each encoder), not assumed from documentation.
 */
export interface EngineProbe {
  readonly platform: Platform;
  readonly arch: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly formats: Readonly<Record<FileFormat, FormatSupport>>;
  /** PDF.js page rendering works (canvas backend loaded). */
  readonly pdfRender: boolean;
  /** PDF.js text extraction works. */
  readonly pdfText: boolean;
  /** Font family used for annotation text that can render Hangul, if any. */
  readonly koreanFont: string | null;
  /** Problems found while probing (developer-facing). */
  readonly errors: readonly string[];
  readonly probedAt: number;
}

export interface ActionCapability {
  readonly actionId: ActionId;
  readonly enabled: boolean;
  /** Input kinds this action can run on in this build. */
  readonly inputKinds: readonly InputKind[];
  /** Image formats accepted as input in this build (subset of the decodable formats). */
  readonly imageInputs: readonly FileFormat[];
  /** Why the action is disabled, for the wheel capsule and the picker. */
  readonly reason?: LocalizedText;
}

export interface CapabilitySnapshot {
  readonly probe: EngineProbe;
  readonly actions: Readonly<Record<ActionId, ActionCapability>>;
}

/** Minimal description of an input used by supports(). */
export interface InputDescriptor {
  readonly kind: InputKind;
  readonly format: FileFormat;
}
