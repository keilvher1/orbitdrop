/**
 * Global-drag pipeline in a real Electron run, with a protocol-faithful stub in
 * place of the native helper (e2e/fixtures/stub-helper.mjs): main spawns it,
 * configures it, receives its drops (each sent twice) and runs them through
 * the same pipeline as every other input — one job per drag session, a
 * notification for drag-started jobs, an editor window for tools. The native
 * wheel itself is not exercised here (see native/* tests and the support matrix).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_SETTINGS,
  DESIGN_TOKENS,
  HelperConfigureSchema,
  wheelTokens,
  type EditorContext,
  type HelperConfigureMessage,
  type OrbitApi,
} from '@orbitdrop/contracts';
import { appDir, hooks, imageMeta, launchApp, makeJpeg, makePdf, windowOf } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

test.skip(process.platform === 'win32', 'the stub helper is a shebang script');

test('helper drops: configure round-trip, one job per session, notification, editor for tools, shutdown on quit', async () => {
  const work = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-files-'));
  const logs = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-helper-'));
  const stubLog = join(logs, 'stub.log');
  try {
    const pdf = await makePdf(work);
    const photo = await makeJpeg(work, 'photo.jpg', 800, 600);
    const drops = [
      { sessionId: 'sess_convert', actionId: 'convert.png', mode: 'convert', files: [pdf] },
      { sessionId: 'sess_crop', actionId: 'tool.crop', mode: 'tools', files: [photo] },
    ];
    const launched = await launchApp({
      work,
      env: {
        ORBITDROP_E2E_HELPER: '1',
        ORBITDROP_HELPER_PATH: join(appDir, 'e2e', 'fixtures', 'stub-helper.mjs'),
        STUB_LOG: stubLog,
        STUB_DROPS: JSON.stringify(drops),
      },
    });
    const h = hooks(launched.app);
    try {
      await expect.poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { helperStatus(): { state: string } } }).__orbitdrop.helperStatus())).state).toBe('running');

      // The conversion drop: exactly one job for the session although the drop was sent twice.
      await expect
        .poll(async () => (await h.jobs()).filter((j) => j.sessionId === 'sess_convert').map((j) => j.state), { timeout: 60_000 })
        .toEqual(['completed']);
      const job = (await h.jobs()).find((j) => j.sessionId === 'sess_convert')!;
      expect(job.outputs[0]?.name).toBe('Page 001.png');
      expect(await imageMeta(join(work, 'Page 001.png'))).toEqual({ format: 'png', width: 2550, height: 3300 });

      // The tool drop opened an editor (no job until the user applies).
      const editor = await windowOf(launched.app, 'editor');
      const context = await editor.evaluate(async () => {
        const windowContext = await window.orbit.getWindowContext();
        if (windowContext.kind !== 'editor') throw new Error('not an editor');
        return window.orbit.getEditor(windowContext.editorId);
      });
      expect((context as EditorContext).actionId).toBe('tool.crop');
      expect((context as EditorContext).files.map((f) => f.name)).toEqual(['photo.jpg']);
      expect((await h.jobs()).filter((j) => j.sessionId === 'sess_crop')).toEqual([]);

      // Drag-started jobs notify (recorded instead of shown in automation).
      await expect.poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { notifications(): unknown[] } }).__orbitdrop.notifications()))).toEqual([
        { title: '완료: PNG로 변환', body: 'Page 001.png' },
      ]);

      // What main sent to the helper is valid protocol.
      const received = (await readFile(stubLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });
      const configure = received.find((m) => m.type === 'configure');
      const parsed = HelperConfigureSchema.safeParse(configure);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.locale).toBe('ko');
        expect(parsed.data.strings.dropHint).toBe('여기에 놓기');
        expect(parsed.data.strings).toMatchObject({
          unsupportedFolder: '폴더는 처리할 수 없음',
          unsupportedNonFile: '파일이 아님',
          unsupportedVirtual: '먼저 파일로 저장하세요',
          unsupportedCloud: '먼저 내려받으세요',
        });
        expect(parsed.data.menus.find((m) => m.key === 'pdf')!.convert.map((s) => s.label)).toEqual(['DOCX', 'JPG', 'PNG', 'TXT']);
        expect(parsed.data.extensions['.pdf']).toBe('pdf');
      }
      expect(received.some((m) => m.type === 'queryPermissions')).toBe(process.platform === 'darwin');

      // A settings change re-configures the helper.
      await h.updateSettings({ locale: 'en' });
      await expect
        .poll(async () =>
          (await readFile(stubLog, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { type: string; locale?: string })
            .filter((m) => m.type === 'configure')
            .map((m) => m.locale),
        )
        .toEqual(['ko', 'en']);

      // So does the wheel opacity (Settings › 드래그): the wheel's background colours arrive scaled. In high
      // contrast the wheel stays opaque, the message does not change and nothing new is sent.
      const configures = async () =>
        (await readFile(stubLog, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as HelperConfigureMessage)
          .filter((m) => m.type === 'configure');
      const current = (await configures()).at(-1)!;
      const theme = current.highContrast ? 'highContrast' : current.tokens.sectorText === DESIGN_TOKENS.color.dark.sectorText ? 'dark' : 'light';
      expect(current.tokens).toEqual(wheelTokens(theme, current.reduceMotion, DEFAULT_SETTINGS.globalDrag.wheelOpacity));
      if (!current.highContrast) {
        await h.updateSettings({ globalDrag: { wheelOpacity: 55 } });
        await expect.poll(async () => (await configures()).length).toBe(3);
        const translucent = (await configures()).at(-1)!;
        expect(HelperConfigureSchema.safeParse(translucent).success).toBe(true);
        expect(translucent.tokens).toEqual(wheelTokens(theme, translucent.reduceMotion, 55));
      }
    } finally {
      await launched.close();
    }
    // Quitting sent `shutdown` to the helper.
    expect((await readFile(stubLog, 'utf8')).includes('"type":"shutdown"')).toBe(true);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});
