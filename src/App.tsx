import { AppProvider } from "@/lib/AppContext";
import { Header } from "@/components/Header";
import { Toast } from "@/components/Toast";
import { InstallBanner } from "@/components/InstallBanner";
import { DecisionInput } from "@/components/DecisionInput";
import { RevealScreen } from "@/components/RevealScreen";
import { ReportScreen } from "@/components/ReportScreen";
import { HistoryScreen } from "@/components/HistoryScreen";
import { ProfileScreen } from "@/components/ProfileScreen";
import { LoginScreen } from "@/components/LoginScreen";
import { UpgradeScreen } from "@/components/UpgradeScreen";
import { CompareScreen } from "@/components/CompareScreen";
import { GuideScreen } from "@/components/GuideScreen";
import { AdvisorScreen } from "@/components/AdvisorScreen";
import { WatchlistScreen } from "@/components/WatchlistScreen";
import { ComparisonHistoryScreen } from "@/components/ComparisonHistoryScreen";
import { OnboardingScreen } from "@/components/OnboardingScreen";
import { HelpSheet } from "@/components/HelpSheet";
import { HelpCircle } from "lucide-react";

import { useApp } from "@/lib/AppContext";

function ScreenRouter() {
  const { screen } = useApp();
  switch (screen) {
    case "input":
      return <DecisionInput />;
    case "reveal":
      return <RevealScreen />;
    case "report":
      return <ReportScreen />;
    case "history":
      return <HistoryScreen />;
    case "profile":
      return <ProfileScreen />;
    case "login":
      return <LoginScreen />;
    case "upgrade":
      return <UpgradeScreen />;
    case "compare":
      return <CompareScreen />;
    case "guide":
      return <GuideScreen />;
    case "advisor":
      return <AdvisorScreen />;
    case "watchlist":
      return <WatchlistScreen />;
    case "comparisonHistory":
      return <ComparisonHistoryScreen />;

    default:
      return <DecisionInput />;
  }
}

// Persistent "How it works" floating help button (Section 2). Sits fixed
// near the bottom of the shell, available on the core screens; hidden on
// auth/upgrade flows where it would just be noise.
function HelpFab() {
  const { screen, helpSheetOpen, replayOnboarding, t } = useApp();
  if (screen === "login" || screen === "upgrade") return null;
  return (
    <button
      // Replays the full 5-slide onboarding (Section 1) — this is now the
      // "about / how everything works" reference for the whole app, not
      // just the old 3-step summary. The small "?" next to the photo
      // upload field still opens the quick HelpSheet inline.
      onClick={() => replayOnboarding()}
      aria-label={t("helpButtonLabel")}
      title={t("helpButtonLabel")}
      className={`fixed bottom-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border-2 border-amber-500/60 bg-[#0B0B0F] text-amber-400 shadow-lg shadow-black/40 transition-transform hover:scale-105 active:scale-95 ltr:right-5 rtl:left-5 ${
        helpSheetOpen ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      <HelpCircle className="h-5 w-5" />
    </button>
  );
}

function AppShell() {
  const { onboardingVisible } = useApp();

  if (onboardingVisible) {
    return <OnboardingScreen />;
  }

  return (
    <div className="min-h-screen bg-[#0B0B0F] text-zinc-100 antialiased">
      <div className="pointer-events-none fixed inset-0 z-0 bg-gradient-to-b from-amber-950/10 via-transparent to-transparent" />
      <div className="relative z-10">
        <Header />
        <main className="pb-8">
          <ScreenRouter />
        </main>
        <footer className="border-t border-amber-500/10 px-4 py-6 text-center">
          <p className="text-xs text-zinc-600">
            Qarari.AI — {new Date().getFullYear()}
          </p>
        </footer>
      </div>
      <Toast />
      <InstallBanner />
      <HelpFab />
      <HelpSheet />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}