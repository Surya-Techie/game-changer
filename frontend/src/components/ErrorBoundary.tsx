import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * Top-level error boundary. Without this, a single component throwing
 * (e.g. lightweight-charts complaining about a bad time value) blanks
 * the whole page and the user sees nothing — no clue what to do.
 *
 * Here we show the error, log to console for diagnostics, and offer a
 * reload button. In production we should ALSO ship the error to Sentry
 * or a similar service; that wiring is left as a follow-up once a
 * tenant DSN is configured.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("UI error boundary caught:", err, info.componentStack);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-bg-panel-solid border border-accent-sell/40 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-6 py-5 border-b border-bg-border flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-accent-sell/20 flex items-center justify-center">
              <AlertOctagon className="h-5 w-5 text-accent-sell" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Something broke in the UI</h2>
              <p className="text-xs text-slate-400">QTI · client-side error</p>
            </div>
          </div>
          <div className="px-6 py-5 space-y-3">
            <pre className="text-[11px] bg-bg-elevated/60 border border-bg-border rounded p-3 text-accent-sell font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto">
              {this.state.err.message}
            </pre>
            <p className="text-xs text-slate-400">
              Reloading the page usually fixes it. If it keeps happening, the
              backend or ai-service is probably down — check the dev console
              and server logs.
            </p>
          </div>
          <div className="px-6 py-4 bg-bg-elevated/40 border-t border-bg-border flex justify-end">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-accent-info hover:bg-accent-info/80 text-white font-bold text-sm rounded-lg transition-colors flex items-center gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
