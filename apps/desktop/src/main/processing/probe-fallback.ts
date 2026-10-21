import { FILE_FORMATS, type EngineProbe, type FileFormat, type FormatSupport } from '@orbitdrop/contracts';

/**
 * Probe result used when the engines could not be probed at all (worker failed
 * to start, processors failed to load, probe threw or timed out). Every format
 * is unavailable, so every action is disabled with a reason — nothing is
 * offered that cannot run.
 */
export function failedProbe(errors: readonly string[], platform: NodeJS.Platform = process.platform, arch: string = process.arch): EngineProbe {
  const none: FormatSupport = { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'engines unavailable' };
  const formats = Object.fromEntries(FILE_FORMATS.map((format) => [format, none])) as Record<FileFormat, FormatSupport>;
  return {
    platform: platform === 'darwin' || platform === 'win32' ? platform : 'linux',
    arch,
    versions: {},
    formats,
    pdfRender: false,
    pdfText: false,
    koreanFont: null,
    errors: errors.length > 0 ? [...errors] : ['engine probe failed'],
    probedAt: Date.now(),
  };
}

/** True when at least one format can be read and written. */
export function probeHasEngines(probe: EngineProbe): boolean {
  return Object.values(probe.formats).some((f) => f.input) && Object.values(probe.formats).some((f) => f.output);
}
