import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { ShoppingBag, Camera, Scale, ShieldCheck, CheckCircle2, Bell, Sparkles } from "lucide-react";

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
      className="fixed inset-0 z-[100] flex flex-col bg-[#FFFFFF]"
      // Tapping anywhere on the slide (outside the buttons) also advances —
      // makes the sequence feel tappable, not just swipeable-in-theory.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-onboarding-control]")) return;
        goNext();
      }}
    >
      {/* Ambient glow background matching the app's dark + gold theme */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-shary-dark/20 via-transparent to-transparent" />

      {/* Skip link — top-start (RTL: top-right, LTR: top-left) */}
      <div className="relative z-10 flex justify-end px-5 pt-5">
        <button
          data-onboarding-control
          onClick={(e) => {
            e.stopPropagation();
            completeOnboarding();
          }}
          className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-700"
        >
          {t("onboardingSkip")}
        </button>
      </div>

      {/* Slide content */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div key={index} className="reveal-fade-rise flex flex-col items-center">
          {/* Icon in a soft radial glow ring, with the icon itself floating/rotating */}
          <div className="relative mb-8 flex h-32 w-32 items-center justify-center">
            <div className="onboarding-ring absolute inset-0 rounded-full bg-gradient-to-br from-shary/30 to-shary-dark/10 blur-xl" />
            <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black ring-1 ring-shary/30 shadow-2xl">
              <Icon className="onboarding-icon-float h-11 w-11 text-shary-dark" strokeWidth={1.5} />
            </div>
            {/* Floating example-value chip */}
            <div
              className="onboarding-chip absolute -bottom-3 whitespace-nowrap rounded-full border border-shary/40 bg-white/95 px-3 py-1.5 text-xs font-bold text-shary-dark shadow-lg"
              style={{ insetInlineEnd: "-1rem" }}
            >
              {t(slide.chipKey)}
            </div>
          </div>

          <h1 className="whitespace-pre-line text-2xl font-bold leading-snug text-zinc-900">
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
                i === index ? "w-6 bg-shary" : "w-1.5 bg-zinc-700"
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
          className="flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-shary to-shary-dark px-6 py-3.5 font-bold text-[#FFFFFF] shadow-xl shadow-shary/20 transition-transform active:scale-[0.98]"
        >
          {isLast && <Sparkles className="h-4 w-4" />}
          {isLast ? t("onboardingStart") : t("onboardingNext")}
        </button>
      </div>
    </div>
  );
}
