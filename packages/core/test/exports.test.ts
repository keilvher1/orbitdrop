import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src';
import * as coreNode from '../src/node';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const NODE_BUILTINS = new Set(builtinModules);

function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]*?\s+from\s+)?['"]([^'"]+)['"]/g)) found.push(m[1]!);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]!);
  return found;
}

function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(candidate)) return candidate;
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

describe('package entry points', () => {
  it('src/index.ts never reaches a Node built-in (it is bundled into the renderer)', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of specifiers(file)) {
        if (spec.startsWith('.')) visit(resolveRelative(file, spec));
        else if (spec.startsWith('node:') || NODE_BUILTINS.has(spec.split('/')[0]!)) offenders.push(`${relative(srcDir, file)} → ${spec}`);
      }
    };
    visit(join(srcDir, 'index.ts'));
    expect(offenders).toEqual([]);
    const reached = [...seen].map((f) => relative(srcDir, f)).sort();
    expect(reached).not.toContain(join('node', 'output.ts'));
    expect(reached.some((f) => f.startsWith('golden'))).toBe(false);
    expect(reached).toEqual(expect.arrayContaining(['coords.ts', 'selection.ts', 'geometry.ts', 'capabilities.ts']));
  });

  it('exports the public API from both entries, including the processors-edit modules', () => {
    for (const name of [
      'hitTestWheel',
      'placeWheel',
      'placeWheelOnDisplays',
      'placeWheelFromAppKit',
      'placeWheelFromPhysical',
      'hitTestFromAppKit',
      'hitTestFromPhysical',
      'isArmed',
      'displayIndexForPoint',
      'displaysFromAppKitScreens',
      'displaysFromWin32Monitors',
      'appKitPointToGlobal',
      'physicalToDipPoint',
      'dipToPhysicalRect',
      'displayForPoint',
      'clampRectIntoArea',
      'fitRectIntoArea',
      'roundHalfUp',
      'buildCapabilitySnapshot',
      'supports',
      'buildWheelMenu',
      'adjustMenuForFileCount',
      'buildHelperMenus',
      'helperExtensionMap',
      'isReadableFormat',
      'menuKeyForPaths',
      'extensionOfPath',
      'buildFileSelection',
      'buildSelectedFile',
      'resolveSubmission',
      'convertedName',
      'toolResultName',
      'numberedName',
      'sanitizeBaseName',
      'detectFormatFromHeader',
      'detectLinkFile',
      'JobQueue',
      'DragSessionTracker',
      'computeCompositionLayout',
      'scaleCompositionLayout',
      'drawAnnotations',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
    for (const name of ['writeOutput', 'commitTempFile', 'makeTempPath', 'isTempFileName', 'cleanupTempFiles', 'discardTempFile', 'assertWritableDir', 'mapFsError', 'validateInputFile', 'defaultCloudRoots']) {
      expect(typeof (coreNode as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(core.SNIFF_BYTES).toBe(1024);
    expect(core.MAX_NAME_BYTES).toBe(255);
  });
});
