import { Notice, Spinner } from '../components/Notice';
import { TitleBar } from '../components/TitleBar';

export function ViewLoading({ label, title }: { readonly label: string; readonly title?: string }) {
  return (
    <div className="view">
      {title !== undefined ? <TitleBar title={title} /> : null}
      <div className="view-loading" role="status">
        <Spinner size={16} />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function ViewError({ title, detail, windowTitle }: { readonly title: string; readonly detail?: string; readonly windowTitle?: string }) {
  return (
    <div className="view" style={{ minWidth: 320 }}>
      <TitleBar title={windowTitle ?? 'OrbitDrop'} />
      <div className="view-error">
        <Notice tone="danger">
          <strong>{title}</strong>
          {detail ? <div className="muted">{detail}</div> : null}
        </Notice>
      </div>
    </div>
  );
}
