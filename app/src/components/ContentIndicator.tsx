import { Newspaper, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// AUDIT.md Part 6(b) item 7 — a small, honest signal on Markets/Watchlist
// rows for symbols we KNOW already have fresh news or today's AI insight
// cached (see useContentAvailability.ts). Renders nothing at all when
// neither is available — never a placeholder/empty-state icon, since
// "we haven't checked" and "there's nothing" must never look the same as
// "there's genuinely something here."
export function ContentIndicator({ hasNews, hasInsight, className }: { hasNews: boolean; hasInsight: boolean; className?: string }) {
  if (!hasNews && !hasInsight) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {hasNews && (
        <span title="Fresh news available" className="grid h-4 w-4 place-items-center rounded-full bg-surface-2 text-muted-foreground">
          <Newspaper className="h-2.5 w-2.5" />
        </span>
      )}
      {hasInsight && (
        <span title="AI insight available today" className="grid h-4 w-4 place-items-center rounded-full bg-primary/15 text-[color:var(--color-primary)]">
          <Sparkles className="h-2.5 w-2.5" />
        </span>
      )}
    </span>
  );
}
