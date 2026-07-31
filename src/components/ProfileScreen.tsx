import { useEffect, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { currencies, FREE_MONTHLY_LIMIT } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  User, Mail, Phone, MapPin, LogOut, Share2, CheckCircle2,
  Crown, Zap, Send, ChevronLeft, Copy
} from "lucide-react";

export function ProfileScreen() {
  const { t, lang, dir, user, signOut, navigate, isPremium, session, authLoading } = useApp();
  const [scansUsed, setScansUsed] = useState(0);
  const [scansMax, setScansMax] = useState(FREE_MONTHLY_LIMIT);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function fetchUsage() {
      if (!session?.access_token) return;
      try {
        const res = await fetch("/api/user?action=scans-remaining", { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        if (!data.unlimited && typeof data.remaining === "number") {
          const max = typeof data.max === "number" ? data.max : FREE_MONTHLY_LIMIT;
          setScansUsed(Math.max(0, max - data.remaining));
          setScansMax(max);
        }
      } catch {
        // non-critical display value; ignore failures silently here
      }
    }
    fetchUsage();
  }, [session, isPremium]);

  // Redirect to login only once we actually KNOW there's no session — never
  // during the brief moment right after login where `session` is already
  // set but the `user` profile row is still being fetched. Checking `user`
  // here (instead of `session`) was the bug: it bounced a freshly-logged-in
  // person straight back to the login screen because their profile hadn't
  // loaded yet, even though they were properly authenticated. This also has
  // to run in an effect, not during render, so it never fires on a stale
  // value mid-render.
  useEffect(() => {
    if (!authLoading && !session?.user) {
      navigate("login");
    }
  }, [authLoading, session, navigate]);

  if (authLoading || (session?.user && !user)) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center px-4 py-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }

  if (!session?.user) {
    return null; // the effect above is already redirecting to login
  }

  const handleLogout = async () => {
    await signOut();
    navigate("input");
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText("https://qarari-aia.vercel.app");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shareUrl = encodeURIComponent("https://qarari-aia.vercel.app");
  const shareText = encodeURIComponent(lang === "ar" ? "ساعدني في توفير فلوسي بقرارات شراء ذكية مع Qarari.AI!" : "Help me save money with smart purchase decisions using Qarari.AI!");

  const subEndDate = user.subscriptionEndDate
    ? new Date(user.subscriptionEndDate).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-24">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/50 text-zinc-400 transition-colors hover:text-amber-400"
        >
          {dir === "rtl" ? <ChevronLeft className="h-5 w-5 rotate-180" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
        <h1 className="font-serif text-2xl font-bold text-amber-400">{t("profile")}</h1>
      </div>

      {/* Profile Header */}
      <div className="mb-6 rounded-2xl border border-amber-500/15 bg-gradient-to-b from-zinc-900/80 to-[#0B0B0F] p-6 shadow-lg">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg">
            <span className="text-2xl font-bold text-[#0B0B0F]">
              {user.name.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-zinc-100">{user.name}</h2>
              {isPremium && (
                <span className="flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-400/20 to-amber-600/20 px-2 py-0.5 text-xs font-bold text-amber-400 ring-1 ring-amber-500/30">
                  <Crown className="h-3 w-3" /> {user.currentPlanName ? user.currentPlanName.replace('_', ' ').toUpperCase() : t("premium")}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-500">{user.email}</p>
            {isPremium && subEndDate ? (
              <p className="mt-1 text-xs text-amber-400/80">
                {t("premiumActive")} {subEndDate}
              </p>
            ) : isPremium ? (
              <p className="mt-1 text-xs text-amber-400/80">
                {lang === "ar" ? "باقة دائمة نشطة" : "Lifetime plan active"}
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">
                {t("freePlanStatus", { used: scansUsed, max: scansMax })}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Share Card */}
      <div className="mb-6 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-transparent p-5 shadow-xl shadow-amber-500/5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-500">
            <Share2 className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-amber-400">
              {lang === "ar" ? "شارك التطبيق مع أصدقائك" : "Share with friends"}
            </h3>
            <p className="text-[11px] text-zinc-400">
              {lang === "ar" ? "ساعدهم في توفير أموالهم وقرارات شرائهم" : "Help them save money and make better decisions"}
            </p>
          </div>
        </div>

        <div className="relative mb-4">
          <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-2 pl-3">
            <span className="flex-1 truncate text-xs text-zinc-500">qarari-aia.vercel.app</span>
            <button 
              onClick={handleCopyLink}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-[11px] font-bold text-[#0B0B0F] transition-all active:scale-95"
            >
              {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? (lang === "ar" ? "تم" : "Done") : (lang === "ar" ? "نسخ" : "Copy")}
            </button>
          </div>
          {copied && (
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 animate-bounce rounded-full bg-emerald-500 px-3 py-1 text-[10px] font-bold text-white shadow-lg">
              {lang === "ar" ? "تم نسخ الرابط بنجاح!" : "Link copied successfully!"}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <a 
            href={`https://wa.me/?text=${shareText}%20${shareUrl}`}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:border-emerald-500/30 hover:text-emerald-400"
          >
            <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.414 0 .018 5.393 0 12.029c0 2.119.554 4.187 1.605 6.006L0 24l6.117-1.605a11.803 11.803 0 005.925 1.577h.005c6.631 0 12.026-5.398 12.03-12.03a11.85 11.85 0 00-3.486-8.451"/></svg>
            واتساب
          </a>
          <a 
            href={`https://t.me/share/url?url=${shareUrl}&text=${shareText}`}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:border-sky-500/30 hover:text-sky-400"
          >
            <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.52-1.4.51-.46-.01-1.35-.26-2.01-.48-.81-.27-1.45-.42-1.39-.89.03-.25.38-.51 1.05-.78 4.1-1.78 6.84-2.95 8.22-3.51 3.91-1.58 4.72-1.85 5.25-1.86.12 0 .38.03.55.17.14.11.18.26.2.37.02.12.02.25.01.38z"/></svg>
            تيليجرام
          </a>
        </div>
      </div>

      {/* Profile Details */}
      <div className="mb-6 space-y-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-amber-400/70" />
            <div className="flex-1">
              <p className="text-xs text-zinc-500">{t("profileName")}</p>
              <p className="text-sm text-zinc-200">{user.name}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-amber-400/70" />
            <div className="flex-1">
              <p className="text-xs text-zinc-500">{t("profileEmail")}</p>
              <p className="text-sm text-zinc-200">{user.email}</p>
            </div>
          </div>
        </div>
        {user.phone && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center gap-3">
              <Phone className="h-5 w-5 text-amber-400/70" />
              <div className="flex-1">
                <p className="text-xs text-zinc-500">{t("profilePhone")}</p>
                <p className="text-sm text-zinc-200">{user.phone}</p>
              </div>
            </div>
          </div>
        )}
        {user.country && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center gap-3">
              <MapPin className="h-5 w-5 text-amber-400/70" />
              <div className="flex-1">
                <p className="text-xs text-zinc-500">{t("profileCountry")}</p>
                <p className="text-sm text-zinc-200">{t(user.country)}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Upgrade CTA (if free) */}
      {!isPremium && (
        <div className="mb-6 rounded-2xl border border-amber-500/30 bg-gradient-to-b from-amber-500/10 to-transparent p-6 text-center">
          <Crown className="mx-auto mb-2 h-8 w-8 text-amber-400" />
          <h3 className="font-serif text-lg font-bold text-amber-400">{t("premium")}</h3>
          <Button onClick={() => navigate("upgrade")} className="mt-4 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] hover:from-amber-300 hover:to-amber-500">
            <Zap className="h-4 w-4" /> {t("subscribeNow")}
          </Button>
        </div>
      )}

      {/* Support Contact */}
      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="mb-3 text-sm font-bold text-amber-400">{t("contactSupport")}</h3>
        <p className="mb-3 text-xs text-zinc-500">{t("needHelp")}</p>
        <div className="flex gap-3">
          <a
            href="https://t.me/qarari_support"
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2.5 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-500/10"
          >
            <Send className="h-4 w-4" /> {t("supportTelegram")}
          </a>
        </div>
      </div>

      {/* Logout */}
      <Button onClick={handleLogout} variant="outline" className="w-full border-red-500/20 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-300">
        <LogOut className="h-4 w-4" /> {t("logout")}
      </Button>
    </div>
  );
}
