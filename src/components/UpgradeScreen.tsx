import { useState, useRef } from "react";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { INSTAPAY_NUMBER } from "@/lib/types";
import { 
  Crown, Check, ChevronLeft, Zap, ShieldCheck, 
  Rocket, Copy, Upload, Camera, X, CheckCircle2, Gem
} from "lucide-react";

export function UpgradeScreen() {
  const { t, lang, navigate, showToast, session } = useApp();
  const [selectedPlan, setSelectedPlan] = useState<{ id: string; title: string; price: string } | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const [activeTab, setActiveTab] = useState<"monthly" | "once">("monthly");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleCopyNumber = () => {
    navigator.clipboard.writeText(INSTAPAY_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setScreenshotFile(file);
      const reader = new FileReader();
      reader.onload = () => setScreenshot(reader.result as string);
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };

  const handleConfirmPayment = async () => {
    if (!session?.user) {
      showToast(t("pleaseLogin"));
      navigate("login");
      return;
    }
    if (!screenshotFile) {
      showToast(lang === "ar" ? "يرجى رفع صورة التحويل أولاً" : "Please upload the transfer screenshot first");
      return;
    }
    setLoading(true);
    try {
      const path = `${session.user.id}/${Date.now()}-${screenshotFile.name}`;
      const { error: uploadError } = await supabase.storage.from("screenshots").upload(path, screenshotFile);
      if (uploadError) throw uploadError;

      const res = await fetch("/api/user?action=subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan: selectedPlan?.id, screenshotUrl: path }),
      });

      if (!res.ok) {
        // invalid_screenshot / duplicate_receipt come back with a ready-made
        // Arabic message from the server — show it directly so the person
        // knows exactly what to fix instead of a generic error.
        const errBody = await res.json().catch(() => null);
        if (errBody?.error === "invalid_screenshot" || errBody?.error === "duplicate_receipt" || errBody?.error === "already_subscribed") {
          showToast(errBody.message || (lang === "ar" ? "حدث خطأ في الصورة المرفوعة" : "There was a problem with the uploaded image"));
          return;
        }
        throw new Error("subscribe_failed");
      }

      setSubmitted(true);
      showToast(t("paymentSuccess"));
    } catch (e) {
      showToast(lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry");
    } finally {
      setLoading(false);
    }
  };

  const PlanCard = ({
    id,
    title,
    price,
    features,
    variant = "default",
    ribbon = "",
  }: {
    id: string;
    title: string;
    price: string;
    features: string;
    variant?: "default" | "gold" | "purple";
    ribbon?: string;
  }) => {
    const isGold = variant === "gold";
    const isPurple = variant === "purple";
    return (
      <div
        className={`relative rounded-2xl border p-6 transition-all ${
          isGold
            ? "border-2 border-amber-500 bg-gradient-to-b from-amber-500/10 to-zinc-900/60 shadow-lg shadow-amber-500/10"
            : isPurple
            ? "border-2 border-purple-400 bg-gradient-to-b from-purple-500/10 to-zinc-900/60 shadow-lg shadow-purple-500/10"
            : "border-zinc-800 bg-zinc-900/40 hover:border-amber-500/50"
        }`}
      >
        {ribbon && (
          <div
            className={`absolute -top-3 right-6 rounded-full px-3 py-1 text-[11px] font-extrabold ${
              isPurple
                ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white"
                : "bg-gradient-to-r from-amber-400 to-amber-600 text-[#17130A]"
            }`}
          >
            {ribbon}
          </div>
        )}
        <div className="mb-1">
          <h3 className={`text-[15px] font-extrabold ${isPurple ? "text-purple-300" : isGold ? "text-amber-400" : "text-zinc-200"}`}>
            {title}
          </h3>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[28px] font-black text-zinc-50">{price}</span>
          </div>
        </div>
        <ul className="mt-4 mb-5 space-y-1.5 list-none p-0">
          {features.split("+").map((feature, i) => (
            <li key={i} className="flex items-center gap-2 py-0.5">
              <Check className={`h-3.5 w-3.5 shrink-0 ${isPurple ? "text-purple-400" : "text-amber-500"}`} />
              <span className="text-[13px] text-zinc-300">{feature.trim()}</span>
            </li>
          ))}
        </ul>
        <Button
          onClick={() => setSelectedPlan({ id, title, price })}
          className={`w-full font-bold ${
            isGold
              ? "bg-gradient-to-r from-amber-400 to-amber-600 text-[#17130A] hover:from-amber-300 hover:to-amber-500"
              : isPurple
              ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white hover:from-purple-400 hover:to-indigo-400"
              : "bg-zinc-800/80 text-zinc-200 border border-zinc-700 hover:bg-zinc-700"
          }`}
        >
          {isGold && <Zap className="mr-2 h-4 w-4" />}
          {isPurple && <Gem className="mr-2 h-4 w-4" />}
          {t("subscribeNow")}
        </Button>
      </div>
    );
  };

  if (submitted) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15">
          <CheckCircle2 className="h-10 w-10 text-emerald-400" />
        </div>
        <h2 className="mb-4 font-serif text-2xl font-bold text-amber-400">{t("paymentSuccess")}</h2>
        <p className="mb-8 text-zinc-400">{t("activationTime")}</p>
        <Button onClick={() => navigate("input")} className="w-full max-w-xs bg-amber-500 text-[#0B0B0F] hover:bg-amber-400">
          {t("back")}
        </Button>
      </div>
    );
  }

  if (selectedPlan) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <button onClick={() => setSelectedPlan(null)} className="mb-6 flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400">
          <ChevronLeft className={`h-4 w-4 ${lang === "ar" ? "rotate-180" : ""}`} />
          {t("back")}
        </button>

        <div className="rounded-2xl border border-amber-500/15 bg-zinc-900/60 p-6 shadow-xl">
          <div className="mb-8 text-center">
            <h2 className="text-xl font-bold text-amber-400">{t("paymentMethod")}</h2>
            <p className="mt-2 text-sm text-zinc-400">{selectedPlan.title} — {selectedPlan.price}</p>
          </div>

          <div className="mb-8 space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
              <p className="mb-3 text-center text-sm text-zinc-400">{t("transferViaInstaPay")}</p>
              <div className="flex items-center justify-center gap-3">
                <span className="font-mono text-2xl font-bold text-zinc-100 tracking-wider">{INSTAPAY_NUMBER}</span>
                <button 
                  onClick={handleCopyNumber}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg transition-all ${copied ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-400 hover:text-amber-400'}`}
                >
                  {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium text-zinc-300">{t("uploadScreenshot")}</Label>
                <button
                  type="button"
                  onClick={() => setShowExample((v) => !v)}
                  className="text-[11px] font-bold text-amber-400 hover:text-amber-300 underline underline-offset-2"
                >
                  {showExample
                    ? (lang === "ar" ? "إخفاء المثال" : "Hide example")
                    : (lang === "ar" ? "شوف مثال؟" : "See an example")}
                </button>
              </div>
              {showExample && (
                <div className="overflow-hidden rounded-xl border border-amber-500/20 bg-zinc-950/50">
                  <img
                    src="/images/instapay-receipt-example.jpg"
                    alt="InstaPay receipt example"
                    className="mx-auto max-h-64 w-auto"
                  />
                  <p className="p-3 text-center text-[11px] leading-relaxed text-zinc-400">
                    {lang === "ar"
                      ? "لازم تظهر في الصورة: علامة نجاح العملية، المبلغ، ورقم المرجع — زي المثال ده بالظبط."
                      : "The image must show the success indicator, the amount, and the reference number — exactly like this example."}
                  </p>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileSelect} className="hidden" />
              
              {screenshot ? (
                <div className="relative group overflow-hidden rounded-xl border border-amber-500/30">
                  <img src={screenshot} alt="screenshot" className="h-48 w-full object-cover transition-transform group-hover:scale-105" />
                  <button
                    onClick={() => setScreenshot(null)}
                    className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white shadow-lg active:scale-90"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 p-6 text-zinc-500 transition-all hover:border-amber-500/30 hover:text-amber-400"
                  >
                    <Upload className="h-6 w-6" />
                    <span className="text-xs font-bold">{t("chooseFile")}</span>
                  </button>
                  <button 
                    onClick={() => cameraInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 p-6 text-zinc-500 transition-all hover:border-amber-500/30 hover:text-amber-400"
                  >
                    <Camera className="h-6 w-6" />
                    <span className="text-xs font-bold">{t("takePhoto")}</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl bg-amber-500/5 p-4 border border-amber-500/10">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-[11px] leading-relaxed text-zinc-400">{t("activationTime")}</p>
            </div>
            
            <Button
              onClick={handleConfirmPayment}
              disabled={loading || !screenshot}
              className="w-full h-12 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold text-lg hover:from-amber-300 hover:to-amber-500 disabled:opacity-50"
            >
              {loading ? <Rocket className="h-5 w-5 animate-bounce" /> : t("confirmPayment")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 pb-24">
      <button onClick={() => navigate("input")} className="mb-6 flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400">
        <ChevronLeft className={`h-4 w-4 ${lang === "ar" ? "rotate-180" : ""}`} />
        {t("back")}
      </button>

      <div className="mb-10 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl shadow-amber-500/20">
          <Crown className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h1 className="font-serif text-3xl font-bold text-amber-400">{t("premium")}</h1>
        <p className="mt-2 text-sm text-zinc-400">{t("premiumDesc")}</p>
      </div>

      {/* Segmented tabs */}
      <div className="mb-4 flex gap-1 rounded-2xl border border-white/5 bg-zinc-900 p-1">
        <button
          onClick={() => setActiveTab("monthly")}
          className={`flex-1 rounded-xl px-2 py-3 text-center text-[13.5px] font-extrabold transition-all ${
            activeTab === "monthly"
              ? "bg-gradient-to-r from-amber-400 to-amber-600 text-[#17130A]"
              : "text-zinc-500"
          }`}
        >
          {t("pricingTabMonthly")}
          <span className="mt-0.5 block text-[10px] font-semibold opacity-80">{t("pricingTabMonthlySub")}</span>
        </button>
        <button
          onClick={() => setActiveTab("once")}
          className={`flex-1 rounded-xl px-2 py-3 text-center text-[13.5px] font-extrabold transition-all ${
            activeTab === "once"
              ? "bg-gradient-to-r from-amber-400 to-amber-600 text-[#17130A]"
              : "text-zinc-500"
          }`}
        >
          {t("pricingTabOnce")}
          <span className="mt-0.5 block text-[10px] font-semibold opacity-80">{t("pricingTabOnceSub")}</span>
        </button>
      </div>

      {activeTab === "monthly" ? (
        <div className="space-y-4">
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/[0.07] px-4 py-2.5 text-xs text-amber-200/90">
            {t("pricingValueStrip")}
          </div>

          <PlanCard id="smart_shopper" title={t("smartShopper")} price={t("smartShopperPrice")} features={t("smartShopperFeatures")} />
          <PlanCard
            id="power_buyer"
            title={t("powerBuyer")}
            price={t("powerBuyerPrice")}
            features={t("powerBuyerFeatures")}
            variant="gold"
            ribbon={t("bestValueRibbon")}
          />
          <PlanCard
            id="buywise_elite"
            title={t("buyWiseElite")}
            price={t("buyWiseElitePrice")}
            features={t("buyWiseEliteFeatures")}
            variant="purple"
            ribbon={t("eliteRibbon")}
          />

          <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500 px-1.5">
            {t("oneTimeRenewalNote")}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="mb-3 flex items-center justify-between border-b border-white/5 pb-4 text-xs text-zinc-500">
            <span>{t("freePlanFeatures")}</span>
            <b className="text-zinc-300">{lang === "ar" ? "مجانًا" : "Free"}</b>
          </div>

          <PlanCard id="small_bundle" title={t("oneTimeSmall")} price={t("oneTimeSmallPrice")} features={t("oneTimeSmallFeatures")} />
          <PlanCard id="medium_bundle" title={t("oneTimeMedium")} price={t("oneTimeMediumPrice")} features={t("oneTimeMediumFeatures")} />
          <PlanCard id="large_bundle" title={t("oneTimeLarge")} price={t("oneTimeLargePrice")} features={t("oneTimeLargeFeatures")} />

          <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500 px-1.5">
            {t("oneTimeRenewalNote")}
          </p>
        </div>
      )}
    </div>
  );
}
