// @vitest-environment jsdom
import './setup';
import { DESIGN_TOKENS, type EstimateRequest, type PreviewOutcome, type PreviewRequestIpc, type SelectedFile } from '@orbitdrop/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../src/renderer/src/i18n/catalog';
import { AnnotateEditor } from '../../src/renderer/src/views/editor/annotate/AnnotateEditor';
import { CompressEditor } from '../../src/renderer/src/views/editor/compress/CompressEditor';
import { BUSY_DELAY_MS, BUSY_HOLD_MS, SETTLE_MS, Stage } from '../../src/renderer/src/views/editor/editorKit';
import { PdfOrderEditor } from '../../src/renderer/src/views/editor/pdf/PdfOrderEditor';
import { RedactEditor } from '../../src/renderer/src/views/editor/redact/RedactEditor';
import { ESTIMATE_DEBOUNCE_MS } from '../../src/renderer/src/views/editor/compress/useBatchEstimates';
import { PREVIEW_DEBOUNCE_MS } from '../../src/renderer/src/views/editor/usePreview';
import { createFakeOrbit, deferred, renderWithEnv, sampleEditorContext } from './helpers';

/**
 * Accessibility regressions found by the renderer audit (headless Chromium):
 * focus that fell to <body> when the focused control turned itself off or
 * went away, chatty live regions (Compress estimates, "Rendering preview…"),
 * forced-colours focus/progress indicators and non-text/text contrast.
 */

const t = createTranslator('ko');

afterEach(() => {
  vi.useRealTimers();
});

/** Focused, still a real (not disabled) button, announced as unavailable. */
function expectFocusedUnavailable(button: HTMLElement) {
  expect(document.activeElement).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
}

// ------------------------------------------------------------------ focus never falls to <body>

