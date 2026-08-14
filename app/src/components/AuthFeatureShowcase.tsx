import { useEffect, useState } from "react";
import { Bot, History, FlaskConical, Brain, SplitSquareHorizontal, BookOpen } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

// Auth page left panel (2026-08-15) — the panel was nearly empty (a
// fabricated testimonial, nothing else), and it's desktop-only
// (`hidden lg:flex` in auth.tsx), so this is pure decoration with zero
// mobile risk. Fills it with a real feature tour instead of the removed
// testimonial (see auth.tsx's own comment on why that was removed).
//
// Copy is reused VERBATIM from the landing page's own feature grid
// (routes/index.tsx) rather than invented — this can never promise
// anything the landing page itself doesn't already claim, and stays in
// sync by construction if that copy is ever revised (same wording, two
// places, both worth double-checking together if one changes).
//
// Same priority as the landing page: differentiators first (AI agent,
// scenario challenges, the simulator, AI insights), then one
// representative "table stakes" slide (journal + coaching, merged into
// one honest sentence rather than a 7th/8th slide — options/margin are
// still covered on the landing page itself).
const SLIDES = [
  { icon: Bot, title: "AI portfolio agent", body: "An AI that runs its own sub-portfolio of your virtual cash — quant screening plus real news reasoning, autonomous or approve-first." },
  { icon: History, title: "Scenario challenges", body: "Trade the 2008 crash, the 2020 COVID crash, or the 2022 bear market day-by-day, with real historical prices and no look-ahead." },
  { icon: FlaskConical, title: "What-if simulator", body: "Backtest any amount, any date, any stock — compare vs. the S&P 500." },
  { icon: Brain, title: "AI stock insights", body: "A daily lean, drivers, and risks per stock — grounded in the stock's own measured price history, not just a vibe." },
  { icon: SplitSquareHorizontal, title: "Options trading", body: "A real chain, priced live with Black-Scholes — buy and sell calls and puts on any stock or ETF." },
  { icon: BookOpen, title: "Journal & coaching", body: "Write down your reasoning at the moment you trade — Coach names your own patterns from what you actually did, never from whether you're up or down." },
] as const;

const SLIDE_MS = 5500;

export function AuthFeatureShowcase() {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    // Non-negotiable accessibility requirement: reduced motion means ONE
    // static slide, never a slower rotation — no timer running at all, not
    // even a long one. Hover-pause reuses the same effect (both are just
    // "should the timer exist right now").
    if (reducedMotion || paused) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(id);
  }, [reducedMotion, paused]);

  const activeIndex = reducedMotion ? 0 : index;
  const slide = SLIDES[activeIndex];

  return (
    <div
      className="w-full max-w-sm"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* `key` forces a remount on every slide change, which is what
         restarts the CSS enter animation below — simplest possible
         crossfade with zero JS animation library and zero new
         dependency. Suppressed entirely under reduced motion, both here
         (no class applied) and structurally (activeIndex never changes,
         so this element never remounts in the first place). */}
      <div
        key={activeIndex}
        className={cn(
          "rounded-xl border border-border bg-card p-6",
          !reducedMotion && "animate-in fade-in duration-700",
        )}
      >
        <div className="grid h-11 w-11 place-items-center rounded-lg bg-primary/15 text-[color:var(--color-primary)]">
          <slide.icon className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-lg font-semibold">{slide.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{slide.body}</p>
      </div>

      {!reducedMotion && (
        <div className="mt-4 flex gap-1.5">
          {SLIDES.map((s, i) => (
            <button
              key={s.title}
              type="button"
              aria-label={`Show slide ${i + 1}: ${s.title}`}
              aria-current={i === activeIndex}
              onClick={() => setIndex(i)}
              className={cn("h-1.5 rounded-full transition-all", i === activeIndex ? "w-6 bg-primary" : "w-1.5 bg-border hover:bg-muted-foreground/40")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
