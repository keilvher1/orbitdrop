/**
 * Runs convert-electron-smoke.mjs: the processors bundled like electron-vite
 * does (CJS, dependencies external) and executed under Electron 44's Node —
 * as ELECTRON_RUN_AS_NODE, inside a real utilityProcess (where pdf.js does not
 * treat the environment as Node), and from an app.asar with pdfjs-dist packed
 * and only native binaries unpacked.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SmokeMode {
  passed: boolean;
  processType: string | null;
  electron: string | null;
  probe?: { pdfRender: boolean; pdfText: boolean; errors: string[] };
  results?: { actionId: string; outputs: { name: string; width?: number; height?: number; pages?: number; pageSizes?: number[][] }[] }[];
  bufferPoolSize?: number;
  resolved?: Record<string, string | null>;
  stderr?: string[];
}
interface SmokeModule {
  electronBinary(): string | null;
  runConvertSmoke(modes?: string[]): Promise<{ ok: boolean; bundle: { importMetaUrlPolyfilled: boolean; keepsDynamicImport: boolean }; modes: Record<string, SmokeMode> }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const smoke = (await import(pathToFileURL(join(here, 'convert-electron-smoke.mjs')).href)) as SmokeModule;
const hasElectron = smoke.electronBinary() !== null;
// The utilityProcess modes start the Electron app (no window); skip them on headless Linux.
const canLaunchApp = process.platform === 'darwin' || process.platform === 'win32' || Boolean(process.env.DISPLAY);

describe.skipIf(!hasElectron)('conversion engine under Electron', () => {
  it('converts under ELECTRON_RUN_AS_NODE, in a utilityProcess and from app.asar', { timeout: 300_000 }, async () => {
    const modes = canLaunchApp ? ['node', 'utility', 'asar', 'asar-native'] : ['node'];
    const summary = await smoke.runConvertSmoke(modes);
    for (const mode of modes) {
      const result = summary.modes[mode]!;
      expect(result.passed, `${mode}: ${JSON.stringify(result.stderr ?? '')}`).toBe(true);
      expect(result.electron).toMatch(/^\d+\./);
      expect(result.probe).toMatchObject({ pdfRender: true, pdfText: true, errors: [] });
      const jpegsToPdf = result.results!.find((r) => r.actionId === 'convert.pdf (jpegs)')!;
      expect(jpegsToPdf.outputs[0]).toMatchObject({ pages: 3, pageSizes: [[1600, 1200], [1200, 900], [1600, 1200]] });
      const pdfToJpg = result.results!.find((r) => r.actionId === 'convert.jpeg')!;
      expect(pdfToJpg.outputs.map((o) => [o.name, o.width, o.height])).toEqual([
        ['report-p001.jpg', 1275, 1650],
        ['report-p002.jpg', 1275, 1650],
      ]);
    }
    if (canLaunchApp) {
      expect(summary.modes.utility!.processType).toBe('utility');
      // Electron's utility process pools Buffers in 64 KiB slabs (Node: 8 KiB) — the condition behind the JPEG regression.
      expect(summary.modes.utility!.bufferPoolSize).toBe(65_536);
      expect(summary.modes.asar!.resolved!['pdfjs-dist/package.json']).toMatch(/\.asar[\\/]node_modules[\\/]pdfjs-dist/);
      expect(summary.modes['asar-native']!.resolved!.sharp).toMatch(/\.asar[\\/]node_modules[\\/]sharp/);
    }
    expect(summary.bundle).toMatchObject({ importMetaUrlPolyfilled: true, keepsDynamicImport: true });
  });
});
