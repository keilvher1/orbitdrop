import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultSettingsFor, type HelperStatus, type JobSnapshot, type ModifierKey } from '@orbitdrop/contracts';
import { comboText, trayTooltip } from '../../src/main/support/keys';
import { HELPER_REASON_DISABLED_FOR_RUN, HELPER_REASON_NOT_FOUND, localizeHelperStatus } from '../../src/main/helper/status-text';
import { bindTranslate } from '../../src/main/i18n';
import type { JobRecordView, JobSpec } from '../../src/main/jobs/manager';
import { Notifier, isSkippedJob, needsAnotherFolder, noteworthyWarnings, type NotificationRequest } from '../../src/main/notifications';
import { buildTrayTemplate, type TrayActions, type TrayState } from '../../src/main/tray/menu';
import { clampRect, fitSize, placeCentered, resizeWithin } from '../../src/main/windows/placement';
import { WINDOW_SPECS } from '../../src/main/windows/specs';

const work = { x: 0, y: 25, width: 1440, height: 875 };

describe('window placement', () => {
  it('centers on the pointer and stays inside the work area (including negative displays)', () => {
    expect(placeCentered({ x: 700, y: 400 }, { width: 520, height: 640 }, work)).toEqual({ x: 440, y: 80, width: 520, height: 640 });
    // pointer at the tray icon (top right) → panel pinned to the top-right corner
    expect(placeCentered({ x: 1400, y: 10 }, { width: 220, height: 220 }, work)).toEqual({ x: 1212, y: 33, width: 220, height: 220 });
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    expect(placeCentered({ x: -1915, y: 1035 }, { width: 520, height: 640 }, left)).toEqual({ x: -1912, y: 392, width: 520, height: 640 });
  });

  it('shrinks windows that do not fit a tiny work area', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 300 };
    expect(fitSize({ width: 520, height: 640 }, tiny)).toEqual({ width: 384, height: 284 });
    expect(clampRect({ x: -50, y: 900, width: 520, height: 640 }, tiny)).toEqual({ x: 8, y: 8, width: 384, height: 284 });
  });

  it('resize requests keep the top edge and horizontal center, respect the minimum and the work area', () => {
    const current = { x: 440, y: 80, width: 520, height: 640 };
    expect(resizeWithin(current, { width: 560, height: 700 }, work, { width: 440, height: 400 })).toEqual({ x: 420, y: 80, width: 560, height: 700 });
    expect(resizeWithin(current, { width: 200, height: 120 }, work, { width: 440, height: 400 })).toEqual({ x: 480, y: 80, width: 440, height: 400 });
    expect(resizeWithin(current, { width: 4000, height: 4000 }, work, { width: 440, height: 400 })).toEqual({ x: 8, y: 33, width: 1424, height: 859 });
  });

  it('the welcome window is laid out within 440–560 DIP, takes focus and is a single window', () => {
    expect(WINDOW_SPECS.welcome.width).toBeGreaterThanOrEqual(440);
    expect(WINDOW_SPECS.welcome.width).toBeLessThanOrEqual(560);
    expect(WINDOW_SPECS.welcome.minWidth).toBeGreaterThanOrEqual(440);
    expect(WINDOW_SPECS.welcome).toMatchObject({ focus: true, single: true, alwaysOnTop: false, resizable: false });
  });

  it('the editor starts 520 DIP wide within the 440–560 range, the Drop Zone is small and always on top', () => {
    expect(WINDOW_SPECS.editor.width).toBe(520);
    expect(WINDOW_SPECS.editor.minWidth).toBe(440);
    // Windows shown without focus take the first click (macOS acceptFirstMouse); focused ones do not click through.
    expect(Object.entries(WINDOW_SPECS).filter(([, spec]) => spec.acceptFirstMouse).map(([kind]) => kind).sort()).toEqual(['dropzone', 'jobs']);
    // the panel is laid out at 520 DIP: users cannot resize the window around it (its content sizes it)
    expect(WINDOW_SPECS.editor.resizable).toBe(false);
    // the renderer sizes the height to its content; short views must be able to shrink the window
    expect(WINDOW_SPECS.editor.minHeight).toBeLessThanOrEqual(240);
    expect(WINDOW_SPECS.dropzone.alwaysOnTop).toBe(true);
    expect(WINDOW_SPECS.dropzone.focus).toBe(false);
  });
});

