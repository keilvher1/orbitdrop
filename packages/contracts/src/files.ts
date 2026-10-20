import type { ErrorCode } from './errors';
import type { FileFormat, InputKind } from './formats';
import type { MenuKey } from './menus';

/** Where a selection came from. All sources share the same pipeline afterwards. */
export type SelectionSource = 'globalDrag' | 'dropZone' | 'openDialog' | 'test';

/**
 * A file as the renderer sees it. The absolute path stays in main; the renderer
 * only gets an opaque fileId that main approved.
 */
export interface SelectedFile {
  readonly fileId: string;
  readonly name: string;
  /** Lower-case extension including the dot ('' if none). */
  readonly ext: string;
  /** Format detected from the file header (not the extension); null if unknown. */
  readonly format: FileFormat | null;
  readonly kind: InputKind | null;
  readonly bytes: number;
  /** Set when the file cannot be processed (folder, unknown type, unreadable…). */
  readonly problem?: { readonly code: ErrorCode; readonly message: string };
  /** Header disagrees with the extension (processing follows the header). */
  readonly extensionMismatch?: boolean;
}

export interface FileSelection {
  readonly selectionId: string;
  readonly source: SelectionSource;
  readonly files: readonly SelectedFile[];
  /** Menu for the usable files; null when nothing in the selection is supported. */
  readonly menuKey: MenuKey | null;
}
