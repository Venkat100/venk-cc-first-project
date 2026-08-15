// Auth page showcase (2026-08-15 follow-up) — abstract, geometric per-slide
// diagrams, inline SVG, no image assets. Deliberately schematic rather than
// illustrative: this is a finance product whose credibility is protected on
// purpose, so the graphic language stays "technical trading terminal," not
// decoration. Each graphic marks exactly one or two "emphasis" strokes with
// `data-draw` + `pathLength={1}` — picked up by the `.svg-draw-in` CSS in
// styles.css to draw themselves in briefly on slide entry. Most strokes are
// NOT marked, on purpose: six slides' worth of every-line-animating would
// read as busy, not "quick and understated."

type GraphicProps = { className?: string };

const svgProps = {
  viewBox: "0 0 176 96",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function AgentGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      <line data-draw pathLength={1} x1="88" y1="48" x2="34" y2="20" opacity="0.5" />
      <line data-draw pathLength={1} x1="88" y1="48" x2="142" y2="20" opacity="0.5" />
      <line data-draw pathLength={1} x1="88" y1="48" x2="34" y2="76" opacity="0.5" />
      <line data-draw pathLength={1} x1="88" y1="48" x2="142" y2="76" opacity="0.5" />
      <circle cx="88" cy="48" r="7" fill="currentColor" stroke="none" />
      <circle cx="34" cy="20" r="4" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="142" cy="20" r="4" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="34" cy="76" r="4" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="142" cy="76" r="4" fill="currentColor" stroke="none" opacity="0.7" />
    </svg>
  );
}

export function ScenarioGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      <line x1="10" y1="66" x2="166" y2="66" opacity="0.3" />
      <line x1="34" y1="60" x2="34" y2="72" opacity="0.5" />
      <line x1="66" y1="60" x2="66" y2="72" opacity="0.5" />
      <path data-draw pathLength={1} d="M92 66 L104 26 L116 66" />
      <circle cx="104" cy="26" r="3.5" fill="currentColor" stroke="none" />
      <line x1="142" y1="60" x2="142" y2="72" opacity="0.5" />
    </svg>
  );
}

export function SimulatorGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      <path d="M10 74 L70 52" opacity="0.5" />
      <path data-draw pathLength={1} d="M70 52 L166 18" />
      <path d="M70 52 L166 64" opacity="0.3" strokeDasharray="3 4" />
      <circle cx="70" cy="52" r="3.5" fill="currentColor" stroke="none" />
      <circle cx="166" cy="18" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const CANDLES = [
  { x: 24, wickTop: 30, wickBottom: 70, bodyTop: 42, bodyBottom: 62 },
  { x: 56, wickTop: 20, wickBottom: 58, bodyTop: 26, bodyBottom: 48 },
  { x: 88, wickTop: 38, wickBottom: 76, bodyTop: 50, bodyBottom: 68 },
  { x: 120, wickTop: 16, wickBottom: 52, bodyTop: 20, bodyBottom: 40 },
  { x: 152, wickTop: 24, wickBottom: 60, bodyTop: 32, bodyBottom: 50 },
] as const;

export function InsightsGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      {CANDLES.map((c) => (
        <g key={c.x} opacity="0.4">
          <line x1={c.x} y1={c.wickTop} x2={c.x} y2={c.wickBottom} />
          <rect x={c.x - 5} y={c.bodyTop} width="10" height={c.bodyBottom - c.bodyTop} fill="currentColor" stroke="none" opacity="0.55" />
        </g>
      ))}
      <path data-draw pathLength={1} d="M16 62 Q 56 34 88 46 T 160 24" strokeWidth={2.5} />
    </svg>
  );
}

const RUNGS = [
  { y: 16, x2: 100, opacity: 0.3, emphasis: false },
  { y: 34, x2: 130, opacity: 0.45, emphasis: false },
  { y: 52, x2: 166, opacity: 1, emphasis: true },
  { y: 70, x2: 130, opacity: 0.45, emphasis: false },
  { y: 88, x2: 100, opacity: 0.3, emphasis: false },
] as const;

export function OptionsGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      <line x1="10" y1="8" x2="10" y2="90" opacity="0.3" />
      {RUNGS.map((r) => (
        <line
          key={r.y}
          data-draw={r.emphasis || undefined}
          pathLength={r.emphasis ? 1 : undefined}
          x1="10"
          y1={r.y}
          x2={r.x2}
          y2={r.y}
          opacity={r.opacity}
          strokeWidth={r.emphasis ? 2.5 : 2}
        />
      ))}
    </svg>
  );
}

const JOURNAL_ROWS = [
  { y: 24, filled: false, w: 78 },
  { y: 48, filled: false, w: 96 },
  { y: 72, filled: true, w: 64 },
] as const;

export function JournalGraphic({ className }: GraphicProps) {
  return (
    <svg aria-hidden className={className} {...svgProps}>
      {JOURNAL_ROWS.map((r) => (
        <g key={r.y}>
          <circle cx="18" cy={r.y} r="5" fill={r.filled ? "currentColor" : "none"} opacity={r.filled ? 1 : 0.5} />
          {r.filled && <path d={`M15 ${r.y} l2 2.5 l4.5 -5`} stroke="var(--color-background)" strokeWidth={1.5} />}
          <line
            data-draw={r.filled || undefined}
            pathLength={r.filled ? 1 : undefined}
            x1="34"
            y1={r.y}
            x2={34 + r.w}
            y2={r.y}
            opacity={r.filled ? 0.9 : 0.35}
          />
        </g>
      ))}
    </svg>
  );
}

// Full-panel ambient texture — a faint technical grid + one large, soft
// chart-path arc, sitting behind the slide content. No viewBox: the SVG's
// own rendered pixel box IS its coordinate space, so the grid tiles at a
// literal 44px regardless of the panel's aspect ratio (no distortion), and
// `overflow-hidden` on the panel (auth.tsx) clips the arc path's generous
// coordinate range at both the short-laptop and tall-monitor extremes this
// was verified at. Kept as its own component (not merged into the grid
// pattern) since the two layers were tuned to different opacities.
export function ShowcaseBackdrop({ gridId }: { gridId: string }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full text-foreground">
      <defs>
        <pattern id={gridId} width="44" height="44" patternUnits="userSpaceOnUse">
          <path d="M44 0 L0 0 0 44" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${gridId})`} opacity="0.05" />
      <path
        d="M-40 520 C 120 380, 260 560, 420 400 S 680 180, 1000 320"
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="2.5"
        opacity="0.08"
      />
    </svg>
  );
}
