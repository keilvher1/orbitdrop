import type { ConvertOptions, EditorContext, SelectedFile } from '@orbitdrop/contracts';
import { ChevronDown, ChevronUp, FileImage, GripVertical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useEnv } from '../../../app/env';
import { Segmented } from '../../../components/Segmented';
import { formatBytes } from '../../../i18n/format';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { isBoolean, isNumber, isOneOf, isRecord, isString, pick } from '../editorKit';
import './pdf.css';

type PageSize = ConvertOptions['pageSize'];
export type MarginChoice = 'none' | 'narrow' | 'normal';

const PAGE_SIZES: readonly PageSize[] = ['image', 'a4', 'letter'];
export const MARGIN_PT: Readonly<Record<MarginChoice, number>> = { none: 0, narrow: 18, normal: 36 };
const MARGINS: readonly MarginChoice[] = ['none', 'narrow', 'normal'];
const SEPARATORS = ['marker', 'formfeed', 'blank'] as const;

/** Order from the defaults when it lists exactly the editor's files, else the selection order. */
export function initialOrder(files: readonly SelectedFile[], defaults: unknown): string[] {
  const ids = files.map((f) => f.fileId);
  const raw = isRecord(defaults) ? defaults.order : undefined;
  if (Array.isArray(raw) && raw.length === ids.length && raw.every(isString) && new Set(raw).size === ids.length && raw.every((id) => ids.includes(id))) {
    return [...raw];
  }
  return ids;
}

/** Move the item at `from` to index `to` (both within bounds). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export function marginChoiceFor(marginPt: number): MarginChoice {
  let best: MarginChoice = 'none';
  for (const choice of MARGINS) {
    if (Math.abs(MARGIN_PT[choice] - marginPt) < Math.abs(MARGIN_PT[best] - marginPt)) best = choice;
  }
  return best;
}

/**
 * Options for ConvertOptionsSchema (strict): known, valid fields from the
 * defaults (flatten colour, metadata, quality, …) plus the confirmed order and
 * page setup.
 */
