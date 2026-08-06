import { useEffect, useState } from "react";
import {
  Shield, LogOut, BarChart3, DollarSign,
  Loader2, RefreshCw, Users,
} from "lucide-react";
import { getStoredCreds, storeCreds, clearCreds, adminFetch } from "@/admin/adminApi";

type Tab = "metrics" | "costs";

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function AdminLogin({ onSuccess, expiredNotice }: { onSuccess: () => void; expiredNotice?: boolean }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin?action=login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
      });
      if (!res.ok) {
        setError("كلمة المرور غير صحيحة");
        return;
      }
      storeCreds({ username: "admin", password });
      onSuccess();
    } catch {
      setError("حصل خطأ، حاول تاني");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0B0B0F] px-4">
      <form onSubmit={handleLogin} className="w-full max-w-sm rounded-2xl border border-amber-500/15 bg-zinc-900/60 p-6 shadow-2xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg">
            <Shield className="h-7 w-7 text-[#0B0B0F]" />
          </div>
          <h1 className="font-serif text-xl font-bold text-amber-400">لوحة تحكم Shary</h1>
          <p className="mt-1 text-xs text-zinc-500">Admin Dashboard</p>
        </div>

        <div className="space-y-3">
          {expiredNotice && (
            <p className="rounded-lg bg-orange-500/10 px-3 py-2 text-center text-xs text-orange-400 ring-1 ring-orange-500/20">
              انتهت صلاحية الجلسة (كلمة المرور المحفوظة بقت مش صحيحة) — سجّل دخول تاني
            </p>
          )}
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="كلمة المرور"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 text-center"
            autoComplete="current-password"
            autoFocus
          />
        </div>

        {error && <p className="mt-3 text-xs text-red-400 text-center">{error}</p>}

        <button
          type="submit"
          disabled={loading || !password}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-amber-400 to-amber-600 py-2.5 text-sm font-bold text-[#0B0B0F] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
          دخول
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics tab (Section 26 — Business Metrics Dashboard)
// ---------------------------------------------------------------------------
function StatCard({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-amber-500/30 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/60"}`}>
      <div className="mb-2 flex items-center gap-2 text-zinc-500">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className={`text-xl font-bold ${accent ? "text-amber-400" : "text-zinc-100"}`}>{value}</p>
    </div>
  );
}

function MetricsTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminFetch("/api/admin?action=metrics");
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setLoadError(body?.error ? `${body.error}${body.message ? `: ${body.message}` : ""}` : `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch (e: any) {
      setLoadError(e?.message || "network_error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-amber-400" /></div>;
  }

  if (loadError || !data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-red-400">حصل خطأ وإحنا بنجيب المقاييس{loadError ? `: ${loadError}` : ""}</p>
        <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-500/40">
          <RefreshCw className="h-3.5 w-3.5" /> حاول تاني
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-amber-400">
          <RefreshCw className="h-3.5 w-3.5" /> تحديث
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard icon={Users} label="إجمالي المستخدمين" value={data.totalUsers} accent />
        <StatCard icon={Users} label="تسجيلات آخر 7 أيام" value={data.newSignupsThisWeek} />
        <StatCard icon={BarChart3} label="تحليلات هذا الشهر" value={data.analysesThisMonth} />
        <StatCard icon={BarChart3} label="إجمالي التحليلات" value={data.totalAnalyses} />
        <StatCard icon={DollarSign} label="إجمالي الفلوس اللي وفّرها المستخدمين" value={`${data.totalMoneySaved.toLocaleString()} EGP`} accent />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Costs tab (Section 25 — AI Cost Dashboard)
// ---------------------------------------------------------------------------
function CostsTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminFetch("/api/admin?action=ai-costs");
      const body = await res.json().catch(() => null);
      // This used to blindly `setData(await res.json())` even on a 500 —
      // so an error body like {error:"server_error"} got stored as `data`,
      // and the render below did `data.dailyTrend.map(...)` on a field
      // that error body never has, crashing the whole tab with "Cannot
      // read properties of undefined (reading 'map')". Catch it here
      // instead and show the actual error.
      if (!res.ok || !body) {
        setLoadError(body?.error ? `${body.error}${body.message ? `: ${body.message}` : ""}` : `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch (e: any) {
      setLoadError(e?.message || "network_error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-amber-400" /></div>;
  }

  if (loadError || !data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-red-400">حصل خطأ وإحنا بنجيب تكلفة الذكاء الاصطناعي{loadError ? `: ${loadError}` : ""}</p>
        <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-500/40">
          <RefreshCw className="h-3.5 w-3.5" /> حاول تاني
        </button>
      </div>
    );
  }

  const dailyTrend = data.dailyTrend || [];
  const byModel = data.byModel || {};
  const byEndpoint = data.byEndpoint || {};
  const maxDay = Math.max(1, ...dailyTrend.map((d: any) => d.cost));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-amber-400">
          <RefreshCw className="h-3.5 w-3.5" /> تحديث
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={DollarSign} label="تكلفة تقديرية هذا الشهر" value={`$${data.totalCostThisMonth}`} accent />
        <StatCard icon={BarChart3} label="عدد طلبات AI" value={data.totalCallsThisMonth} />
        <StatCard icon={BarChart3} label="متوسط التكلفة/طلب" value={`$${data.avgCostPerCall}`} />
        <StatCard icon={BarChart3} label="إجمالي التوكنز" value={data.totalTokensThisMonth.toLocaleString()} />
      </div>

      {/* Daily trend, last 14 days */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="mb-3 text-xs font-bold text-zinc-400">التكلفة اليومية — آخر 14 يوم</p>
        <div className="flex h-32 items-end gap-1">
          {dailyTrend.map((d: any) => (
            <div key={d.date} className="group relative flex-1">
              <div
                className="w-full rounded-t bg-amber-500/50 transition-colors group-hover:bg-amber-400"
                style={{ height: `${Math.max(4, (d.cost / maxDay) * 100)}%` }}
              />
              <div className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-200 group-hover:block">
                {d.date}: ${d.cost}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* By model */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="mb-3 text-xs font-bold text-zinc-400">حسب الموديل</p>
        <div className="space-y-2">
          {Object.entries(byModel).map(([model, v]: any) => (
            <div key={model} className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">{model}</span>
              <span className="text-zinc-500">{v.calls} طلب — ${v.cost.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* By endpoint */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="mb-3 text-xs font-bold text-zinc-400">حسب نوع الطلب</p>
        <div className="space-y-2">
          {Object.entries(byEndpoint).map(([ep, v]: any) => (
            <div key={ep} className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">{ep}</span>
              <span className="text-zinc-500">{v.calls} طلب — ${v.cost.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-zinc-600">{data.note}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export default function AdminApp() {
  const [authed, setAuthed] = useState(() => !!getStoredCreds());
  const [tab, setTab] = useState<Tab>("metrics");
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthed(false);
      setSessionExpired(true);
    };
    window.addEventListener("admin-unauthorized", onUnauthorized);
    return () => window.removeEventListener("admin-unauthorized", onUnauthorized);
  }, []);

  if (!authed) {
    return (
      <AdminLogin
        onSuccess={() => { setAuthed(true); setSessionExpired(false); }}
        expiredNotice={sessionExpired}
      />
    );
  }

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "metrics", label: "مقاييس الأعمال", icon: BarChart3 },
    { id: "costs", label: "تكلفة الذكاء الاصطناعي", icon: DollarSign },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-[#0B0B0F] text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-amber-500/15 bg-[#0B0B0F]/95 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-600">
              <Shield className="h-4 w-4 text-[#0B0B0F]" />
            </div>
            <span className="font-serif text-sm font-bold text-amber-400">لوحة تحكم Shary</span>
          </div>
          <button
            onClick={() => { clearCreds(); setAuthed(false); }}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400"
          >
            <LogOut className="h-3.5 w-3.5" /> خروج
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-4">
        <div className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-1">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
                tab === tb.id ? "bg-amber-500/15 text-amber-400" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <tb.icon className="h-3.5 w-3.5" /> {tb.label}
            </button>
          ))}
        </div>

        {tab === "metrics" && <MetricsTab />}
        {tab === "costs" && <CostsTab />}
      </div>
    </div>
  );
}
