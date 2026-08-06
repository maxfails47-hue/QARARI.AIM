import { useMemo } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { ChevronLeft, TrendingUp, Flame } from "lucide-react";

// Shary no longer keeps a per-search history list or "good/fair/bad deal"
// verdicts — there's no offered price to judge anymore, just a plain
// product search. This screen now only surfaces two lightweight stats:
// - totalSaved: sums `moneySaved` on any rows saved before the pivot to
//   plain search (nothing writes new rows here going forward, so this is
//   effectively a frozen historical total for existing users).
// - streak: consecutive days of activity, computed from the same legacy rows.
export function HistoryScreen() {
  const { t, lang, dir, history, navigate, session } = useApp();

  const stats = useMemo(() => {
    const totalSaved = history.reduce((sum, h) => sum + (typeof h.moneySaved === "number" ? h.moneySaved : 0), 0);

    const dates = [...new Set(history.map((h) => new Date(h.createdAt).toDateString()))].sort();
    let streak = 0;
    if (dates.length > 0) {
      const today = new Date().toDateString();
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      if (dates.includes(today) || dates.includes(yesterday)) {
        let checkDate = dates.includes(today) ? new Date() : new Date(Date.now() - 86400000);
        while (dates.includes(checkDate.toDateString())) {
          streak++;
          checkDate = new Date(checkDate.getTime() - 86400000);
        }
      }
    }

    return { totalSaved, streak };
  }, [history]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:text-shary-dark"
        >
          {dir === "rtl" ? <ChevronLeft className="h-5 w-5 rotate-180" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
        <h1 className="text-2xl font-bold text-shary-dark">{t("historyTitle")}</h1>
      </div>

      {!session?.user && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-shary/20 bg-shary/5 p-4">
          <p className="text-xs text-zinc-400">
            {lang === "ar"
              ? "اعمل حساب عشان تتبع نشاطك وتقدر توصله من أي جهاز."
              : "Create an account to track your activity and access it from any device."}
          </p>
          <Button onClick={() => navigate("login")} className="shrink-0 bg-shary text-[#FFFFFF] hover:bg-shary">
            {t("signup")}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-shary/15 bg-gradient-to-b from-shary/10 to-transparent p-6 text-center">
          <TrendingUp className="mx-auto mb-2 h-6 w-6 text-shary-dark" />
          <p className="text-2xl font-bold text-shary-dark">{stats.totalSaved.toLocaleString()}</p>
          <p className="text-xs text-zinc-500">{t("totalSaved")}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white/60 p-6 text-center">
          <Flame className="mx-auto mb-2 h-6 w-6 text-shary-dark" />
          <p className="text-2xl font-bold text-shary-dark">{stats.streak}</p>
          <p className="text-xs text-zinc-500">{t("dayStreak")}</p>
        </div>
      </div>

      <Button onClick={() => navigate("input")} className="mt-6 w-full bg-shary text-[#FFFFFF] hover:bg-shary">
        {t("newDecision")}
      </Button>
    </div>
  );
}
