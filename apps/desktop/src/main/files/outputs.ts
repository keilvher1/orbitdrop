import { basename, dirname } from 'node:path';
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