function actions(): TrayActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    openFile: vi.fn(),
    toggleDropZone: vi.fn(),
    revealOutput: vi.fn(),
    openJobs: vi.fn(),
    setGlobalDrag: vi.fn(),
    openPermissions: vi.fn(),
    restartHelper: vi.fn(),
    openSettings: vi.fn(),
    openAbout: vi.fn(),
    quit: vi.fn(),
    openGuide: vi.fn(),
    openWebsite: vi.fn(),
    reportProblem: vi.fn(),
    openLogFolder: vi.fn(),
  } as unknown as TrayActions & Record<string, ReturnType<typeof vi.fn>>;
}

const labels = (items: MenuItemConstructorOptions[]): string[] => items.filter((i) => i.type !== 'separator').map((i) => String(i.label));

function state(helper: HelperStatus, extra: Partial<TrayState> = {}): TrayState {
  return { helper, globalDragEnabled: true, dropZoneOpen: false, recent: [], platform: 'darwin', ...extra };
}

describe('tray menu', () => {
  it('has the product menu items in Korean by default', () => {
    const items = buildTrayTemplate(state({ state: 'running', helperVersion: '1', globalDrag: true }), actions(), bindTranslate(() => 'ko'));
    expect(labels(items)).toEqual(['파일 열기…', 'Drop Zone 열기', '최근 작업', '작업 창', '전역 드래그: 켜짐', '전역 드래그 사용', '설정…', '도움말', '정보', '종료']);
    const recent = items.find((i) => i.label === '최근 작업')!;
    expect((recent.submenu as MenuItemConstructorOptions[])[0]).toMatchObject({ label: '최근 작업 없음', enabled: false });
  });

  it('is localized to English and reflects state', () => {
    const a = actions();
    const items = buildTrayTemplate(
      state({ state: 'needsPermission', permissions: ['accessibility'] }, { dropZoneOpen: true, recent: [{ jobId: 'job_1', outputId: 'out_1', name: 'Page 001.jpg', moreCount: 2 }] }),
      a,
      bindTranslate(() => 'en'),
    );
    expect(labels(items)).toContain('Close Drop Zone');
    expect(labels(items)).toContain('Global drag: Permission needed');
    const recent = items.find((i) => i.label === 'Recent Jobs')!.submenu as MenuItemConstructorOptions[];
    expect(recent[0]!.label).toBe('Page 001.jpg and 2 more');
    (recent[0]!.click as () => void)();
    expect(a.revealOutput).toHaveBeenCalledWith('out_1');
    (items.find((i) => i.label === 'Open Permission Settings…')!.click as () => void)();
    expect(a.openPermissions).toHaveBeenCalled();
    const toggle = items.find((i) => i.type === 'checkbox')!;
    (toggle.click as (item: { checked: boolean }) => void)({ checked: false });
    expect(a.setGlobalDrag).toHaveBeenCalledWith(false);
  });

  it('offers a restart after crashes and explains the fallback when the helper is missing', () => {
    const t = bindTranslate(() => 'ko');
    const crashed = labels(buildTrayTemplate(state({ state: 'crashed', restarts: 5, reason: 'x' }), actions(), t));
    expect(crashed).toContain('전역 드래그 다시 시작');
    const missing = buildTrayTemplate(state({ state: 'unavailable', reason: 'x' }), actions(), t);
    expect(labels(missing)).toContain('파일 열기나 Drop Zone으로 계속 사용할 수 있습니다');
    expect(missing.find((i) => i.type === 'checkbox')!.enabled).toBe(false);
  });

  it('has a Help submenu: how to use, website, report a problem, log folder', () => {
    const a = actions();
    const items = buildTrayTemplate(state({ state: 'running', helperVersion: '1', globalDrag: true }), a, bindTranslate(() => 'ko'));
    const help = items.find((i) => i.label === '도움말')!.submenu as MenuItemConstructorOptions[];
    expect(labels(help)).toEqual(['사용법', 'OrbitDrop 웹사이트', '문제 신고', '로그 폴더 열기']);
    for (const [label, action] of [
      ['사용법', 'openGuide'],
      ['OrbitDrop 웹사이트', 'openWebsite'],
      ['문제 신고', 'reportProblem'],
      ['로그 폴더 열기', 'openLogFolder'],
    ] as const) {
      (help.find((i) => i.label === label)!.click as () => void)();
      expect(a[action]).toHaveBeenCalledTimes(1);
    }
    const english = buildTrayTemplate(state({ state: 'disabled' }), a, bindTranslate(() => 'en'));
    expect(labels(english.find((i) => i.label === 'Help')!.submenu as MenuItemConstructorOptions[])).toEqual(['How to Use', 'OrbitDrop Website', 'Report a Problem', 'Open Log Folder']);
  });

  it('the tooltip names the drag keys of this platform (Option on macOS, Ctrl/Alt on Windows)', () => {
    const ko = bindTranslate(() => 'ko');
    expect(trayTooltip(DEFAULT_SETTINGS, 'darwin', ko)).toBe('OrbitDrop — 파일을 끌면서 Shift: 변환 · Option+Shift: 도구');
    expect(trayTooltip(defaultSettingsFor('win32'), 'win32', bindTranslate(() => 'en'))).toBe('OrbitDrop — while dragging a file, Shift: Convert · Ctrl+Shift: Tools');
    const custom = { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, toolsModifiers: ['shift', 'alt', 'control'] as ModifierKey[] } };
    expect(comboText(custom.globalDrag.toolsModifiers, 'win32', ko)).toBe('Ctrl+Alt+Shift');
    // Global drag off: no keys to name.
    expect(trayTooltip({ ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, enabled: false } }, 'darwin', ko)).toBe('OrbitDrop');
  });

  it('escapes & in file names on Windows', () => {
    const items = buildTrayTemplate(state({ state: 'disabled' }, { platform: 'win32', recent: [{ jobId: 'j', outputId: 'o', name: 'R&D.png', moreCount: 0 }] }), actions(), bindTranslate(() => 'en'));
    const recent = items.find((i) => i.label === 'Recent Jobs')!.submenu as MenuItemConstructorOptions[];
    expect(recent[0]!.label).toBe('R&&D.png');
  });
});

