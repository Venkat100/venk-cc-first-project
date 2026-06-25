import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getWatchlist, addToWatchlist, removeFromWatchlist } from "@/lib/portfolio/queries";
import type { WatchlistItem } from "@/lib/supabase/types";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Star button that toggles a symbol in the watchlist — the SAME write path the
 * Watchlist tab uses (addToWatchlist/removeFromWatchlist + the ["watchlist"]
 * query), so membership stays consistent everywhere it's shown. Self-contained:
 * reads membership from the shared cache (react-query dedupes the fetch),
 * optimistically toggles, and stops click propagation so it won't trigger a
 * surrounding row/link.
 */
export function WatchlistStar({ symbol, className, size = 16 }: { symbol: string; className?: string; size?: number }) {
  const sym = symbol.toUpperCase();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["watchlist"], queryFn: getWatchlist });
  const tracked = (data ?? []).some((w) => w.symbol === sym);

  // `next` (the intended tracked state) is passed as the mutation variable so
  // every callback agrees — `tracked` from the closure flips mid-mutation due to
  // the optimistic update, which would otherwise invert the toast text.
  const mut = useMutation({
    mutationFn: (next: boolean) => (next ? addToWatchlist(sym) : removeFromWatchlist(sym)),
    onMutate: async (next: boolean) => {
      await qc.cancelQueries({ queryKey: ["watchlist"] });
      const prev = qc.getQueryData<WatchlistItem[]>(["watchlist"]);
      qc.setQueryData<WatchlistItem[]>(["watchlist"], (old) => {
        const cur = old ?? [];
        return next
          ? [{ id: `optimistic-${sym}`, user_id: "", symbol: sym, created_at: new Date().toISOString() }, ...cur]
          : cur.filter((w) => w.symbol !== sym);
      });
      return { prev };
    },
    onError: (e: Error, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData(["watchlist"], ctx.prev);
      toast.error(e.message || "Couldn't update your watchlist.");
    },
    onSuccess: (_d, next) => toast(next ? `Added ${sym} to watchlist` : `Removed ${sym}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  return (
    <button
      type="button"
      aria-label={tracked ? `Remove ${sym} from watchlist` : `Add ${sym} to watchlist`}
      aria-pressed={tracked}
      disabled={mut.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        mut.mutate(!tracked);
      }}
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent disabled:opacity-50", className)}
    >
      <Star
        style={{ width: size, height: size }}
        className={cn(tracked ? "fill-[color:var(--color-primary)] text-[color:var(--color-primary)]" : "text-muted-foreground")}
      />
    </button>
  );
}
