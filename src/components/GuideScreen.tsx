import { useApp } from "@/lib/AppContext";
import { ChevronLeft, Zap, TrendingUp, Crown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GuideScreen() {
  const { t, lang, dir, navigate } = useApp();

  const features = [
    {
      titleAr: "📊 تحليل الأسعار الذكي",
      titleEn: "📊 Smart Price Analysis",
      descAr: "نحلل أسعار المنتج من جوجل مباشرة ونطلعلك النطاق العادل الحقيقي في السوق",
      descEn: "We analyze real prices from Google and show you the fair market range",
    },
    {
      titleAr: "⚖️ مقارنة ذكية",
      titleEn: "⚖️ Smart Comparison",
      descAr: "قارن بين منتجين وشوف الفرق في السعر والجودة والضمان وسعر إعادة البيع",
      descEn: "Compare products side-by-side with price, quality, warranty, and resale value",
    },
    {
      titleAr: "🧠 مساعد شخصي ذكي",
      titleEn: "🧠 Smart Personal Advisor",
      descAr: "اسأل المساعد أي سؤال عن الشراء وهو يرد بنصائح مخصصة لك",
      descEn: "Ask the advisor anything about shopping and get personalized advice",
    },
    {
      titleAr: "💬 150 رسالة شهريًا (بريميوم)",
      titleEn: "💬 150 Messages/Month (Premium)",
      descAr: "تحدث مع المساعد وهو يتذكر اهتماماتك",
      descEn: "Chat with the advisor who remembers your interests",
    },
    {
      titleAr: "🛡️ حماية من الاستغلال",
      titleEn: "🛡️ Protection from Exploitation",
      descAr: "نساعدك تتجنب الأسعار المبالغ فيها والمنتجات الرديئة",
      descEn: "Avoid overpriced products and low-quality items",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <button
        onClick={() => navigate("input")}
        className="mb-6 flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400"
      >
        <ChevronLeft className={`h-4 w-4 ${lang === "ar" ? "rotate-180" : ""}`} />
        {t("back")}
      </button>

      {/* Hero Section */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl shadow-amber-500/20">
          <Zap className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h1 className="font-serif text-3xl font-bold text-amber-400">
          {lang === "ar" ? "مرحباً بك في قراري" : "Welcome to Qarari"}
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          {lang === "ar"
            ? "منصتك الذكية لاتخاذ قرارات شراء صحيحة مبنية على بيانات حقيقية"
            : "Your smart platform for making right purchase decisions based on real data"}
        </p>
      </div>

      {/* Main Value Proposition */}
      <div className="mb-8 rounded-2xl border border-amber-500/30 bg-gradient-to-b from-amber-500/10 to-transparent p-6 text-center">
        <p className="text-lg font-bold text-amber-400">
          {lang === "ar"
            ? "💰 قرار شراء واحد صحيح يوفر لك آلاف الجنيهات"
            : "💰 One right purchase decision saves you thousands"}
        </p>
        <p className="mt-2 text-sm text-zinc-300">
          {lang === "ar"
            ? "والاشتراك البريميوم بـ 150 جنيه فقط يوفر لك أكثر من ذلك بكتير"
            : "And premium subscription at just 150 EGP saves you much more"}
        </p>
      </div>

      {/* Features Grid */}
      <div className="mb-8 space-y-3">
        <h2 className="font-serif text-xl font-bold text-amber-400">
          {lang === "ar" ? "🎯 المميزات الرئيسية" : "🎯 Main Features"}
        </h2>
        {features.map((feature, i) => (
          <div key={i} className="rounded-xl border border-amber-500/15 bg-zinc-900/60 p-4">
            <p className="font-bold text-amber-400">
              {lang === "ar" ? feature.titleAr : feature.titleEn}
            </p>
            <p className="mt-1 text-sm text-zinc-300">
              {lang === "ar" ? feature.descAr : feature.descEn}
            </p>
          </div>
        ))}
      </div>

      {/* Premium Benefits */}
      <div className="mb-8 rounded-2xl border border-amber-500/20 bg-gradient-to-b from-amber-500/5 to-transparent p-6 text-center">
        <Crown className="mx-auto mb-3 h-8 w-8 text-amber-400" />
        <h2 className="font-serif text-xl font-bold text-amber-400">
          {lang === "ar" ? "افتح كل إمكانيات قراري" : "Unlock the full power of Qarari"}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          {lang === "ar"
            ? "تحليلات ومقارنات ورسائل أكتر مع المساعد الذكي، وذاكرة تتذكر اهتماماتك"
            : "More analyses, comparisons, and advisor messages — plus smart memory that remembers your interests"}
        </p>
        <Button
          onClick={() => navigate("upgrade")}
          className="mt-5 w-full bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold hover:from-amber-300 hover:to-amber-500"
        >
          {lang === "ar" ? "👑 اشترك الآن" : "👑 Subscribe Now"}
        </Button>
      </div>

      {/* How It Works */}
      <div className="mb-8 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-6">
        <h2 className="mb-4 font-serif text-lg font-bold text-amber-400">
          {lang === "ar" ? "🚀 كيف تستخدم قراري؟" : "🚀 How to Use Qarari?"}
        </h2>
        <div className="space-y-3">
          {[
            {
              num: "1",
              ar: "ادخل اسم المنتج والسعر اللي عايز تشتريه",
              en: "Enter the product name and price you want to buy",
            },
            {
              num: "2",
              ar: "اختار حالة الجهاز (جديد، كسر زيرو، مستعمل)",
              en: "Choose device condition (new, like new, used)",
            },
            {
              num: "3",
              ar: "نحلل لك الأسعار الحقيقية والنطاق العادل",
              en: "We analyze real prices and fair market range",
            },
            {
              num: "4",
              ar: "نقول لك: هل السعر غالي؟ عادل؟ رخيص؟",
              en: "We tell you: Is it overpriced? Fair? Cheap?",
            },
            {
              num: "5",
              ar: "اسأل المساعد أي سؤال إضافي وهو يرد عليك",
              en: "Ask the advisor any follow-up questions",
            },
          ].map((step, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-sm font-bold text-amber-400">
                {step.num}
              </div>
              <p className="text-sm text-zinc-300">
                {lang === "ar" ? step.ar : step.en}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="space-y-3">
        <Button
          onClick={() => navigate("input")}
          className="w-full bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold hover:from-amber-300 hover:to-amber-500"
        >
          {lang === "ar" ? "🚀 ابدأ الآن" : "🚀 Start Now"}
        </Button>
        <Button
          onClick={() => navigate("upgrade")}
          variant="outline"
          className="w-full border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
        >
          {lang === "ar" ? "👑 اشترك بريميوم" : "👑 Subscribe Premium"}
        </Button>
      </div>
    </div>
  );
}
