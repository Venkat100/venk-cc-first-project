// My PaperTrader — brand mark, wired to brand/README.md's rules.
//
// BrandIcon renders public/icon.svg (the outlined "Fold Line" mark) — the
// SVG already carries its own dark rounded-square background and green
// stroke, so callers no longer need the old bg-primary wrapper div. Safe
// on any background at 24px+ per the README; NOT for the favicon or small/
// uncontrolled placements (use /favicon.svg — icon-solid.svg — there).
//
// BrandWordmark renders "My PaperTrader" as LIVE TEXT (never an embedded
// SVG lockup inside the app), Treatment A from brand/README.md: "My"
// muted, "Paper" in the foreground colour, "Trader" in brand green. Stays
// crisp at any size, inherits the app font, stays accessible.
import { cn } from "@/lib/utils";

export function BrandIcon({ size = 36, className }: { size?: number; className?: string }) {
  return <img src="/icon.svg" alt="" width={size} height={size} className={cn("shrink-0", className)} style={{ width: size, height: size }} />;
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-[650] tracking-[-0.02em]", className)}>
      <span className="font-medium text-muted-foreground">My </span>
      <span className="text-foreground">Paper</span>
      <span className="text-[#22C55E]">Trader</span>
    </span>
  );
}
