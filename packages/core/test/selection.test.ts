import { describe, expect, it } from 'vitest';
import type { FileFormat, InputKind } from '@orbitdrop/contracts';
import {
  asciiLower,
  buildCapabilitySnapshot,
  buildFileSelection,
  buildSelectedFile,
  canRewriteSameFormat,
  extensionOfPath,
  fileNameOfPath,
  formatOfSingleFileKey,
  helperExtensionMap,
  menuKeyForPaths,
  resolveSubmission,
  selectionMenuKey,
  type SelectionCandidate,
} from '../src';
import { PROBE_DARWIN_ARM64, PROBE_DARWIN_ARM64_IMAGEIO } from '../src/golden/probes';

const snapshot = buildCapabilitySnapshot(PROBE_DARWIN_ARM64);
const map = helperExtensionMap(snapshot);

function ok(fileId: string, displayName: string, format: FileFormat, extensionMismatch = false): SelectionCandidate {
  const kind: InputKind = format === 'pdf' ? 'pdf' : 'image';
  return { fileId, input: { displayName, format, kind, bytes: 1000 + fileId.length, extensionMismatch } };
}

function bad(fileId: string, path: string, code: 'NOT_A_FILE' | 'UNSUPPORTED_FORMAT' | 'READ_PERMISSION_DENIED'): SelectionCandidate {
  return { fileId, path, error: { code, message: code.toLowerCase() } };
}

describe('path classification', () => {
  it('takes the last component with either separator and ignores trailing separators', () => {
    expect(fileNameOfPath('/Users/me/Page 001.pdf')).toBe('Page 001.pdf');
    expect(fileNameOfPath('C:\\Users\\me\\photo.JPG')).toBe('photo.JPG');
    expect(fileNameOfPath('\\\\nas\\share\\scan.pdf')).toBe('scan.pdf');
    expect(fileNameOfPath('C:/mixed\\sep/x.png')).toBe('x.png');
    expect(fileNameOfPath('/Users/me/folder/')).toBe('folder');
    expect(fileNameOfPath('C:\\')).toBe('C:');
    expect(fileNameOfPath('/')).toBe('');
    expect(fileNameOfPath('plain.txt')).toBe('plain.txt');
  });

  it('extracts lower-case (ASCII only) extensions', () => {
    expect(extensionOfPath('/a/photo.JPG')).toBe('.jpg');
    expect(extensionOfPath('/a/archive.tar.GZ')).toBe('.gz');
    expect(extensionOfPath('/a/.png')).toBe('');
    expect(extensionOfPath('/a/photo.')).toBe('');
    expect(extensionOfPath('/a.dir/file')).toBe('');
    expect(extensionOfPath('/a/x.\uff2a\uff30\uff27')).toBe('.\uff2a\uff30\uff27');
    expect(asciiLower('AbC-\u00c4\u00d6-\u0130-\u212a')).toBe('abc-\u00c4\u00d6-\u0130-\u212a'); // Kelvin sign and dotted I stay as they are
  });

  it('only accepts single-file menu keys from the extension map', () => {
    expect(formatOfSingleFileKey('pdf')).toBe('pdf');
    expect(formatOfSingleFileKey('image/webp')).toBe('webp');
    expect(formatOfSingleFileKey('image/svg')).toBeUndefined();
    expect(formatOfSingleFileKey('images')).toBeUndefined();
    expect(formatOfSingleFileKey('mixed')).toBeUndefined();
  });

  it('classifies dragged paths like the native helpers must', () => {
    expect(menuKeyForPaths(['/a/b.pdf'], map)).toBe('pdf');
    expect(menuKeyForPaths(['/a/b.JPG', 'C:\\x\\c.jpeg'], map)).toBe('image/jpeg');
    expect(menuKeyForPaths(['/a/b.jpg', '/a/c.png'], map)).toBe('images');
    expect(menuKeyForPaths(['/a/b.jpg', '/a/c.pdf'], map)).toBe('mixed');
    expect(menuKeyForPaths(['/a/b.heic'], map)).toBeNull();
    expect(menuKeyForPaths(['/a/b.heic'], helperExtensionMap(buildCapabilitySnapshot(PROBE_DARWIN_ARM64_IMAGEIO)))).toBe('image/heic');
    expect(menuKeyForPaths(['/a/b.png', '/a/readme.txt'], map)).toBeNull();
    expect(menuKeyForPaths([], map)).toBeNull();
    expect(menuKeyForPaths(['/a/folder.png/'], map)).toBeNull();
    expect(menuKeyForPaths(['/a/b.png', ''], map)).toBeNull();
  });

  it('looks up own keys only and ignores invalid map values', () => {
    expect(menuKeyForPaths(['/a/x.constructor'], map)).toBeNull();
    expect(menuKeyForPaths(['/a/x.toString'], {})).toBeNull();
    const nullProto = Object.assign(Object.create(null) as Record<string, string>, { '.png': 'image/png' });
    expect(menuKeyForPaths(['/a/x.png'], nullProto)).toBe('image/png');
    expect(menuKeyForPaths(['/a/x.png'], { '.png': 'images' })).toBeNull();
    expect(menuKeyForPaths(['/a/x.png'], { '.png': 'image/svg' })).toBeNull();
  });
});