describe('Annotate: toolbar buttons that turn themselves off keep or move focus', () => {
  function annotate() {
    const orbit = createFakeOrbit();
    const ctx = sampleEditorContext('tool.annotate', { defaults: { shapes: [], outputFormat: 'input' } });
    renderWithEnv(<AnnotateEditor ctx={ctx} title="주석 달기" />, { orbit });
    return { orbit, user: userEvent.setup(), surface: screen.getByRole('application', { name: '주석 캔버스' }) };
  }

  it('Delete selected annotation: the shape goes, focus moves to the drawing surface', async () => {
    const { user, surface } = annotate();
    const trash = screen.getByRole('button', { name: t('annotate.delete') });
    expect(trash.getAttribute('aria-disabled')).toBe('true'); // nothing selected yet, but focusable
    await user.click(screen.getByRole('button', { name: t('annotate.add.rect') }));
    expect(trash.hasAttribute('aria-disabled')).toBe(false);
    trash.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
    expect(trash.getAttribute('aria-disabled')).toBe('true');
    // Pressing the unavailable button again does nothing (and leaves focus alone).
    trash.focus();
    await user.keyboard('{Enter}');
    expectFocusedUnavailable(trash);
  });

  it('Undo at the start and Redo at the end of the history keep focus; ⌘Z stays a no-op at the start', async () => {
    const { user } = annotate();
    await user.click(screen.getByRole('button', { name: t('annotate.add.arrow') }));
    const undoButton = screen.getByRole('button', { name: t('annotate.undo') });
    const redoButton = screen.getByRole('button', { name: t('annotate.redo') });
    undoButton.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
    expectFocusedUnavailable(undoButton);
    await user.keyboard('{Enter}'); // nothing left to undo
    await user.keyboard('{Meta>}z{/Meta}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
    expect(redoButton.hasAttribute('aria-disabled')).toBe(false);

    redoButton.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expectFocusedUnavailable(redoButton);
    await user.keyboard('{Enter}'); // nothing left to redo
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(undoButton.hasAttribute('aria-disabled')).toBe(false);
  });

  it('a press on an unavailable button does not take focus from the open text box (no confirm-then-undo)', async () => {
    const { user } = annotate();
    await user.click(screen.getByRole('button', { name: t('annotate.add.text') }));
    const box = await screen.findByRole('textbox', { name: t('annotate.textLabel') });
    (box as HTMLTextAreaElement).value = '초안';
    fireEvent.input(box);
    await user.click(screen.getByRole('button', { name: t('annotate.undo') }));
    await user.click(screen.getByRole('button', { name: t('annotate.delete') }));
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('주석 0개')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('annotate.undo') }).hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('Redact: deleting regions never drops focus', () => {
  function redact() {
    const orbit = createFakeOrbit();
    const ctx = sampleEditorContext('tool.redact', { defaults: { regions: [], outputFormat: 'input' } });
    renderWithEnv(<RedactEditor ctx={ctx} title="정보 가리기" />, { orbit });
    return { orbit, user: userEvent.setup(), surface: screen.getByRole('application', { name: '가리기 캔버스' }) };
  }
  const item = (n: number) => screen.getByRole('button', { name: new RegExp(`^${t('redact.region', { n })}`) });

  it('Delete on a list item focuses the next item, else the previous one, else the drawing surface', async () => {
    const { user, surface } = redact();
    const add = screen.getByRole('button', { name: t('redact.add') });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    const second = item(2);
    const third = item(3);

    item(1).focus();
    await user.keyboard('{Delete}');
    expect(screen.getByText('영역 2개')).toBeTruthy();
    expect(document.activeElement).toBe(second); // the next item, now labelled "영역 1"
    expect(second.textContent).toContain(t('redact.region', { n: 1 }));

    third.focus(); // now the last item ("영역 2")
    await user.keyboard('{Backspace}');
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expect(document.activeElement).toBe(second); // the previous item

    await user.keyboard('{Delete}');
    expect(screen.getByText('영역 0개')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
  });

  it('the delete button keeps focus once nothing is selected; deleting the last region moves focus to the surface', async () => {
    const { user, surface } = redact();
    const add = screen.getByRole('button', { name: t('redact.add') });
    await user.click(add);
    await user.click(add); // region 2 is selected
    const trash = screen.getByRole('button', { name: t('redact.delete') });
    trash.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expectFocusedUnavailable(trash);
    await user.keyboard('{Enter}'); // nothing selected: nothing happens
    expect(screen.getByText('영역 1개')).toBeTruthy();

    await user.click(item(1)); // select the remaining region
    trash.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('영역 0개')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('redact.delete') })).toBeNull();
    expect(document.activeElement).toBe(surface);
  });
});

describe('PDF order: a move button that reaches the end keeps focus', () => {
  const files: SelectedFile[] = [
    { fileId: 'f1', name: 'a.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 1000 },
    { fileId: 'f2', name: 'b.png', ext: '.png', format: 'png', kind: 'image', bytes: 2000 },
    { fileId: 'f3', name: 'c.webp', ext: '.webp', format: 'webp', kind: 'image', bytes: 3000 },
  ];
  const defaults = { flattenBackground: '#FFFFFF', keepMetadata: false, pageSize: 'image', marginPt: 0, pageSeparator: 'marker', order: ['f1', 'f2', 'f3'] };
  const names = () => screen.getAllByRole('listitem').map((row) => row.querySelector('.pdf-name')?.textContent);

  it.each([
    ['down', 'pdf.moveDown', ['a.jpg', 'c.webp', 'b.png'], 3],
    ['up', 'pdf.moveUp', ['b.png', 'a.jpg', 'c.webp'], 1],
  ] as const)('Move %s on the row that becomes last/first', async (_dir, key, after, position) => {
    renderWithEnv(<PdfOrderEditor ctx={sampleEditorContext('convert.pdf', { files, defaults })} title="PDF로 변환" />);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: t(key, { name: 'b.png' }) });
    button.focus();
    await user.keyboard('{Enter}');
    expect(names()).toEqual(after);
    expect(screen.getByText(t('pdf.moved', { name: 'b.png', position }))).toBeTruthy();
    expectFocusedUnavailable(button);
    await user.keyboard('{Enter}'); // already at the end: nothing moves
    expect(names()).toEqual(after);
  });
});

// ------------------------------------------------------------------ live regions

/** Every change of a live region to a non-empty text, in order (what a screen reader would be asked to speak). */
function recordAnnouncements(region: Element): string[] {
  const spoken: string[] = [];
  let last = region.textContent ?? '';
  const observer = new MutationObserver(() => {
    const text = region.textContent ?? '';
    if (text !== '' && text !== last) spoken.push(text);
    last = text;
  });
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  return spoken;
}

