import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LivePriceChart } from "@/components/LivePriceChart";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { StockInsightBody, AiDisclaimer } from "@/components/InsightUI";
import { getQuote, getCompanyNews, type NewsItem, type Quote } from "@/lib/marketData";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { getStockInsight } from "@/lib/insights/api";
import { getHoldings, getTransactions } from "@/lib/portfolio/queries";
import { getOptionPositions } from "@/lib/options/queries";
import { getMarginState } from "@/lib/margin/api";
import { executeTrade } from "@/lib/trading/execute";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct, fmtCompact, fmtQty, fmtRelativeTime } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { OptionChainView } from "@/components/options/OptionChainView";
import { OptionOrderPanel, type OrderPanelState } from "@/components/options/OptionOrderPanel";
import { OptionPositionsList } from "@/components/options/OptionPositionsList";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Sparkles, Newspaper, ExternalLink, Globe } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/stock/$symbol")({
  loader: ({ params }) => ({ symbol: params.symbol.toUpperCase() }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.symbol ?? "Stock"} · PaperTrader` }],
  }),
  component: StockDetail,
});

function StockDetail() {
  const { symbol } = Route.useLoaderData();
  const quoteQ = useQuery({ queryKey: ["quote", symbol], queryFn: () => getQuote(symbol), staleTime: 15_000, refetchInterval: 30_000, retry: 1 });
  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const txQ = useQuery({ queryKey: ["transactions"], queryFn: getTransactions });
  const { profile } = useAuth();
  // Margin-aware buying power — see app.dashboard.tsx for the same gated
  // pattern: only fetches getMarginState() when the user has margin on.
  const marginStateQ = useQuery({
    queryKey: ["marginState"],
    queryFn: getMarginState,
    enabled: !!profile?.margin_enabled,
    staleTime: 10_000,
  });
  const buyingPower = profile?.margin_enabled && marginStateQ.data ? marginStateQ.data.buyingPower : (profile?.cash_balance ?? 0);

  const quote = quoteQ.data;
  const position = (holdingsQ.data ?? []).find((h) => h.symbol === symbol);
  const recent = useMemo(() => (txQ.data ?? []).filter((t) => t.symbol === symbol).slice(0, 8), [txQ.data, symbol]);

  // Options (O3) — one shared query key so Dashboard/Portfolio/Stock Detail
  // can never disagree about current value/P&L (see lib/options/queries.ts).
  const optionPositionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });
  const symbolOptionPositions = useMemo(() => (optionPositionsQ.data ?? []).filter((p) => p.symbol === symbol), [optionPositionsQ.data, symbol]);
  const [orderPanel, setOrderPanel] = useState<OrderPanelState>({ open: false });

  // Total portfolio value — same EQUITY formula as the Dashboard (cash + Σ
  // qty×price + options value − margin loan; hardening-pass fix: this used
  // to be cash + stock holdings only, silently excluding options value and
  // never netting a margin loan, which understated "% of portfolio" for
  // anyone using either feature). Reuses the quote already loaded for THIS
  // symbol; only fetches the OTHER held symbols.
  const otherSymbols = useMemo(() => (holdingsQ.data ?? []).map((h) => h.symbol).filter((s) => s !== symbol), [holdingsQ.data, symbol]);
  const otherQuotesQ = useQuotes(otherSymbols);
  const portfolioPricesReady = otherSymbols.length === 0 || otherQuotesQ.isSuccess;
  const holdingsValue = (holdingsQ.data ?? []).reduce((sum, h) => sum + (h.symbol === symbol ? (quote?.price ?? 0) : quoteOf(otherQuotesQ.data, h.symbol).price) * h.quantity, 0);
  const allOptionsValue = (optionPositionsQ.data ?? []).reduce((sum, p) => sum + p.marketValue, 0);
  const totalPortfolio = (profile?.cash_balance ?? 0) + holdingsValue + allOptionsValue - (profile?.margin_loan ?? 0);

  // Invalid ticker or provider failure → friendly card, never a crash.
  if (quoteQ.isError) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <h2 className="text-lg font-semibold">Couldn't load {symbol}</h2>
        <p className="mt-1 text-sm text-muted-foreground">That ticker may be invalid, or the market data provider is temporarily unavailable.</p>
        <Link to="/app/markets"><Button className="mt-4">Back to markets</Button></Link>
      </div>
    );
  }

  const up = (quote?.dayChangePct ?? 0) >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          {quote?.logo ? (
            <img src={quote.logo} alt={symbol} className="h-14 w-14 shrink-0 rounded-2xl bg-white object-contain p-1.5" />
          ) : (
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface-2 text-sm font-bold">{symbol.slice(0, 2)}</div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{symbol}</h1>
              {quote?.sector && quote.sector !== "—" && (
                <span className="rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{quote.sector}</span>
              )}
            </div>
            <p className="truncate text-sm text-muted-foreground">{quote?.name ?? "Loading…"}</p>
          </div>
        </div>
        <div className="text-right">
          {quote ? (
            <>
              <p className="text-3xl font-semibold tabular">{fmtUSD(quote.price)}</p>
              <p className={cn("text-sm tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                {up ? "+" : "−"}{fmtUSD(Math.abs(quote.dayChange))} ({fmtPct(quote.dayChangePct)}) today
              </p>
            </>
          ) : (
            <div className="h-10 w-32 animate-pulse rounded bg-surface-2" />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="p-3 sm:p-5">
              <LivePriceChart symbol={symbol} height={340} defaultRange="3M" quote={quote} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Key stats</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {quote ? (
                <>
                  <Stat label="Open" value={quote.open != null ? fmtUSD(quote.open) : "—"} />
                  <Stat label="Day high" value={quote.high != null ? fmtUSD(quote.high) : "—"} />
                  <Stat label="Day low" value={quote.low != null ? fmtUSD(quote.low) : "—"} />
                  <Stat label="Prev close" value={quote.previousClose != null ? fmtUSD(quote.previousClose) : "—"} />
                  <Stat label="Market cap" value={quote.marketCap != null ? `$${fmtCompact(quote.marketCap)}` : "—"} />
                  <Stat label="52-wk range" value={quote.week52Low != null && quote.week52High != null ? `${fmtUSD(quote.week52Low)} – ${fmtUSD(quote.week52High)}` : "—"} />
                </>
              ) : (
                <div className="col-span-full"><LoadingState label="Loading stats…" /></div>
              )}
            </CardContent>
          </Card>

          <InsightCard symbol={symbol} />

          <Card>
            <CardContent className="p-3 sm:p-5">
              <Tabs defaultValue="position">
                <div className="overflow-x-auto">
                  <TabsList className="w-max">
                    <TabsTrigger value="position">Your position</TabsTrigger>
                    <TabsTrigger value="options">Options</TabsTrigger>
                    <TabsTrigger value="news">News</TabsTrigger>
                    <TabsTrigger value="about">About</TabsTrigger>
                    <TabsTrigger value="trades">Recent trades</TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="position" className="mt-4">
                  {position && quote ? (
                    (() => {
                      const marketValue = quote.price * position.quantity;
                      const returnAbs = (quote.price - position.avg_cost) * position.quantity;
                      const returnPct = position.avg_cost > 0 ? ((quote.price - position.avg_cost) / position.avg_cost) * 100 : 0;
                      const todayAbs = quote.dayChange * position.quantity;
                      const pctOfPortfolio = portfolioPricesReady && totalPortfolio > 0 ? (marketValue / totalPortfolio) * 100 : null;
                      return (
                        <div className="space-y-4">
                          <div className="grid gap-4 sm:grid-cols-4">
                            <Stat label="Shares" value={fmtQty(position.quantity)} />
                            <Stat label="Avg cost" value={fmtUSD(position.avg_cost)} />
                            <Stat label="Market value" value={fmtUSD(marketValue)} />
                            <Stat label="Today's change" value={`${todayAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(todayAbs))}`} tone={todayAbs >= 0 ? "gain" : "loss"} />
                          </div>
                          <div className="grid gap-4 sm:grid-cols-3">
                            <Stat label="Total return" value={`${returnAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(returnAbs))}`} tone={returnAbs >= 0 ? "gain" : "loss"} />
                            <Stat label="Total return %" value={fmtPct(returnPct)} tone={returnPct >= 0 ? "gain" : "loss"} />
                            <Stat label="% of portfolio" value={pctOfPortfolio != null ? `${pctOfPortfolio.toFixed(1)}%` : "—"} />
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div className="rounded-lg border border-dashed border-border py-8 text-center">
                      <p className="text-sm text-muted-foreground">You don't own any {symbol} yet.</p>
                      <p className="mt-1 text-xs text-muted-foreground">Place a paper order from the panel on the right to start a position.</p>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="options" className="mt-4 space-y-6">
                  <OptionChainView symbol={symbol} onSelectContract={(contract, side) => setOrderPanel({ open: true, mode: "buy", contract, side })} />
                  {symbolOptionPositions.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs uppercase tracking-wider text-muted-foreground">Your option positions in {symbol}</p>
                      <OptionPositionsList positions={symbolOptionPositions} onSell={(p) => setOrderPanel({ open: true, mode: "sell", position: p })} />
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="news" className="mt-4">
                  <NewsTab symbol={symbol} />
                </TabsContent>
                <TabsContent value="about" className="mt-4">
                  <AboutTab symbol={symbol} quote={quote} />
                </TabsContent>
                <TabsContent value="trades" className="mt-4">
                  {recent.length ? (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b border-border text-left text-xs uppercase text-muted-foreground"><th className="py-2 font-medium">Date</th><th className="py-2 font-medium">Type</th><th className="py-2 font-medium text-right">Qty</th><th className="py-2 font-medium text-right">Price</th></tr></thead>
                      <tbody>
                        {recent.map((t) => (
                          <tr key={t.id} className="border-b border-border/60 last:border-0">
                            <td className="py-2 text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</td>
                            <td className="py-2 uppercase">{t.side}</td>
                            <td className="py-2 text-right tabular">{fmtQty(t.quantity)}</td>
                            <td className="py-2 text-right tabular">{fmtUSD(t.price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-muted-foreground">No trades for {symbol} yet.</p>}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <OrderPanel price={quote?.price ?? 0} symbol={symbol} buyingPower={buyingPower} positionQty={position?.quantity ?? 0} ready={!!quote} />
      </div>

      <OptionOrderPanel state={orderPanel} onClose={() => setOrderPanel({ open: false })} />
    </div>
  );
}

function InsightCard({ symbol }: { symbol: string }) {
  const [requested, setRequested] = useState(false);
  const insightQ = useQuery({
    queryKey: ["insight", symbol],
    queryFn: () => getStockInsight(symbol),
    enabled: requested,
    staleTime: 6 * 60 * 60_000, // server caches per day; keep the client copy too
    retry: 0,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-[color:var(--color-primary)]" /> AI Insight</CardTitle>
      </CardHeader>
      <CardContent>
        {!requested ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">News-driven, history-aware analysis of {symbol} — generated on demand and refreshed daily.</p>
            <Button className="gap-2" onClick={() => setRequested(true)}><Sparkles className="h-4 w-4" /> Get AI insight</Button>
            <AiDisclaimer />
          </div>
        ) : insightQ.isLoading ? (
          <LoadingState label="Reading the latest news…" />
        ) : insightQ.isError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Couldn't generate an insight right now — the AI or news service may be busy. Please try again shortly.</p>
            <Button variant="outline" size="sm" onClick={() => insightQ.refetch()}>Try again</Button>
            <AiDisclaimer />
          </div>
        ) : insightQ.data ? (
          <StockInsightBody insight={insightQ.data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-sm font-medium tabular", tone === "gain" && "text-[color:var(--color-gain)]", tone === "loss" && "text-[color:var(--color-loss)]")}>{value}</p>
    </div>
  );
}

function NewsTab({ symbol }: { symbol: string }) {
  const newsQ = useQuery({ queryKey: ["news", symbol], queryFn: () => getCompanyNews(symbol), staleTime: 10 * 60_000, retry: 1 });

  // isPending (not isLoading): isLoading is isPending && isFetching, which
  // goes false during the gap between retry attempts even though we still
  // have neither data nor a settled error — that gap would otherwise flash
  // the empty state instead of the spinner.
  if (newsQ.isPending) return <LoadingState label="Loading news…" />;
  if (newsQ.isError) {
    return (
      <div className="space-y-3">
        <ErrorState message={(newsQ.error as Error)?.message ?? "Couldn't load news right now."} />
        <div className="text-center"><Button variant="outline" size="sm" onClick={() => newsQ.refetch()}>Try again</Button></div>
      </div>
    );
  }
  const items = newsQ.data ?? [];
  if (items.length === 0) {
    return <EmptyState icon={Newspaper} title="No recent news" description={`No recent news for ${symbol} in the last week.`} />;
  }
  return (
    <ul className="divide-y divide-border/60">
      {items.map((n, i) => <NewsRow key={i} item={n} />)}
    </ul>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  const meta = [item.source, fmtRelativeTime(item.datetime)].filter(Boolean).join(" · ");
  const body = (
    <>
      <p className={cn("text-sm font-medium leading-snug", item.url && "group-hover:underline")}>{item.headline}</p>
      {meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
    </>
  );
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      {item.url ? (
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="group flex items-start justify-between gap-2">
          {body}
          <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
      ) : (
        body
      )}
    </li>
  );
}

function AboutTab({ symbol, quote }: { symbol: string; quote?: Quote }) {
  if (!quote) return <LoadingState label="Loading company info…" />;
  // Finnhub's /stock/profile2 is empty for ETFs/funds — no sector, no market
  // cap, no country. Degrade to a clear fund label instead of blank gaps.
  const isLikelyFund = !quote.marketCap && (!quote.sector || quote.sector === "—");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {quote.logo ? (
          <img src={quote.logo} alt={symbol} className="h-11 w-11 shrink-0 rounded-xl bg-white object-contain p-1" />
        ) : (
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-xs font-bold">{symbol.slice(0, 2)}</div>
        )}
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{quote.name}</p>
          <p className="text-xs text-muted-foreground">{symbol}{quote.exchange ? ` · ${quote.exchange}` : ""}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sector / type" value={isLikelyFund ? "Exchange-traded fund" : (quote.sector ?? "—")} />
        <Stat label="Market cap" value={quote.marketCap != null ? `$${fmtCompact(quote.marketCap)}` : "—"} />
        <Stat label="Country" value={quote.country ?? "—"} />
        {quote.ipo && <Stat label="IPO date" value={quote.ipo} />}
      </div>

      {quote.weburl && (
        <a href={quote.weburl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-[color:var(--color-primary)] hover:underline">
          <Globe className="h-3.5 w-3.5" /> Visit website
        </a>
      )}

      <p className="text-[11px] text-muted-foreground">Live quote &amp; company profile from Finnhub; historical price chart from Twelve Data.</p>
    </div>
  );
}

// Sensible minimums; anything below is rejected with a friendly message
// rather than silently truncated or crashing on absurd precision.
const MIN_SHARES = 0.0001;
const MIN_DOLLARS = 1;

function validateSharesQty(raw: string): { ok: true; qty: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a quantity." };
  if (n <= 0) return { ok: false, error: "Enter a quantity greater than zero." };
  if (n < MIN_SHARES) return { ok: false, error: `Minimum order is ${MIN_SHARES} shares.` };
  const dp = (raw.split(".")[1] ?? "").length;
  if (dp > 6) return { ok: false, error: "Enter up to 6 decimal places." };
  return { ok: true, qty: n };
}

function validateDollarAmount(raw: string): { ok: true; amount: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a dollar amount." };
  if (n <= 0) return { ok: false, error: "Enter an amount greater than zero." };
  if (n < MIN_DOLLARS) return { ok: false, error: `Minimum order is ${fmtUSD(MIN_DOLLARS)}.` };
  const dp = (raw.split(".")[1] ?? "").length;
  if (dp > 2) return { ok: false, error: "Enter up to 2 decimal places." };
  return { ok: true, amount: n };
}

function OrderPanel({ price, symbol, buyingPower, positionQty, ready }: { price: number; symbol: string; buyingPower: number; positionQty: number; ready: boolean }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [mode, setMode] = useState<"shares" | "dollars">("shares");
  const [qtyInput, setQtyInput] = useState("1");
  const [amountInput, setAmountInput] = useState("50");
  const [limit, setLimit] = useState(price);
  const [sellAll, setSellAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const execPrice = type === "market" ? price : limit;
  const qtyNum = Number(qtyInput) || 0;
  const amountNum = Number(amountInput) || 0;
  const estQtyForDollars = execPrice > 0 ? amountNum / execPrice : 0;
  const isSellAll = side === "sell" && sellAll;
  const hasPosition = positionQty > 0;

  const est = isSellAll ? positionQty * execPrice : mode === "shares" ? qtyNum * execPrice : amountNum;

  const qc = useQueryClient();
  const { refreshProfile } = useAuth();

  const trade = useMutation({
    mutationFn: () => {
      if (isSellAll) return executeTrade({ symbol, side: "sell", sellAll: true });
      if (mode === "dollars") return executeTrade({ symbol, side, amount: amountNum });
      return executeTrade({ symbol, side, quantity: qtyNum });
    },
    onSuccess: async (r) => {
      // Refresh everything the trade affects so Dashboard/Portfolio/position update.
      await Promise.all([
        refreshProfile(),
        qc.invalidateQueries({ queryKey: ["holdings"] }),
        qc.invalidateQueries({ queryKey: ["transactions"] }),
        qc.invalidateQueries({ queryKey: ["marginState"] }),
      ]);
      const verb = r.side === "buy" ? "Bought" : "Sold";
      toast.success(
        mode === "dollars" || isSellAll
          ? `${verb} ≈${fmtQty(r.quantity, 4)} shares of ${r.symbol} for ${fmtUSD(r.total)}`
          : `${verb} ${fmtQty(r.quantity)} ${r.symbol} @ ${fmtUSD(r.price)}`,
        { description: `${r.side === "buy" ? "Cost" : "Proceeds"} ${fmtUSD(r.total)} · Buying power now ${fmtUSD(r.cashBalance)}` },
      );
      setSellAll(false);
      setConfirmOpen(false);
    },
    onError: (e: Error) => {
      toast.error(e.message || "That order couldn't be completed.");
      setConfirmOpen(false);
    },
  });

  // Validates the current form, then OPENS the confirm dialog — the actual
  // trade.mutate() only fires from the dialog's own Confirm button, so
  // Cancel/Escape/backdrop are guaranteed no-ops (nothing has been sent yet).
  function onOpenConfirm() {
    if (type === "limit") {
      // TODO(Phase 6+): real limit-order handling (rest the order until the
      // market crosses the limit). For now only market orders execute.
      toast.info("Limit orders are coming soon — switch to a Market order to trade now.");
      return;
    }
    if (isSellAll) {
      if (!hasPosition) {
        toast.error("You don't own any shares to sell.");
        return;
      }
      setConfirmOpen(true);
      return;
    }
    if (mode === "shares") {
      const v = validateSharesQty(qtyInput);
      if (!v.ok) {
        toast.error(v.error);
        return;
      }
    } else {
      const v = validateDollarAmount(amountInput);
      if (!v.ok) {
        toast.error(v.error);
        return;
      }
    }
    setConfirmOpen(true);
  }

  const pending = trade.isPending;
  const confirmLabel = isSellAll
    ? `Confirm sell · all ${symbol} (${fmtQty(positionQty)})`
    : mode === "dollars"
      ? `Confirm ${side} · ${fmtUSD(amountNum || 0)} of ${symbol}`
      : `Confirm ${side} · ${qtyInput || 0} ${symbol}`;

  const dialogTitle = isSellAll ? `Close ${symbol} position` : side === "buy" ? "Confirm buy" : "Confirm sell";
  const dialogConsequence = isSellAll
    ? `Close your entire ${symbol} position (${fmtQty(positionQty)} shares)? This sells everything for an estimated ${fmtUSD(est)}.`
    : side === "buy"
      ? mode === "dollars"
        ? `Buy ${fmtUSD(amountNum)} of ${symbol} (≈${fmtQty(estQtyForDollars, 4)} shares)? This uses ${fmtUSD(est)} of your ${fmtUSD(buyingPower)} buying power.`
        : `Buy ${fmtQty(qtyNum)} ${symbol} for about ${fmtUSD(est)}? This uses ${fmtUSD(est)} of your ${fmtUSD(buyingPower)} buying power.`
      : mode === "dollars"
        ? `Sell about ${fmtUSD(amountNum)} of ${symbol} (≈${fmtQty(estQtyForDollars, 4)} shares)?`
        : `Sell ${fmtQty(qtyNum)} ${symbol} for an estimated ${fmtUSD(est)}?`;

  return (
    <Card className="h-fit">
      <CardHeader className="pb-2"><CardTitle className="text-base">Place paper order</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-surface p-1">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)} className={cn("rounded px-3 py-2.5 text-sm font-medium capitalize sm:py-1.5", side === s ? (s === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)]" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)]") : "text-muted-foreground")}>{s}</button>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label>Order type</Label>
          <Select value={type} onValueChange={(v: "market" | "limit") => setType(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="market">Market</SelectItem>
              <SelectItem value="limit">Limit (soon)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {side === "sell" && hasPosition && (
          <button
            type="button"
            onClick={() => setSellAll((v) => !v)}
            className={cn(
              "w-full rounded-md border px-3 py-3 text-left text-sm transition-colors sm:py-2",
              isSellAll ? "border-[color:var(--color-loss)] bg-[color:var(--color-loss)]/10 text-[color:var(--color-loss)]" : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {isSellAll ? "✓ " : ""}Sell all — closes your entire position ({fmtQty(positionQty)} shares ≈ {fmtUSD(positionQty * execPrice)})
          </button>
        )}

        {!isSellAll && (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-surface p-1">
              {(["shares", "dollars"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={cn("rounded px-3 py-2.5 text-sm font-medium capitalize sm:py-1.5", mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>{m}</button>
              ))}
            </div>

            {mode === "shares" ? (
              <div className="space-y-1.5">
                <Label htmlFor="qty">Quantity</Label>
                <Input id="qty" type="number" min={MIN_SHARES} step="any" value={qtyInput} onChange={(e) => setQtyInput(e.target.value)} className="tabular" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="amount">Amount</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input id="amount" type="number" min={MIN_DOLLARS} step="0.01" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} className="tabular pl-6" />
                </div>
                <p className="text-xs text-muted-foreground">
                  ≈ {fmtQty(estQtyForDollars, 4)} shares @ {fmtUSD(execPrice)}
                </p>
              </div>
            )}
          </>
        )}

        {type === "limit" && (
          <div className="space-y-1.5">
            <Label htmlFor="limit">Limit price</Label>
            <Input id="limit" type="number" step="0.01" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="tabular" />
            <p className="text-[11px] text-muted-foreground">Limit orders aren't executed yet — use Market to trade now.</p>
          </div>
        )}

        <div className="rounded-md border border-border bg-surface p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Estimated {side === "buy" ? "cost" : "credit"}</span><span className="tabular font-medium">{fmtUSD(est)}</span></div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>Buying power</span><span className="tabular">{fmtUSD(buyingPower)}</span></div>
        </div>

        <Button
          disabled={!ready || pending}
          className={cn("h-12 w-full text-base", side === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)] hover:opacity-90" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)] hover:opacity-90")}
          onClick={onOpenConfirm}
        >
          {pending ? "Placing…" : confirmLabel}
        </Button>
        <p className="text-[11px] text-muted-foreground">All orders are simulated paper trades. No real money is used.</p>
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={dialogTitle}
        consequence={dialogConsequence}
        detail={
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{isSellAll ? "Shares × price" : mode === "dollars" ? "Amount" : "Shares × price"}</span>
              <span className="tabular font-medium">
                {isSellAll
                  ? `${fmtQty(positionQty)} × ${fmtUSD(execPrice)} = ${fmtUSD(est)}`
                  : mode === "dollars"
                    ? fmtUSD(amountNum)
                    : `${fmtQty(qtyNum)} × ${fmtUSD(execPrice)} = ${fmtUSD(est)}`}
              </span>
            </div>
            {side === "buy" && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Buying power after</span>
                <span className="tabular">{fmtUSD(buyingPower - est)}</span>
              </div>
            )}
          </div>
        }
        confirmLabel={confirmLabel}
        variant={isSellAll ? "destructive" : "default"}
        loading={pending}
        onConfirm={() => trade.mutate()}
      />
    </Card>
  );
}
