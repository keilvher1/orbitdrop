import { ACTIONS, type EditorContext, type OrbitErrorInfo } from '@orbitdrop/contracts';
import { useEffect, useState } from 'react';
import { useEnv } from '../../app/env';
import { ViewError, ViewLoading } from '../../app/ViewState';
import { AdjustEditor } from './adjust/AdjustEditor';
import { AnnotateEditor } from './annotate/AnnotateEditor';
import { BackgroundEditor } from './background/BackgroundEditor';
import { CompressEditor } from './compress/CompressEditor';
import { CropEditor } from './crop/CropEditor';
import { MetadataEditor } from './metadata/MetadataEditor';
import { PdfOrderEditor } from './pdf/PdfOrderEditor';
import { RedactEditor } from './redact/RedactEditor';
import { StageBudgetProvider } from './editorKit';
import { asErrorInfo } from '../../app/errors';

/** Loads the EditorContext for this window and shows the matching editor. */
export function EditorView({ editorId }: { readonly editorId: string }) {
  const { orbit, t } = useEnv();
  const [ctx, setCtx] = useState<EditorContext | null>(null);
  const [error, setError] = useState<OrbitErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    orbit.getEditor(editorId).then(
      (next) => {
        if (!cancelled) setCtx(next);
      },
      (reason: unknown) => {
        if (!cancelled) setError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, editorId]);

  if (error) return <ViewError title={t('editor.loadFailed')} detail={t.error(error)} />;
  if (ctx === null) return <ViewLoading label={t('common.loading')} title="OrbitDrop" />;

  const title = t.text(ACTIONS[ctx.actionId].title);
  return <StageBudgetProvider>{editorFor(ctx, title)}</StageBudgetProvider>;
}

function editorFor(ctx: EditorContext, title: string) {
  switch (ctx.actionId) {
    case 'tool.crop':
      return <CropEditor ctx={ctx} title={title} />;
    case 'tool.addBackground':
      return <BackgroundEditor ctx={ctx} title={title} />;
    case 'tool.compress':
      return <CompressEditor ctx={ctx} title={title} />;
    case 'tool.metadata':
      return <MetadataEditor ctx={ctx} title={title} />;
    case 'tool.edit':
      return <AdjustEditor ctx={ctx} title={title} />;
    case 'tool.annotate':
      return <AnnotateEditor ctx={ctx} title={title} />;
    case 'tool.redact':
      return <RedactEditor ctx={ctx} title={title} />;
    case 'convert.pdf':
      return <PdfOrderEditor ctx={ctx} title={title} />;
    default:
      return <UnsupportedEditor title={title} />;
  }
}

function UnsupportedEditor({ title }: { readonly title: string }) {
  const { t } = useEnv();
  return <ViewError title={t('editor.unsupported')} windowTitle={title} />;
}
