import { useState, useRef, useMemo, useEffect } from "react";
import { useApp } from "@/lib/AppContext";
import { getCategoryIcon, getIconByCategory } from "@/lib/categoryIcons";
import { getVariantChipGroups } from "@/lib/variantChips";
import { currencies, FREE_MONTHLY_LIMIT } from "@/lib/types";
import { getDemoReport } from "@/lib/analysisEngine";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Sparkles, Camera, Upload, X, Crown, GitCompare, RefreshCw, Mic, Send } from "lucide-react";
import { getCachedFingerprint } from "@/lib/fingerprint";

export function InputScreen() {
  const { t, lang, navigate, setCurrentReport, isPremium, session, showToast, history, saveToHistory, addToGuestHistory } = useApp();
  const [product, setProduct] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("EGP");
  const [notes, setNotes] = useState("");
  const [purpose, setPurpose] = useState("personal");
  const [duration, setDuration] = useState("oneToTwoYears");
  const [specs, setSpecs] = useState("");
  const [condition, setCondition] = useState("new");
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [maxScans, setMaxScans] = useState<number>(FREE_MONTHLY_LIMIT);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Chat Assistant State
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRemaining, setChatRemaining] = useState(isPremium ? 150 : 20);
  const [chatLimitHit, setChatLimitHit] = useState(false);
  const [listening, setListening] = useState(false);
  const [productVoiceListening, setProductVoiceListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const productVoiceRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ─── Voice Input for Product Name & Price ───
  // Uses Web Speech API to capture product name + price from voice command.
  // Example: "آيفون 15 برو سعره 35000" → product="آيفون 15 برو", price="35000"
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
      console.log("[Voice Input] Raw transcript:", transcript);

      // Smart parsing: extract product name and price from natural speech
      // Pattern 1: "ProductName priceNumber" or "ProductName سعره Number"
      const pricePatterns = [
        /(?:سعره|سعرها|بسعر|الثمن|price\s*(?:is|of)?\s*|for\s*\$?|\b\$?)(\d+[,.]?\d*)/i,
        /(\d+[,.]?\d*)\s*(?:جنيه|دولار|ريال|euro|pound|\$|usd|sar|egp)/i,
        /(?:جنيه|دولار|ريال)\s*(\d+[,.]?\d*)/i,
      ];

      let extractedPrice: string | null = null;
      let extractedProduct: string = transcript;

      for (const pattern of pricePatterns) {
        const match = transcript.match(pattern);
        if (match) {
          extractedPrice = match[1].replace(/[,]/g, "");
          // Remove the price portion from the transcript to get the product name
          extractedProduct = transcript.replace(match[0], "").trim();
          // Clean up trailing/leading connectors
          extractedProduct = extractedProduct.replace(/\s+(و|و|and|is|of|for)\s*$/i, "").trim();
          break;
        }
      }

      // If no explicit price pattern matched, try to find any number at the end
      if (!extractedPrice) {
        const numberMatch = transcript.match(/(\d+[,.]?\d*)\s*$/);
        if (numberMatch) {
          extractedPrice = numberMatch[1].replace(/[,]/g, "");
          extractedProduct = transcript.replace(numberMatch[0], "").trim();
          extractedProduct = extractedProduct.replace(/\s+(و|و|and|is|of|for)\s*$/i, "").trim();
        }
      }

      // Apply extracted values
      if (extractedProduct) {
        setProduct((prev) => (prev ? prev + " " : "") + extractedProduct);
      }
      if (extractedPrice) {
        setPrice(extractedPrice);
      }

      console.log("[Voice Input] Parsed → product:", extractedProduct, "| price:", extractedPrice);
      showToast(
        lang === "ar"
          ? (extractedProduct ? "تم إدخال اسم المنتج" : "") + (extractedPrice ? ` والسعر: ${extractedPrice}` : "")
          : (extractedProduct ? "Product name added" : "") + (extractedPrice ? ` & price: ${extractedPrice}` : "")
      );
    };

    rec.onend = () => setProductVoiceListening(false);
    rec.onerror = (e: any) => {
      console.warn("[Voice Input] Error:", e.error);
      setProductVoiceListening(false);
    };

    rec.start();
    productVoiceRef.current = rec;
    setProductVoiceListening(true);
  };

  // Device fingerprint — fetched once on mount and cached for the session.
  // Used for server-side guest quota enforcement (not stored in localStorage).
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

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    if (!session?.user) {
      showToast(lang === "ar" ? "برجاء تسجيل الدخول أولاً" : "Please login first");
      navigate("login");
      return;
    }
    if (chatLimitHit || chatRemaining <= 0) {
      setChatLimitHit(true);
      return;
    }

    const question = chatInput.trim();
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
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      } else {
        // Fallback for raw text if any (though backend should return JSON now)
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

  const localIcon = useMemo(() => getCategoryIcon(product), [product]);
  const variantChipGroups = useMemo(() => getVariantChipGroups(product), [product]);

  // "Smart" product icon: the local keyword match above is instant and
  // covers the common cases, but it's a fixed keyword list and misses
  // anything not on it (falling back to the generic box icon). To make the
  // icon feel genuinely smart, we ask Groq (a fast, tiny classification
  // call — see api/user.ts?action=classify-icon) to upgrade the icon in the
  // background once the user pauses typing. This NEVER blocks or delays the
  // UI: the local icon renders immediately and stays until (and unless) the
  // AI call resolves; a slow network or a failed/timed-out call just means
  // the local icon is kept, never a stuck spinner or empty icon.
  const [aiCategory, setAiCategory] = useState<string | null>(null);
  useEffect(() => {
    setAiCategory(null); // reset the AI upgrade whenever the product name changes
    const trimmed = product.trim();
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // hard cap so a slow call never lingers
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
        // Silent — the local keyword icon is already showing, so a failed
        // or aborted classification call is never user-visible.
      } finally {
        clearTimeout(timeout);
      }
    }, 500); // wait for a pause in typing before spending an AI call

    return () => {
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [product]);

  // Prefer the AI category only when it actually identified something
  // specific — if Groq comes back with "other" but the local keyword match
  // already found a concrete icon, keep the more specific local one instead
  // of downgrading to the generic box.
  const Icon = aiCategory && aiCategory !== "other" ? getIconByCategory(aiCategory) : localIcon;

  // Tapping a chip appends it to specs (e.g. "128GB") instead of the user
  // having to type it. Avoids adding the same value twice.
  const toggleSpecChip = (value: string) => {
    const parts = specs.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.includes(value)) {
      setSpecs(parts.filter((p) => p !== value).join(", "));
    } else {
      setSpecs([...parts, value].join(", "));
    }
  };

  // Both Free and Premium now carry a monthly cap (Premium's is just much higher),
  // so quota can be exceeded on either tier.
  const quotaExceeded = remaining !== null && remaining <= 0;

  // Fetch the real remaining-scans count from the server on load and whenever
  // premium status changes — never a locally-guessed number (fixes the
  // negative-counter bug: this always reflects the server's floor-at-0 value).
  //
  // IMPORTANT: for guests, deviceFingerprint is fetched asynchronously in a
  // separate effect above and is still `null` on the very first render. If
  // this effect fires before that resolves, it sends a request with no
  // fingerprint, which makes the server fall back to the (empty) IP-based
  // guest_usage lookup instead of the real fingerprint-based usage row —
  // so it always reports the full quota, even after scans were used. We
  // guard on that here and add deviceFingerprint as a dependency so the
  // fetch re-runs (with the fingerprint included) once it's ready.
  useEffect(() => {
    if (!session?.user && deviceFingerprint === null) return; // wait for guest fingerprint
    async function fetchRemaining() {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        // Include fingerprint in the request body so the server can
        // resolve the correct quota for guest users
        const body: Record<string, any> = {};
        if (deviceFingerprint) {
          body.deviceFingerprint = deviceFingerprint;
        }
        const res = await fetch("/api/user?action=scans-remaining", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const data = await res.json();
        setRemaining(data.unlimited ? null : data.remaining);
        if (typeof data.max === "number") setMaxScans(data.max);
      } catch {
        setRemaining(null);
      }
    }
    fetchRemaining();
  }, [session, isPremium, deviceFingerprint]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => setPhoto(reader.result as string);
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };

  const handleSubmit = async () => {
    // Fetch the real quota from the server using fingerprint (not localStorage)
    // This ensures the check is always server-authoritative
    if (quotaExceeded) {
      navigate("upgrade");
      return;
    }
    if (quotaExceeded) {
      navigate("upgrade");
      return;
    }
    if (!product.trim() || !price.trim()) {
      showToast(lang === "ar" ? "اكتب اسم المنتج والسعر" : "Enter product name and price");
      return;
    }
    setLoading(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

      let imageBase64: { data: string; mimeType: string } | undefined;
      if (photo) {
        const [meta, data] = photo.split(",");
        const mimeType = meta.match(/data:(.*);base64/)?.[1] || "image/jpeg";
        imageBase64 = { data, mimeType };
      }

      const body: Record<string, any> = {
        product: product.trim(),
        offeredPrice: parseFloat(price),
        currency,
        notes: notes.trim(),
        purpose,
        duration,
        specs: specs.trim(),
        condition,
        language: lang,
        imageBase64,
      };
      // Always send fingerprint for server-side guest quota enforcement
      if (deviceFingerprint) {
        body.deviceFingerprint = deviceFingerprint;
      }

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 403) {
        // Section 14: hard server-side quota block — never runs the analysis
        setRemaining(0);
        navigate("upgrade");
        return;
      }

      if (!res.ok) {
        showToast(t("analysisError") || (lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry"));
        return;
      }

      const result = await res.json();
      console.log("FULL AI RESPONSE:", result);
      setCurrentReport(result);
      // Guests aren't signed in yet, so this can't be saved to Supabase —
      // keep it in local device history so it's not just gone if they
      // navigate away without creating an account.
      if (!session?.user) addToGuestHistory(result);
      setRemaining((r) => (r !== null ? Math.max(0, r - 1) : r));
      navigate("report");
    } catch {
      showToast(lang === "ar" ? "تعذر الاتصال بالخادم" : "Couldn't reach the server");
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = () => {
    setCurrentReport(getDemoReport());
    navigate("report");
  };

  // Analysis takes ~30-40 seconds (live price research + AI reasoning), so a
  // static "Analyzing..." label makes the screen feel frozen. Rotate through
  // a few reassuring, specific status phrases while `loading` is true so the
  // person can see real progress is happening in the background.
  const loadingMessages =
    lang === "ar"
      ? [
          "جاري فحص الأسعار بالذكاء الاصطناعي...",
          "نجمع بيانات السوق حالياً...",
          "نقارن بأسعار المتاجر الموثوقة...",
          "نحسب أفضل سعر عادل للمنتج...",
          "قريبًا يكتمل التقرير...",
        ]
      : [
          "Analyzing prices with AI...",
          "Gathering live market data...",
          "Comparing trusted retailer prices...",
          "Calculating the fairest price...",
          "Almost done with your report...",
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
        <div className="mb-3 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl shadow-amber-500/20">
          <Sparkles className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h1 className="font-serif text-3xl font-bold text-amber-400">{t("appName")}</h1>
        <p className="mt-1 text-sm text-zinc-400">{t("tagline")}</p>
      </div>

      {/* Form Card */}
      <div className="rounded-2xl border border-amber-500/15 bg-gradient-to-b from-zinc-900/80 to-[#0B0B0F] p-6 shadow-2xl">
        <div className="space-y-5">
          {/* Product Name with Live Icon */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("productName")}</Label>
            <div className="flex items-center gap-2">
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black shadow-md ring-1 ring-amber-500/20">
                <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 via-transparent to-transparent" />
                <Icon className="relative h-6 w-6 text-amber-400/90" strokeWidth={1.5} />
              </div>
              <Input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder={t("productNamePlaceholder")}
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
              />
              <button
                type="button"
                onClick={toggleProductVoiceInput}
                disabled={loading}
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border transition-all ${
                  productVoiceListening
                    ? "border-red-500 bg-red-500/20 text-red-400 animate-pulse"
                    : "border-zinc-700 bg-zinc-800/50 text-amber-400 hover:border-amber-500/50 hover:bg-amber-500/10"
                } disabled:opacity-50`}
                title={lang === "ar" ? "ادخل اسم المنتج بالصوت" : "Voice input for product name"}
              >
                <Mic className="h-5 w-5" />
              </button>
            </div>
            {/* Voice input hint */}
            {productVoiceListening && (
              <p className="text-[11px] text-red-400 animate-pulse">
                {lang === "ar" ? "🎤 بتكلم دلوقتي... قول اسم المنتج والسعر (مثال: \"آيفون 15 سعره 35000\")" : "🎤 Listening... Say the product name and price (e.g., \"iPhone 15 price 35000\")"}
              </p>
            )}
          </div>

          {/* Price + Currency */}
          <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("offeredPrice")}</Label>
            <Input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={lang === "ar" ? "0 (أو قول السعر بالصوت)" : "0 (or say the price by voice)"}
              className="border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
            />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("currency")}</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  {currencies.map((c) => (
                    <SelectItem key={c.code} value={c.code} className="focus:bg-amber-500/20 focus:text-amber-400">
                      {lang === "ar" ? `${c.arName} (${c.arShort})` : `${c.enName} (${c.enShort})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("notes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              className="min-h-[60px] border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
            />
          </div>

          {/* Usage Profile */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("purposeOfUse")}</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  <SelectItem value="personal" className="focus:bg-amber-500/20 focus:text-amber-400">{t("personal")}</SelectItem>
                  <SelectItem value="gift" className="focus:bg-amber-500/20 focus:text-amber-400">{t("gift")}</SelectItem>
                  <SelectItem value="work" className="focus:bg-amber-500/20 focus:text-amber-400">{t("work")}</SelectItem>
                  <SelectItem value="gaming" className="focus:bg-amber-500/20 focus:text-amber-400">{t("gaming")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("expectedDuration")}</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  <SelectItem value="lessThanYear" className="focus:bg-amber-500/20 focus:text-amber-400">{t("lessThanYear")}</SelectItem>
                  <SelectItem value="oneToTwoYears" className="focus:bg-amber-500/20 focus:text-amber-400">{t("oneToTwoYears")}</SelectItem>
                  <SelectItem value="threePlusYears" className="focus:bg-amber-500/20 focus:text-amber-400">{t("threePlusYears")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Product Condition */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("productCondition")}</Label>
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                <SelectItem value="new" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionNew")}</SelectItem>
                <SelectItem value="likeNew" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionLikeNew")}</SelectItem>
                <SelectItem value="used" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionUsed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Other Specs */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("otherSpecs")}</Label>
            <Input
              value={product === "" ? "" : specs}
              onChange={(e) => setSpecs(e.target.value)}
              placeholder={lang === "ar" ? "اللون، السعة، المميزات..." : "Color, storage, features..."}
              className="border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50"
            />
            {/* Quick-pick chips: tap the exact variant instead of typing it.
                Narrows the market price range and keeps cache results precise. */}
            {variantChipGroups.length > 0 && (
              <div className="space-y-2 pt-1">
                {variantChipGroups.map((group) => (
                  <div key={group.label.en}>
                    <p className="mb-1 text-[11px] text-zinc-500">{lang === "ar" ? group.label.ar : group.label.en}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {group.options.map((opt) => {
                        const selected = specs.split(",").map((p) => p.trim()).includes(opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => toggleSpecChip(opt)}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                              selected
                                ? "border-amber-500 bg-amber-500/20 text-amber-400"
                                : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-amber-500/40 hover:text-amber-400"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Photo Upload - Available for ALL users */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-300">{t("uploadPhoto")}</Label>
            <div className="flex gap-2">
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileSelect} className="hidden" />
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400"
              >
                <Upload className="h-4 w-4" /> {t("uploadPhoto")}
              </Button>
              <Button
                onClick={() => cameraInputRef.current?.click()}
                variant="outline"
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400"
              >
                <Camera className="h-4 w-4" /> {t("takePhoto")}
              </Button>
            </div>
            {photo && (
              <div className="relative inline-block">
                <img src={photo} alt="product" className="h-20 w-20 rounded-lg border border-amber-500/20 object-cover" />
                <button
                  onClick={() => setPhoto(null)}
                  className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow-lg"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <p className="text-xs text-zinc-500">{t("photoHelper")}</p>
          </div>

          {/* Scan Counter */}
          <div className="text-center text-sm">
            {remaining === null ? (
              <span className="text-zinc-600">…</span>
            ) : (
              <span className={isPremium ? "font-bold text-amber-400" : "text-zinc-400"}>
                {t("scansLeft", { remaining, max: maxScans })}
              </span>
            )}
          </div>

          {/* Submit */}
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold hover:from-amber-300 hover:to-amber-500 disabled:opacity-90"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#0B0B0F] border-t-transparent" />
                <span key={loadingMessageIndex}>{loadingMessages[loadingMessageIndex]}</span>
              </span>
            ) : quotaExceeded ? (
              <><Crown className="h-4 w-4" /> {t("upgrade")}</>
            ) : (
              <><Sparkles className="h-4 w-4" /> {t("analyzeDecision")}</>
            )}
          </Button>

          {/* Analysis progress skeleton — gives a visible sense of a
              multi-step process running (price research → AI reasoning →
              report assembly) instead of a single frozen spinner. */}
          {loading && (
            <div className="space-y-2 rounded-xl border border-amber-500/10 bg-zinc-900/40 p-3">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="h-2.5 animate-pulse rounded-full bg-gradient-to-r from-zinc-700/70 via-zinc-600/50 to-zinc-700/70"
                  style={{ width: `${85 - row * 15}%`, animationDelay: `${row * 150}ms` }}
                />
              ))}
            </div>
          )}

          {/* Compare Button */}
          <Button
            onClick={() => navigate("compare")}
            variant="outline"
            className="w-full border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10"
          >
            <GitCompare className="h-4 w-4" /> {t("compareProducts")}
            {!isPremium && <Crown className="ml-1 h-3 w-3" />}
          </Button>

          {/* Smart Assistant Trigger */}
          <div className="mt-8 flex justify-center">
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
                <span className="text-[10px] text-zinc-500 text-right">
                  {lang === "ar" ? "مساعدك الذكي جاهز للرد على أي سؤال" : "Your AI assistant is ready to help"}
                </span>
              </div>
            </button>
          </div>

          {/* Chat Panel — centered modal overlay so it always sits mid-screen
              and can never get clipped at a screen edge. */}
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
                    <span className="text-[10px] text-zinc-500">
                      {t("chatQuestionsLeft").replace("{n}", String(chatRemaining))}
                    </span>
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
                  <div ref={chatEndRef} />
                </div>
                <div className="border-t border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendChat()}
                      placeholder={t("typeMessage")}
                      disabled={chatLoading || chatLimitHit}
                      className="flex-1 min-w-0 rounded-xl border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      onClick={toggleListening}
                      disabled={chatLoading || chatLimitHit}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-50 ${
                        listening ? "bg-red-500 text-white animate-pulse" : "bg-zinc-800 text-amber-400 hover:bg-zinc-700"
                      }`}
                    >
                      <Mic className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => sendChat()}
                      disabled={chatLoading || chatLimitHit || !chatInput.trim()}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-amber-600 text-black hover:brightness-110 disabled:opacity-50"
                    >
                      <Send className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}



          {/* Demo Report */}
          {history.length === 0 && (
            <button
              onClick={handleDemo}
              className="w-full text-center text-xs text-zinc-500 underline hover:text-amber-400 mt-3"
            >
              {lang === "ar" ? "شوف مثال لتحليل توضيحي" : "See an example analysis"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}