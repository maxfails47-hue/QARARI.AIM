// Captures `beforeinstallprompt` at MODULE LOAD TIME — i.e. the moment this
// file is imported/executed by the browser, which happens as soon as
// main.tsx's script runs, well before React mounts anything (including
// before the ~8.6s SplashScreen finishes and <App/> / <InstallBanner/> get
// rendered).
//
// Why this matters: Chrome fires `beforeinstallprompt` once, early in page
// load. If no listener is attached yet when it fires, the event is gone for
// good — a listener added later (e.g. inside a component's useEffect that
// only mounts after a long splash screen) will never see it. This is exactly
// why the native "Install" option in Chrome's 3-dot menu still works (the
// browser tracks installability itself, independent of this JS event) while
// a custom in-app banner that listens too late never appears.

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Listener = (e: BeforeInstallPromptEvent | null) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<Listener>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l(deferredPrompt));
  });

  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    listeners.forEach((l) => l(null));
  });
}

/** Current captured prompt, if the event has already fired (possibly before any component mounted). */
export function getDeferredPrompt() {
  return deferredPrompt;
}

export function wasJustInstalled() {
  return installed;
}

/** Subscribe to future changes (fires once immediately with the current value). */
export function onInstallPromptChange(listener: Listener) {
  listeners.add(listener);
  listener(deferredPrompt);
  return () => listeners.delete(listener);
}

export function clearDeferredPrompt() {
  deferredPrompt = null;
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIos() {
  if (typeof window === "undefined") return false;
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}
