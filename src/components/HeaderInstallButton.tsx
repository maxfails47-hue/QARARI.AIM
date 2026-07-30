import { useEffect, useState, useCallback } from "react";
import { Download } from "lucide-react";
import { useApp } from "@/lib/AppContext";
import {
  onInstallPromptChange,
  clearDeferredPrompt,
  isStandalone,
  isIos,
  type BeforeInstallPromptEvent,
} from "@/lib/pwaInstall";

// Small, always-on install badge that lives inside the sticky header (unlike
// <InstallBanner/>, which is a temporary floating card that auto-hides).
// This gives the user a permanent way to install the app even after they've
// dismissed or missed the banner. Tapping it either triggers the native
// Chrome/Android install prompt directly, or — on iOS, where there's no
// programmatic prompt — reveals a small tooltip with the manual steps.

const SEEN_KEY = "qarari-header-install-badge-seen";

export function HeaderInstallButton() {
  const { t, dir } = useApp();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosEligible, setIosEligible] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [showDot, setShowDot] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;

    setShowDot(!localStorage.getItem(SEEN_KEY));

    if (isIos()) setIosEligible(true);

    const unsubscribe = onInstallPromptChange((prompt) => {
      setDeferredPrompt(prompt);
    });

    // Only the real "appinstalled" event should hide the button going
    // forward — not merely "no captured prompt yet", which used to cause
    // the button to disappear (or never appear) on every load before
    // `beforeinstallprompt` had fired.
    const handleInstalled = () => setInstalled(true);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      unsubscribe();
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const dismissDot = useCallback(() => {
    localStorage.setItem(SEEN_KEY, "1");
    setShowDot(false);
  }, []);

  const handleClick = async () => {
    dismissDot();

    if (deferredPrompt) {
      setShowTooltip(false);
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") setInstalled(true);
      clearDeferredPrompt();
      setDeferredPrompt(null);
      return;
    }

    // No native prompt captured yet (iOS always lacks one; Android/desktop
    // Chrome may just not have fired `beforeinstallprompt` yet). Either way,
    // the button stays visible and instead shows manual steps.
    setShowTooltip((v) => !v);
    window.setTimeout(() => setShowTooltip(false), 6000);
  };

  // The button is always visible unless the app is already installed/running
  // standalone — it no longer hides itself while waiting on Chrome's
  // `beforeinstallprompt` event.
  if (installed || isStandalone()) return null;

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        aria-label={t("installHeaderHint")}
        title={t("installHeaderHint")}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 text-[#0B0B0F] shadow-md shadow-amber-500/25 transition-transform active:scale-95"
      >
        <Download className="h-4 w-4" strokeWidth={2.5} />
        {showDot && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[#0B0B0F]" />
        )}
      </button>

      {showTooltip && (
        <div
          dir={dir}
          className={`absolute top-11 z-50 w-40 rounded-lg border border-amber-500/25 bg-zinc-900 px-2.5 py-2 text-[11px] leading-snug text-zinc-200 shadow-xl ${
            dir === "rtl" ? "right-0" : "left-0"
          }`}
        >
          {iosEligible
            ? `${t("installIosStep1")} — ${t("installIosStep2")}`
            : t("installManualHint")}
        </div>
      )}
    </div>
  );
}
