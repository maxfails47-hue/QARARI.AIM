import { useState, useRef, useMemo } from "react";
import { FutureValueCard } from "@/components/FutureValueCard";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { getCategoryIcon } from "@/lib/categoryIcons";
import { currencies, SHOW_BTECH_COMPARISON } from "@/lib/types";
import type { Verdict } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Info, TrendingUp, AlertTriangle, Check, X, Compass,
  Shield, Lightbulb, Copy, Share2, Bookmark, Bell,
  ThumbsUp, ThumbsDown, MessageCircle, Mic, Send,
  Sparkles, GitCompare, Crown, Users, RefreshCw, DollarSign, Handshake,
  ExternalLink, ShoppingCart,
} from "lucide-react";

// ---- "Search the best price yourself" (Jumia/Amazon/Noon/optionally B.TECH) ----
// Renders whenever the report carries at least one store link. Each entry
// now also carries a REAL live price/stock status when api/analyze.ts
// managed to resolve one (see api/_priceResolver.ts) — shown next to the
// link when available; falls back to a plain "view current price" link
// when a store's price couldn't be read live.
function RetailerSearchLinks({
  retailerPrices,
  lang,
}: {
  retailerPrices: { retailer: string; url: string; price?: number | null; currency?: string; inStock?: boolean | null }[];
  lang: "ar" | "en";
}) {
  const visibleLinks = retailerPrices.filter(
    (rp) => SHOW_BTECH_COMPARISON || rp.retailer.toUpperCase() !== "B.TECH"
  );

  if (visibleLinks.length < 1) return null;

  const cheapestPrice = visibleLinks.reduce<number | null>((min, rp) => {
    if (typeof rp.price !== "number") return min;
    return min === null ? rp.price : Math.min(min, rp.price);
  }, null);

  return (
    <div className="mb-4 rounded-xl border border-amber-500/15 bg-[#0B0B0F] p-5">
      <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
        <ShoppingCart className="h-5 w-5" />
        {lang === "ar" ? "دور على أفضل سعر بنفسك" : "Find the best price yourself"}
      </h2>
      <p className="mt-1 mb-4 text-xs text-zinc-500">
        {lang === "ar"
          ? "الأسعار دي حقيقية اتقرت من صفحات المتاجر نفسها دلوقتي، مش تقدير — بس ينفع تتغير قبل ما تدوس اشتري."
          : "These prices were read live from each store's own page just now — not an estimate — but they can still change before checkout."}
      </p>

      <div className="space-y-2.5">
        {visibleLinks.map((rp, i) => {
          const hasPrice = typeof rp.price === "number";
          const isCheapest = hasPrice && cheapestPrice !== null && rp.price === cheapestPrice;
          return (
            <a
              key={i}
              href={rp.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-between rounded-xl border p-3.5 transition-colors ${
                isCheapest ? "border-amber-400/50 bg-amber-500/10" : "border-zinc-700 bg-zinc-800/40 hover:bg-zinc-800/70"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-xs font-bold text-[#0B0B0F]">
                  {rp.retailer.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <span className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
                    {rp.retailer}
                    {isCheapest && (
                      <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-[#0B0B0F]">
                        {lang === "ar" ? "الأرخص" : "Cheapest"}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-zinc-500">
                    {hasPrice
                      ? rp.inStock === false
                        ? lang === "ar" ? "غير متوفر حاليًا" : "Currently out of stock"
                        : lang === "ar" ? "متوفر" : "In stock"
                      : lang === "ar" ? "شوف السعر الحالي" : "View current price"}
                  </span>
                </div>
              </div>
              {hasPrice ? (
                <div className="text-end">
                  <p className="font-bold text-zinc-100">{Math.round(rp.price as number).toLocaleString()} {rp.currency}</p>
                </div>
              ) : (
                <ExternalLink className="h-4 w-4 shrink-0 text-zinc-500" />
              )}
            </a>
          );
        })}
      </div>

      <p className="mt-3.5 text-[11px] leading-relaxed text-zinc-500">
        {lang === "ar"
          ? "كل لينك بيوديك مباشرة لأول منتج فعلي لقيناه في نتائج البحث بالمتجر ده — مش صفحة بحث عامة. لو معرفناش نقرا السعر حيًا من صفحة المتجر، بنورّيك اللينك برضه من غير رقم بدل ما نخمّن. بعض الروابط شراكة تجارية، وده مش بيأثر على ترتيب أو تقييم 'قرار' للصفقة."
          : "Each link takes you straight to the actual first product we found in that store's search results — not a generic search page. If we couldn't read a live price off the store's page, we still show the link without a number rather than guess. Some links are commercial partnerships; this doesn't affect Qarari's ranking or rating of the deal."}
      </p>
    </div>
  );
}

export function ReportScreen() {
  const { t, lang, dir, currentReport, navigate, saveToHistory, history, user, session, showToast, isPremium, requireAuth } = useApp();
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);
  const [showFeedbackBox, setShowFeedbackBox] = useState(false);
  const [isWatched, setIsWatched] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRemaining, setChatRemaining] = useState(20);
  const [chatLimitHit, setChatLimitHit] = useState(false);
  const [listening, setListening] = useState(false);
  const [negVariant, setNegVariant] = useState<"polite" | "firm">("polite");
  const [showCompareInput, setShowCompareInput] = useState(false);
  const [compareProduct, setCompareProduct] = useState("");
  const recognitionRef = useRef<any>(null);

  const report = currentReport;
  if (!report) {
    navigate("input");
    return null;
  }

  // Temporary debug log — remove once the null/undefined-field rendering
  // issue is confirmed fixed in production.
  console.log("FULL AI RESPONSE:", report);

  // ---- Defensive formatting helpers ----
  // The AI is allowed to return null for pricing fields when it has no
  // reliable market data (see api/analyze.ts), and any of the optional
  // fields can legitimately be missing. Never assume a field exists before
  // calling a method on it.
  const naLabel = lang === "ar" ? "غير متوفر" : "N/A";
  const fmtPrice = (n: unknown): string => (typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : naLabel);
  const bilingualSafe = (bt: { ar?: string; en?: string } | null | undefined): string =>
    (lang === "ar" ? bt?.ar : bt?.en) ?? "";
  const bilingualArrSafe = (ba: { ar?: string[]; en?: string[] } | null | undefined): string[] =>
    (lang === "ar" ? ba?.ar : ba?.en) ?? [];

  const isExample = report.id.startsWith("demo-");
  // "Saved" must only reflect the real account-synced history — guests get
  // auto-added to a local on-device history the moment a report is
  // generated (see InputScreen's addToGuestHistory call), which is a
  // different thing from actually saving to their account. Checking that
  // local list here made the button permanently show "already saved" for
  // guests before they ever pressed it, since it always matched.
  const isSaved = !!session?.user && history.some((h) => h.id === report.id);
  // Item 4: premium analyses are now auto-saved server-side the moment the
  // analysis completes (api/analyze.ts), before the client's local
  // `history` list has necessarily refreshed to include it. Trusting
  // isPremium here (rather than waiting on that refresh) avoids the
  // confusing moment where a premium user sees an active "Save" button for
  // a report that's already in their history.
  const effectivelySaved = isPremium || isSaved;

  const currencyShort = (code: string) => {
    const c = currencies.find((c) => c.code === code);
    return lang === "ar" ? c?.arShort : c?.enShort;
  };
  const cShort = currencyShort(report.currency);

  const verdictConfig: Record<Verdict, { color: string; bg: string; border: string }> = {
    good: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
    fair: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
    bad: { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
  };
  const vc = verdictConfig[report.verdict] ?? verdictConfig.fair;

  const ProductIcon = useMemo(() => getCategoryIcon(report.product), [report.product]);

  const handleSave = () => {
    requireAuth(async () => {
      const ok = await saveToHistory(report);
      showToast(ok ? t("saveToHistory") + " ✓" : (lang === "ar" ? "حصل خطأ، حاول تاني" : "Something went wrong, please try again"));
    });
  };

  const handleShare = async () => {
    const summary = `${t("appName")} — ${report.product}\n${t(report.verdict === "good" ? "goodDeal" : report.verdict === "fair" ? "fairDeal" : "badDeal")}\n${t("offeredPrice")}: ${fmtPrice(report.offeredPrice)} ${cShort}\n${t("fairPriceRange")}: ${fmtPrice(report.marketFairPriceMin)}-${fmtPrice(report.marketFairPriceMax)} ${cShort}\n${t("potentialSavings")}: ${fmtPrice(report.moneySaved)} ${cShort}`;
    if (navigator.share) {
      try { await navigator.share({ text: summary, title: t("appName") }); } catch {}
    } else {
      navigator.clipboard.writeText(summary);
      showToast(t("copied"));
    }
  };

  const activeNegotiationText = (): { ar: string; en: string } => {
    const variant = isPremium && report.negotiationScriptVariants ? report.negotiationScriptVariants[negVariant] : null;
    // Guard against older/cached reports where a variant exists but is
    // empty — fall back to the base script rather than showing a blank box.
    return variant && variant.ar ? variant : report.negotiationScript;
  };

  const handleCopyNegotiation = () => {
    const text = bilingualSafe(activeNegotiationText());
    navigator.clipboard.writeText(text);
    showToast(t("copied"));
  };

  const handleWhatsAppShare = () => {
    const text = bilingualSafe(activeNegotiationText());
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  };

  const handleFeedback = (type: "up" | "down") => {
    if (type === "up") { setFeedbackGiven("up"); showToast(t("thanksFeedback")); }
    else { setFeedbackGiven("down"); setShowFeedbackBox(true); }
  };

  const submitFeedback = () => {
    setFeedbackGiven("down"); setShowFeedbackBox(false); showToast(t("thanksFeedback"));
  };

  const toggleListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast(lang === "ar" ? "المتصفح لا يدعم الإدخال الصوتي" : "Browser doesn't support voice input"); return; }
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.lang = lang === "ar" ? "ar-EG" : "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setChatInput((prev) => (prev ? prev + " " : "") + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  };

  const sendChat = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? chatInput).trim();
    if (!question || chatLoading) return;

    // Demo/example reports never hit the real API — no product to actually
    // research and no point spending a Groq call on it.
    if (isExample) {
      setChatMessages((prev) => [...prev, { role: "user", content: question }, { role: "assistant", content: t("chatDisabledExample") }]);
      setChatInput("");
      return;
    }

    if (chatLimitHit || chatRemaining <= 0) {
      setChatLimitHit(true);
      return;
    }

    const outgoingHistory = [...chatMessages, { role: "user" as const, content: question }];
    setChatMessages(outgoingHistory);
    setChatInput("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          reportId: report.id,
          product: report.product,
          offeredPrice: report.offeredPrice,
          currency: report.currency,
          verdict: report.verdict,
          marketFairPriceMin: report.marketFairPriceMin,
          marketFairPriceMax: report.marketFairPriceMax,
          question,
          history: chatMessages.slice(-8),
          language: lang,
        }),
      });

      if (res.status === 403) {
        setChatLimitHit(true);
        setChatRemaining(0);
        setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatLimitReached") }]);
        return;
      }

      if (!res.ok) {
        setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatError") }]);
        return;
      }

      const data = await res.json();
      setChatMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      if (!data.unlimited && typeof data.remaining === "number") {
        setChatRemaining(data.remaining);
        if (data.remaining <= 0) setChatLimitHit(true);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatError") }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Quick-chip shortcuts into the same assistant chat — no separate bot,
  // no new API, just a pre-filled question sent through the existing /api/ask
  // flow so it reuses this report's real offeredPrice/marketFairPrice data.
  const askQuickQuestion = (question: string) => {
    setShowChat(true);
    sendChat(question);
  };

  const handleCompare = () => {
    if (!isPremium) {
      navigate("upgrade");
      return;
    }
    if (!compareProduct.trim()) return;
    // Hand off both sides explicitly: product B is what was just typed here,
    // product A/price A/currency come from the report currently being viewed.
    // CompareScreen consumes both one-time on mount, so a later plain visit
    // to the compare tab (nav bar, history, etc.) starts genuinely blank
    // instead of re-showing this report's product every time.
    sessionStorage.setItem("qarari-compare-prefill-b", compareProduct.trim());
    if (currentReport) {
      sessionStorage.setItem(
        "qarari-compare-prefill-a",
        JSON.stringify({
          product: currentReport.product,
          price: currentReport.offeredPrice,
          currency: currentReport.currency,
        })
      );
    }
    setShowCompareInput(false);
    setCompareProduct("");
    navigate("compare");
  };

  const bilingual = (bt: { ar: string; en: string } | null | undefined) => bilingualSafe(bt);
  const bilingualArr = (ba: { ar: string[]; en: string[] } | null | undefined) => bilingualArrSafe(ba);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 pb-24">
      {isExample && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-400">
          <Sparkles className="h-4 w-4" /> {t("example")}
        </div>
      )}

      {/* Product Header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black shadow-lg ring-1 ring-amber-500/20">
          {report.productImage ? (
            <img
              src={report.productImage}
              alt={report.product}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              className="relative h-full w-full object-contain bg-white p-1.5"
            />
          ) : (
            <>
              <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 via-transparent to-transparent" />
              <ProductIcon className="relative h-10 w-10 text-amber-400/90" strokeWidth={1.5} />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-2xl font-bold text-amber-400">{report.product}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-zinc-800/60 px-2.5 py-1 text-sm text-zinc-300">
              {fmtPrice(report.offeredPrice)} {cShort}
            </span>
            <span className={`rounded-lg ${vc.bg} ${vc.border} border px-2.5 py-1 text-sm font-medium ${vc.color}`}>
              {t(report.verdict === "good" ? "goodDeal" : report.verdict === "fair" ? "fairDeal" : "badDeal")}
            </span>
            {typeof report.moneySaved === "number" && report.moneySaved > 0 && (
              <span className="rounded-lg bg-emerald-500/10 px-2.5 py-1 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/20">
                {t("moneySaved")}: {fmtPrice(report.moneySaved)} {cShort}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Market Overview */}
      <div className="mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Search className="h-5 w-5" /> {t("marketOverview")}
        </h2>
        <div className="flex items-center justify-between rounded-xl bg-zinc-800/40 p-4">
          <div className="text-center">
            <p className="text-xs text-zinc-500">{t("offeredPrice")}</p>
            <p className="mt-1 text-lg font-bold text-zinc-100">{fmtPrice(report.offeredPrice)}</p>
            <p className="text-xs text-zinc-500">{cShort}</p>
          </div>
          <div className="h-12 w-px bg-zinc-700" />
          <div className="text-center">
            <p className="text-xs text-zinc-500">{t("fairPriceRange")}</p>
            <p className="mt-1 text-lg font-bold text-amber-400">
              {report.marketFairPriceMin === null && report.marketFairPriceMax === null
                ? naLabel
                : `${fmtPrice(report.marketFairPriceMin)}–${fmtPrice(report.marketFairPriceMax)}`}
            </p>
            <p className="text-xs text-zinc-500">{cShort}</p>
          </div>
        </div>
        {bilingual(report.marketPriceSummary) && (
          <p className="mt-3 rounded-lg bg-zinc-800/30 p-3 text-sm leading-relaxed text-zinc-300">
            {bilingual(report.marketPriceSummary)}
          </p>
        )}
      </div>

      {/* "Search the best price yourself" — Jumia/Amazon/Noon/optionally
          B.TECH, with a real live price shown per store when resolved */}
      {report.retailerPrices && report.retailerPrices.length > 0 && (
        <RetailerSearchLinks retailerPrices={report.retailerPrices} lang={lang} />
      )}

      {/* Community Radar — REAL data with enhanced social proof */}
      {report.communityInsights && report.communityInsights.analyzedCount >= 3 && (
        <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-emerald-400">
            <Users className="h-5 w-5" /> {t("communityInsightsTitle")}
          </h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="rounded-lg bg-zinc-800/40 p-3 text-center">
              <p className="text-2xl font-bold text-emerald-400">{report.communityInsights.analyzedCount}</p>
              <p className="text-xs text-zinc-400">{lang === "ar" ? "شخص حلّل المنتج ده" : "people analyzed this product"}</p>
            </div>
            <div className="rounded-lg bg-zinc-800/40 p-3 text-center">
              <p className="text-2xl font-bold text-amber-400">
                {report.communityInsights.recentPrices?.length
                  ? Math.round((report.communityInsights.recentPrices.reduce((a, b) => a + b, 0) / report.communityInsights.recentPrices.length) / report.offeredPrice * 100)
                  : naLabel}
                %
              </p>
              <p className="text-xs text-zinc-400">{lang === "ar" ? "سعر منتجك من متوسط السوق" : "Your price vs market avg"}</p>
            </div>
          </div>
          {(report.communityInsights.recentPrices ?? []).length > 1 && (
            <div className="border-t border-emerald-500/15 pt-3">
              <p className="mb-2 text-xs text-zinc-500">{t("communityRecentPrices")}</p>
              <div className="flex flex-wrap gap-2">
                {(report.communityInsights.recentPrices ?? []).map((p, i) => (
                  <span
                    key={i}
                    className={`rounded-lg px-2.5 py-1 text-sm ${
                      p === report.offeredPrice
                        ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                        : p < report.offeredPrice
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {fmtPrice(p)} {cShort}
                    {p === report.offeredPrice && (lang === "ar" ? " (سعر انت)" : " (your price)")}
                  </span>
                ))}
              </div>
              <div className="mt-3 rounded-lg bg-zinc-800/30 p-2.5">
                <p className="text-xs text-zinc-400">
                  {lang === "ar"
                    ? `📊 ${report.communityInsights.recentPrices!.filter((p) => p <= report.offeredPrice).length} من ${report.communityInsights.recentPrices!.length} شخص دفعوا نفس السعر أو أقل`
                    : `📊 ${report.communityInsights.recentPrices!.filter((p) => p <= report.offeredPrice).length} out of ${report.communityInsights.recentPrices!.length} paid the same or less`}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Final Verdict */}
      <div className="mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Info className="h-5 w-5" /> {t("finalVerdict")}
        </h2>
        <ol className={`space-y-2 ${dir === "rtl" ? "pr-5" : "pl-5"}`}>
          {bilingualArr(report.reasoningPoints).map((point, i) => (
            <li key={i} className="text-sm text-zinc-300">
              <span className="font-bold text-amber-400">{i + 1}.</span> {point}
            </li>
          ))}
        </ol>
        {isPremium && (
          <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500">
            <Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}
          </p>
        )}
      </div>

      {/* Before You Buy */}
      <div className={`mb-4 rounded-xl border ${report.verdict === "bad" ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"} p-4`}>
        <div className="flex items-start gap-2">
          <AlertTriangle className={`h-5 w-5 shrink-0 ${report.verdict === "bad" ? "text-red-400" : "text-amber-400"}`} />
          <div>
            <p className={`text-sm font-bold ${report.verdict === "bad" ? "text-red-400" : "text-amber-400"}`}>{t("beforeYouBuy")}</p>
            <p className="mt-1 text-sm text-zinc-300">
              {bilingual(report.preRecommendation) ||
                (lang === "ar"
                  ? "راجع سعر السوق العادل والحالة المذكورة للمنتج بعناية قبل إتمام الشراء."
                  : "Review the fair market price and the product's stated condition carefully before completing this purchase.")}
            </p>
          </div>
        </div>
      </div>

      {/* Future + Regret */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-400">
            <TrendingUp className="h-4 w-4" /> {t("futureCompatibility")}
          </h3>
          <p className="text-sm text-zinc-300">
            {bilingual(report.futureCompatibility) ||
              (lang === "ar"
                ? "معلومات التوافق المستقبلي مش متاحة لهذا المنتج حالياً."
                : "Future compatibility info isn't available for this product right now.")}
          </p>
        </div>
        <div className="rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-400">
            <AlertTriangle className="h-4 w-4" /> {t("regretProbability")}
          </h3>
          <span className={`inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${
            report.regretLevel === "low" ? "bg-emerald-500/10 text-emerald-400" :
            report.regretLevel === "medium" ? "bg-amber-500/10 text-amber-400" :
            "bg-red-500/10 text-red-400"
          }`}>
            {t(report.regretLevel ?? "medium")}
          </span>
          <p className="mt-2 text-sm text-zinc-300">{bilingual(report.regretJustification)}</p>
        </div>
      </div>

      {/* Future Value Card - Premium */}
      {report.resaleValue2Years && (
        <FutureValueCard
          lang={lang}
          offeredPrice={report.offeredPrice}
          resaleValue2Years={report.resaleValue2Years}
          resaleDepreciationRate={report.resaleDepreciationRate}
          currencyShort={cShort}
        />
      )}

      {/* Cons + Pros */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {dir === "rtl" ? (
          <>
            <div className="rounded-xl border border-red-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-red-400">
                <X className="h-4 w-4" /> {t("cons")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.cons).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <X className="h-4 w-4 shrink-0 text-red-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
            <div className="rounded-xl border border-emerald-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Check className="h-4 w-4" /> {t("pros")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.pros).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-emerald-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Check className="h-4 w-4" /> {t("pros")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.pros).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
            <div className="rounded-xl border border-red-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-red-400">
                <X className="h-4 w-4" /> {t("cons")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.cons).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <X className="h-4 w-4 shrink-0 text-red-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
          </>
        )}
      </div>

      {/* Better Alternatives + Compare Button */}
      <div className="mb-4">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Compass className="h-5 w-5" /> {t("betterAlternatives")}
        </h2>
        <div className="space-y-3">
          {(report.betterAlternatives ?? []).map((alt, i) => {
            const AltIcon = getCategoryIcon(alt?.name ?? "");
            const altLinks = (alt?.searchLinks ?? []).filter(
              (l) => SHOW_BTECH_COMPARISON || l.retailer.toUpperCase() !== "B.TECH"
            );
            return (
              <div key={i} className="flex items-start gap-3 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-4">
                <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black shadow-md ring-1 ring-amber-500/20">
                  <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 via-transparent to-transparent" />
                  <AltIcon className="relative h-7 w-7 text-amber-400/90" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-bold text-zinc-100">{alt?.name ?? naLabel}</h3>
                  <p className="mt-1 text-xs text-zinc-400">{bilingual(alt?.reason)}</p>
                  <p className="mt-1 text-xs text-zinc-500">{bilingual(alt?.whySuitable)}</p>

                  {(typeof alt?.fairPriceMin === "number" || typeof alt?.fairPriceMax === "number") && (
                    <p className="mt-1.5 text-xs font-bold text-amber-400">
                      {t("fairPriceRange")}: {fmtPrice(alt?.fairPriceMin ?? null)}–{fmtPrice(alt?.fairPriceMax ?? null)} {cShort}
                    </p>
                  )}

                  {altLinks.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {altLinks.map((link, j) => (
                        <a
                          key={j}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-zinc-900/60 px-2.5 py-1 text-[11px] font-bold text-amber-400 transition-colors hover:bg-amber-500/10"
                        >
                          <ExternalLink className="h-3 w-3" /> {link.retailer}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Compare with another product */}
        <div className="mt-3">
          {!showCompareInput ? (
            <Button
              onClick={() => setShowCompareInput(true)}
              variant="outline"
              className="w-full border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10"
            >
              <GitCompare className="h-4 w-4" /> {lang === "ar" ? "قارن بمنتج آخر" : "Compare with another product"}
              {!isPremium && <Crown className="ml-1 h-3 w-3" />}
            </Button>
          ) : (
            <div className="rounded-xl border border-amber-500/20 bg-zinc-900/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-amber-400">
                <GitCompare className="h-4 w-4" /> {lang === "ar" ? "قارن بمنتج آخر" : "Compare with another product"}
              </h3>
              <div className="flex gap-2">
                <Input
                  value={compareProduct}
                  onChange={(e) => setCompareProduct(e.target.value)}
                  placeholder={t("productNamePlaceholder")}
                  className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
                />
                <Button onClick={handleCompare} className="bg-amber-500 text-[#0B0B0F] hover:bg-amber-400">
                  <GitCompare className="h-4 w-4" /> {t("compareNow")}
                </Button>
              </div>
              <button onClick={() => setShowCompareInput(false)} className="mt-2 text-xs text-zinc-500 hover:text-zinc-300">
                {lang === "ar" ? "إلغاء" : "Cancel"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Negotiation Script */}
      <div className="mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <MessageCircle className="h-5 w-5" /> {t("negotiationScript")}
        </h2>
        {isPremium && (
          <div className="mb-3 flex gap-2">
            {(["polite", "firm"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setNegVariant(v)}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  negVariant === v ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30" : "bg-zinc-800/50 text-zinc-400"
                }`}
              >
                {t(v)}
              </button>
            ))}
          </div>
        )}
        <div className="rounded-xl bg-zinc-800/40 p-4">
          <p className="text-sm leading-relaxed text-zinc-200">{bilingual(activeNegotiationText())}</p>
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={handleCopyNegotiation} variant="outline" className="flex-1 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-amber-400">
            <Copy className="h-4 w-4" /> {t("copy")}
          </Button>

        </div>
      </div>

      {/* Hidden Risks */}
      <div className="mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Shield className="h-5 w-5" /> {t("hiddenRisks")}
        </h2>
        <ul className="space-y-2">
          {bilingualArr(report.hiddenRisks).map((risk, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              {risk}
            </li>
          ))}
        </ul>
        {isPremium && (
          <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500">
            <Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}
          </p>
        )}
      </div>

      {/* Final Tip */}
      <div className="mb-4 rounded-2xl border border-amber-500/30 bg-gradient-to-b from-amber-500/10 to-transparent p-6 text-center shadow-lg shadow-amber-500/5">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15">
          <Lightbulb className="h-6 w-6 text-amber-400" />
        </div>
        <p className="font-serif text-base leading-relaxed text-amber-100">{bilingual(report.finalTip)}</p>
      </div>

      {/* Feedback */}
      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-center">
        <p className="mb-3 text-sm text-zinc-400">{t("feedbackQuestion")}</p>
        {feedbackGiven ? (
          <p className="text-sm font-medium text-amber-400">{t("thanksFeedback")}</p>
        ) : (
          <div className="flex items-center justify-center gap-4">
            <button onClick={() => handleFeedback("up")} className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition-colors hover:bg-emerald-500/15 hover:text-emerald-400">
              <ThumbsUp className="h-5 w-5" />
            </button>
            <button onClick={() => handleFeedback("down")} className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400">
              <ThumbsDown className="h-5 w-5" />
            </button>
          </div>
        )}
        {showFeedbackBox && !feedbackGiven && (
          <div className="mt-3 space-y-2">
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder={t("tellUsWhy")}
              className="min-h-[60px] w-full rounded-lg border border-zinc-700 bg-zinc-800/50 p-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
            />
            <Button onClick={submitFeedback} className="w-full bg-amber-500 text-[#0B0B0F] hover:bg-amber-400">
              {t("submitFeedback")}
            </Button>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="grid grid-cols-2 gap-3">
        <Button onClick={handleSave} disabled={effectivelySaved} className="bg-amber-500 text-[#0B0B0F] hover:bg-amber-400 disabled:opacity-50">
          <Bookmark className="h-4 w-4" /> {effectivelySaved ? "✓ " + t("saveToHistory") : t("saveToHistory")}
        </Button>
        <Button onClick={handleShare} variant="outline" className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-amber-400">
          <Share2 className="h-4 w-4" /> {t("shareReport")}
        </Button>
        <Button onClick={() => navigate("input")} variant="outline" className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-amber-400">
          <Sparkles className="h-4 w-4" /> {t("newDecision")}
        </Button>
        <Button
          onClick={() => {
            requireAuth(async () => {
              if (!session?.user) return;
              const { error } = await supabase.from("watchlist").insert({
                user_id: session.user.id,
                product: report.product,
                saved_price: report.offeredPrice,
                currency: report.currency,
                condition: report.condition || "new",
              });
              if (error) {
                // Was previously ignored, so the toast below fired even when
                // the insert failed and nothing was actually saved.
                console.error("Save to watchlist failed:", error);
                showToast(lang === "ar" ? "حصل خطأ، حاول تاني" : "Something went wrong, please try again");
                return;
              }
              setIsWatched(true);
              showToast(t("notifyPriceDrop") + " ✓");
            });
          }}
          disabled={isWatched}
          variant="outline"
          className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 disabled:opacity-50"
        >
          <Bell className="h-4 w-4" /> {isWatched ? "✓ " + t("notifyPriceDrop") : t("notifyPriceDrop")}
        </Button>
      </div>

      {/* Quick-chip shortcuts into the assistant — only surfaced when there's
          an actual gap between offered and fair price worth negotiating.
          Deliberately NOT a separate card: same bot, pre-filled question. */}
      {typeof report.marketFairPriceMin === "number" && report.offeredPrice > report.marketFairPriceMin && (
        <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() =>
              askQuickQuestion(
                lang === "ar" ? "جهزلي سكريبت تفاوض على السعر ده" : "Give me a negotiation script for this price"
              )
            }
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/25 bg-zinc-900/60 px-3.5 py-2 text-xs font-bold text-amber-400 transition-colors hover:bg-amber-500/10"
          >
            <Handshake className="h-3.5 w-3.5" />
            {lang === "ar" ? "جهزلي سكريبت تفاوض" : "Negotiation script"}
          </button>
          <button
            onClick={() =>
              askQuickQuestion(
                lang === "ar" ? "ليه السعر ده تحديداً؟" : "Why exactly is this the fair price?"
              )
            }
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-700 bg-zinc-900/60 px-3.5 py-2 text-xs font-bold text-zinc-400 transition-colors hover:text-amber-400"
          >
            {lang === "ar" ? "ليه السعر ده تحديداً؟" : "Why this price?"}
          </button>
        </div>
      )}

      {/* Smart Assistant Trigger */}
      <div className="mt-4 flex justify-center">
        <button
          onClick={() => setShowChat(true)}
          className="group relative flex items-center gap-3 overflow-hidden rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 px-6 py-4 ring-1 ring-amber-500/20 transition-all hover:ring-amber-500/50 shadow-xl"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-amber-500/5 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-amber-600 text-[#0B0B0F] shadow-lg shadow-amber-500/30">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex flex-col items-start">
            <span className="text-sm font-bold text-amber-400">
              {lang === "ar" ? "اسأل لو لسه محتار" : "Ask if you're still unsure"}
            </span>
            <span className="text-[10px] text-zinc-500">
              {lang === "ar" ? "مساعدك الذكي جاهز للرد على أي سؤال" : "Your AI assistant is ready to help"}
            </span>
          </div>
        </button>
      </div>

      {/* Chat Panel — centered modal overlay so it always sits mid-screen and
          can never get clipped at a screen edge (fixes the old bottom-corner
          popup that could render half off-screen on mobile). */}
      {showChat && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowChat(false); }}
        >
          <div className="flex h-[75vh] max-h-[560px] w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-amber-500/30 bg-[#0B0B0F] shadow-2xl shadow-amber-500/10">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-gradient-to-r from-zinc-900 to-zinc-900/50 px-4 py-3.5">
              <span className="flex items-center gap-2 text-sm font-bold text-amber-400">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-300 to-amber-600 text-[#0B0B0F]">
                  <Sparkles className="h-4 w-4" />
                </span>
                {t("askAssistant")}
              </span>
              <div className="flex items-center gap-3">
                {!isExample && (
                  <span className="text-[10px] text-zinc-500">
                    {t("chatQuestionsLeft").replace("{n}", String(chatRemaining))}
                  </span>
                )}
                <button onClick={() => setShowChat(false)} className="text-zinc-500 hover:text-zinc-300">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center opacity-60">
                  <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300/20 to-amber-600/20 ring-1 ring-amber-500/20">
                    <Sparkles className="h-7 w-7 text-amber-400" />
                  </div>
                  <p className="text-xs text-zinc-500">{t("askAssistantHint")}</p>
                </div>
              ) : (
                chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                      msg.role === "user" ? "bg-amber-500 text-black font-medium" : "bg-zinc-800 text-zinc-200 border border-zinc-700"
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-400">{t("chatThinking")}</div>
                </div>
              )}
            </div>
            <div className="border-t border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                  placeholder={t("typeMessage")}
                  disabled={chatLoading || (chatLimitHit && !isExample)}
                  className="flex-1 min-w-0 rounded-xl border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={toggleListening}
                  disabled={chatLoading || (chatLimitHit && !isExample)}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-50 ${
                    listening ? "bg-red-500 text-white animate-pulse" : "bg-zinc-800 text-amber-400 hover:bg-zinc-700"
                  }`}
                >
                  <Mic className="h-5 w-5" />
                </button>
                <button
                  onClick={() => sendChat()}
                  disabled={chatLoading || (chatLimitHit && !isExample) || !chatInput.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-amber-600 text-black hover:brightness-110 disabled:opacity-50"
                >
                  <Send className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}