describe('FileSelection building', () => {
  it('keeps drop order, places rejected paths in their position and dedupes fileIds', () => {
    const selection = buildFileSelection('sel1', 'globalDrag', [
      ok('f1', 'b.png', 'png'),
      bad('f2', '/Users/me/Folder', 'NOT_A_FILE'),
      ok('f3', 'a.png', 'png'),
      ok('f1', 'b.png', 'png'),
      bad('f4', 'C:\\Users\\me\\notes.TXT', 'UNSUPPORTED_FORMAT'),
    ]);
    expect(selection.files.map((f) => f.fileId)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(selection.files[1]).toEqual({
      fileId: 'f2',
      name: 'Folder',
      ext: '',
      format: null,
      kind: null,
      bytes: 0,
      problem: { code: 'NOT_A_FILE', message: 'not_a_file' },
    });
    expect(selection.files[3]).toMatchObject({ name: 'notes.TXT', ext: '.txt', problem: { code: 'UNSUPPORTED_FORMAT' } });
    expect(selection.menuKey).toBe('image/png');
    expect(selection).toMatchObject({ selectionId: 'sel1', source: 'globalDrag' });
  });

  it('derives the menu from the usable files only', () => {
    expect(buildFileSelection('s', 'dropZone', [ok('a', 'a.jpg', 'jpeg'), ok('b', 'b.pdf', 'pdf')]).menuKey).toBe('mixed');
    expect(buildFileSelection('s', 'dropZone', [bad('a', '/x', 'NOT_A_FILE')]).menuKey).toBeNull();
    expect(buildFileSelection('s', 'openDialog', []).menuKey).toBeNull();
    expect(selectionMenuKey([])).toBeNull();
  });

  it('marks the extension mismatch only when present and the real format', () => {
    const file = buildSelectedFile(ok('a', 'Fake.JPG', 'png', true));
    expect(file).toMatchObject({ name: 'Fake.JPG', ext: '.jpg', format: 'png', kind: 'image', extensionMismatch: true });
    expect(buildSelectedFile(ok('b', 'real.png', 'png'))).not.toHaveProperty('extensionMismatch');
  });

  it('flags formats this build cannot read when given a snapshot', () => {
    const selection = buildFileSelection('s', 'globalDrag', [ok('h', 'IMG_0001.HEIC', 'heic'), ok('j', 'b.jpg', 'jpeg')], { snapshot });
    expect(selection.files[0]).toMatchObject({ format: 'heic', problem: { code: 'UNSUPPORTED_FORMAT' } });
    expect(selection.menuKey).toBe('image/jpeg');
    const io = buildCapabilitySnapshot(PROBE_DARWIN_ARM64_IMAGEIO);
    expect(buildFileSelection('s', 'globalDrag', [ok('h', 'IMG.HEIC', 'heic')], { snapshot: io }).menuKey).toBe('image/heic');
  });

  it('limits the number of usable files', () => {
    const selection = buildFileSelection('s', 'dropZone', [bad('x', '/x', 'NOT_A_FILE'), ok('a', 'a.png', 'png'), ok('b', 'b.png', 'png'), ok('c', 'c.png', 'png')], {
      maxFiles: 2,
    });
    expect(selection.files.map((f) => f.problem?.code ?? 'ok')).toEqual(['NOT_A_FILE', 'ok', 'ok', 'TOO_MANY_FILES']);
  });
});

describe('resolveSubmission', () => {
  const images = buildFileSelection('s', 'globalDrag', [ok('j1', 'a.jpg', 'jpeg'), ok('p1', 'b.png', 'png'), ok('w1', 'c.webp', 'webp')]);
  const pdfs = buildFileSelection('s', 'globalDrag', [ok('d1', 'one.pdf', 'pdf'), ok('d2', 'two.pdf', 'pdf')]);
  const mixed = buildFileSelection('s', 'dropZone', [ok('d1', 'one.pdf', 'pdf'), ok('j1', 'a.jpg', 'jpeg')]);

  it('runs one job per file for conversions, skipping files already in the target format', () => {
    expect(resolveSubmission(images, 'convert.jpeg', snapshot)).toEqual({
      kind: 'plan',
      actionId: 'convert.jpeg',
      fileIds: ['p1', 'w1'],
      skipped: [{ fileId: 'j1', warning: 'SKIPPED_SAME_FORMAT' }],
      needsEditor: false,
      merges: false,
      jobs: [['p1'], ['w1']],
    });
    expect(resolveSubmission(pdfs, 'convert.jpeg', snapshot)).toMatchObject({ kind: 'plan', jobs: [['d1'], ['d2']], needsEditor: false });
    expect(resolveSubmission(mixed, 'convert.png', snapshot)).toMatchObject({ kind: 'plan', fileIds: ['d1', 'j1'] });
  });

  it('plans no jobs, only skipped files, when every file already has the target format', () => {
    const jpgs = buildFileSelection('s', 'globalDrag', [ok('a', 'a.jpg', 'jpeg'), ok('b', 'b.jpg', 'jpeg')]);
    expect(resolveSubmission(jpgs, 'convert.jpeg', snapshot)).toEqual({
      kind: 'plan',
      actionId: 'convert.jpeg',
      fileIds: [],
      skipped: [
        { fileId: 'a', warning: 'SKIPPED_SAME_FORMAT' },
        { fileId: 'b', warning: 'SKIPPED_SAME_FORMAT' },
      ],
      needsEditor: false,
      merges: false,
      jobs: [],
    });
  });

  it('re-encodes an image whose name says another format into its real format (photo.jpg that is a PNG → PNG)', () => {
    const misnamed = buildFileSelection('s', 'globalDrag', [ok('m', 'photo.jpg', 'png', true)]);
    expect(resolveSubmission(misnamed, 'convert.png', snapshot)).toMatchObject({ kind: 'plan', fileIds: ['m'], skipped: [], jobs: [['m']] });
    // Correctly named: nothing to do.
    const named = buildFileSelection('s', 'globalDrag', [ok('p', 'photo.png', 'png')]);
    expect(resolveSubmission(named, 'convert.png', snapshot)).toMatchObject({ kind: 'plan', fileIds: [], skipped: [{ fileId: 'p' }] });
    // A PDF named .png is not rewritten as a PDF (only images are).
    const pdfNamedPng = buildFileSelection('s', 'globalDrag', [ok('d', 'scan.png', 'pdf', true)]);
    expect(resolveSubmission(pdfNamedPng, 'convert.pdf', snapshot)).toMatchObject({ kind: 'plan', fileIds: [], skipped: [{ fileId: 'd' }] });
    // canRewriteSameFormat is the shared rule (main's retry path uses it too).
    expect(canRewriteSameFormat(snapshot, 'convert.png', { kind: 'image', format: 'png', extensionMismatch: true })).toBe(true);
    expect(canRewriteSameFormat(snapshot, 'convert.png', { kind: 'image', format: 'png', extensionMismatch: false })).toBe(false);
    expect(canRewriteSameFormat(snapshot, 'convert.jpeg', { kind: 'image', format: 'png', extensionMismatch: true })).toBe(false);
  });

  it('merges images into one PDF job and asks for the page order when there are several', () => {
    expect(resolveSubmission(images, 'convert.pdf', snapshot)).toMatchObject({ kind: 'plan', merges: true, needsEditor: true, jobs: [['j1', 'p1', 'w1']] });
    const one = buildFileSelection('s', 'globalDrag', [ok('a', 'a.png', 'png')]);
    expect(resolveSubmission(one, 'convert.pdf', snapshot)).toMatchObject({ kind: 'plan', merges: true, needsEditor: false, jobs: [['a']] });
  });

  it('opens an editor for tools; single-file tools refuse several files', () => {
    const one = buildFileSelection('s', 'globalDrag', [ok('a', 'a.jpg', 'jpeg')]);
    expect(resolveSubmission(one, 'tool.crop', snapshot)).toMatchObject({ kind: 'plan', needsEditor: true, jobs: [['a']] });
    expect(resolveSubmission(images, 'tool.crop', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'TOO_MANY_FILES', retryable: false } });
    expect(resolveSubmission(images, 'tool.compress', snapshot)).toMatchObject({ kind: 'plan', needsEditor: true, jobs: [['j1'], ['p1'], ['w1']] });
  });

  it('follows the requested fileIds and their order', () => {
    expect(resolveSubmission(images, 'convert.pdf', snapshot, ['w1', 'j1', 'w1'])).toMatchObject({ kind: 'plan', fileIds: ['w1', 'j1'], jobs: [['w1', 'j1']] });
    expect(resolveSubmission(images, 'convert.pdf', snapshot, ['nope'])).toMatchObject({ kind: 'rejected', error: { code: 'INVALID_OPTIONS' } });
    const withProblem = buildFileSelection('s', 'globalDrag', [ok('a', 'a.png', 'png'), bad('x', '/locked.png', 'READ_PERMISSION_DENIED')]);
    expect(resolveSubmission(withProblem, 'convert.jpeg', snapshot, ['a', 'x'])).toMatchObject({ kind: 'rejected', error: { code: 'READ_PERMISSION_DENIED' } });
    expect(resolveSubmission(withProblem, 'convert.jpeg', snapshot)).toMatchObject({ kind: 'plan', fileIds: ['a'] });
  });

  it('never silently drops files the action cannot take', () => {
    expect(resolveSubmission(mixed, 'tool.crop', snapshot, ['d1'])).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT' } });
    expect(resolveSubmission(mixed, 'convert.webp', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT', detail: 'pdf' } });
    expect(resolveSubmission(images, 'convert.txt', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT' } });
  });

  it('reports disabled actions, empty selections, unusable selections and size limits', () => {
    expect(resolveSubmission(images, 'convert.heic', snapshot)).toMatchObject({
      kind: 'rejected',
      error: { code: 'ENGINE_UNAVAILABLE', message: 'No HEIC encoder in this build' },
    });
    expect(resolveSubmission(buildFileSelection('s', 'test', []), 'convert.png', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'INVALID_OPTIONS' } });
    const onlyBad = buildFileSelection('s', 'test', [bad('x', '/a', 'NOT_A_FILE'), bad('y', '/b', 'UNSUPPORTED_FORMAT')]);
    expect(resolveSubmission(onlyBad, 'convert.png', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'NOT_A_FILE' } });
    expect(resolveSubmission(images, 'convert.png', snapshot, undefined, { maxFiles: 2 })).toMatchObject({ kind: 'rejected', error: { code: 'TOO_MANY_FILES' } });
    expect(resolveSubmission(images, 'convert.gif', snapshot)).toMatchObject({ kind: 'rejected', error: { code: 'INVALID_OPTIONS' } });
    const heic = buildFileSelection('s', 'globalDrag', [ok('h', 'a.heic', 'heic')], { snapshot });
    expect(resolveSubmission(heic, 'convert.jpeg', snapshot, ['h'])).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT' } });
  });
});
