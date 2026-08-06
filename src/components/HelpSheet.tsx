import { useApp } from "@/lib/AppContext";
import { X } from "lucide-react";

export function HelpSheet() {
  const { t, helpSheetOpen, setHelpSheetOpen } = useApp();

  if (!helpSheetOpen) return null;

  const steps = [t("helpStep1"), t("helpStep2"), t("helpStep3")];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) setHelpSheetOpen(false);
      }}
    >
      <div className="w-full max-w-lg rounded-t-3xl border-t border-amber-500/20 bg-[#0B0B0F] p-6 pb-8 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-lg font-bold text-amber-400">{t("helpSheetTitle")}</h2>
          <button
            onClick={() => setHelpSheetOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-xl border border-amber-500/10 bg-zinc-900/60 p-3.5"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 text-xs font-bold text-[#0B0B0F]">
                {i + 1}
              </span>
              <span className="text-sm leading-relaxed text-zinc-200">{step}</span>
            </li>
          ))}
        </ol>

        <button
          onClick={() => setHelpSheetOpen(false)}
          className="mt-5 w-full rounded-2xl bg-gradient-to-r from-amber-400 to-amber-600 py-3 font-bold text-[#0B0B0F] shadow-lg shadow-amber-500/20"
        >
          {t("helpGotIt")}
        </button>
      </div>
    </div>
  );
}
