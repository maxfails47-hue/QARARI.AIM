import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronLeft, RefreshCw, Smartphone, Laptop,
  Gamepad2, Headphones, Monitor, Watch, Camera, Tablet,
  ArrowRight, TrendingUp, Store, Users, Globe, Flame,
  Info, CheckCircle2, AlertCircle, Search
} from "lucide-react";
import { getSmartMarketPrice, DevicePriceMap } from "@/lib/tradeInEngine";

const deviceCategories = [
  { id: "phone", label: "📱 موبايل", labelEn: "Phone", Icon: Smartphone },
  { id: "laptop", label: "💻 لابتوب", labelEn: "Laptop", Icon: Laptop },
  { id: "tablet", label: "📟 تابلت", labelEn: "Tablet", Icon: Tablet },
  { id: "watch", label: "⌚ ساعة ذكية", labelEn: "Smartwatch", Icon: Watch },
  { id: "console", label: "🎮 جهاز ألعاب", labelEn: "Gaming Console", Icon: Gamepad2 },
];

const conditionLabelsAr: Record<string, string> = {
  excellent: "ممتاز (بدون خدوش)",
  good: "جيد (خدوش بسيطة)",
  fair: "متوسط (خدوش واضحة)",
  poor: "ضعيف (عيوب واضحة)",
};

