import { useEffect, useState, useCallback } from "react";
import { Sparkles, X, Share } from "lucide-react";
import { useApp } from "@/lib/AppContext";
import {
  onInstallPromptChange,
  clearDeferredPrompt,
  isStandalone,
  isIos,
  type BeforeInstallPromptEvent,
} from "@/lib/pwaInstall";

// Custom PWA install banner.
// - Android/Chrome & desktop Chrome: captures `beforeinstallprompt` and shows
//   a themed banner with a real "Install" button that triggers the native
//   Chrome install prompt via `deferredPrompt.prompt()`.
// - iOS Safari: there is no `beforeinstallprompt` event, so we show a short
//   instructional variant ("tap Share → Add to Home Screen") instead.
// The banner never appears if the app is already installed/standalone, and
// remembers a dismissal (or an install) in localStorage so it doesn't nag.

const DISMISS_KEY = "shary-install-dismissed-at";
const AUTO_HIDE_MS = 30_000;
const RESHOW_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const APPEAR_DELAY_MS = 2_500;

function wasRecentlyDismissed() {
  const raw = localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < RESHOW_AFTER_MS;
}

export function InstallBanner() {
  const { t, dir } = useApp();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosEligible, setIosEligible] = useState(false);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  const dismiss = useCallback(() => {
    setClosing(true);
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    window.setTimeout(() => setVisible(false), 300);
  }, []);

  useEffect(() => {
    if (isStandalone() || wasRecentlyDismissed()) return;

    let appearTimer: number | undefined;
    let hideTimer: number | undefined;

    const scheduleShow = () => {
      appearTimer = window.setTimeout(() => {
        setVisible(true);
        hideTimer = window.setTimeout(() => dismiss(), AUTO_HIDE_MS);
      }, APPEAR_DELAY_MS);
    };

    // Subscribe to the centrally-captured prompt (fires immediately with the
    // current value if `beforeinstallprompt` already happened earlier during
    // page load — e.g. while the splash screen was still showing).
    let hasScheduled = false;
    const unsubscribe = onInstallPromptChange((prompt) => {
      setDeferredPrompt(prompt);
      if (prompt && !hasScheduled) {
        hasScheduled = true;
        scheduleShow();
      }
      if (!prompt) {
        // appinstalled fired
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
        setVisible(false);
      }
    });

    // iOS Safari never fires beforeinstallprompt — show instructions instead.
    if (isIos()) {
      setIosEligible(true);
      scheduleShow();
    }

    return () => {
      unsubscribe();
      window.clearTimeout(appearTimer);
      window.clearTimeout(hideTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    }
    clearDeferredPrompt();
    setDeferredPrompt(null);
    dismiss();
  };

  if (!visible || (!deferredPrompt && !iosEligible)) return null;

  return (
    <div
      dir={dir}
      role="dialog"
      aria-live="polite"
      className={`fixed inset-x-3 bottom-3 z-50 sm:inset-x-auto sm:bottom-6 ${
        dir === "rtl" ? "sm:left-6" : "sm:right-6"
      } sm:max-w-sm transition-all duration-300 ${
        closing ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      <div className="flex items-start gap-3 rounded-2xl border border-shary/25 bg-white/95 p-3.5 shadow-2xl shadow-shary/10 backdrop-blur-md">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-shary to-shary-dark shadow-lg shadow-shary/20">
          <Sparkles className="h-5 w-5 text-[#FFFFFF]" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">
            {t(deferredPrompt ? "installTitle" : "installIosTitle")}
          </p>

          {deferredPrompt ? (
            <>
              <p className="mt-0.5 text-xs text-zinc-400">{t("installSubtitle")}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={handleInstall}
                  className="rounded-lg bg-gradient-to-br from-shary to-shary-dark px-3.5 py-1.5 text-xs font-bold text-[#FFFFFF] shadow-md shadow-shary/20 transition-transform active:scale-95"
                >
                  {t("installBtn")}
                </button>
                <button
                  onClick={dismiss}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-800"
                >
                  {t("installDismiss")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-0.5 text-xs text-zinc-400">{t("installSubtitle")}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-zinc-400">
                <span>{t("installIosStep1")}</span>
                <Share className="h-3.5 w-3.5 text-shary-dark" />
                <span>{t("installIosStep2")}</span>
              </p>
            </>
          )}
        </div>

        <button
          onClick={dismiss}
          aria-label="close"
          className="shrink-0 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-zinc-50/60 hover:text-zinc-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