describe('helper status for the renderer', () => {
  const ko = bindTranslate(() => 'ko');
  const en = bindTranslate(() => 'en');

  it('replaces developer reasons with localized text', () => {
    expect(localizeHelperStatus({ state: 'unavailable', reason: HELPER_REASON_NOT_FOUND }, ko)).toEqual({ state: 'unavailable', reason: '전역 드래그 도우미가 설치되어 있지 않습니다' });
    expect(localizeHelperStatus({ state: 'unavailable', reason: HELPER_REASON_DISABLED_FOR_RUN }, en)).toEqual({
      state: 'unavailable',
      reason: 'The global drag helper was not started for this run',
    });
    expect(localizeHelperStatus({ state: 'unavailable', reason: 'spawn EACCES something' }, en)).toEqual({ state: 'unavailable', reason: 'The global drag helper is not available' });
    expect(localizeHelperStatus({ state: 'crashed', restarts: 5, reason: 'exited (code 6, SIGABRT)' }, ko)).toEqual({
      state: 'crashed',
      restarts: 5,
      reason: '전역 드래그 도우미가 5번 비정상 종료되어 중지했습니다',
    });
    expect(localizeHelperStatus({ state: 'running', helperVersion: '1.0', globalDrag: false, reason: 'Input Monitoring not granted (CGPreflightListenEventAccess)' }, en)).toEqual({
      state: 'running',
      helperVersion: '1.0',
      globalDrag: false,
      reason: 'Global drag is not available on this computer right now',
    });
  });

  it('keeps statuses without developer text unchanged', () => {
    const running = { state: 'running', helperVersion: '1.0', globalDrag: true } as const;
    expect(localizeHelperStatus(running, ko)).toBe(running);
    expect(localizeHelperStatus({ state: 'running', helperVersion: '1.0', globalDrag: true, reason: 'x' }, ko)).toEqual(running);
    expect(localizeHelperStatus({ state: 'disabled' }, ko)).toEqual({ state: 'disabled' });
    expect(localizeHelperStatus({ state: 'needsPermission', permissions: ['accessibility'] }, ko)).toEqual({ state: 'needsPermission', permissions: ['accessibility'] });
  });
});

