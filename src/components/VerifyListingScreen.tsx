import { useRef, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { ArrowRight, ArrowLeft, Camera, Image as ImageIcon, Clock, X } from "lucide-react";

interface VerifyListingResult {
  listing: {
    productName: string | null;
    price: number | null;
    currency: string | null;
    discountPercent: number | null;
    priceAfterDiscount: number | null;
  };
  product?: string;
  currency?: string;
  stores: {
    retailer: string;
    url: string;
    price: number | null;
    currency: string;
    inStock: boolean | null;
    isCheapest: boolean;
    lastChecked: string;
  }[];
  cheapest: { retailer: string; price: number; url: string } | null;
  storesChecked?: number;
  storesResolved?: number;
  verdict: {
    status: "unverified" | "excellent" | "good" | "fair" | "high";
    message: string;
  };
}

function fileToBase64(file: File): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const data = result.split(",")[1] || "";
      resolve({ data, mimeType: file.type || "image/jpeg" });
    };
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

function timeAgo(iso: string, lang: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return lang === "ar" ? "الآن" : "just now";
  if (mins < 60) return lang === "ar" ? `منذ ${mins} دقيقة` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return lang === "ar" ? `منذ ${hrs} ساعة` : `${hrs}h ago`;
}

const VERDICT_STYLES: Record<VerifyListingResult["verdict"]["status"], { border: string; bg: string; text: string }> = {
  excellent: { border: "border-shary", bg: "bg-shary-light", text: "text-shary-dark" },
  good: { border: "border-shary", bg: "bg-shary-light", text: "text-shary-dark" },
  fair: { border: "border-amber-300", bg: "bg-amber-50", text: "text-amber-700" },
  high: { border: "border-red-300", bg: "bg-red-50", text: "text-red-600" },
  unverified: { border: "border-zinc-200", bg: "bg-zinc-50", text: "text-zinc-500" },
};

