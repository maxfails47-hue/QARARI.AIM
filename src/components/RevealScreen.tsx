import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { getCategoryIcon } from "@/lib/categoryIcons";
import { currencies } from "@/lib/types";
import type { Verdict } from "@/lib/types";
import { Check, X, Lock, Share2, Sparkles } from "lucide-react";
import { generateShareCard } from "@/lib/shareCard";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** requestAnimationFrame count-up from 0 to `target`, ease-out cubic. */
function useCountUp(target: number | null, durationMs: number, start: boolean): number {
  const [value, setValue] = useState(0);
  const reduced = useMemo(prefersReducedMotion, []);

  useEffect(() => {
    if (target === null || !start) return;
    if (reduced) {
      setValue(target);
      return;
    }
    let raf = 0;
    const startTime = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - startTime) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, start, durationMs, reduced]);

  return value;
}

const VERDICT_STYLES: Record<Verdict, { ring: string; badgeBg: string; text: string; glow: string; pillBg: string; pillText: string }> = {
  good: { ring: "ring-emerald-500/40", badgeBg: "bg-emerald-500", text: "text-emerald-400", glow: "shadow-emerald-500/30", pillBg: "bg-emerald-500/10 border-emerald-500/30", pillText: "text-emerald-400" },
  fair: { ring: "ring-emerald-500/40", badgeBg: "bg-emerald-500", text: "text-emerald-400", glow: "shadow-emerald-500/30", pillBg: "bg-emerald-500/10 border-emerald-500/30", pillText: "text-emerald-400" },
  bad: { ring: "ring-red-500/40", badgeBg: "bg-red-500", text: "text-red-400", glow: "shadow-red-500/30", pillBg: "bg-red-500/10 border-red-500/30", pillText: "text-red-400" },
};

