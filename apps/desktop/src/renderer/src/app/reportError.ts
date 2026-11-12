import { RENDERER_ERROR_LIMITS, type OrbitApi, type RendererErrorReport } from '@orbitdrop/contracts';

const clip = (text: unknown, max: number): string | undefined => (typeof text === 'string' && text.length > 0 ? text.slice(0, max) : undefined);

/**
 * A view crashed (ErrorBoundary) or the window could not start its view:
 * tell main, which writes it to main.log (validated, path-redacted,
 * size-capped, rate-limited). Fire-and-forget; never throws — reporting must
 * not break the fallback screen.
 */
export function reportRendererError(
  orbit: Pick<OrbitApi, 'reportRendererError'> | undefined,
  source: RendererErrorReport['source'],
  error: unknown,
  componentStack?: string | null,
): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const name = clip(err.name, RENDERER_ERROR_LIMITS.name);
    const stack = clip(err.stack, RENDERER_ERROR_LIMITS.stack);
    const components = clip(componentStack, RENDERER_ERROR_LIMITS.componentStack);
    const report: RendererErrorReport = {
      source,
      message: clip(err.message, RENDERER_ERROR_LIMITS.message) ?? '',
      ...(name !== undefined ? { name } : {}),
      ...(stack !== undefined ? { stack } : {}),
      ...(components !== undefined ? { componentStack: components } : {}),
    };
    orbit?.reportRendererError?.(report);
  } catch {
    // nothing to do: the window still shows its fallback
  }
}
