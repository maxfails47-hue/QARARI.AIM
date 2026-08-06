import { useApp } from "@/lib/AppContext";
import { CheckCircle2 } from "lucide-react";

export function Toast() {
  const { toast, dir } = useApp();
  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-6 ${dir === "rtl" ? "left-6" : "right-6"} z-50 flex items-center gap-2 rounded-xl border border-shary/30 bg-white/95 px-4 py-3 shadow-xl shadow-shary/10 backdrop-blur-md`}
    >
      <CheckCircle2 className="h-5 w-5 text-shary-dark" />
      <span className="text-sm font-medium text-zinc-900">{toast}</span>
    </div>
  );
}