export function RevealScreen() {
  const { t, lang, currentReport, navigate, showToast } = useApp();
  const report = currentReport;

  // Timeline stages: 0=mount, 1=badge, 2=label, 3=counters, 4=bar, 5=pill, 6=locked+CTA
  const reduced = useMemo(prefersReducedMotion, []);
  const [stage, setStage] = useState(reduced ? 6 : 0);

  useEffect(() => {
    if (!report || reduced) return;
    const timers = [
      setTimeout(() => setStage(1), 150),
      setTimeout(() => setStage(2), 650),
      setTimeout(() => setStage(3), 950),
      setTimeout(() => setStage(4), 1900),
      setTimeout(() => setStage(5), 2350),
      setTimeout(() => setStage(6), 2650),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);

  if (!report) {
    navigate("input");
    return null;
  }

  if (report.priceMode === "findPrice") {
    navigate("report");
    return null;
  }

  const isBad = report.verdict === "bad";
  const vc = VERDICT_STYLES[report.verdict] ?? VERDICT_STYLES.fair;
  const ProductIcon = getCategoryIcon(report.product);

  const currencyShort = (code: string) => {
    const c = currencies.find((c) => c.code === code);
    return lang === "ar" ? c?.arShort : c?.enShort;
  };
  const cShort = currencyShort(report.currency) || report.currency;

  const fmt = (n: number) => Math.round(n).toLocaleString();

  const offeredAnimated = useCountUp(report.offeredPrice, 900, stage >= 3);
  const fairAnimated = useCountUp(
    typeof report.marketFairPriceMin === "number" ? report.marketFairPriceMin : null,
    900,
    stage >= 3
  );

  // Money saved / overpay — driven purely by the real analyzed numbers.
  const savedAmount = typeof report.moneySaved === "number" && report.moneySaved > 0 ? report.moneySaved : null;
  const overpayAmount =
    savedAmount === null && typeof report.moneySaved === "number" && report.moneySaved < 0
      ? Math.abs(report.moneySaved)
      : null;
  const pillAmount = savedAmount ?? overpayAmount;
  const pillAnimated = useCountUp(pillAmount, 700, stage >= 5);

  // Position bar: where the offered price sits between the fair min/max.
  const min = typeof report.marketFairPriceMin === "number" ? report.marketFairPriceMin : null;
  const max = typeof report.marketFairPriceMax === "number" ? report.marketFairPriceMax : null;
  let barPct = 50;
  if (min !== null && max !== null && max > min) {
    barPct = Math.max(4, Math.min(100, ((report.offeredPrice - min) / (max - min)) * 100));
  } else if (min !== null && report.offeredPrice <= min) {
    barPct = 8;
  } else if (max !== null && report.offeredPrice >= max) {
    barPct = 92;
  }

  const handleShare = async () => {
    // Percentage badge: how far the offered price sits from the fair price,
    // using the same `min` the price-position bar already shows.
    let pctLabel: string | null = null;
    let pctPrefix: string | null = null;
    if (min !== null && min > 0) {
      if (isBad) {
        const pct = Math.round(((report.offeredPrice - min) / min) * 100);
        if (pct > 0) {
          pctLabel = `+${pct}%`;
          pctPrefix = t("shareCardPctOverpriced");
        }
      } else {
        const pct = Math.round(((min - report.offeredPrice) / min) * 100);
        if (pct > 0) {
          pctLabel = `-${pct}%`;
          pctPrefix = t("shareCardPctCheaper");
        }
      }
    }

    let blob: Blob | null = null;
    try {
      blob = await generateShareCard({
        lang,
        verdict: report.verdict,
        productName: report.product,
        offeredPrice: report.offeredPrice,
        fairPrice: min,
        currencyShort: cShort,
        pctLabel,
        copy: {
          tagline: t("shareCardTagline"),
          hookLine: isBad ? t("shareCardHookBad") : t("shareCardHookGood"),
          verdictLabel: isBad
            ? t("revealNotGoodDeal")
            : t(report.verdict === "good" ? "goodDeal" : "fairDeal"),
          offeredLabel: t("offeredPrice"),
          fairLabel: t("revealFairPriceFrom"),
          fairLockNote: t("shareCardFairLockNote"),
          pctPrefix,
          lockedTitle: t("revealLockedTitle"),
          lockedDesc: t("revealLockedDesc"),
          ctaLabel: t("revealSeeFullAnalysis"),
          shareLabel: t("revealShare"),
          footerCta: t("shareCardFooterCta"),
          brand: t("appName"),
        },
      });
    } catch {
      blob = null; // canvas unsupported or drawing failed — fall through to text share
    }

    if (blob) {
      const file = new File([blob], "qarari-verdict.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: t("appName") });
        } catch {
          // user cancelled the share sheet — no-op, not an error
        }
        return;
      }
      // No file-sharing support (older browsers) — download the image directly
      // so the user still ends up with a shareable picture in their gallery.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "qarari-verdict.png";
      a.click();
      URL.revokeObjectURL(url);
      showToast(t("shareCardSaved"));
      return;
    }

    // Last-resort fallback: plain text share (original behavior).
    const summary = `${t("appName")} — ${report.product}\n${t(
      report.verdict === "good" ? "goodDeal" : report.verdict === "fair" ? "fairDeal" : "badDeal"
    )}\n${t("offeredPrice")}: ${fmt(report.offeredPrice)} ${cShort}${
      pillAmount !== null
        ? `\n${t(savedAmount !== null ? "revealSavedAmount" : "revealOverpaidAmount")}: ${fmt(pillAmount)} ${cShort}`
        : ""
    }`;
    if (navigator.share) {
      try {
        await navigator.share({ text: summary, title: t("appName") });
      } catch {
        // user cancelled — no-op
      }
    } else {
      navigator.clipboard.writeText(summary);
      showToast(t("copied"));
    }
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-64px)] max-w-lg flex-col items-center justify-center px-5 py-8 text-center">
      {/* Verdict badge */}
      <div className={stage >= 1 ? "reveal-badge-pop" : "opacity-0"}>
        <div
          className={`flex h-24 w-24 items-center justify-center rounded-full ${vc.badgeBg} shadow-2xl ${vc.glow} ring-8 ${vc.ring}`}
        >
          {isBad ? <X className="h-12 w-12 text-white" strokeWidth={3} /> : <Check className="h-12 w-12 text-white" strokeWidth={3} />}
        </div>
      </div>

      {/* Verdict label + product name */}
      <div className={`mt-5 ${stage >= 2 ? "reveal-fade-rise" : "opacity-0"}`}>
        <h1 className={`font-serif text-2xl font-bold ${vc.text}`}>
          {isBad
            ? t("revealNotGoodDeal")
            : t(report.verdict === "good" ? "goodDeal" : "fairDeal")}
        </h1>
        <p className="mt-1.5 flex items-center justify-center gap-2 text-sm text-zinc-400">
          <ProductIcon className="h-4 w-4 text-amber-400/80" strokeWidth={1.5} />
          <span className="max-w-[220px] truncate">{report.product}</span>
        </p>
      </div>

      {/* Price comparison count-up */}
      <div className={`mt-7 grid w-full grid-cols-2 gap-3 ${stage >= 3 ? "reveal-fade-rise" : "opacity-0"}`}>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs text-zinc-500">{t("offeredPrice")}</p>
          <p className="mt-1 text-xl font-bold text-zinc-100">{fmt(offeredAnimated)}</p>
          <p className="text-[11px] text-zinc-500">{cShort}</p>
        </div>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs text-zinc-500">{t("revealFairPriceFrom")}</p>
          <p className="mt-1 text-xl font-bold text-amber-400">
            {min === null ? (lang === "ar" ? "غير متوفر" : "N/A") : fmt(fairAnimated)}
          </p>
          <p className="text-[11px] text-zinc-500">{cShort}</p>
        </div>
      </div>

      {/* Position bar: where the offered price sits within the fair range */}
      {min !== null && max !== null && (
        <div className={`mt-4 w-full ${stage >= 4 ? "reveal-fade-rise" : "opacity-0"}`}>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full bg-gradient-to-r ${
                isBad ? "from-red-500 to-red-400" : "from-emerald-500 to-emerald-400"
              } transition-all duration-700 ease-out`}
              style={{ width: stage >= 4 ? `${barPct}%` : "0%" }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-zinc-500">
            <span>{fmt(min)} {cShort}</span>
            <span>{fmt(max)} {cShort}</span>
          </div>
        </div>
      )}

      {/* Savings / overpay pill */}
      {pillAmount !== null && (
        <div className={`mt-5 ${stage >= 5 ? "reveal-fade-rise" : "opacity-0"}`}>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-bold ${vc.pillBg} ${vc.pillText}`}>
            {t(savedAmount !== null ? "revealSavedAmount" : "revealOverpaidAmount")}: {fmt(pillAnimated)} {cShort}
          </span>
        </div>
      )}

      {/* Blurred/locked preview of the full report */}
      <div className={`relative mt-7 w-full overflow-hidden rounded-2xl border border-amber-500/15 bg-zinc-900/60 p-5 ${stage >= 6 ? "reveal-fade-rise" : "opacity-0"}`}>
        <div className="space-y-2.5" style={{ filter: "blur(5px)" }} aria-hidden="true">
          <div className="h-3 w-3/4 rounded bg-zinc-700" />
          <div className="h-3 w-full rounded bg-zinc-700" />
          <div className="h-3 w-5/6 rounded bg-zinc-700" />
          <div className="h-3 w-2/3 rounded bg-zinc-700" />
          <div className="h-3 w-full rounded bg-zinc-700" />
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#0B0B0F]/75 px-6 text-center">
          <Lock className="h-6 w-6 text-amber-400" />
          <p className="text-sm font-bold text-zinc-100">{t("revealLockedTitle")}</p>
          <p className="text-xs leading-relaxed text-zinc-400">{t("revealLockedDesc")}</p>
        </div>
      </div>

      {/* Primary CTA */}
      <button
        onClick={() => navigate("report")}
        className={`relative mt-5 flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-amber-400 to-amber-600 py-4 font-bold text-[#0B0B0F] shadow-xl shadow-amber-500/25 transition-transform active:scale-[0.98] ${stage >= 6 ? "reveal-fade-rise" : "opacity-0"}`}
      >
        <span className="pointer-events-none absolute inset-0 overflow-hidden">
          <span className="reveal-cta-shine absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        </span>
        <Sparkles className="h-4 w-4" />
        {t("revealSeeFullAnalysis")}
      </button>

      {/* Secondary share action */}
      <button
        onClick={handleShare}
        className={`mt-3 flex items-center gap-2 text-sm font-medium text-zinc-400 transition-colors hover:text-amber-400 ${stage >= 6 ? "reveal-fade-rise" : "opacity-0"}`}
      >
        <Share2 className="h-4 w-4" /> {t("revealShare")}
      </button>
    </div>
  );
}
