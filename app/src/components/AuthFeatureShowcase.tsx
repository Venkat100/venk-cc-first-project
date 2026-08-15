import { useEffect, useId, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import {
  AgentGraphic,
  InsightsGraphic,
  JournalGraphic,
  OptionsGraphic,
  ScenarioGraphic,
  ShowcaseBackdrop,
  SimulatorGraphic,
} from "@/components/ShowcaseGraphics";

// Auth page left panel (2026-08-15, graphic pass) — the centered/enlarged
// layout from the prior follow-up still read as "empty, with something in
// the middle": an icon + heading + two lines floating alone in a big dark
// panel. This pass gives it a real graphic language instead — an ambient
// backdrop (grid + a soft chart-path arc) for depth, and one abstract
// diagram per slide instead of a lucide icon — while keeping the explicit
// "precise and technical, not sci-fi" brief: no particle fields, no glow
// piles, nothing louder than a trading terminal would show.
//
// Copy is reused VERBATIM from the landing page's own feature grid
// (routes/index.tsx) rather than invented — this can never promise
// anything the landing page itself doesn't already claim, and stays in
// sync by construction if that copy is ever revised (same wording, two
// places, both worth double-checking together if one changes).
const SLIDES = [
  { Graphic: AgentGraphic, title: "AI portfolio agent", body: "An AI that runs its own sub-portfolio of your virtual cash — quant screening plus real news reasoning, autonomous or approve-first." },
  { Graphic: ScenarioGraphic, title: "Scenario challenges", body: "Trade the 2008 crash, the 2020 COVID crash, or the 2022 bear market day-by-day, with real historical prices and no look-ahead." },
  { Graphic: SimulatorGraphic, title: "What-if simulator", body: "Backtest any amount, any date, any stock — compare vs. the S&P 500." },
  { Graphic: InsightsGraphic, title: "AI stock insights", body: "A daily lean, drivers, and risks per stock — grounded in the stock's own measured price history, not just a vibe." },
  { Graphic: OptionsGraphic, title: "Options trading", body: "A real chain, priced live with Black-Scholes — buy and sell calls and puts on any stock or ETF." },
  { Graphic: JournalGraphic, title: "Journal & coaching", body: "Write down your reasoning at the moment you trade — Coach names your own patterns from what you actually did, never from whether you're up or down." },
] as const;

// 4s — fast enough to feel alive, still comfortably readable (a heading
// plus two lines of body text) with margin before the crossfade eats into
// reading time. Do not go below 4s; reading speed is the constraint here,
// not preference.
const SLIDE_MS = 4000;

export function AuthFeatureShowcase() {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const gridId = useId();

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
  const Graphic = slide.Graphic;

  return (
    // Centered in the FULL left panel (the logo is absolutely positioned in
    // auth.tsx, out of flow, so this flex-1 centers against the whole panel
    // height), `relative` so the backdrop's `absolute inset-0` is scoped to
    // this box rather than the whole document.
    <div className="relative flex flex-1 items-center justify-center">
      <ShowcaseBackdrop gridId={gridId} />
      {/* A slight upward bias off dead-centre, not perfect centring: with a
         wide graphic now sitting above the heading, true dead-centre pushed
         the whole block — and the dots below it — noticeably close to the
         panel's vertical middle in a way that read as "centred" rather than
         "composed." A composed hero is usually anchored a touch above
         centre, with room left underneath for the dots to breathe. -6% is
         proportional to the block's own height, not a fixed px, so it stays
         sensible whether the panel is a short laptop or a tall monitor
         (verified at both below). */}
      <div
        className="relative z-10 max-w-[520px] -translate-y-[6%] text-center"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* `key` forces a remount on every slide change, restarting both CSS
           enter animations below — a rise-and-fade on the whole block (via
           tw-animate-css, already a dependency — no new package) and, on
           the graphic's own emphasis stroke(s), a brief "draws itself in"
           (`.svg-draw-in`, styles.css). Suppressed entirely under reduced
           motion, both here (no classes applied) and structurally
           (activeIndex never changes, so this element never remounts). */}
        <div
          key={activeIndex}
          className={cn(!reducedMotion && "animate-in fade-in slide-in-from-bottom-3 duration-500 ease-out")}
        >
          <Graphic className={cn("mx-auto h-24 w-44 text-[color:var(--color-primary)]", !reducedMotion && "svg-draw-in")} />
          <h3 className="mt-6 text-4xl font-semibold tracking-tight">{slide.title}</h3>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">{slide.body}</p>
        </div>

        {!reducedMotion && (
          <div className="mt-6 flex justify-center gap-1.5">
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
    </div>
  );
}
