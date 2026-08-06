import React from "react"
import ReactDOM from "react-dom/client"
// IMPORTANT: import this before anything else so its top-level
// `beforeinstallprompt` listener is attached the instant this script
// evaluates — not after the ~8.6s SplashScreen finishes and mounts <App/>.
import "@/lib/pwaInstall"
import App from "./App.tsx"
import AdminApp from "./admin/AdminApp.tsx"
import { SplashScreen, shouldShowSplash } from "@/components/SplashScreen"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import "./index.css"

// The Admin Dashboard (Section 15 approve/reject UI, plus Sections 25-26)
// lives at a configurable path — never guessable "/admin" by default — as a
// separate lightweight app that never shares state with the main consumer
// app, and is gated by its own username/password on top of that.
// Set VITE_ADMIN_ROUTE_SLUG in your env vars (e.g. "shary-2511k26x");
// falls back to "/admin" if it isn't set.
const adminSlug = (import.meta.env.VITE_ADMIN_ROUTE_SLUG as string) || "admin"
const isAdminRoute = window.location.pathname.startsWith(`/${adminSlug}`)

function Root() {
  const [showSplash, setShowSplash] = React.useState(!isAdminRoute && shouldShowSplash())

  if (showSplash) {
    return <SplashScreen onFinish={() => setShowSplash(false)} />
  }
  return isAdminRoute ? <AdminApp /> : <App />
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
)

// Register the PWA service worker (app shell caching only — /api/* is
// always excluded inside sw.js, so live analysis/chat/price data is never
// served stale). Skipped in dev to avoid caching issues while iterating.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err)
    })
  })
}
