import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLanguage } from "./i18n/LanguageContext";

/**
 * The last line of defense for the browser UI: a React render error anywhere
 * below it used to unmount the whole tree — a blank page, with the session
 * gone from view, recoverable only by a manual reload anyway. The boundary
 * keeps the failure visible and offers that reload explicitly. The error
 * itself is logged, never rendered: it can contain anything a tool returned.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("finanfa UI crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.crashed) return <CrashScreen />;
    return this.props.children;
  }
}

function CrashScreen() {
  const { t } = useLanguage();
  return (
    <div className="crash-screen">
      <div className="crash-card">
        <div className="avatar">f</div>
        <h1>{t("error.title")}</h1>
        <p>{t("error.body")}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          {t("error.reload")}
        </button>
      </div>
    </div>
  );
}
