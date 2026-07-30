import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Language, Screen, AnalysisResult, UserProfile, CompareResult } from "@/lib/types";
import { translations } from "@/lib/translations";
import { getDemoReport } from "@/lib/analysisEngine";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

interface AppContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  dir: "rtl" | "ltr";
  t: (key: string, params?: Record<string, string | number>) => string;
  screen: Screen;
  navigate: (screen: Screen) => void;
  currentReport: AnalysisResult | null;
  setCurrentReport: (r: AnalysisResult | null) => void;
  currentCompare: CompareResult | null;
  setCurrentCompare: (r: CompareResult | null) => void;
  history: AnalysisResult[];
  saveToHistory: (r: AnalysisResult) => Promise<boolean>;
  refreshHistory: () => Promise<void>;
  // Local (device-only) history for guests who haven't created an account
  // yet — so a report is never truly lost just because they didn't sign up.
  addToGuestHistory: (r: AnalysisResult) => void;
  user: UserProfile | null;
  session: Session | null;
  authLoading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isPremium: boolean;
  showToast: (msg: string) => void;
  toast: string | null;
  pendingAction: (() => void) | null;
  setPendingAction: (a: (() => void) | null) => void;
  requireAuth: (action: () => void) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem("qarari-lang");
    return (saved as Language) || "ar";
  });
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const raw = localStorage.getItem("qarari_current_report");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.report && Date.now() - parsed.savedAt < 2 * 60 * 60 * 1000) {
          return "report";
        }
      }
    } catch {
      // ignore corrupted storage
    }
    return "input";
  });
  // Restore the last-viewed report from localStorage so it survives a page
  // reload or the redirect to /login when saving — this is what fixes the
  // "report disappears if I don't sign up" bug. Reports older than 2 hours
  // are treated as stale and dropped, so this never resurrects something old.
  const [currentReport, setCurrentReportState] = useState<AnalysisResult | null>(() => {
    try {
      const raw = localStorage.getItem("qarari_current_report");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.report && Date.now() - parsed.savedAt < 2 * 60 * 60 * 1000) {
        return parsed.report as AnalysisResult;
      }
    } catch {
      // ignore corrupted storage
    }
    return null;
  });
  const setCurrentReport = useCallback((r: AnalysisResult | null) => {
    setCurrentReportState(r);
    try {
      if (r) {
        localStorage.setItem("qarari_current_report", JSON.stringify({ report: r, savedAt: Date.now() }));
      } else {
        localStorage.removeItem("qarari_current_report");
      }
    } catch {
      // ignore quota errors
    }
  }, []);
  const [currentCompare, setCurrentCompare] = useState<CompareResult | null>(null);
  const [guestHistory, setGuestHistory] = useState<AnalysisResult[]>(() => {
    try {
      const raw = localStorage.getItem("qarari_guest_history");
      return raw ? (JSON.parse(raw) as AnalysisResult[]) : [];
    } catch {
      return [];
    }
  });
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
    localStorage.setItem("qarari-lang", lang);
  }, [lang, dir]);

  const setLang = (l: Language) => setLangState(l);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let str = translations[lang][key] || translations.en[key] || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        str = str.replace(`{${k}}`, String(v));
      });
    }
    return str;
  }, [lang]);

  const navigate = useCallback((s: Screen) => {
    setScreen(s);
    window.scrollTo(0, 0);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // ---- Fetch the user's profile row (tier, scans, etc.) fresh from the DB ----
  // Re-run on every auth-state-change, never cached client-side, so the
  // Premium badge never goes stale after login/refresh/admin approval.
  const refreshUserProfile = useCallback(async (userId: string, email: string) => {
    const { data, error } = await supabase.from("users").select("*").eq("id", userId).single();
    if (error || !data) {
      setUser(null);
      return;
    }
    setUser({
      id: data.id,
      email: data.email || email,
      name: data.full_name || "",
      age: data.age || "",
      country: data.country || "",
      phone: data.phone || "",
      interests: data.interests || [],
      tier: data.tier,
      currentPlanName: data.current_plan_name,
      chatMessagesLimit: data.chat_messages_limit,
      chatMessagesUsed: data.chat_messages_used,
      priceAlertsLimit: data.price_alerts_limit,
      priceAlertsUsed: data.price_alerts_used,
      canExportPdf: data.can_export_pdf,
      subscriptionEndDate: data.subscription_end_date ? new Date(data.subscription_end_date).getTime() : null,
      referralCode: data.referral_code || "",
      inviteCount: data.invite_count || 0,
    });
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!session?.user) {
      setHistory([]);
      return;
    }
    const { data, error } = await supabase
      .from("analyses")
      .select("*")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false });
    if (!error && data) {
      setHistory(data.map((row: any) => ({ ...row.full_report, id: row.id, moneySaved: row.money_saved })));
    }
  }, [session]);

  // ---- Auth state listener: the single source of truth (fixes the "badge
  // disappears after login" bug — tier is always re-fetched here, never a
  // stale one-time value). ----
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) {
        refreshUserProfile(newSession.user.id, newSession.user.email || "");
      } else {
        setUser(null);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [refreshUserProfile]);

  useEffect(() => {
    if (session?.user) {
      refreshHistory();
    }
  }, [session, refreshHistory]);

  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error?.message || null };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message || null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setHistory([]);
    setCurrentReport(null);
  }, [setCurrentReport]);

  // Section 7 login-gating: run `action` now if signed in, otherwise stash it
  // and redirect to login; LoginScreen's success handler resumes it.
  // First-time-only: once session exists, this always takes the "run now" path.
  const requireAuth = useCallback((action: () => void) => {
    if (session?.user) {
      action();
    } else {
      setPendingAction(() => action);
      navigate("login");
    }
  }, [session, navigate]);

  const saveToHistory = useCallback(async (r: AnalysisResult): Promise<boolean> => {
    if (!session?.user) return false;

    // Ensure numeric values are never null for the database (Section 2/12)
    const { error } = await supabase.from("analyses").insert({
      user_id: session.user.id,
      product: r.product,
      offered_price: r.offeredPrice,
      currency: r.currency,
      verdict: r.verdict,
      market_fair_price_min: r.marketFairPriceMin || 0,
      market_fair_price_max: r.marketFairPriceMax || 0,
      market_fair_price_mid: r.marketFairPriceMid || 0,
      money_saved: r.moneySaved || 0,
      full_report: r,
    });
    if (error) {
      // Surface the real reason (RLS, missing column, etc.) instead of
      // failing silently while the caller shows a success toast anyway.
      console.error("Save to history failed:", error);
      return false;
    }

    await refreshHistory();

    // Section 12: maintain totalMoneySaved as a running total, never subtracting.
    if (typeof r.moneySaved === "number" && r.moneySaved > 0) {
      const { data: row } = await supabase.from("users").select("total_money_saved").eq("id", session.user.id).single();
      await supabase
        .from("users")
        .update({ total_money_saved: (row?.total_money_saved || 0) + r.moneySaved })
        .eq("id", session.user.id);
    }
    return true;
  }, [session, refreshHistory]);

  const addToGuestHistory = useCallback((r: AnalysisResult) => {
    setGuestHistory((prev) => {
      const next = [r, ...prev.filter((h) => h.id !== r.id)].slice(0, 15);
      try {
        localStorage.setItem("qarari_guest_history", JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }, []);

  // Guests see their device-local history; signed-in users see their real
  // synced history from Supabase.
  const effectiveHistory = session?.user ? history : guestHistory;

  const isPremium = user?.tier === "premium";

  return (
    <AppContext.Provider value={{
      lang, setLang, dir, t, screen, navigate,
      currentReport, setCurrentReport,
      currentCompare, setCurrentCompare,
      history: effectiveHistory, saveToHistory, refreshHistory,
      addToGuestHistory,
      user, session, authLoading,
      signUp, signIn, signOut,
      isPremium,
      showToast, toast,
      pendingAction, setPendingAction,
      requireAuth,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export { getDemoReport };
