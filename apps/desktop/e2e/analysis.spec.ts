/**
 * Claude analysis (opt-in, bring your own key) in the real app. In automation main replaces the OS
 * key store and the Anthropic API with a scripted stand-in (analysis/test-backend.ts): no Keychain /
 * DPAPI prompt, no network, and only a fake key in the real format. Covered: Settings › Claude 분석
 * (format check in the page, save, "연결 확인", delete with an in-window confirmation, no encryption),
 * the key never held by the page or written as typed to any file, and the wheels offering
 * "Claude 분석" exactly while it is enabled with a saved key.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { OrbitApi, WheelMenu } from '@orbitdrop/contracts';
import { hooks, launchApp, makeJpeg, makePdf, windowOf, type Launched } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

/** Fake, in the real format; valid nowhere. */
const KEY = `sk-ant-api03-${'E2e'.repeat(28)}e2eK`;
const PIECE = 'E2eE2eE2eE2e';

test.describe.configure({ mode: 'serial' });

let launched: Launched;
let settings: Page;
let pdf: string;
let jpg: string;

test.beforeAll(async () => {
  launched = await launchApp();
  pdf = await makePdf(launched.work, 'report.pdf');
  jpg = await makeJpeg(launched.work, 'photo.jpg', 400, 300);
  await hooks(launched.app).openWindow('settings');
  settings = await windowOf(launched.app, 'settings');
  await settings.getByRole('tab', { name: 'Claude 분석' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

/**
 * Every regular file in the app data folder — OrbitDrop's own (settings, history, logs, the key file) and
 * Chromium's (storage, caches) — as raw bytes. Symbolic links and sockets (Chromium's Singleton*) are skipped.
 */
async function dataFiles(): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (info === null) continue; // gone meanwhile
      if (info.isDirectory()) await walk(path, `${prefix}${name}/`);
      else if (info.isFile() && info.size < 16 * 1024 * 1024) out[`${prefix}${name}`] = await readFile(path).catch(() => Buffer.alloc(0));
    }
  };
  await walk(launched.userData, '');
  return out;
}

/** Files of the app data folder that hold the key (as typed, or a distinctive piece of it). */
async function filesWithKey(): Promise<string[]> {
  return Object.entries(await dataFiles())
    .filter(([, bytes]) => bytes.includes(KEY) || bytes.includes(PIECE) || bytes.includes(Buffer.from(PIECE, 'utf16le')))
    .map(([name]) => name);
}

/** The menu main builds for a fresh selection of `paths` (what the picker and the Drop Zone show). */
async function menuLabels(paths: string[], mode: 'convert' | 'tools'): Promise<string[]> {
  const selection = await hooks(launched.app).registerPaths(paths);
  const menu = await settings.evaluate(([id, m]) => window.orbit.getMenu(id, m), [selection.selectionId, mode] as const);
  return (menu as WheelMenu).sectors.map((sector) => sector.label);
}

test('off by default: it explains what is sent and refuses a malformed key in the page', async () => {
  await expect(settings.getByRole('checkbox', { name: 'Claude 분석 사용' })).not.toBeChecked();
  await expect(settings.getByText('키 없음')).toBeVisible();
  const privacy = settings.getByRole('region', { name: '보내는 내용과 비용' });
  await expect(privacy).toContainText('Anthropic API로 보내지고');
  await expect(privacy).toContainText('긴 변 1568px 이하로 줄인 사본');
  await expect(privacy).toContainText('이 키의 Anthropic 계정에 청구됩니다');
  await expect(privacy).toContainText('파일을 놓기 전에는 아무것도 보내지 않습니다');
  await expect(settings.getByText(/모델: Claude Opus 5\.5/)).toBeVisible();

  const field = settings.getByLabel('Anthropic API 키');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('not-a-key');
  await settings.getByRole('button', { name: '저장' }).click();
  await expect(settings.getByText('sk-ant-로 시작하는 Anthropic API 키 전체를 붙여 넣으세요.')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(Object.keys(await dataFiles())).not.toContain('claude-api-key.json');
  // Without analysis the wheels are exactly the reference menus.
  expect(await menuLabels([pdf], 'tools')).toEqual([]);
  expect(await menuLabels([jpg], 'tools')).toEqual(['압축', '메타데이터', '편집', '주석', '배경 추가', '자르기', '가리기']);
});

test('saving keeps only "저장됨 · …e2eK" in the page; the key is stored encrypted, nowhere as typed', async () => {
  const field = settings.getByLabel('Anthropic API 키');
  await field.fill(`  ${KEY}  `);
  await field.press('Enter');
  await expect(settings.getByText('저장됨 · …e2eK')).toBeVisible();
  await expect(settings.getByText('키를 암호화해 저장했습니다.')).toBeVisible();
  await expect(field).toHaveValue('');
  expect(await settings.content()).not.toContain(PIECE);
  expect(await settings.evaluate(() => window.orbit.getAnalysisStatus())).toEqual({ enabled: false, hasKey: true, keyHint: '…e2eK', encryptionAvailable: true, available: false });

  const files = await dataFiles();
  expect(Object.keys(files)).toContain('claude-api-key.json');
  expect(JSON.parse(files['claude-api-key.json']!.toString('utf8'))).toMatchObject({ format: 'orbitdrop-claude-api-key', version: 1, hint: 'e2eK' });
  expect(Object.keys(files)).toContain('logs/main.log');
  // Not in settings.json, history, the log, nor anywhere Chromium keeps page data.
  expect(await filesWithKey()).toEqual([]);
  if (process.platform !== 'win32') expect((await stat(join(launched.userData, 'claude-api-key.json'))).mode & 0o777).toBe(0o600);
});

test('"연결 확인" asks main (scripted API): connected, then a refused key', async () => {
  const h = hooks(launched.app);
  await h.scriptAnalysis({ verify: 'ok' });
  const check = settings.getByRole('button', { name: '연결 확인' });
  await check.click();
  await expect(settings.getByText('연결됨: Anthropic이 이 키를 받아들였습니다.')).toBeVisible();
  await h.scriptAnalysis({ verify: 'ANALYSIS_AUTH_FAILED' });
  await check.click();
  await expect(settings.getByText(/Anthropic이 API 키를 거부했습니다/)).toBeVisible();
  expect((await h.scriptAnalysis({ verify: 'ok' })).verifyCalls).toBe(2);
});

test('the wheels offer "Claude 분석" exactly while it is enabled with a saved key', async () => {
  const h = hooks(launched.app);
  // A key alone does not offer it: submission is refused, the menus are unchanged.
  expect(await h.submit([pdf], 'tool.analyze')).toMatchObject({ kind: 'rejected', error: { code: 'ANALYSIS_NOT_CONFIGURED' } });
  expect(await menuLabels([pdf], 'tools')).toEqual([]);

  // A controlled checkbox: it shows the setting once main saved it.
  const enable = settings.getByRole('checkbox', { name: 'Claude 분석 사용' });
  await enable.click();
  await expect(enable).toBeChecked();
  await expect(settings.getByText('휠의 도구 메뉴에 ‘Claude 분석’이 있습니다. PDF는 도구 메뉴에 이 항목만 나옵니다.')).toBeVisible();
  expect(((await h.updateSettings({})) as { analysis: unknown }).analysis).toEqual({ enabled: true, instruction: '' });
  expect(await menuLabels([pdf], 'tools')).toEqual(['Claude 분석']);
  expect(await menuLabels([pdf, jpg], 'tools')).toEqual(['Claude 분석']);
  expect(await menuLabels([jpg], 'tools')).toEqual(['압축', '메타데이터', '편집', '주석', '배경 추가', '자르기', '가리기', 'Claude 분석']);
  expect(await menuLabels([pdf], 'convert')).toEqual(['DOCX', 'JPG', 'PNG', 'TXT']);

  // The picker opened on the tools wheel of a PDF shows it (the native helper gets the same menus).
  await h.openPicker([pdf], 'tools');
  const picker = await windowOf(launched.app, 'picker');
  await expect(picker.getByRole('menu', { name: '도구 메뉴' })).toBeVisible();
  await expect(picker.getByRole('menuitem', { name: 'Claude 분석' })).toBeVisible();
  await picker.evaluate(() => window.orbit.closeWindow());
});

test('the standing request is a setting (saved after typing), never part of the key file', async () => {
  const box = settings.getByLabel('추가 요청 (선택)');
  await box.fill('표의 합계가 맞는지 확인해 줘');
  await box.blur();
  await expect.poll(async () => ((await hooks(launched.app).updateSettings({})) as { analysis: { instruction: string } }).analysis.instruction).toBe('표의 합계가 맞는지 확인해 줘');
  const files = await dataFiles();
  expect(files['settings.json']!.toString('utf8')).toContain('표의 합계가 맞는지 확인해 줘');
  expect(files['claude-api-key.json']!.toString('utf8')).not.toContain('표의 합계');
});

test('deleting the key asks in the window, removes the file and the sector', async () => {
  await settings.getByRole('button', { name: '키 삭제…' }).click();
  const dialog = settings.getByRole('alertdialog', { name: 'API 키를 삭제할까요?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '삭제' }).click();
  await expect(settings.getByText('키를 삭제했습니다.')).toBeVisible();
  await expect(settings.getByText('키 없음')).toBeVisible();
  expect(Object.keys(await dataFiles())).not.toContain('claude-api-key.json');
  expect(await menuLabels([pdf], 'tools')).toEqual([]);
  expect(await hooks(launched.app).submit([pdf], 'tool.analyze')).toMatchObject({ kind: 'rejected', error: { code: 'ANALYSIS_NOT_CONFIGURED' } });
  expect(await filesWithKey()).toEqual([]);
});

test('when the OS cannot encrypt, the page says so and main refuses to save', async () => {
  const h = hooks(launched.app);
  await h.scriptAnalysis({ encryption: false });
  // The status is read again when the tab is shown.
  await settings.getByRole('tab', { name: '정보' }).click();
  await settings.getByRole('tab', { name: 'Claude 분석' }).click();
  await expect(settings.getByText(/키를 암호화할 수 없어 키를 저장할 수 없습니다/)).toBeVisible();
  const refused = await settings.evaluate((key) => window.orbit.saveAnalysisKey(key).then(() => 'saved', (error: Error) => error.message), KEY);
  expect(refused).toMatch(/^ANALYSIS_KEY_STORAGE_UNAVAILABLE: /);
  expect(refused).not.toContain(PIECE);
  expect(Object.keys(await dataFiles())).not.toContain('claude-api-key.json');
  await h.scriptAnalysis({ encryption: true });
});
