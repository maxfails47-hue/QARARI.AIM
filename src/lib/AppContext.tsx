import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Language, Screen, AnalysisResult, UserProfile } from "@/lib/types";
import { translations } from "@/lib/translations";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

interface AppContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  dir: "rtl" | "ltr";
  t: (key: string, params?: Record<string, string | number>) => string;
  screen: Screen;
  navigate: (screen: Screen) => void;
  // Kept only so already-saved legacy analyses (pre plain-search pivot)
  // still surface in the "total savings" stat on HistoryScreen. Nothing
  // writes new entries here anymore.
  history: AnalysisResult[];
  refreshHistory: () => Promise<void>;
  user: UserProfile | null;
  session: Session | null;
  authLoading: boolean;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: string | null; needsConfirmation: boolean; alreadyRegistered: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  showToast: (msg: string) => void;
  toast: string | null;
  pendingAction: (() => void) | null;
  setPendingAction: (a: (() => void) | null) => void;
  requireAuth: (action: () => void) => void;
  // First-run onboarding (Section 1): shown once before InputScreen, then
  // gated behind a localStorage flag. Exposed on context so ProfileScreen
  // (or any other screen) can offer a "Replay intro" action for QA/marketing.
  onboardingVisible: boolean;
  completeOnboarding: () => void;
  replayOnboarding: () => void;
  // Persistent "How it works" help sheet (Section 2) — a single piece of
  // shared UI state so the floating "؟" button in the app shell and any
  // screen can open/close it.
  helpSheetOpen: boolean;
  setHelpSheetOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem("shary-lang");
    return (saved as Language) || "ar";
  });
  const [screen, setScreen] = useState<Screen>("input");
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [onboardingVisible, setOnboardingVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem("shary_onboarded") !== "true";
    } catch {
      return true;
    }
  });
  const [helpSheetOpen, setHelpSheetOpen] = useState(false);

  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
    localStorage.setItem("shary-lang", lang);
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

  const completeOnboarding = useCallback(() => {
    try {
      localStorage.setItem("shary_onboarded", "true");
    } catch {
      // ignore quota/private-mode errors — worst case onboarding replays once more
    }
    setOnboardingVisible(false);
  }, []);

  const replayOnboarding = useCallback(() => {
    setOnboardingVisible(true);
    navigate("input");
  }, [navigate]);

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

  const signUp = useCallback(async (email: string, password: string, fullName?: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Without this, Supabase falls back to the project's "Site URL"
        // (Authentication → URL Configuration in the dashboard) — which is
        // often still left as the localhost default. That sends the
        // confirmation link to a dead localhost address instead of back to
        // the real app. Setting it explicitly here removes that dependency.
        emailRedirectTo: window.location.origin,
        // Stash the name in auth user_metadata so it survives the email-
        // confirmation flow. The old approach only wrote full_name to
        // public.users via a client-side UPDATE *after* signUp resolved —
        // but when the project requires email confirmation, there's no
        // session yet at that point, so the UPDATE never ran and the name
        // was silently lost forever. Putting it here means the
        // on_auth_user_created DB trigger can read it and set full_name at
        // row-creation time, regardless of whether confirmation is required.
        data: fullName ? { full_name: fullName } : undefined,
      },
    });
    if (error) return { error: error.message, needsConfirmation: false, alreadyRegistered: false };

    // Supabase returns a "success" response with no error even when the email
    // is already registered (identities is an empty array in that case) —
    // otherwise it would leak which emails exist. We must detect this
    // ourselves, or the UI will lie and say "account created" for existing users.
    const alreadyRegistered = !!data.user && (data.user.identities?.length ?? 0) === 0;

    // If email confirmation is required in the Supabase project, signUp
    // succeeds but returns no session — the user is NOT actually logged in
    // yet. The caller must not treat this as an authenticated session.
    const needsConfirmation = !alreadyRegistered && !data.session;

    return { error: null, needsConfirmation, alreadyRegistered };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message || null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setHistory([]);
  }, []);

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

  // Nothing creates new AnalysisResult rows anymore (the offered-price /
  // verdict flow is retired — Shary just searches and shows results now).
  // `history` here only surfaces rows saved before that pivot, purely so
  // HistoryScreen can still total up past `moneySaved` for the "total
  // savings" stat.

  return (
    <AppContext.Provider value={{
      lang, setLang, dir, t, screen, navigate,
      history, refreshHistory,
      user, session, authLoading,
      signUp, signIn, signOut,
      showToast, toast,
      pendingAction, setPendingAction,
      requireAuth,
      onboardingVisible, completeOnboarding, replayOnboarding,
      helpSheetOpen, setHelpSheetOpen,
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


