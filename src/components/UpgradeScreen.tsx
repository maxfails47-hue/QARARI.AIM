import { useState, useRef } from "react";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { INSTAPAY_NUMBER } from "@/lib/types";
import { 
  Crown, Check, ChevronLeft, Zap, Star, ShieldCheck, 
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
        if (errBody?.error === "invalid_screenshot" || errBody?.error === "duplicate_receipt") {
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
    highlight = false, 
    badge = "", 
    isFree = false 
  }: { 
    id: string;
    title: string; 
    price: string; 
    features: string; 
    highlight?: boolean; 
    badge?: string;
    isFree?: boolean;
  }) => (
    <div className={`relative rounded-2xl border ${highlight ? 'border-amber-500 bg-amber-500/5 shadow-lg shadow-amber-500/10' : 'border-zinc-800 bg-zinc-900/40'} p-6 transition-all hover:border-amber-500/50`}>
      {badge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[#0B0B0F]">
          {badge}
        </div>
      )}
      <div className="mb-4">
        <h3 className={`text-lg font-bold ${highlight ? 'text-amber-400' : 'text-zinc-200'}`}>{title}</h3>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold text-zinc-100">{price}</span>
        </div>
      </div>
      <div className="mb-6 space-y-3">
        {features.split('+').map((feature, i) => (
          <div key={i} className="flex items-start gap-2">
            <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="text-xs text-zinc-400">{feature.trim()}</p>
          </div>
        ))}
      </div>
      {!isFree && (
        <Button
          onClick={() => setSelectedPlan({ id, title, price })}
          className={`w-full font-bold ${highlight ? 'bg-amber-500 text-[#0B0B0F] hover:bg-amber-400' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
        >
          <Zap className="mr-2 h-4 w-4" /> {t("subscribeNow")}
        </Button>
      )}
    </div>
  );

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
              <Label className="text-sm font-medium text-zinc-300">{t("uploadScreenshot")}</Label>
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

      <div className="space-y-12">
        {/* Free Plan */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-zinc-200">{t("freePlan")}</h3>
              <p className="text-xs text-zinc-500 mt-1">{t("freePlanFeatures")}</p>
            </div>
            <div className="text-xl font-bold text-zinc-100">{lang === "ar" ? "مجانًا" : "Free"}</div>
          </div>
        </section>

        {/* One-time Usage */}
        <section>
          <div className="mb-6 flex items-center gap-3">
            <Star className="h-5 w-5 text-amber-500" />
            <h2 className="text-xl font-bold text-zinc-100">{t("oneTimeUsage")}</h2>
            <span className="rounded-full bg-zinc-800 px-3 py-1 text-[10px] font-medium text-zinc-400">
              {t("noExpiration")}
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <PlanCard id="small_bundle" title={t("oneTimeSmall")} price={t("oneTimeSmallPrice")} features={t("oneTimeSmallFeatures")} />
            <PlanCard id="medium_bundle" title={t("oneTimeMedium")} price={t("oneTimeMediumPrice")} features={t("oneTimeMediumFeatures")} highlight={true} badge={lang === "ar" ? "الأكثر طلبًا" : "Popular"} />
            <PlanCard id="large_bundle" title={t("oneTimeLarge")} price={t("oneTimeLargePrice")} features={t("oneTimeLargeFeatures")} />
          </div>
        </section>

        {/* Monthly Subscriptions */}
        <section>
          <div className="mb-6 flex items-center gap-3">
            <Rocket className="h-5 w-5 text-amber-500" />
            <h2 className="text-xl font-bold text-zinc-100">{t("monthlySubscription")}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <PlanCard id="smart_shopper" title={t("smartShopper")} price={t("smartShopperPrice")} features={t("smartShopperFeatures")} />
            <PlanCard id="power_buyer" title={t("powerBuyer")} price={t("powerBuyerPrice")} features={t("powerBuyerFeatures")} />
          </div>
          {/* BuyWise Elite - Premium tier */}
          <div className="grid gap-4 md:grid-cols-1 mt-4">
            <div className="relative rounded-2xl border border-purple-500/50 bg-gradient-to-br from-purple-500/10 to-indigo-500/10 p-6 transition-all hover:border-purple-500/80 shadow-lg shadow-purple-500/10">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                {lang === "ar" ? "النخبة" : "Elite"}
              </div>
              <div className="mb-4">
                <h3 className="text-lg font-bold text-purple-300">{t("buyWiseElite")}</h3>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-zinc-100">{t("buyWiseElitePrice")}</span>
                </div>
              </div>
              <div className="mb-6 space-y-3">
                {(t("buyWiseEliteFeatures") || "").split('+').map((feature: string, i: number) => (
                  <div key={i} className="flex items-start gap-2">
                    <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-purple-400" />
                    <p className="text-xs text-zinc-400">{feature.trim()}</p>
                  </div>
                ))}
              </div>
              <Button
                onClick={() => setSelectedPlan({ id: "buywise_elite", title: t("buyWiseElite"), price: t("buyWiseElitePrice") })}
                className="w-full font-bold bg-gradient-to-r from-purple-500 to-indigo-500 text-white hover:from-purple-400 hover:to-indigo-400"
              >
                <Gem className="mr-2 h-4 w-4" /> {t("subscribeNow")}
              </Button>
            </div>
          </div>
        </section>

        {/* Value reinforcement */}
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-400">
            {lang === "ar" ? "قرار شراء واحد صحيح يوفر لك آلاف الجنيهات!" : "One right purchase decision saves you thousands!"}
          </p>
        </div>
      </div>
    </div>
  );
}
