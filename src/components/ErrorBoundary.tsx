import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Catches any render-time crash anywhere below it in the tree (e.g. a
// component calling `.toLocaleString()` on a null price, or `.map()` on a
// missing array) and shows a friendly message with the actual error instead
// of leaving the user staring at a blank white screen.
//
// This is a safety net, not a substitute for fixing the underlying null
// handling in the components themselves — see ReportScreen.tsx for the
// actual defensive fixes.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] Caught a render crash:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    // Sending the user back to a known-good screen is safer than just
    // clearing the flag, since the bad data that caused the crash (e.g. a
    // malformed cached report) is likely still sitting in state/localStorage.
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#0B0B0F] px-6 text-center text-zinc-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 ring-1 ring-red-500/30">
            <AlertTriangle className="h-7 w-7 text-red-400" />
          </div>
          <h1 className="font-serif text-xl font-bold text-red-400">حدث خطأ غير متوقع / Something went wrong</h1>
          <p className="max-w-md text-sm text-zinc-400">
            التطبيق واجه مشكلة أثناء عرض هذه الشاشة. جرّب الرجوع للصفحة الرئيسية.
            <br />
            The app hit a problem rendering this screen. Try going back to the home screen.
          </p>
          {this.state.error && (
            <pre className="max-w-full overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left text-xs text-red-300">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-[#0B0B0F] hover:bg-amber-400"
          >
            <RotateCcw className="h-4 w-4" /> الرجوع للرئيسية / Go home
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