/**
 * Let `ms` of fake time pass, in 10 ms slices: act() holds React's work until it ends, so React renders (and
 * starts or clears timers in effects) between slices much as it would in real time.
 */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 10) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(10, left));
    });
  }
}

const COMPRESS_DEFAULTS = { format: 'input', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false };

describe('Compress: one settled estimate announcement instead of one per slider step', () => {
  it('the size boxes are not live; Δ has a spoken label; the summary is spoken once the estimate settled', async () => {
    vi.useFakeTimers();
    const orbit = createFakeOrbit();
    // Each request gets a different estimate (the input is 1,234,567 bytes).
    orbit.requestPreview.mockImplementation(async (request: PreviewRequestIpc) => ({
      ok: true as const,
      seq: request.seq,
      url: `data:image/png;base64,${request.seq}`,
      width: 400,
      height: 300,
      estimatedBytes: 600_000 + 10_000 * (request.seq - 1),
    }));
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });

    const sizes = document.querySelector('.compress-sizes') as HTMLElement;
    expect(sizes.hasAttribute('aria-live')).toBe(false);
    expect(sizes.querySelector('[aria-live]')).toBeNull();
    const changeLabel = within(sizes).getByText(t('compress.change'));
    expect(changeLabel.className).toBe('visually-hidden');
    expect(within(sizes).getByText('Δ').getAttribute('aria-hidden')).toBe('true');

    // A persistent, initially empty polite region right after the boxes.
    const region = sizes.nextElementSibling as HTMLElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toBe('');
    const spoken = recordAnnouncements(region);

    await advance(PREVIEW_DEBOUNCE_MS);
    expect(screen.getByText('600 KB')).toBeTruthy();
    await advance(SETTLE_MS - 10);
    expect(spoken).toEqual([]); // not settled yet
    await advance(10);
    expect(spoken).toEqual([t('compress.announce', { size: '600 KB', change: '−51%' })]);

    // Ten Quality steps, 250 ms apart: each answer arrives between steps, nothing is spoken meanwhile.
    const slider = screen.getByRole('slider', { name: t('compress.quality') });
    for (let i = 1; i <= 10; i += 1) {
      fireEvent.change(slider, { target: { value: String(75 + i) } });
      await advance(250);
    }
    expect(region.textContent).toBe('');
    expect(spoken).toHaveLength(1);
    await advance(SETTLE_MS);
    expect(orbit.requestPreview).toHaveBeenCalledTimes(11);
    // 600 KB + 10 × 10 KB = 700 KB (−43 %): one summary for the whole run of steps.
    expect(spoken).toEqual([t('compress.announce', { size: '600 KB', change: '−51%' }), t('compress.announce', { size: '700 KB', change: '−43%' })]);
  });

  it('a not-smaller estimate: the warning is part of the settled summary, its notice is not a live region', async () => {
    vi.useFakeTimers();
    const orbit = createFakeOrbit();
    // The input is 1,234,567 bytes: 1.3 MB is not smaller.
    orbit.requestPreview.mockImplementation(async (request: PreviewRequestIpc) => ({ ok: true as const, seq: request.seq, url: `data:image/png;base64,${request.seq}`, width: 400, height: 300, estimatedBytes: 1_300_000 }));
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    const region = (document.querySelector('.compress-sizes') as HTMLElement).nextElementSibling as HTMLElement;
    const spoken = recordAnnouncements(region);
    await advance(PREVIEW_DEBOUNCE_MS);
    const notice = screen.getByText(t('compress.notSmaller')).closest('.notice') as HTMLElement;
    expect(notice.hasAttribute('role')).toBe(false); // would come and go (and be read) on every step near the threshold
    expect(spoken).toEqual([]);
    await advance(SETTLE_MS);
    expect(spoken).toEqual([`${t('compress.announce', { size: '1.3 MB', change: '+5%' })} ${t('compress.notSmaller')}`]);
  });

  it('nothing is spoken while a newer preview is still pending', async () => {
    vi.useFakeTimers();
    const orbit = createFakeOrbit();
    const answers: { request: PreviewRequestIpc; d: ReturnType<typeof deferred<PreviewOutcome>> }[] = [];
    orbit.requestPreview.mockImplementation((request: PreviewRequestIpc) => {
      const d = deferred<PreviewOutcome>();
      answers.push({ request, d });
      return d.promise;
    });
    const ok = (request: PreviewRequestIpc, estimatedBytes: number): PreviewOutcome => ({ ok: true, seq: request.seq, url: `data:image/png;base64,${request.seq}`, width: 400, height: 300, estimatedBytes });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    const region = (document.querySelector('.compress-sizes') as HTMLElement).nextElementSibling as HTMLElement;
    const spoken = recordAnnouncements(region);

    await advance(PREVIEW_DEBOUNCE_MS);
    fireEvent.change(screen.getByRole('slider', { name: t('compress.quality') }), { target: { value: '50' } });
    await advance(PREVIEW_DEBOUNCE_MS);
    expect(answers).toHaveLength(2);
    await act(async () => answers[0]!.d.resolve(ok(answers[0]!.request, 600_000))); // the older answer: shown, but not current
    await advance(2000);
    expect(spoken).toEqual([]);
    await act(async () => answers[1]!.d.resolve(ok(answers[1]!.request, 500_000)));
    await advance(SETTLE_MS);
    expect(spoken).toEqual([t('compress.announce', { size: '500 KB', change: '−59%' })]);
  });

  it('several files: the total is spoken once every file has its estimate, again only after the next settle', async () => {
    vi.useFakeTimers();
    const files: SelectedFile[] = [1_000_000, 2_000_000, 500_000].map((bytes, i) => ({ fileId: `f${i + 1}`, name: `IMG_${i + 1}.jpg`, ext: '.jpg', format: 'jpeg', kind: 'image', bytes }));
    let scale = 1;
    const sizes: Record<string, number> = { f1: 600_000, f2: 900_000, f3: 250_000 };
    const orbit = createFakeOrbit({
      requestEstimate: async (request: EstimateRequest) => ({ ok: true as const, seq: request.seq, fileId: request.fileId, estimatedBytes: Math.round(sizes[request.fileId]! * scale) }),
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { files, defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    const boxes = document.querySelector('.compress-sizes') as HTMLElement;
    expect(boxes.hasAttribute('aria-live')).toBe(false);
    expect(within(boxes).getByText(t('compress.change')).className).toBe('visually-hidden');
    const region = boxes.nextElementSibling as HTMLElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    const spoken = recordAnnouncements(region);

    await advance(ESTIMATE_DEBOUNCE_MS);
    expect(screen.getByText('1.8 MB')).toBeTruthy();
    expect(spoken).toEqual([]);
    await advance(SETTLE_MS);
    expect(spoken).toEqual([t('compress.announceBatch', { size: '1.8 MB', change: '−50%' })]);

    scale = 0.5;
    fireEvent.change(screen.getByRole('slider', { name: t('compress.quality') }), { target: { value: '40' } });
    expect(region.textContent).toBe(''); // pending again
    await advance(ESTIMATE_DEBOUNCE_MS + SETTLE_MS - 10);
    expect(spoken).toHaveLength(1);
    await advance(10);
    expect(spoken.at(-1)).toBe(t('compress.announceBatch', { size: '875 KB', change: '−75%' }));
  });

  it('several files, one not smaller: the warning is shown at once but spoken only with the settled total', async () => {
    vi.useFakeTimers();
    const files: SelectedFile[] = [1_000_000, 2_000_000].map((bytes, i) => ({ fileId: `f${i + 1}`, name: `IMG_${i + 1}.jpg`, ext: '.jpg', format: 'jpeg', kind: 'image', bytes }));
    const sizes: Record<string, number> = { f1: 1_100_000, f2: 900_000 };
    const orbit = createFakeOrbit({
      requestEstimate: async (request: EstimateRequest) => ({ ok: true as const, seq: request.seq, fileId: request.fileId, estimatedBytes: sizes[request.fileId]! }),
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { files, defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    const region = (document.querySelector('.compress-sizes') as HTMLElement).nextElementSibling as HTMLElement;
    const spoken = recordAnnouncements(region);
    await advance(ESTIMATE_DEBOUNCE_MS);
    const warning = t.plural('compress.someNotSmaller', 1);
    const notice = screen.getByText(warning).closest('.notice') as HTMLElement;
    expect(notice.hasAttribute('role')).toBe(false);
    expect(spoken).toEqual([]);
    await advance(SETTLE_MS);
    expect(spoken).toEqual([`${t('compress.announceBatch', { size: '2 MB', change: '−33%' })} ${warning}`]);
  });
});

describe('Stage: one persistent, delayed "Rendering preview…" status', () => {
  let setPending: (pending: boolean) => void = () => undefined;
  function Host() {
    const [pending, set] = useState(false);
    setPending = set;
    return (
      <Stage display={{ width: 120, height: 80 }} pending={pending}>
        <img src="data:image/png;base64," alt="" />
      </Stage>
    );
  }

  it('exists from mount, outside the aria-busy stage; text only after the delay; one announcement per burst', async () => {
    vi.useFakeTimers();
    renderWithEnv(<Host />);
    const status = screen.getByRole('status');
    const stage = document.querySelector('.stage') as HTMLElement;
    expect(status.textContent).toBe('');
    expect(status.className).toBe('visually-hidden');
    expect(stage.contains(status)).toBe(false); // a busy region may hold back its announcements
    expect(stage.hasAttribute('aria-busy')).toBe(false);
    const spoken = recordAnnouncements(status);

    // A quick preview: busy, but neither shown nor announced.
    act(() => setPending(true));
    expect(stage.getAttribute('aria-busy')).toBe('true');
    await advance(BUSY_DELAY_MS - 10);
    expect(status.textContent).toBe('');
    expect(document.querySelector('.stage-busy')).toBeNull();
    act(() => setPending(false));
    expect(stage.hasAttribute('aria-busy')).toBe(false);
    await advance(BUSY_HOLD_MS * 2);
    expect(spoken).toEqual([]);

    // A slow one: the pill appears (hidden from AT) and the same status element speaks.
    act(() => setPending(true));
    await advance(BUSY_DELAY_MS);
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(t('editor.previewLoading'));
    const pill = document.querySelector('.stage-busy') as HTMLElement;
    expect(pill.getAttribute('aria-hidden')).toBe('true');
    expect(pill.querySelector('[role]')).toBeNull();
    act(() => setPending(false));
    expect(document.querySelector('.stage-busy')).toBeNull();
    expect(stage.hasAttribute('aria-busy')).toBe(false);

    // More slow renders right after it (slider steps): the pill follows them, the status is not repeated.
    await advance(300);
    act(() => setPending(true));
    await advance(BUSY_DELAY_MS + 100);
    expect(document.querySelector('.stage-busy')).not.toBeNull();
    act(() => setPending(false));
    expect(spoken).toEqual([t('editor.previewLoading')]);

    // Idle for the hold time: emptied (silently); the next slow render is announced again.
    await advance(BUSY_HOLD_MS - 10);
    expect(status.textContent).toBe(t('editor.previewLoading'));
    await advance(10);
    expect(status.textContent).toBe('');
    act(() => setPending(true));
    await advance(BUSY_DELAY_MS);
    expect(spoken).toEqual([t('editor.previewLoading'), t('editor.previewLoading')]);
    expect(screen.getAllByRole('status')).toEqual([status]);
  });
});

// ------------------------------------------------------------------ stylesheets: forced colours and contrast

interface ParsedRule {
  readonly media: string | null;
  readonly selector: string;
  readonly css: string;
}

/**
 * Source of an editor stylesheet. Vitest turns CSS imports (even `?raw`) into empty strings and the renderer
 * tsconfig has no Node types, so node:fs is loaded untyped; the URL is built from a variable because Vite
 * rewrites `new URL('<literal>', import.meta.url)` into a served asset URL.
 */
async function editorCssSource(relativePath: string): Promise<string> {
  const fsModule = 'node:fs';
  const urlModule = 'node:url';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
  const relative = `../../src/renderer/src/views/editor/${relativePath}`;
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), 'utf8');
}

/** Style rules of an editor stylesheet in source order (jsdom's CSS parser), with the media query they sit in. */
async function rulesOf(relativePath: string): Promise<ParsedRule[]> {
  const style = document.createElement('style');
  style.textContent = await editorCssSource(relativePath);
  document.head.append(style);
  const rules: ParsedRule[] = [];
  const walk = (list: CSSRuleList, media: string | null) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, rule.media.mediaText);
      else if (rule instanceof CSSStyleRule) rules.push({ media, selector: rule.selectorText, css: rule.style.cssText.toLowerCase() });
    }
  };
  walk(style.sheet!.cssRules, null);
  style.remove();
  return rules;
}