export function pdfOptions(defaults: unknown, pageSize: PageSize, marginPt: number, order: readonly string[]): ConvertOptions {
  const flatten = pick(defaults, 'flattenBackground', (v): v is string => isString(v) && /^#[0-9a-fA-F]{6}$/.test(v), '#FFFFFF');
  const quality = pick<number | undefined>(defaults, 'quality', (v): v is number => isNumber(v) && Number.isInteger(v) && v >= 1 && v <= 100, undefined);
  const dpi = pick<150 | 300 | undefined>(defaults, 'dpi', (v): v is 150 | 300 => v === 150 || v === 300, undefined);
  return {
    flattenBackground: flatten,
    keepMetadata: pick(defaults, 'keepMetadata', isBoolean, false),
    pageSeparator: pick(defaults, 'pageSeparator', isOneOf(SEPARATORS), 'marker'),
    ...(quality === undefined ? {} : { quality }),
    ...(dpi === undefined ? {} : { dpi }),
    pageSize,
    marginPt,
    order: [...order],
  };
}

export function PdfOrderEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const files = useMemo(() => new Map(ctx.files.map((f) => [f.fileId, f])), [ctx.files]);
  const startOrder = useMemo(() => initialOrder(ctx.files, ctx.defaults), [ctx.files, ctx.defaults]);
  const startPageSize = pick(ctx.defaults, 'pageSize', isOneOf(PAGE_SIZES), 'image');
  const startMargin = marginChoiceFor(pick(ctx.defaults, 'marginPt', isNumber, 0));

  const [order, setOrder] = useState<string[]>(startOrder);
  const [pageSize, setPageSize] = useState<PageSize>(startPageSize);
  const [margin, setMargin] = useState<MarginChoice>(startMargin);
  const [announcement, setAnnouncement] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusAfterMove = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    rowRefs.current.get(id)?.focus();
  }, [order]);

  const nameOf = (id: string) => files.get(id)?.name ?? id;

  const move = (from: number, to: number, focus = false) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const id = order[from];
    if (id === undefined) return;
    if (focus) focusAfterMove.current = id;
    setOrder(moveItem(order, from, to));
    setAnnouncement(t('pdf.moved', { name: nameOf(id), position: to + 1 }));
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.target !== event.currentTarget) return; // keys on the row buttons behave normally
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (event.altKey) {
      move(index, index + delta, true);
    } else {
      const id = order[index + delta];
      if (id !== undefined) rowRefs.current.get(id)?.focus();
    }
  };

  const resetDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropIndex(index + (after ? 1 : 0));
  };

  const onDrop = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    if (dragId !== null && dropIndex !== null) {
      const from = order.indexOf(dragId);
      const to = from < dropIndex ? dropIndex - 1 : dropIndex;
      move(from, to);
    }
    resetDrag();
  };

  const changed = order.join('\n') !== startOrder.join('\n') || pageSize !== startPageSize || margin !== startMargin;

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('pdf.create')}
      onPrimary={() => void commit.commit(pdfOptions(ctx.defaults, pageSize, MARGIN_PT[margin], order))}
      primaryDisabled={order.length === 0}
      onReset={() => {
        setOrder(startOrder);
        setPageSize(startPageSize);
        setMargin(startMargin);
      }}
      resetDisabled={!changed}
    >
      <div className="editor-section">
        <h2 className="editor-section-title" id={`${ctx.editorId}-order`}>
          {t('pdf.order')}
        </h2>
        <p className="pdf-help muted">{t('pdf.help')}</p>
        <ol className="pdf-list" aria-labelledby={`${ctx.editorId}-order`}>
          {order.map((id, index) => {
            const file = files.get(id);
            const name = nameOf(id);
            const dropBefore = dragId !== null && dropIndex === index;
            const dropAfter = dragId !== null && dropIndex === order.length && index === order.length - 1;
            return (
              <li
                key={id}
                ref={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                className="pdf-row"
                tabIndex={0}
                draggable
                aria-label={`${t('pdf.page', { n: index + 1 })} · ${name}`}
                aria-describedby={`${ctx.editorId}-pdf-keys`}
                data-dragging={dragId === id || undefined}
                data-drop={dropBefore ? 'before' : dropAfter ? 'after' : undefined}
                onKeyDown={(event) => onRowKeyDown(event, index)}
                onDragStart={(event) => {
                  setDragId(id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', name);
                }}
                onDragOver={(event) => onDragOver(event, index)}
                onDrop={onDrop}
                onDragEnd={resetDrag}
              >
                <GripVertical size={14} className="pdf-grip" aria-hidden="true" />
                <span className="pdf-page tabular">{t('pdf.page', { n: index + 1 })}</span>
                <FileImage size={16} className="pdf-icon" aria-hidden="true" />
                <span className="pdf-name" title={name}>
                  {name}
                </span>
                <span className="pdf-size muted tabular">{file ? formatBytes(file.bytes, t.locale, platform) : ''}</span>
                <span className="pdf-buttons">
                  <button type="button" className="btn-icon" aria-label={t('pdf.moveUp', { name })} title={t('pdf.moveUp', { name })} disabled={index === 0} onClick={() => move(index, index - 1)}>
                    <ChevronUp size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={t('pdf.moveDown', { name })}
                    title={t('pdf.moveDown', { name })}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        <span id={`${ctx.editorId}-pdf-keys`} className="visually-hidden">
          {t('pdf.keysHelp', { alt: platform === 'darwin' ? 'Option' : 'Alt' })}
        </span>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </div>
      <div className="editor-controls">
        <div className="field-row">
          <span className="field-label">{t('pdf.pageSize')}</span>
          <Segmented<PageSize>
            label={t('pdf.pageSize')}
            value={pageSize}
            onChange={setPageSize}
            options={PAGE_SIZES.map((size) => ({ value: size, label: t(`pdf.pageSize.${size}`) }))}
          />
        </div>
        <div className="field-row">
          <span className="field-label">{t('pdf.margin')}</span>
          <Segmented<MarginChoice> label={t('pdf.margin')} value={margin} onChange={setMargin} options={MARGINS.map((m) => ({ value: m, label: t(`pdf.margin.${m}`) }))} />
        </div>
      </div>
    </EditorFrame>
  );
}