function view(snapshot: Partial<JobSnapshot>, origin: JobSpec['origin'] = { source: 'globalDrag', sessionId: 's1' }, batchId: string | null = null): JobRecordView {
  const full: JobSnapshot = {
    jobId: 'job_1',
    batchId,
    sessionId: origin.sessionId,
    actionId: 'convert.jpeg',
    inputName: 'Page 001.pdf',
    inputCount: 1,
    state: 'completed',
    progress: { kind: 'indeterminate' },
    createdAt: 0,
    startedAt: 0,
    finishedAt: 1,
    outputs: [{ outputId: 'out_1', name: 'Page 001.jpg', dirDisplay: 'Desktop', format: 'jpeg', bytes: 1 }],
    warnings: [],
    error: null,
    inputBytes: 1,
    ...snapshot,
  };
  return { jobId: full.jobId, batchId, spec: { actionId: full.actionId, inputs: [], options: {}, outputDir: null, origin }, snapshot: full };
}

describe('notifications', () => {
  function notifier(batch: JobRecordView[] = [], enabled = true) {
    const shown: NotificationRequest[] = [];
    const revealOutput = vi.fn();
    const openJobs = vi.fn();
    const n = new Notifier({ show: (r) => shown.push(r), enabled: () => enabled, locale: () => 'ko', t: bindTranslate(() => 'ko'), jobs: { batch: () => batch }, revealOutput, openJobs });
    return { n, shown, revealOutput, openJobs };
  }

  it('announces a finished drag job; clicking reveals the output', () => {
    const { n, shown, revealOutput } = notifier();
    n.onJobSettled(view({}));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('완료: JPG로 변환');
    expect(shown[0]!.body).toBe('Page 001.jpg');
    shown[0]!.onClick();
    expect(revealOutput).toHaveBeenCalledWith('out_1');
  });

  it('explains failures and ignores non-drag jobs, cancellations and disabled notifications', () => {
    const { n, shown, openJobs } = notifier();
    n.onJobSettled(view({ state: 'failed', outputs: [], error: { code: 'PDF_ENCRYPTED', message: 'x', retryable: false } }));
    expect(shown[0]!.body).toBe('Page 001.pdf: 암호로 보호된 PDF입니다');
    shown[0]!.onClick();
    expect(openJobs).toHaveBeenCalled();
    n.onJobSettled(view({}, { source: 'dropZone', sessionId: null }));
    n.onJobSettled(view({ state: 'cancelled', outputs: [] }));
    expect(shown).toHaveLength(1);
    const off = notifier([], false);
    off.n.onJobSettled(view({}));
    expect(off.shown).toHaveLength(0);
  });

  it('summarizes a batch once, when its last job finished', () => {
    const done = view({ jobId: 'a' }, undefined, 'b_1');
    const running = view({ jobId: 'b', state: 'running', outputs: [] }, undefined, 'b_1');
    const batch = [done, running];
    const { n, shown } = notifier(batch);
    n.onJobSettled(done);
    expect(shown).toHaveLength(0);
    batch[1] = view({ jobId: 'b', state: 'failed', outputs: [], error: { code: 'IMAGE_CORRUPT', message: 'x', retryable: false } }, undefined, 'b_1');
    n.onJobSettled(batch[1]);
    n.onJobSettled(batch[1]);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.body).toBe('1개 완료, 1개 실패');
  });
});