export function TradeInScreen() {
  const { t, lang, dir, navigate } = useApp();
  const [selectedCategory, setSelectedCategory] = useState<string>("phone");
  const [deviceName, setDeviceName] = useState("");
  const [condition, setCondition] = useState<string>("good");
  const [result, setResult] = useState<DevicePriceMap | null>(null);

  const handleCalculate = () => {
    if (!deviceName.trim()) return;
    const priceMap = getSmartMarketPrice(deviceName.trim(), condition);
    setResult(priceMap);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("input")}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-amber-400"
          >
            <ChevronLeft className={`h-5 w-5 ${dir === "rtl" ? "rotate-180" : ""}`} />
          </button>
          <div>
            <h1 className="font-serif text-xl font-bold text-amber-400">
              {lang === "ar" ? "خريطة الاستبدال الذكي" : "Smart Trade-in Map"}
            </h1>
            <p className="text-xs text-zinc-500">
              {lang === "ar" ? "أسعار حقيقية من السوق المصري (OLX، فيسبوك، محلات)" : "Real Egyptian market prices (OLX, FB, Shops)"}
            </p>
          </div>
        </div>
        <div className="hidden sm:flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/10 text-amber-400">
          <RefreshCw className="h-5 w-5" />
        </div>
      </div>

      {!result ? (
        <div className="space-y-6">
          {/* Search Section */}
          <div className="rounded-2xl border border-amber-500/20 bg-zinc-900/60 p-6 shadow-xl shadow-amber-500/5">
            <div className="mb-6">
              <label className="mb-2 block text-sm font-bold text-zinc-300">
                {lang === "ar" ? "اكتب نوع جهازك" : "Device Name"}
              </label>
              <div className="relative">
                <Input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder={lang === "ar" ? "مثلاً: iPhone 13 Pro أو MSI GL66" : "e.g. iPhone 13 Pro or MSI GL66"}
                  className="h-14 border-zinc-700 bg-zinc-800/50 pl-12 text-lg text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:ring-amber-500/20"
                />
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500" />
              </div>
            </div>

            <div className="mb-6">
              <label className="mb-3 block text-sm font-bold text-zinc-300">
                {lang === "ar" ? "حالة الجهاز" : "Condition"}
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(conditionLabelsAr).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setCondition(key)}
                    className={`rounded-xl px-3 py-3 text-xs font-medium transition-all ${
                      condition === key
                        ? "bg-amber-500 text-black shadow-lg shadow-amber-500/20"
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <Button
              onClick={handleCalculate}
              disabled={!deviceName.trim()}
              className="h-14 w-full bg-gradient-to-r from-amber-400 to-amber-600 text-lg font-bold text-black hover:from-amber-300 hover:to-amber-500 disabled:opacity-40"
            >
              {lang === "ar" ? "اعرف السعر الحقيقي" : "Get Real Market Price"}
            </Button>
          </div>

          {/* Market Stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                <Globe className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] text-zinc-500">تحديثات يومية</p>
                <p className="text-xs font-bold text-zinc-300">أسعار السوق اليوم</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] text-zinc-500">أكثر من 500 جروب</p>
                <p className="text-xs font-bold text-zinc-300">متابعة فيسبوك</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400">
                <Store className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] text-zinc-500">تجار معتمدين</p>
                <p className="text-xs font-bold text-zinc-300">أسعار المحلات</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Result Header */}
          <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-amber-500/10 to-amber-600/5 p-6 border border-amber-500/20">
            <div>
              <p className="text-xs font-bold text-amber-500 uppercase tracking-wider mb-1">نتائج التقييم لـ</p>
              <h2 className="text-2xl font-bold text-zinc-100">{deviceName}</h2>
              <div className="mt-2 flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                  <CheckCircle2 className="h-3 w-3" /> {conditionLabelsAr[condition]}
                </span>
                {result.marketStatus === "hot" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-bold text-orange-400">
                    <Flame className="h-3 w-3" /> مطلوب جداً
                  </span>
                )}
              </div>
            </div>
            <button 
              onClick={() => setResult(null)}
              className="text-xs text-zinc-500 hover:text-amber-400"
            >
              بحث جديد
            </button>
          </div>

          {/* The Map (Pricing Tiers) */}
          <div className="grid grid-cols-1 gap-4">
            {/* Facebook Groups - Highest */}
            <div className="group relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 transition-all hover:border-blue-500/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
                    <Users className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-100">جروبات الفيسبوك</h3>
                    <p className="text-xs text-zinc-500">أعلى سعر (محتاج وقت ومجهود)</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-blue-400">{result.socialGroups.toLocaleString()} <span className="text-sm">ج.م</span></p>
                  <p className="text-[10px] text-emerald-500">+7% فوق المتوسط</p>
                </div>
              </div>
            </div>

            {/* Direct Sale - Average */}
            <div className="group relative overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 transition-all shadow-lg shadow-amber-500/5">
              <div className="absolute right-0 top-0 rounded-bl-xl bg-amber-500 px-3 py-1 text-[10px] font-bold text-black">
                الأكثر واقعية
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-400 text-black">
                    <Globe className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-100">بيع مباشر (OLX / Dubizzle)</h3>
                    <p className="text-xs text-zinc-400">سعر السوق العادل</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-bold text-amber-400">{result.directSale.toLocaleString()} <span className="text-sm">ج.م</span></p>
                  <p className="text-[10px] text-zinc-500">سعر التنفيذ الفعلي</p>
                </div>
              </div>
            </div>

            {/* Trade-in - Lowest */}
            <div className="group relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 transition-all hover:border-purple-500/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400">
                    <Store className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-100">استبدال في المحلات</h3>
                    <p className="text-xs text-zinc-500">أسرع كاش (بسعر أقل)</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-purple-400">{result.tradeIn.toLocaleString()} <span className="text-sm">ج.م</span></p>
                  <p className="text-[10px] text-red-400">-18% عمولة التاجر</p>
                </div>
              </div>
            </div>
          </div>

          {/* Insights */}
          <div className="rounded-2xl bg-zinc-900/40 p-5 border border-zinc-800">
            <h4 className="mb-4 flex items-center gap-2 text-sm font-bold text-zinc-300">
              <Info className="h-4 w-4 text-amber-400" /> نصيحة "قراري" ليك:
            </h4>
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <p className="text-xs leading-relaxed text-zinc-400">
                  لو مش مستعجل، اعرضه على جروبات <strong>"Used iPhones Egypt"</strong> أو <strong>"Laptop Marketplace"</strong> بفرق 2000 جنيه زيادة عن سعر OLX.
                </p>
              </div>
              <div className="flex gap-3">
                <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <p className="text-xs leading-relaxed text-zinc-400">
                  المحلات في "السراج" أو "مول البستان" هتاخده منك بـ <strong>{result.tradeIn.toLocaleString()} ج.م</strong> كاش فوري، وده خيار ممتاز لو هتشتري الجديد من عندهم.
                </p>
              </div>
              <div className="flex gap-3">
                <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <p className="text-xs leading-relaxed text-zinc-400">
                  سعر الـ {deviceName} حالياً <strong>{result.marketStatus === "hot" ? "في العالي" : "مستقر"}</strong>، فده وقت مناسب للبيع قبل نزول الموديلات الجديدة.
                </p>
              </div>
            </div>
          </div>

          <Button
            onClick={() => setResult(null)}
            variant="outline"
            className="w-full border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400"
          >
            حساب جهاز آخر
          </Button>
        </div>
      )}
    </div>
  );
}
