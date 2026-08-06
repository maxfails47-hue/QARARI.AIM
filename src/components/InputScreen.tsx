import { useState, useRef, useMemo, useEffect } from "react";
import { useApp } from "@/lib/AppContext";
import { getCategoryIcon, getIconByCategory } from "@/lib/categoryIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sparkles, Mic, Send, HelpCircle, X, ChevronDown, Check, Clock } from "lucide-react";
import { getCachedFingerprint } from "@/lib/fingerprint";

export function InputScreen() {
  const { t, lang, navigate, session, showToast, setHelpSheetOpen } = useApp();
  const [product, setProduct] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);

  // Chat Assistant State — unrelated to the search form, left as-is.
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{
    role: "user" | "assistant";
    content: string;
    productSuggestions?: { name: string; approxPrice: string; reason: string }[];
  }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRemaining, setChatRemaining] = useState<number | null>(null);
  const [chatLimitHit, setChatLimitHit] = useState(false);
  const [listening, setListening] = useState(false);
  const [productVoiceListening, setProductVoiceListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const productVoiceRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ─── Voice Input for Product Name ───
  // Uses Web Speech API to capture the product name ONLY from voice. The
  // full transcript is placed entirely in the product name field.
  const toggleProductVoiceInput = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      showToast(lang === "ar" ? "المتصفح لا يدعم الإدخال الصوتي" : "Browser doesn't support voice input");
      return;
    }
    if (productVoiceListening) {
      productVoiceRef.current?.stop();
      setProductVoiceListening(false);
      return;
    }

    const rec = new SR();
    rec.lang = lang === "ar" ? "ar-EG" : "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript.trim();
      if (transcript) {
        setProduct((prev) => (prev ? prev + " " : "") + transcript);
      }
      showToast(lang === "ar" ? "تم إدخال اسم المنتج" : "Product name added");
    };

    rec.onend = () => setProductVoiceListening(false);
    rec.onerror = () => setProductVoiceListening(false);

    rec.start();
    productVoiceRef.current = rec;
    setProductVoiceListening(true);
  };

  // Device fingerprint — fetched once on mount and cached for the session.
  const [deviceFingerprint, setDeviceFingerprint] = useState<string | null>(null);
  useEffect(() => {
    getCachedFingerprint().then(setDeviceFingerprint);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

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

  const sendChat = async (overrideText?: string) => {
    const raw = overrideText ?? chatInput;
    if (!raw.trim() || chatLoading) return;
    if (!session?.user) {
      showToast(lang === "ar" ? "برجاء تسجيل الدخول أولاً" : "Please login first");
      navigate("login");
      return;
    }
    if (chatLimitHit || (chatRemaining !== null && chatRemaining <= 0)) {
      setChatLimitHit(true);
      return;
    }

    const question = raw.trim();
    setChatMessages((prev) => [...prev, { role: "user", content: question }]);
    setChatInput("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          question,
          mode: "advisor",
          language: lang,
          history: chatMessages.slice(-5),
        }),
      });

      if (res.status === 403) {
        setChatLimitHit(true);
        setChatRemaining(0);
        setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatLimitReached") }]);
        return;
      }

      const data = await res.json();
      if (data.answer) {
        const suggestions = Array.isArray(data.productSuggestions) && data.productSuggestions.length > 0
          ? data.productSuggestions
          : undefined;
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.answer, productSuggestions: suggestions }]);
      } else {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        setChatMessages((prev) => [...prev, { role: "assistant", content: text }]);
      }
      if (!data.unlimited && typeof data.remaining === "number") {
        setChatRemaining(data.remaining);
        if (data.remaining <= 0) setChatLimitHit(true);
      }
    } catch {
      showToast(t("chatError"));
    } finally {
      setChatLoading(false);
    }
  };

  const budgetChips = [t("budgetSuggestChip1"), t("budgetSuggestChip2"), t("budgetSuggestChip3")];

  const localIcon = useMemo(() => getCategoryIcon(product), [product]);

  // "Smart" product icon: local keyword match is instant; upgraded in the
  // background via a tiny classification call once the user pauses typing.
  const [aiCategory, setAiCategory] = useState<string | null>(null);
  useEffect(() => {
    setAiCategory(null);
    const trimmed = product.trim();
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const debounce = setTimeout(async () => {
      try {
        const res = await fetch("/api/user?action=classify-icon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productName: trimmed }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.category) setAiCategory(data.category);
      } catch {
        // Silent — the local keyword icon is already showing.
      } finally {
        clearTimeout(timeout);
      }
    }, 500);

    return () => {
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [product]);

  const Icon = aiCategory && aiCategory !== "other" ? getIconByCategory(aiCategory) : localIcon;

  useEffect(() => {
    async function fetchChatRemaining() {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        const res = await fetch("/api/user?action=chat-remaining", { method: "POST", headers, body: "{}" });
        const data = await res.json();
        if (typeof data.remaining === "number") setChatRemaining(data.remaining);
      } catch {
        // leave as null
      }
    }
    fetchChatRemaining();
  }, [session]);

  // Calls the /api/search endpoint: product name only, real per-store
  // prices back. Unmetered — Shary's search is free, no quota system.
  // reveal/report screens — those were built around the old verdict shape.
  // Results render inline below until the real "Full Analysis" screen
  // (Phase 5) exists.
  const [searchResult, setSearchResult] = useState<any>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);

  function timeAgo(iso: string, l: string): string {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return l === "ar" ? "الآن" : "just now";
    if (mins < 60) return l === "ar" ? `منذ ${mins} دقيقة` : `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return l === "ar" ? `منذ ${hrs} ساعة` : `${hrs}h ago`;
  }

  const handleSubmit = async () => {
    if (!product.trim()) {
      showToast(lang === "ar" ? "اكتب اسم المنتج" : "Enter a product name");
      return;
    }
    setLoading(true);
    setSearchError(null);
    setSearchResult(null);
    setWhyOpen(false);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: product.trim(), currency: "EGP", language: lang }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSearchError(err?.error || (lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry"));
        return;
      }

      const result = await res.json();
      setSearchResult(result);
      setRemaining((r) => (r !== null ? Math.max(0, r - 1) : r));
    } catch {
      setSearchError(lang === "ar" ? "تعذر الاتصال بالخادم" : "Couldn't reach the server");
    } finally {
      setLoading(false);
    }
  };


  const loadingMessages =
    lang === "ar"
      ? [
          "بندور في المتاجر...",
          "بنقارن الأسعار الحقيقية...",
          "بنتأكد من التوفر...",
          "قريبًا نلاقي أرخص سعر...",
        ]
      : [
          "Searching stores...",
          "Comparing real prices...",
          "Checking stock...",
          "Almost there...",
        ];

  useEffect(() => {
    if (!loading) {
      setLoadingMessageIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingMessageIndex((i) => (i + 1) % loadingMessages.length);
    }, 3500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, lang]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* Hero */}
      <div className="mb-6 text-center">
        <div className="mb-3 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-shary shadow-xl shadow-shary/30">
          <span className="text-2xl font-extrabold text-white">S</span>
        </div>
        <h1 className="text-3xl font-bold text-shary-dark">{t("appName")}</h1>
        <p className="mt-1 text-sm text-zinc-400">{t("tagline")}</p>
      </div>

      {/* Search Card — product name + voice only. Everything else
          (offered price, currency, condition, purpose/duration, photo
          upload, other specs) was removed on purpose: Shary no longer
          judges a price the user types in, it searches real stores. */}
      <div className="rounded-2xl border border-shary/15 bg-white p-6 shadow-2xl">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-medium text-zinc-700">{t("productName")}</Label>
              <button
                type="button"
                onClick={() => setHelpSheetOpen(true)}
                aria-label={lang === "ar" ? "إزاي شاري بيشتغل؟" : "How does Shary work?"}
                className="flex items-center gap-1 rounded-full border border-shary/40 bg-shary-light px-2 py-0.5 text-[11px] font-bold text-shary-dark hover:bg-shary/10"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {t("helpButtonLabel")}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-shary-light ring-1 ring-shary/20">
                <Icon className="relative h-6 w-6 text-shary-dark" strokeWidth={1.5} />
              </div>
              <Input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && handleSubmit()}
                placeholder={t("productNamePlaceholder")}
                className="flex-1 border-zinc-300 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-shary"
              />
              <button
                type="button"
                onClick={toggleProductVoiceInput}
                disabled={loading}
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border transition-all ${
                  productVoiceListening
                    ? "border-red-500 bg-red-50 text-red-500 animate-pulse"
                    : "border-zinc-300 bg-white text-shary-dark hover:border-shary hover:bg-shary-light"
                } disabled:opacity-50`}
                title={lang === "ar" ? "ادخل اسم المنتج بالصوت" : "Voice input for product name"}
              >
                <Mic className="h-5 w-5" />
              </button>
            </div>
            {productVoiceListening && (
              <p className="text-[11px] text-red-500 animate-pulse">
                {lang === "ar" ? "🎤 بتكلم دلوقتي... قول اسم المنتج" : "🎤 Listening... Say the product name"}
              </p>
            )}
          </div>

          {/* Submit */}
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full bg-shary text-white font-bold hover:bg-shary-dark disabled:opacity-90"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span key={loadingMessageIndex}>{loadingMessages[loadingMessageIndex]}</span>
              </span>
            ) : (
              <><Sparkles className="h-4 w-4" /> {lang === "ar" ? "دوّر على أرخص سعر" : "Find the best price"}</>
            )}
          </Button>

          {loading && (
            <div className="space-y-2 rounded-xl border border-shary/10 bg-shary-light/40 p-3">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="h-2.5 animate-pulse rounded-full bg-gradient-to-r from-zinc-200 via-zinc-100 to-zinc-200"
                  style={{ width: `${85 - row * 15}%`, animationDelay: `${row * 150}ms` }}
                />
              ))}
            </div>
          )}

          {/* Search error */}
          {searchError && !loading && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {searchError}
            </div>
          )}

          {/* Search results — inline stopgap until the real "Full Analysis"
              screen (Phase 5) exists. Every price/store here came back from
              /api/search a moment ago; see each card's tiny "•" source tag. */}
          {searchResult && !loading && (
            <div className="reveal-fade-rise space-y-3 rounded-2xl border border-zinc-200 bg-white p-4">
              {/* Header: product photo + name (photo only if a real store page had one) */}
              <div className="flex items-center gap-3">
                {searchResult.productImage && (
                  <img
                    src={searchResult.productImage}
                    alt={searchResult.product}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    className="h-16 w-16 shrink-0 rounded-xl border border-zinc-200 object-contain bg-white"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-zinc-800">{searchResult.product}</p>
                  <span className="text-[10px] text-zinc-400">
                    {searchResult.storesResolved}/{searchResult.storesChecked} {lang === "ar" ? "متاجر" : "stores"}
                  </span>
                </div>
              </div>

              {/* Best price hero — every figure here is a real field from /api/search */}
              {searchResult.cheapest && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                  <div className="flex items-end justify-between">
                    <div>
                      <p className="text-[10px] font-medium text-zinc-400">
                        {lang === "ar" ? "أفضل سعر" : "Best price"}
                      </p>
                      <p className="text-2xl font-extrabold text-zinc-900">
                        {searchResult.cheapest.price.toLocaleString()}
                        <span className="ms-1 text-sm font-semibold text-zinc-500">{searchResult.currency}</span>
                      </p>
                    </div>
                    <span className="rounded-full bg-shary px-2.5 py-1 text-[10px] font-bold text-white">
                      {lang === "ar" ? "الأرخص" : "Cheapest price"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-400">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {timeAgo(searchResult.cheapest.lastChecked, lang)}
                    </span>
                    {searchResult.savingsVsAverage && (
                      <span className="font-semibold text-shary-dark">
                        {lang === "ar"
                          ? `وفّرت ${searchResult.savingsVsAverage.toLocaleString()} ${searchResult.currency}`
                          : `You save ${searchResult.savingsVsAverage.toLocaleString()} ${searchResult.currency}`}
                        {" "}
                        {lang === "ar" ? "عن متوسط السعر" : "vs. average price"}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Real BUY NOW / WAIT verdict — score circle + collapsible real
                  reasons. Only rendered once price_history has enough real
                  data (see api/_priceHistory.ts) — null/null until then, so
                  nothing here is ever fabricated. */}
              {searchResult.decision && searchResult.priceHistory && (
                <div
                  className={`reveal-fade-rise rounded-xl border p-3 ${
                    searchResult.decision.verdict === "BUY_NOW"
                      ? "value-banner border-shary bg-shary-light"
                      : "border-amber-300 bg-amber-50"
                  }`}
                  style={{ animationDelay: "80ms" }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: `conic-gradient(${
                          searchResult.decision.verdict === "BUY_NOW" ? "#00B884" : "#f59e0b"
                        } ${searchResult.decision.score * 3.6}deg, #e4e4e7 0deg)`,
                      }}
                    >
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white">
                        <span className="text-sm font-extrabold text-zinc-800">{searchResult.decision.score}</span>
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm font-bold ${
                          searchResult.decision.verdict === "BUY_NOW" ? "text-shary-dark" : "text-amber-700"
                        }`}
                      >
                        {searchResult.decision.verdict === "BUY_NOW"
                          ? lang === "ar" ? "وقت ممتاز للشراء" : "Great time to buy"
                          : lang === "ar" ? "يفضل تستنى شوية" : "Better to wait"}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {lang === "ar" ? "أقل سعر مسجّل" : "Lowest ever"}: {searchResult.priceHistory.lowestEver.toLocaleString()}{" "}
                        {searchResult.currency} · {lang === "ar" ? "متوسط 90 يوم" : "90d avg"}:{" "}
                        {searchResult.priceHistory.average90d.toLocaleString()} {searchResult.currency}
                      </p>
                    </div>
                  </div>

                  {(searchResult.decision.reasons || []).length > 0 && (
                    <div className="mt-2 border-t border-black/5 pt-2">
                      <button
                        type="button"
                        onClick={() => setWhyOpen((v) => !v)}
                        className="flex w-full items-center justify-between text-[11px] font-semibold text-zinc-600"
                      >
                        {lang === "ar" ? "ليه القرار ده؟" : "Why this decision?"}
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${whyOpen ? "rotate-180" : ""}`} />
                      </button>
                      {whyOpen && (
                        <div className="mt-1.5 space-y-1">
                          {searchResult.decision.reasons.map((r: string, i: number) => (
                            <p key={i} className="flex items-start gap-1.5 text-[11px] text-zinc-600">
                              <Check className="mt-0.5 h-3 w-3 shrink-0 text-shary-dark" />
                              {r}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Instant analysis — real spread between today's cheapest/priciest
                  price, no history needed so it's always available (unlike the
                  historical verdict above). */}
              {searchResult.instantAnalysis && (
                <div className="value-banner reveal-fade-rise flex items-start gap-2 rounded-xl border border-shary/20 bg-shary-light p-3" style={{ animationDelay: "140ms" }}>
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-shary-dark" />
                  <p className="text-[12px] leading-relaxed text-shary-dark">{searchResult.instantAnalysis.message}</p>
                </div>
              )}

              {/* Store comparison */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-zinc-500">
                  {lang === "ar" ? "مقارنة المتاجر" : "Store comparison"}
                </p>
                {(searchResult.stores || []).map((s: any, i: number) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ animationDelay: `${i * 60}ms` }}
                    className={`reveal-fade-rise flex items-center justify-between rounded-xl border p-3 text-sm transition-colors ${
                      s.isCheapest ? "border-shary bg-shary-light" : "border-zinc-200 bg-white hover:border-shary/40"
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-zinc-800">
                        {s.retailer}
                        {s.isCheapest && (
                          <span className="ml-2 rounded-full bg-shary px-2 py-0.5 text-[10px] font-bold text-white">
                            {lang === "ar" ? "الأرخص" : "Cheapest"}
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-zinc-400">
                        {s.inStock === true
                          ? lang === "ar" ? "متوفر" : "In stock"
                          : s.inStock === false
                          ? lang === "ar" ? "غير متوفر" : "Out of stock"
                          : lang === "ar" ? "الحالة غير معروفة" : "Stock unknown"}
                      </p>
                    </div>
                    <div className="text-end">
                      {s.price !== null ? (
                        <p className="font-bold text-zinc-900">
                          {s.price.toLocaleString()} {s.currency}
                        </p>
                      ) : (
                        <p className="text-xs text-zinc-400">
                          {lang === "ar" ? "السعر غير متاح" : "Price unavailable"}
                        </p>
                      )}
                    </div>
                  </a>
                ))}
              </div>
              {searchResult.note && <p className="text-[11px] text-zinc-400">{searchResult.note}</p>}
            </div>
          )}

          {/* Smart Assistant Trigger — kept, separate feature from the search form */}
          <div className="mt-8 flex justify-center">
            <button
              onClick={() => setShowChat(true)}
              className="group relative flex items-center gap-3 overflow-hidden rounded-2xl bg-white px-6 py-4 ring-1 ring-shary/20 transition-all hover:ring-shary/50 shadow-xl"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-shary text-white shadow-lg shadow-shary/30">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-sm font-bold text-shary-dark">
                  {lang === "ar" ? "اسأل لو لسه محتار" : "Ask if you're still unsure"}
                </span>
                <span className="text-[10px] text-zinc-500 text-right">
                  {lang === "ar" ? "مساعدك الذكي جاهز للرد على أي سؤال" : "Your AI assistant is ready to help"}
                </span>
              </div>
            </button>
          </div>

          {/* Chat Panel */}
          {showChat && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setShowChat(false); }}
            >
              <div className="flex h-[75vh] max-h-[560px] w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-shary/20 bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b border-zinc-100 bg-shary-light px-4 py-3.5">
                  <span className="flex items-center gap-2 text-sm font-bold text-shary-dark">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-shary text-white">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    {t("askAssistant")}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-zinc-500">
                      {t("chatQuestionsLeft").replace("{n}", chatRemaining === null ? "…" : String(chatRemaining))}
                    </span>
                    <button onClick={() => setShowChat(false)} className="text-zinc-400 hover:text-zinc-600">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {chatMessages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-4">
                      <div className="opacity-70">
                        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-shary-light ring-1 ring-shary/20 mx-auto">
                          <Sparkles className="h-7 w-7 text-shary-dark" />
                        </div>
                        <p className="text-xs text-zinc-500">{t("askAssistantHint")}</p>
                      </div>

                      <div className="w-full rounded-2xl border border-shary/20 bg-shary-light p-3 text-start">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-shary-dark">💰</span>
                          <span className="text-[11px] font-bold text-shary-dark">{t("budgetSuggestBadge")}</span>
                        </div>
                        <p className="mb-3 text-xs leading-snug text-zinc-600">{t("budgetSuggestTitle")}</p>
                        <div className="flex flex-wrap gap-2">
                          {budgetChips.map((chip, i) => (
                            <button
                              key={i}
                              onClick={() => sendChat(chip)}
                              disabled={chatLoading || chatLimitHit}
                              className="rounded-full border border-shary/30 bg-white px-3 py-1.5 text-[11px] text-zinc-700 transition-colors hover:border-shary hover:bg-shary-light hover:text-shary-dark disabled:opacity-50"
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    chatMessages.map((msg, i) => (
                      <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                        <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                          msg.role === "user" ? "bg-shary text-white font-medium" : "bg-zinc-100 text-zinc-800 border border-zinc-200"
                        }`}>
                          {msg.content}
                        </div>

                        {msg.role === "assistant" && msg.productSuggestions && msg.productSuggestions.length > 0 && (
                          <div className="mt-2 flex w-full max-w-[85%] flex-col gap-2">
                            {msg.productSuggestions.map((s, si) => (
                              <div key={si} className="rounded-xl border border-shary/20 bg-white p-2.5">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="text-sm font-semibold text-zinc-800">{s.name}</span>
                                  <span className="shrink-0 rounded-full bg-shary-light px-2 py-0.5 text-[11px] font-bold text-shary-dark">
                                    {s.approxPrice}
                                  </span>
                                </div>
                                <p className="text-[11px] leading-snug text-zinc-500">{s.reason}</p>
                              </div>
                            ))}
                            <p className="text-[10px] text-zinc-400">{t("productSuggestionsDisclaimer")}</p>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                  {chatLoading && (
                    <div className="flex justify-start">
                      <div className="rounded-xl bg-zinc-100 border border-zinc-200 px-3 py-2 text-sm text-zinc-500">{t("chatThinking")}</div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className="border-t border-zinc-100 bg-white p-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendChat()}
                      placeholder={t("typeMessage")}
                      disabled={chatLoading || chatLimitHit}
                      className="flex-1 min-w-0 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-shary focus:outline-none disabled:opacity-50"
                    />
                    <button
                      onClick={toggleListening}
                      disabled={chatLoading || chatLimitHit}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-50 ${
                        listening ? "bg-red-500 text-white animate-pulse" : "bg-zinc-100 text-shary-dark hover:bg-zinc-200"
                      }`}
                    >
                      <Mic className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => sendChat()}
                      disabled={chatLoading || chatLimitHit || !chatInput.trim()}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-shary text-white hover:bg-shary-dark disabled:opacity-50"
                    >
                      <Send className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