describe('notifications follow what really happened', () => {
  function notifier(batch: JobRecordView[] = []) {
    const shown: NotificationRequest[] = [];
    const revealOutput = vi.fn();
    const openJobs = vi.fn();
    const n = new Notifier({ show: (r) => shown.push(r), enabled: () => true, locale: () => 'ko', t: bindTranslate(() => 'ko'), jobs: { batch: () => batch }, revealOutput, openJobs });
    return { n, shown, revealOutput, openJobs };
  }
  const larger = { code: 'OUTPUT_LARGER_THAN_INPUT' as const, params: { inputBytes: 10, outputBytes: 12 } };
  const skippedWarning = { code: 'SKIPPED_SAME_FORMAT' as const };

  it('a compressed file that did not get smaller is not announced as plain "done"; clicking opens the jobs window', () => {
    const { n, shown, openJobs, revealOutput } = notifier();
    n.onJobSettled(view({ actionId: 'tool.compress', warnings: [larger], outputs: [{ outputId: 'o', name: 'photo Compressed.jpg', dirDisplay: 'Desktop', format: 'jpeg', bytes: 12 }] }));
    expect(shown[0]).toMatchObject({ title: '완료(확인 필요): 이미지 압축', body: 'photo Compressed.jpg — 원본보다 작아지지 않았습니다' });
    shown[0]!.onClick();
    expect(openJobs).toHaveBeenCalled();
    expect(revealOutput).not.toHaveBeenCalled();
    // Informational warnings (metadata dropped by default) keep the plain message.
    n.onJobSettled(view({ warnings: [{ code: 'METADATA_REMOVED', params: { kinds: 'exif' } }] }));
    expect(shown[1]!.title).toBe('완료: JPG로 변환');
  });

  it('a file skipped because it already had the target format is reported as skipped, not done', () => {
    const { n, shown } = notifier();
    n.onJobSettled(view({ actionId: 'convert.png', inputName: 'a.png', outputs: [], warnings: [skippedWarning] }));
    expect(shown[0]).toMatchObject({ title: '건너뜀: PNG로 변환', body: 'a.png: 이미 같은 형식입니다' });
  });

  it('batches count done, skipped, failed and "needs a look" separately', () => {
    const done = view({ jobId: 'a' }, undefined, 'b_1');
    const skipped = view({ jobId: 'b', outputs: [], warnings: [skippedWarning] }, undefined, 'b_1');
    const mixed = notifier([done, skipped]);
    mixed.n.onJobSettled(done);
    expect(mixed.shown[0]).toMatchObject({ title: '완료: JPG로 변환', body: '1개 완료, 1개 건너뜀(이미 같은 형식)' });

    const allSkipped = notifier([skipped, view({ jobId: 'c', outputs: [], warnings: [skippedWarning] }, undefined, 'b_1')]);
    allSkipped.n.onJobSettled(skipped);
    expect(allSkipped.shown[0]).toMatchObject({ title: '건너뜀: JPG로 변환', body: '2개 건너뜀(이미 같은 형식)' });

    const warned = view({ jobId: 'd', warnings: [larger] }, undefined, 'b_1');
    const withWarning = notifier([done, warned]);
    withWarning.n.onJobSettled(warned);
    expect(withWarning.shown[0]).toMatchObject({ title: '완료(확인 필요): JPG로 변환', body: '2개 완료, 1개 확인 필요' });
  });

  it('names DOCX by its inputs (contracts actionTitle)', () => {
    const { n, shown } = notifier();
    const image = view({ actionId: 'convert.docx', outputs: [{ outputId: 'o', name: 'scan.docx', dirDisplay: 'Desktop', format: 'docx', bytes: 5 }] });
    n.onJobSettled({ ...image, spec: { ...image.spec, actionId: 'convert.docx', inputs: [{ fileId: 'f', path: '/x/scan.png', displayName: 'scan.png', sourceDir: '/x', format: 'png', bytes: 1 }] } });
    expect(shown[0]!.title).toBe('완료: DOCX로 변환 (이미지 삽입, OCR 없음)');
  });

  it('helpers: noteworthy warnings, skipped jobs, failures that need another folder', () => {
    expect(noteworthyWarnings([{ code: 'METADATA_REMOVED' }, { code: 'DOCX_IMAGE_ONLY' }, larger]).map((w) => w.code)).toEqual(['OUTPUT_LARGER_THAN_INPUT']);
    expect(isSkippedJob({ state: 'completed', outputs: [], warnings: [skippedWarning] })).toBe(true);
    expect(isSkippedJob({ state: 'completed', outputs: [], warnings: [] })).toBe(false);
    const readOnly = view({ state: 'failed', outputs: [], error: { code: 'OUTPUT_DIR_NOT_WRITABLE', message: 'x', retryable: true } });
    expect(needsAnotherFolder(readOnly)).toBe(true);
    expect(needsAnotherFolder({ ...readOnly, spec: { ...readOnly.spec, origin: { source: 'dropZone', sessionId: null } } })).toBe(false);
    expect(needsAnotherFolder(view({ state: 'failed', outputs: [], error: { code: 'TIMEOUT', message: 'x', retryable: true } }))).toBe(false);
    expect(needsAnotherFolder(view({ state: 'failed', outputs: [], error: { code: 'DISK_FULL', message: 'x', retryable: true } }))).toBe(true);
  });
});
