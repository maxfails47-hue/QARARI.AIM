import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/AppContext";
import { getCategoryIcon } from "@/lib/categoryIcons";
import { currencies } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ChevronLeft, GitCompare, Crown, Clock, Trash2 } from "lucide-react";

interface ComparisonHistoryItem {
  id: string;
  product_a: string;
  product_b: string;
  price_a: number;
  price_b: number;
  currency: string;
  rows: any[];
  final_recommendation: { ar: string; en: string };
  resale_value_a: number;
  resale_value_b: number;
  warranty_score_a: number;
  warranty_score_b: number;
  created_at: string;
}

export function ComparisonHistoryScreen() {
  const { t, lang, dir, navigate, isPremium, session, showToast } = useApp();

  const [items, setItems] = useState<ComparisonHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const cShort = currencies.find((c) => c.code === "EGP")?.arShort || "ج.م";

  // Fetch comparison history from Supabase
  useEffect(() => {
    if (!session?.user) { setLoading(false); return; }

    async function fetchHistory() {
      try {
        const { data, error } = await supabase
          .from("comparison_history")
          .select("*")
          .eq("user_id", session.user.id)
          .order("created_at", { ascending: false });

        if (!error && data) {
          setItems(data as ComparisonHistoryItem[]);
        }
      } catch (e) {
        console.error("Failed to fetch comparison history:", e);
      } finally {
        setLoading(false);
      }
    }

    fetchHistory();
  }, [session]);

  const handleDelete = async (id: string) => {
    if (!session?.user) return;
    setDeletingId(id);
    try {
      const { error } = await supabase
        .from("comparison_history")
        .delete()
        .eq("id", id)
        .eq("user_id", session.user.id);

      if (!error) {
        setItems((prev) => prev.filter((item) => item.id !== id));
        showToast(lang === "ar" ? "تم حذف المقارنة" : "Comparison deleted");
      }
    } catch (e) {
      console.error("Failed to delete comparison:", e);
    } finally {
      setDeletingId(null);
    }
  };

  const handleViewDetails = (item: ComparisonHistoryItem) => {
    setExpandedId(expandedId === item.id ? null : item.id);
  };

  const bilingual = (bt: any) => {
    if (!bt) return lang === "ar" ? "غير متوفر" : "Not available";
    if (typeof bt === "string") return bt;
    return bt[lang] || bt.ar || bt.en || JSON.stringify(bt);
  };

  if (!session?.user) {
    return (
      <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-4 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl">
          <GitCompare className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h2 className="font-serif text-xl font-bold text-amber-400">
          {lang === "ar" ? "تسجيل الدخول مطلوب" : "Login Required"}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          {lang === "ar" ? "سجل دخولك لعرض سجل المقارنات" : "Sign in to view your comparison history"}
        </p>
        <Button onClick={() => navigate("login")} className="mt-6 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold">
          {lang === "ar" ? "تسجيل الدخول" : "Sign In"}
        </Button>
      </div>
    );
  }

  if (!isPremium) {
    return (
      <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-4 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl">
          <Crown className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h2 className="font-serif text-xl font-bold text-amber-400">{t("premium")}</h2>
        <p className="mt-2 text-sm text-zinc-400">
          {lang === "ar" ? "سجل المقارنات متاح لمشتركي البريميوم فقط" : "Comparison history is available for premium subscribers only"}
        </p>
        <Button onClick={() => navigate("upgrade")} className="mt-6 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold">
          <Crown className="h-4 w-4" /> {t("subscribeNow")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/50 text-zinc-400 transition-colors hover:text-amber-400"
        >
          {dir === "rtl" ? <ChevronLeft className="h-5 w-5 rotate-180" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
        <h1 className="font-serif text-2xl font-bold text-amber-400">
          {lang === "ar" ? "سجل المقارنات" : "Comparison History"}
        </h1>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-800/50" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-zinc-800/50">
            <GitCompare className="h-10 w-10 text-zinc-600" />
          </div>
          <h3 className="text-lg font-bold text-zinc-400">
            {lang === "ar" ? "لا توجد مقارنات سابقة" : "No past comparisons"}
          </h3>
          <p className="mt-2 text-sm text-zinc-500">
            {lang === "ar" ? "ابدأ مقارنة جديدة لترى النتائج هنا" : "Start a new comparison to see results here"}
          </p>
          <Button onClick={() => navigate("compare")} className="mt-6 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold">
            <GitCompare className="h-4 w-4" /> {lang === "ar" ? "مقارنة جديدة" : "New Comparison"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const IconA = getCategoryIcon(item.product_a);
            const IconB = getCategoryIcon(item.product_b);
            const isExpanded = expandedId === item.id;
            const date = new Date(item.created_at);
            const dateStr = lang === "ar"
              ? date.toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })
              : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

            return (
              <div
                key={item.id}
                className="rounded-xl border border-amber-500/15 bg-gradient-to-b from-zinc-900/80 to-[#0B0B0F] overflow-hidden transition-all"
              >
                {/* Header Row */}
                <button
                  onClick={() => handleViewDetails(item)}
                  className="w-full p-4 text-left hover:bg-amber-500/5 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <GitCompare className="h-4 w-4 text-amber-400" />
                      <span className="text-sm font-bold text-amber-400">
                        {item.product_a} <span className="text-zinc-500 text-xs">vs</span> {item.product_b}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-zinc-500 text-xs">
                      <Clock className="h-3 w-3" />
                      <span>{dateStr}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>{item.price_a.toLocaleString()} {cShort}</span>
                    <span className="text-zinc-600">vs</span>
                    <span>{item.price_b.toLocaleString()} {cShort}</span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500 line-clamp-1">
                    {bilingual(item.final_recommendation)}
                  </p>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-amber-500/10 p-4 space-y-4">
                    {/* VS Row */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                      <div className="text-center">
                        <IconA className="h-8 w-8 text-amber-400 mx-auto mb-1" />
                        <p className="text-xs font-bold text-zinc-100 truncate">{item.product_a}</p>
                        <p className="text-[10px] text-amber-400">{item.price_a.toLocaleString()} {cShort}</p>
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600">
                        <span className="text-[10px] font-bold text-[#0B0B0F]">VS</span>
                      </div>
                      <div className="text-center">
                        <IconB className="h-8 w-8 text-amber-400 mx-auto mb-1" />
                        <p className="text-xs font-bold text-zinc-100 truncate">{item.product_b}</p>
                        <p className="text-[10px] text-amber-400">{item.price_b.toLocaleString()} {cShort}</p>
                      </div>
                    </div>

                    {/* Comparison Rows */}
                    {item.rows?.map((row, i) => (
                      <div key={i} className="rounded-lg border border-zinc-800 p-3">
                        <p className="mb-2 text-center text-[11px] font-bold text-amber-400">{bilingual(row.category)}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <div className={`rounded-md p-2 text-center text-xs ${
                            row.winner === "A" ? "bg-amber-500/10 ring-1 ring-amber-500/30" : "bg-zinc-800/40"
                          }`}>
                            <span className={row.winner === "A" ? "text-amber-400 font-medium" : "text-zinc-300"}>
                              {bilingual(row.valueA)}
                            </span>
                          </div>
                          <div className={`rounded-md p-2 text-center text-xs ${
                            row.winner === "B" ? "bg-amber-500/10 ring-1 ring-amber-500/30" : "bg-zinc-800/40"
                          }`}>
                            <span className={row.winner === "B" ? "text-amber-400 font-medium" : "text-zinc-300"}>
                              {bilingual(row.valueB)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}

                    {/* Resale & Warranty */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-zinc-800/40 p-2 text-center">
                        <p className="text-[10px] text-zinc-500">{lang === "ar" ? "إعادة بيع أ" : "Resale A"}</p>
                        <p className="text-sm font-bold text-amber-400">{item.resale_value_a || 50}%</p>
                      </div>
                      <div className="rounded-lg bg-zinc-800/40 p-2 text-center">
                        <p className="text-[10px] text-zinc-500">{lang === "ar" ? "إعادة بيع ب" : "Resale B"}</p>
                        <p className="text-sm font-bold text-amber-400">{item.resale_value_b || 50}%</p>
                      </div>
                      <div className="rounded-lg bg-zinc-800/40 p-2 text-center">
                        <p className="text-[10px] text-zinc-500">{lang === "ar" ? "ضمان أ" : "Warranty A"}</p>
                        <p className="text-sm font-bold text-amber-400">{item.warranty_score_a || 5}/10</p>
                      </div>
                      <div className="rounded-lg bg-zinc-800/40 p-2 text-center">
                        <p className="text-[10px] text-zinc-500">{lang === "ar" ? "ضمان ب" : "Warranty B"}</p>
                        <p className="text-sm font-bold text-amber-400">{item.warranty_score_b || 5}/10</p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-2">
                      <Button
                        onClick={() => navigate("compare")}
                        variant="outline"
                        className="flex-1 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-amber-400"
                      >
                        <GitCompare className="h-3 w-3" /> {lang === "ar" ? "مقارنة جديدة" : "New Compare"}
                      </Button>
                      <Button
                        onClick={() => handleDelete(item.id)}
                        disabled={deletingId === item.id}
                        variant="outline"
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 className="h-3 w-3" /> {lang === "ar" ? "حذف" : "Delete"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
