import { lstat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { FILE_FORMATS, FORMAT_INFO } from '@orbitdrop/contracts';
import { newId } from '../util/ids';

/**
 * outputId → output path. Outputs are files OrbitDrop created; the renderer
 * can only ask to reveal/open them by id.
 */
export interface OutputRecord {
  readonly outputId: string;
  readonly path: string;
  readonly name: string;
  /** Folder name shown to the user (display only). */
  readonly dirDisplay: string;
}

/** Extensions of the formats OrbitDrop writes (canonical and accepted spellings), lower case with the dot. */
export const OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set(FILE_FORMATS.flatMap((format) => [FORMAT_INFO[format].extension, ...FORMAT_INFO[format].extensions]));

/**
 * Whether an output may be handed to the OS "open" action: a regular file
 * (not a folder — an app bundle is one —, not a symlink) with the extension
 * of a format OrbitDrop writes. Output paths come from the processors but
 * also from history.json: a damaged or planted history file must never make
 * "Open" launch a program.
 */
export async function isOpenableOutput(path: string): Promise<boolean> {
  if (!OUTPUT_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export class OutputRegistry {
  private readonly byId = new Map<string, OutputRecord>();
  private readonly byPath = new Map<string, string>();

  constructor(private readonly maxEntries = 5000) {}

  register(path: string): OutputRecord {
    const existing = this.byPath.get(path);
    if (existing) {
      const record = this.byId.get(existing);
      if (record) return record;
    }
    const record: OutputRecord = { outputId: newId('out'), path, name: basename(path), dirDisplay: basename(dirname(path)) || dirname(path) };
    this.byId.set(record.outputId, record);
    this.byPath.set(path, record.outputId);
    while (this.byId.size > this.maxEntries) {
      const oldest = this.byId.keys().next();
      if (oldest.done) break;
      const old = this.byId.get(oldest.value);
      this.byId.delete(oldest.value);
      if (old) this.byPath.delete(old.path);
    }
    return record;
  }

  get(outputId: string): OutputRecord | undefined {
    return this.byId.get(outputId);
  }
}