const FORCED = '(forced-colors: active)';

/**
 * In forced colours the focused swatch must look different from the checked one (with roving focus they are
 * the same element): its focus rule must come after the checked rule and draw a different ring.
 */
async function expectForcedFocusDistinct(file: string, checked: string, focus: string) {
  const forced = (await rulesOf(file)).filter((rule) => rule.media === FORCED);
  const checkedAt = forced.findIndex((rule) => rule.selector === checked);
  const focusAt = forced.findIndex((rule) => rule.selector === focus);
  expect(focusAt, `${focus} in the forced-colours block of ${file}`).toBeGreaterThanOrEqual(0);
  if (checkedAt >= 0) {
    expect(focusAt).toBeGreaterThan(checkedAt);
    expect(forced[checkedAt]!.css).toContain('highlight');
  }
  expect(forced[focusAt]!.css).toMatch(/outline: 3px solid canvastext/);
  expect(forced[focusAt]!.css).toContain('outline-offset: 3px');
}

/** WCAG 2.x contrast of two opaque #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type ColorName = keyof typeof DESIGN_TOKENS.color.light;
const THEMES = ['light', 'dark', 'highContrast', 'highContrastDark'] as const;
/** --c-text-muted → textMuted */
const tokenOf = (cssVar: string) => cssVar.replace(/^--c-/, '').replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase()) as ColorName;

