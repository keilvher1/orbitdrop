import { protocol, type Session } from 'electron';
import { PREVIEW_PROTOCOL } from '@orbitdrop/contracts';
import { previewResponse, type PreviewStore } from './store';

/** Must run before `app.ready`. */
export function registerPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: false, bypassCSP: false },
    },
  ]);
}

/** Serve preview images from the in-memory store: orbit-preview://p/<token>. */
export function servePreviews(store: PreviewStore, session: Session): void {
  session.protocol.handle(PREVIEW_PROTOCOL, (request) => previewResponse(store, request.method, request.url));
}
