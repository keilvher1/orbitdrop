import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly fallback: (error: Error) => ReactNode;
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
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