describe('editor stylesheets', () => {
  it('forced colours: focus on a swatch is visible even when it is the checked one', async () => {
    await expectForcedFocusDistinct('editor.css', ".swatch[aria-checked='true']", '.swatch:focus-visible');
    await expectForcedFocusDistinct('annotate/SwatchGroup.css', ".swatch-icon[data-checked='true']", '.swatch-icon:focus-within');
    await expectForcedFocusDistinct('background/background.css', '.bg-custom.is-selected', '.bg-custom:focus-within');
    // The selection stays visible next to the focus ring.
    const keep = (await rulesOf('editor.css')).find((rule) => rule.media === FORCED && rule.selector === ".swatch[aria-checked='true']:focus-visible");
    expect(keep?.css).toContain('highlight');
  });

  it('swatches have a border with at least 3:1 against the window in every colour set (WCAG 1.4.11)', async () => {
    const swatch = (await rulesOf('editor.css')).find((rule) => rule.media === null && rule.selector === '.swatch');
    const cssVar = /border: 1px solid var\((--c-[a-z-]+)\)/.exec(swatch?.css ?? '')?.[1];
    expect(cssVar, 'an opaque theme colour, not a translucent black').toBeDefined();
    for (const theme of THEMES) {
      const colors = DESIGN_TOKENS.color[theme];
      expect(contrast(colors[tokenOf(cssVar!)], colors.windowBg), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it('the pressed Redact list item shows its style label at full strength (≥ 4.5:1 on the accent)', async () => {
    const rules = await rulesOf('redact/redact.css');
    const pressed = rules.find((rule) => rule.selector === ".redact-list-item[aria-pressed='true'] .redact-list-style");
    expect(pressed?.css).toContain('opacity: 1');
    for (const theme of THEMES) {
      const colors = DESIGN_TOKENS.color[theme];
      expect(contrast(colors.accentText, colors.accent), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('forced colours: the queued/indeterminate Compress bar keeps a visible track and fill', async () => {
    const forced = (await rulesOf('compress/compress.css')).filter((rule) => rule.media === FORCED);
    expect(forced.find((rule) => rule.selector === '.compress-bar-indeterminate')?.css).toMatch(/border: 1px solid canvastext/);
    const fill = forced.find((rule) => rule.selector === '.compress-bar-indeterminate span')?.css ?? '';
    expect(fill).toContain('forced-color-adjust: none');
    expect(fill).toMatch(/background(-color)?: highlight/);
  });
});
