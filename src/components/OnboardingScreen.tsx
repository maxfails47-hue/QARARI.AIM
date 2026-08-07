import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { ShoppingBag, Camera, Scale, Search, ShieldCheck, CheckCircle2, Bell, Sparkles } from "lucide-react";

interface Slide {
  Icon: typeof ShoppingBag;
  chipKey: string;
  headlineKey: string;
  bodyKey: string;
}

const SLIDES: Slide[] = [
  { Icon: ShoppingBag, chipKey: "onboardingSlide1Chip", headlineKey: "onboardingSlide1Headline", bodyKey: "onboardingSlide1Body" },
  { Icon: Camera, chipKey: "onboardingSlide2Chip", headlineKey: "onboardingSlide2Headline", bodyKey: "onboardingSlide2Body" },
  { Icon: Scale, chipKey: "onboardingSlide3Chip", headlineKey: "onboardingSlide3Headline", bodyKey: "onboardingSlide3Body" },
  { Icon: Search, chipKey: "onboardingSlidePriceSearchChip", headlineKey: "onboardingSlidePriceSearchHeadline", bodyKey: "onboardingSlidePriceSearchBody" },
  { Icon: ShieldCheck, chipKey: "onboardingSlide4Chip", headlineKey: "onboardingSlide4Headline", bodyKey: "onboardingSlide4Body" },
  { Icon: CheckCircle2, chipKey: "onboardingSlide5Chip", headlineKey: "onboardingSlide5Headline", bodyKey: "onboardingSlide5Body" },
  { Icon: Bell, chipKey: "onboardingSlide6Chip", headlineKey: "onboardingSlide6Headline", bodyKey: "onboardingSlide6Body" },
];

export function OnboardingScreen() {
  const { t, completeOnboarding } = useApp();
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;
  const slide = SLIDES[index];
  const Icon = slide.Icon;

  const goNext = () => {
    if (isLast) {
      completeOnboarding();
    } else {
      setIndex((i) => i + 1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-[#0B0B0F]"
      // Tapping anywhere on the slide (outside the buttons) also advances —
      // makes the sequence feel tappable, not just swipeable-in-theory.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-onboarding-control]")) return;
        goNext();
      }}
    >
      {/* Ambient glow background matching the app's dark + gold theme */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-amber-950/20 via-transparent to-transparent" />

      {/* Skip link — top-start (RTL: top-right, LTR: top-left) */}
      <div className="relative z-10 flex justify-end px-5 pt-5">
        <button
          data-onboarding-control
          onClick={(e) => {
            e.stopPropagation();
            completeOnboarding();
          }}
          className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-300"
        >
          {t("onboardingSkip")}
        </button>
      </div>

      {/* Slide content */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div key={index} className="reveal-fade-rise flex flex-col items-center">
          {/* Icon in a soft radial glow ring, with the icon itself floating/rotating */}
          <div className="relative mb-8 flex h-32 w-32 items-center justify-center">
            <div className="onboarding-ring absolute inset-0 rounded-full bg-gradient-to-br from-amber-400/30 to-amber-600/10 blur-xl" />
            <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black ring-1 ring-amber-500/30 shadow-2xl">
              <Icon className="onboarding-icon-float h-11 w-11 text-amber-400" strokeWidth={1.5} />
            </div>
            {/* Floating example-value chip */}
            <div
              className="onboarding-chip absolute -bottom-3 whitespace-nowrap rounded-full border border-amber-500/40 bg-zinc-900/95 px-3 py-1.5 text-xs font-bold text-amber-400 shadow-lg"
              style={{ insetInlineEnd: "-1rem" }}
            >
              {t(slide.chipKey)}
            </div>
          </div>

          <h1 className="whitespace-pre-line font-serif text-2xl font-bold leading-snug text-zinc-50">
            {t(slide.headlineKey)}
          </h1>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-400">
            {t(slide.bodyKey)}
          </p>
        </div>
      </div>

      {/* Progress dots + CTA */}
      <div className="relative z-10 flex flex-col items-center gap-6 px-8 pb-10">
        <div className="flex items-center gap-2">
          {SLIDES.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-6 bg-amber-400" : "w-1.5 bg-zinc-700"
              }`}
            />
          ))}
        </div>
        <button
          data-onboarding-control
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          className="flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 to-amber-600 px-6 py-3.5 font-bold text-[#0B0B0F] shadow-xl shadow-amber-500/20 transition-transform active:scale-[0.98]"
        >
          {isLast && <Sparkles className="h-4 w-4" />}
          {isLast ? t("onboardingStart") : t("onboardingNext")}
        </button>
      </div>
    </div>
  );
}
