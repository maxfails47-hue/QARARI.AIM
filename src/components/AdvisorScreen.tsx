import { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageCircle, Send, Mic, ChevronLeft, Bot, Brain, X, Lock, Zap, ShieldCheck, TrendingUp
} from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AdvisorScreen() {
  const { t, lang, dir, session } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const starterQuestions = lang === "ar" ? [
    "معايا 30 ألف وعايز لابتوب للدراسة، إيه أفضل خيار؟",
    "إيه أحسن موبايل كاميرا في 25 ألف؟",
    "فرق إيه بين iPhone 15 و iPhone 14؟ يستاهل؟",
    "عايز سماعات بلوتوث تحت 2000 جنيه، أيها أحسن؟",
  ] : [
    "I have 30K EGP and need a laptop for studying, what's best?",
    "What's the best camera phone under 25K EGP?",
    "iPhone 15 vs 14? Is the upgrade worth it?",
    "I need Bluetooth earphones under 2000 EGP?",
  ];

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendQuestion = (question: string) => {
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    (async () => {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

        const res = await fetch("/api/ask", {
          method: "POST",
          headers,
          body: JSON.stringify({
            question,
            mode: "advisor",
            language: lang,
            history: messages.slice(-8),
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (res.status === 403) {
            setMessages((prev) => [...prev, { role: "assistant", content: lang === "ar" ? "وصلت للحد الأقصى للرسائل المجانية، اشترك في بريميوم لفتح دردشة غير محدودة!" : "You've reached the free message limit, upgrade to Premium for unlimited chat!" }]);
            return;
          }
          throw new Error(errData.error || "failed");
        }

        const data = await res.json();
        if (data.answer) {
          setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
          setShowSuggestions(false);
        } else {
          throw new Error("no_answer");
        }
      } catch (err) {
        console.error("Advisor chat error:", err);
        setMessages((prev) => [...prev, { role: "assistant", content: lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Error, please try again" }]);
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleSend = () => {
    if (!input.trim() || loading) return;

    const question = input.trim();
    setInput("");
    sendQuestion(question);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-80px)] max-w-3xl flex-col px-4 py-4">
      {/* Premium Header */}
      <div className="mb-4 flex items-center justify-between rounded-2xl bg-gradient-to-r from-shary/10 to-shary-dark/5 p-4 border border-shary/20 shadow-lg shadow-shary/5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-shary text-black shadow-lg shadow-shary/20">
              <Bot className="h-7 w-7" />
            </div>
            <div className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 border-2 border-[#FFFFFF]">
              <Zap className="h-3 w-3 text-white fill-white" />
            </div>
          </div>
          <div>
            <h1 className="text-lg font-bold text-shary-dark">
              {lang === "ar" ? "المساعد الشخصي الذكي" : "Smart AI Advisor"}
            </h1>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold uppercase tracking-wider">
                <ShieldCheck className="h-3 w-3" /> متصل بأسعار السوق
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto rounded-3xl border border-zinc-200 bg-zinc-50 p-6 mb-4 space-y-6 scrollbar-hide">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="mb-6 relative">
              <div className="absolute inset-0 blur-3xl bg-shary/20 rounded-full" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-shary to-shary-dark shadow-2xl shadow-shary/40">
                <Brain className="h-10 w-10 text-black" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-zinc-900 mb-2">
              {lang === "ar" ? "أهلاً بك في المستقبل" : "Welcome to the Future"}
            </h2>
            <p className="text-sm text-zinc-500 max-w-xs mb-8">
              {lang === "ar" 
                ? "أنا مساعدك الشخصي، هساعدك تشتري صح وتوفر فلوسك ببيانات حقيقية من السوق."
                : "I'm your personal advisor, helping you buy smart and save money with real market data."}
            </p>
            
            <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
              {starterQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(q); }}
                  className="rounded-2xl border border-zinc-200 bg-zinc-50/30 p-4 text-right text-xs text-zinc-400 transition-all hover:border-shary/30 hover:bg-shary/5 hover:text-shary-dark"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${
              msg.role === "user" 
                ? "bg-shary text-black font-medium rounded-tr-none" 
                : "bg-zinc-50 text-zinc-900 border border-zinc-200 rounded-tl-none"
            }`}>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-zinc-50 border border-zinc-200 rounded-2xl rounded-tl-none px-5 py-3 flex gap-1">
              <div className="h-1.5 w-1.5 bg-shary rounded-full animate-bounce" />
              <div className="h-1.5 w-1.5 bg-shary rounded-full animate-bounce [animation-delay:0.2s]" />
              <div className="h-1.5 w-1.5 bg-shary rounded-full animate-bounce [animation-delay:0.4s]" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="relative">
        <div className="absolute -top-12 left-0 right-0 flex justify-center px-4 pointer-events-none">
          <div className="bg-white backdrop-blur-md border border-shary/20 rounded-full px-4 py-1.5 flex items-center gap-2 shadow-xl pointer-events-auto">
            <TrendingUp className="h-3 w-3 text-emerald-400" />
            <span className="text-[10px] font-bold text-zinc-700 uppercase tracking-wider">
              {lang === "ar" ? "أسعار السوق محدثة الآن" : "Market prices updated now"}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-2xl focus-within:border-shary/50 transition-colors">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={lang === "ar" ? "اسألني أي حاجة..." : "Ask me anything..."}
            className="flex-1 border-none bg-transparent text-zinc-900 placeholder:text-zinc-400 focus-visible:ring-0 h-12"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-shary text-black transition-all hover:bg-shary disabled:opacity-40 shadow-lg shadow-shary/20"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-zinc-600">
          Powered by Shary Intelligence • Egyptian Market Data v2.4
        </p>
      </div>
    </div>
  );
}