export function VerifyListingScreen() {
  const { lang, navigate } = useApp();
  const BackIcon = lang === "ar" ? ArrowRight : ArrowLeft;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyListingResult | null>(null);

  const reset = () => {
    setPreviewUrl(null);
    setResult(null);
    setError(null);
  };

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    reset();
    setPreviewUrl(URL.createObjectURL(file));
    setLoading(true);
    try {
      const imageBase64 = await fileToBase64(file);
      const res = await fetch("/api/verify-listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, currency: "EGP", language: lang }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error || (lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry"));
        return;
      }
      const data = await res.json();
      setResult(data);
    } catch {
      setError(lang === "ar" ? "تعذر الاتصال بالخادم" : "Couldn't reach the server");
    } finally {
      setLoading(false);
    }
  };

  const verdictStyle = result ? VERDICT_STYLES[result.verdict.status] : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <button
        type="button"
        onClick={() => navigate("input")}
        className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-shary-dark"
      >
        <BackIcon className="h-4 w-4" />
        {lang === "ar" ? "رجوع" : "Back"}
      </button>

      <div className="mb-6 text-center">
        <div className="mb-3 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-shary shadow-xl shadow-shary/30">
          <Camera className="h-7 w-7 text-white" strokeWidth={1.75} />
        </div>
        <h1 className="text-2xl font-bold text-shary-dark">
          {lang === "ar" ? "اتأكد من سعر إعلان" : "Verify a listing's price"}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          {lang === "ar"
            ? "ارفع صورة سكرين شوت من فيسبوك أو أي مصدر، ونقارنه بأسعار المتاجر الرسمية دلوقتي"
            : "Upload a screenshot from Facebook or anywhere else, and we'll compare it to real store prices right now"}
        </p>
      </div>

      <div className="rounded-2xl border border-shary/15 bg-white p-6 shadow-2xl">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        {!previewUrl && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-shary/30 bg-shary-light/40 py-10 text-shary-dark transition-colors hover:border-shary hover:bg-shary-light"
          >
            <ImageIcon className="h-8 w-8" strokeWidth={1.5} />
            <span className="text-sm font-bold">{lang === "ar" ? "اختر صورة الإعلان" : "Choose listing photo"}</span>
            <span className="text-[11px] text-zinc-400">
              {lang === "ar" ? "سكرين شوت، صورة سعر، أو أي صورة فيها اسم المنتج والسعر" : "A screenshot, a price tag photo — anything showing the product name and price"}
            </span>
          </button>
        )}

        {previewUrl && (
          <div className="space-y-4">
            <div className="relative">
              <img src={previewUrl} alt="listing" className="max-h-64 w-full rounded-xl border border-zinc-200 object-contain bg-zinc-50" />
              <button
                type="button"
                onClick={reset}
                disabled={loading}
                className="absolute top-2 rtl:left-2 ltr:right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-zinc-600 shadow hover:bg-white disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {loading && (
              <div className="space-y-2 rounded-xl border border-shary/10 bg-shary-light/40 p-3">
                <p className="flex items-center justify-center gap-2 text-sm font-semibold text-shary-dark">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-shary-dark border-t-transparent" />
                  {lang === "ar" ? "بنقرا الصورة ونقارن بالمتاجر الرسمية..." : "Reading the photo and checking real stores..."}
                </p>
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className="h-2.5 animate-pulse rounded-full bg-gradient-to-r from-zinc-200 via-zinc-100 to-zinc-200"
                    style={{ width: `${85 - row * 15}%`, animationDelay: `${row * 150}ms` }}
                  />
                ))}
              </div>
            )}

            {error && !loading && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
            )}

            {result && !loading && (
              <div className="reveal-fade-rise space-y-3">
                {/* Extracted listing */}
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                  <p className="text-[10px] font-medium text-zinc-400">
                    {lang === "ar" ? "قرأناه من الصورة" : "Read from the photo"}
                  </p>
                  <p className="truncate text-sm font-bold text-zinc-800">
                    {result.listing.productName || (lang === "ar" ? "غير معروف" : "Unknown")}
                  </p>
                  {result.listing.price && (
                    <div className="mt-1 flex items-baseline gap-2">
                      <p className="text-xl font-extrabold text-zinc-900">
                        {(result.listing.priceAfterDiscount ?? result.listing.price).toLocaleString()}
                        <span className="ms-1 text-sm font-semibold text-zinc-500">{result.listing.currency}</span>
                      </p>
                      {result.listing.discountPercent && (
                        <span className="rounded-full bg-shary/10 px-2 py-0.5 text-[10px] font-bold text-shary-dark">
                          {lang === "ar" ? `خصم ${result.listing.discountPercent}%` : `${result.listing.discountPercent}% off`}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Verdict */}
                {verdictStyle && (
                  <div className={`rounded-xl border p-3 ${verdictStyle.border} ${verdictStyle.bg}`}>
                    <p className={`text-[12px] leading-relaxed font-semibold ${verdictStyle.text}`}>{result.verdict.message}</p>
                  </div>
                )}

                {/* Store comparison */}
                {result.stores.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold text-zinc-500">
                      {lang === "ar" ? "مقارنة المتاجر الرسمية" : "Official store comparison"}
                    </p>
                    {result.stores.map((s, i) => (
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
                          {s.price !== null && (
                            <p className="flex items-center gap-1 text-[11px] text-zinc-400">
                              <Clock className="h-3 w-3" />
                              {timeAgo(s.lastChecked, lang)}
                            </p>
                          )}
                        </div>
                        <div className="text-end">
                          {s.price !== null ? (
                            <p className="font-bold text-zinc-900">
                              {s.price.toLocaleString()} {s.currency}
                            </p>
                          ) : (
                            <p className="text-xs text-zinc-400">{lang === "ar" ? "السعر غير متاح" : "Price unavailable"}</p>
                          )}
                        </div>
                      </a>
                    ))}
                  </div>
                )}

                <Button
                  onClick={reset}
                  className="w-full bg-white text-shary-dark border border-shary/30 hover:bg-shary-light font-bold"
                >
                  {lang === "ar" ? "اتحقق من إعلان تاني" : "Verify another listing"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
