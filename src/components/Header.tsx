import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Globe, History, User, Sparkles, Plus, Bell, MoreVertical } from "lucide-react";
import { HeaderInstallButton } from "@/components/HeaderInstallButton";

export function Header() {
  const { lang, setLang, t, navigate, screen, user } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the "More" dropdown on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-amber-500/20 bg-[#0B0B0F]/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <button
          onClick={() => navigate("input")}
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg shadow-amber-500/20">
            <Sparkles className="h-5 w-5 text-[#0B0B0F]" />
          </div>
          <div className="flex flex-col items-start leading-none">
            <span className="font-serif text-lg font-bold text-amber-400">Qarari</span>
            <span className="text-[10px] font-medium text-zinc-500">AI Analyzer</span>
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => navigate("input")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "input" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("newDecision")}
          >
            <Plus className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate("history")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "history" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("history")}
          >
            <History className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate(user ? "profile" : "login")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "profile" || screen === "login" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("profile")}
          >
            <User className="h-5 w-5" />
          </button>

          {/* Everything occasional/secondary lives behind this single "More"
              button instead of each getting its own permanent header icon —
              install prompt, premium comparison history, watchlist, language. */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                menuOpen || screen === "watchlist"
                  ? "bg-amber-500/15 text-amber-400"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
              }`}
              title={t("moreMenu")}
              aria-label={t("moreMenu")}
              aria-expanded={menuOpen}
            >
              <MoreVertical className="h-5 w-5" />
            </button>

            {menuOpen && (
              <div className="absolute top-11 z-50 w-52 rounded-xl border border-zinc-800 bg-zinc-900 p-1.5 shadow-2xl ltr:right-0 rtl:left-0">
                {user && (
                  <button
                    onClick={() => {
                      navigate("watchlist");
                      setMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start text-sm transition-colors hover:bg-zinc-800/70 ${
                      screen === "watchlist" ? "text-amber-400" : "text-zinc-200"
                    }`}
                  >
                    <Bell className="h-4 w-4 shrink-0" />
                    {t("watchlistTitle")}
                  </button>
                )}
                {user && <div className="my-1 h-px bg-zinc-800" />}

                <HeaderInstallButton variant="menuItem" onAfterClick={() => setMenuOpen(false)} />

                <div className="my-1 h-px bg-zinc-800" />

                <button
                  onClick={() => {
                    setLang(lang === "ar" ? "en" : "ar");
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start text-sm text-zinc-200 transition-colors hover:bg-zinc-800/70"
                >
                  <Globe className="h-4 w-4 shrink-0" />
                  {lang === "ar" ? "English" : "العربية"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
