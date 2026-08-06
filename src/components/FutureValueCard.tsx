import { DollarSign } from "lucide-react";

interface FutureValueCardProps {
  lang: "ar" | "en";
  offeredPrice: number;
  resaleValue2Years: number;
  resaleDepreciationRate?: string;
  currencyShort: string;
}

export function FutureValueCard({
  lang,
  offeredPrice,
  resaleValue2Years,
  resaleDepreciationRate,
  currencyShort,
}: FutureValueCardProps) {
  const fmtPrice = (n: number): string => n.toLocaleString();
  const realCost = offeredPrice - resaleValue2Years;

  return (
    <div className="mb-4 rounded-2xl border border-shary/25 bg-gradient-to-br from-shary/10 via-shary-dark/5 to-transparent p-6 shadow-lg shadow-shary/5">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-shary-dark">
        <DollarSign className="h-5 w-5" />
        {lang === "ar" ? "خلاصة خسارة القيمة وتكلفة الامتلاك" : "Cost of Ownership Summary"}
      </h2>



      {/* Smart Advice */}
      <div className="mb-4 rounded-lg bg-shary/10 border border-shary/20 p-4">
        <p className="text-xs font-bold text-shary-dark mb-1 uppercase tracking-wide">
          {lang === "ar" ? "💡 نصيحة شاري" : "💡 Shary's Advice"}
        </p>
        <p className="text-sm text-shary-light">
          {lang === "ar"
            ? `لو نيتك تبيعه بعد سنة، الموديل ده مش أفضل استثمار ليك؛ خسارته سريعة في الأول. لو بتشتريه للاستخدام طويل الأجل، فالموضوع أقل سوء.`
            : `If you plan to sell it after a year, this model isn't your best investment; its value drops quickly initially. If you're buying for long-term use, it's less of a concern.`}
        </p>
      </div>

      {/* Total Cost Breakdown */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-zinc-50/60 p-3 text-center">
          <p className="text-[10px] text-zinc-500 mb-1">{lang === "ar" ? "سعر الشراء" : "Purchase"}</p>
          <p className="text-base font-bold text-zinc-900">
            {fmtPrice(offeredPrice)} {currencyShort}
          </p>
        </div>
        <div className="rounded-lg bg-zinc-50/60 p-3 text-center">
          <p className="text-[10px] text-zinc-500 mb-1">{lang === "ar" ? "بعد سنتين" : "After 2 Years"}</p>
          <p className="text-base font-bold text-red-300">
            {fmtPrice(resaleValue2Years)} {currencyShort}
          </p>
        </div>
        <div className="rounded-lg bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/30 p-3 text-center">
          <p className="text-[10px] text-red-400 mb-1 font-bold uppercase">
            {lang === "ar" ? "التكلفة الفعلية" : "Real Cost"}
          </p>
          <p className="text-base font-bold text-red-300">
            {fmtPrice(realCost)} {currencyShort}
          </p>
        </div>
      </div>

      {/* Simplified Formula */}
      <div className="rounded-lg bg-white/60 p-3 border border-zinc-200/50">
        <p className="text-[10px] text-zinc-500 mb-2 uppercase tracking-wide">
          {lang === "ar" ? "الصيغة البسيطة" : "Simple Formula"}
        </p>
        <p className="text-xs text-zinc-700 leading-relaxed">
          {lang === "ar"
            ? `المبلغ ده هو 'التكلفة الحقيقية' عليك؛ وهو الفرق بين اللي هتدفعه دلوقتي (${fmtPrice(offeredPrice)} ${currencyShort}) واللي هتاخده في جيبك لما تيجي تبيعه بعد سنتين (${fmtPrice(resaleValue2Years)} ${currencyShort}).`
            : `This is your 'real cost'; the difference between what you pay now (${fmtPrice(offeredPrice)} ${currencyShort}) and what you'll get back when you sell it after 2 years (${fmtPrice(resaleValue2Years)} ${currencyShort}).`}
        </p>
      </div>
    </div>
  );
}
