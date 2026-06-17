import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sparkline } from "@/components/PriceChart";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { MARKET_UNIVERSE } from "@/lib/marketData";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { getStock, fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

export const Route = createFileRoute("/app/markets")({
  head: () => ({ meta: [{ title: "Markets · PaperTrader" }] }),
  component: Markets,
});

function Markets() {
  const universe = MARKET_UNIVERSE as readonly string[];
  const quotesQ = useQuotes([...universe]);
  const quotes = quotesQ.data;

  const sectors = useMemo(
    () => ["All", ...Array.from(new Set(universe.map((s) => getStock(s)?.sector ?? "—")))],
    [universe],
  );
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("All");
  const [tab, setTab] = useState<"all" | "trending">("all");

  const rows = useMemo(() => {
    let xs = universe.map((sym) => quoteOf(quotes, sym));
    if (sector !== "All") xs = xs.filter((r) => r.sector === sector);
    if (q.trim()) {
      const t = q.toLowerCase();
      xs = xs.filter((r) => r.symbol.toLowerCase().includes(t) || r.name.toLowerCase().includes(t));
    }
    if (tab === "trending") xs = [...xs].sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct));
    return xs;
  }, [universe, quotes, q, sector, tab]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-muted-foreground">Browse, filter and discover stocks to paper-trade. Prices are live.</p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-1">
          {(["all", "trending"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("rounded px-3 py-1 text-xs font-medium capitalize", tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{t}</button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by symbol or name" className="h-7 border-0 bg-transparent p-0 focus-visible:ring-0" />
            </div>
            <div className="flex flex-wrap gap-1">
              {sectors.map((s) => (
                <button
                  key={s}
                  onClick={() => setSector(s)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs",
                    sector === s ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {quotesQ.isLoading ? (
            <LoadingState label="Loading live market prices…" />
          ) : quotesQ.isError ? (
            <ErrorState message="Couldn't load live prices. The market data provider may be rate-limited — try again shortly." />
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="py-3 font-medium">Sector</th>
                  <th className="py-3 font-medium text-right">Price</th>
                  <th className="py-3 font-medium text-right">Change</th>
                  <th className="py-3 font-medium">Trend</th>
                  <th className="px-4 py-3 font-medium text-right">Trade</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const up = r.dayChangePct >= 0;
                  return (
                    <tr key={r.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <Link to="/app/stock/$symbol" params={{ symbol: r.symbol }} className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{r.symbol.slice(0, 2)}</div>
                          <div>
                            <div className="font-semibold">{r.symbol}</div>
                            <div className="text-xs text-muted-foreground">{r.name}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 text-xs text-muted-foreground">{r.sector}</td>
                      <td className="py-3 text-right tabular">{fmtUSD(r.price)}</td>
                      <td className={cn("py-3 text-right tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                        {up ? "+" : "−"}{fmtUSD(Math.abs(r.dayChange))} <span className="text-xs opacity-80">({fmtPct(r.dayChangePct)})</span>
                      </td>
                      {/* TODO(Phase 5+): real sparklines need a batch-friendly intraday
                          source; mock trend shown until then. */}
                      <td className="py-3"><Sparkline data={sparkline(r.symbol)} up={up} width={96} height={28} /></td>
                      <td className="px-4 py-3 text-right">
                        <Link to="/app/stock/$symbol" params={{ symbol: r.symbol }}>
                          <Button size="sm" variant="outline">Trade</Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">No stocks match your filters.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
