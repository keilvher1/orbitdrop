import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly fallback: (error: Error) => ReactNode;
  /** Also told about the crash (App sends it to main.log through reportRendererError). */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/** Keeps a rendering bug in one view from leaving a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No document content here: component stack + message only.
    console.error('[renderer] view crashed', error.message, info.componentStack);
    try {
      this.props.onError?.(error, info);
    } catch {
      // reporting must never break the fallback
    }
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
