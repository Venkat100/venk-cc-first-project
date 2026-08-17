import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NumberInput, parseNumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LivePriceChart } from "@/components/LivePriceChart";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { StockInsightBody, AiDisclaimer } from "@/components/InsightUI";
import { MarketStatusBadge } from "@/components/MarketStatusBadge";
import { getCompanyNews, getStockEnrichment, type NewsItem, type Quote, type StockEnrichment, type NextEarnings, type EarningsSurprise, type RecommendationTrendPoint } from "@/lib/marketData";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { isLikelyFund } from "@/lib/marketData/sector";
import { useTickFlash } from "@/lib/marketData/useTickFlash";
import { getStockInsight } from "@/lib/insights/api";
import { getHoldings, getTransactions } from "@/lib/portfolio/queries";
import { getOptionPositions, getOptionTransactions } from "@/lib/options/queries";
import { getMarginState } from "@/lib/margin/api";
import { computeBorrowSplit, borrowSplitSentence } from "@/lib/margin/borrowSplit";
import { executeTrade } from "@/lib/trading/execute";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct, fmtCompact, fmtQty, fmtRelativeTime } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { OptionChainView } from "@/components/options/OptionChainView";
import { OptionOrderPanel, type OrderPanelState } from "@/components/options/OptionOrderPanel";
import { OptionPositionsList } from "@/components/options/OptionPositionsList";
import { UnlockGate } from "@/components/coaching/UnlockGate";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { JournalEntryDialog, type TradeLinkContext } from "@/components/journal/JournalEntryDialog";
import { JournalEntryCard } from "@/components/journal/JournalEntryCard";
import { getJournalEntries, deleteJournalEntry } from "@/lib/journal/queries";
import { computeJournalOutcome } from "@/lib/journal/outcome";
import { stockTradeSummary, optionTradeSummary } from "@/lib/journal/format";
import type { JournalEntry } from "@/lib/supabase/types";
import { Sparkles, Newspaper, ExternalLink, Globe, BookOpen, Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/stock/$symbol")({
  loader: ({ params }) => ({ symbol: params.symbol.toUpperCase() }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.symbol ?? "Stock"} · My PaperTrader` }],
  }),
  component: StockDetail,
});

function StockDetail() {
  const { symbol } = Route.useLoaderData();
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
  const marginEnabled = !!profile?.margin_enabled;
  const buyingPower = marginEnabled && marginStateQ.data ? marginStateQ.data.buyingPower : (profile?.cash_balance ?? 0);
  // For the buy ConfirmDialog's borrow-vs-cash disclosure (hardening-pass
  // follow-up): the SAME getMarginState() call above already carries cash/
  // loan/rate, so this is free — no extra fetch, no re-derived margin math.
  const cashBalance = marginEnabled && marginStateQ.data ? marginStateQ.data.cashBalance : (profile?.cash_balance ?? 0);
  const marginLoan = marginEnabled && marginStateQ.data ? marginStateQ.data.marginLoan : 0;
  const interestRate = marginEnabled ? marginStateQ.data?.interestRate : undefined;

  const position = (holdingsQ.data ?? []).find((h) => h.symbol === symbol);
  const recent = useMemo(() => (txQ.data ?? []).filter((t) => t.symbol === symbol).slice(0, 8), [txQ.data, symbol]);

  // Options (O3) — one shared query key so Dashboard/Portfolio/Stock Detail
  // can never disagree about current value/P&L (see lib/options/queries.ts).
  const optionPositionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });
  const optionTxQ = useQuery({ queryKey: ["optionTransactions"], queryFn: getOptionTransactions });
  const journalQ = useQuery({ queryKey: ["journalEntries"], queryFn: getJournalEntries });
  const symbolJournalEntries = useMemo(() => (journalQ.data ?? []).filter((e) => e.symbol === symbol), [journalQ.data, symbol]);
  const journalQc = useQueryClient();
  const [journalDialogOpen, setJournalDialogOpen] = useState(false);
  const [editingJournalEntry, setEditingJournalEntry] = useState<JournalEntry | undefined>(undefined);
  const [deletingJournalEntry, setDeletingJournalEntry] = useState<JournalEntry | undefined>(undefined);
  const [deletingJournalBusy, setDeletingJournalBusy] = useState(false);
  const symbolOptionPositions = useMemo(() => (optionPositionsQ.data ?? []).filter((p) => p.symbol === symbol), [optionPositionsQ.data, symbol]);
  const [orderPanel, setOrderPanel] = useState<OrderPanelState>({ open: false });

  // ONE combined useQuotes call for THIS symbol + every OTHER held symbol
  // (needed for the "% of portfolio" stat below) — deliberately NOT two
  // separate queries (a lone ["quote",symbol] here + a Dashboard-side
  // ["quotes",...] elsewhere), which is how a price shown in two places
  // could disagree: different query keys mean different cache entries,
  // fetched independently, possibly at different moments. One shared
  // ["quotes", sortedSymbols] key means the SAME symbol on Dashboard,
  // Portfolio, and here always reads the same react-query cache entry.
  const otherSymbols = useMemo(() => (holdingsQ.data ?? []).map((h) => h.symbol).filter((s) => s !== symbol), [holdingsQ.data, symbol]);
  const allSymbols = useMemo(() => [symbol, ...otherSymbols], [symbol, otherSymbols]);
  const quotesQ = useQuotes(allSymbols);
  const quote = quotesQ.data?.get(symbol);
  const priceFlash = useTickFlash(quote?.price);
  // Stock page enrichment, phase 2: earnings/analyst/peer data. Near-static
  // (server caches 24h — see finnhub.server.ts), so a long client staleTime
  // just avoids a redundant round trip on remounts within the same session;
  // the server-side cache is the real backstop against re-fetching Finnhub.
  const enrichmentQ = useQuery({
    queryKey: ["stockEnrichment", symbol],
    queryFn: () => getStockEnrichment(symbol),
    staleTime: 6 * 60 * 60_000,
    retry: 1,
  });
  const portfolioPricesReady = quotesQ.isSuccess;
  const holdingsValue = (holdingsQ.data ?? []).reduce((sum, h) => sum + quoteOf(quotesQ.data, h.symbol).price * h.quantity, 0);
  const allOptionsValue = (optionPositionsQ.data ?? []).reduce((sum, p) => sum + p.marketValue, 0);
  const totalPortfolio = (profile?.cash_balance ?? 0) + holdingsValue + allOptionsValue - (profile?.margin_loan ?? 0);

  // Invalid ticker or provider failure → friendly card, never a crash.
  if (quotesQ.isError) {
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
              <p className={cn("rounded px-1 text-3xl font-semibold tabular", priceFlash)}>{fmtUSD(quote.price)}</p>
              <p className={cn("text-sm tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                {up ? "+" : "−"}{fmtUSD(Math.abs(quote.dayChange))} ({fmtPct(quote.dayChangePct)}) today
              </p>
              <MarketStatusBadge className="mt-1 justify-end" />
            </>
          ) : (
            <div className="h-10 w-32 animate-pulse rounded bg-surface-2" />
          )}
        </div>
      </div>

      {/* Layout note (2026-08-15, "move News/About into the right column"):
         BOTH direct children below use `contents` at mobile widths, which
         removes the wrapper div from the box model and promotes its own
         children straight into THIS grid — so at <lg every card here
         (chart/order-panel/key-stats/earnings/insight/about/news/tabs) is a
         genuine sibling grid item, ordered purely by its own `order-N`
         class, and the grid's own `gap-6` spaces them uniformly. That's how
         the order panel can land between the chart and Key Stats on mobile
         while still living in a separate right-hand column at `lg:` and up,
         where each wrapper switches to `lg:flex lg:flex-col` (a real
         two-column layout again) and every child's `lg:order-none` hands
         control back to plain DOM order within its own column. No content
         is duplicated — each section renders in exactly one place, this
         class combination only changes ITS POSITION per breakpoint. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-1 lg:order-none">
            <Card>
              <CardContent className="p-3 sm:p-5">
                <LivePriceChart symbol={symbol} height={340} defaultRange="3M" quote={quote} />
              </CardContent>
            </Card>
          </div>

          <div className="order-3 lg:order-none">
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
                    <FundamentalsRow quote={quote} />
                  </>
                ) : (
                  <div className="col-span-full"><LoadingState label="Loading stats…" /></div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="order-4 lg:order-none">
            <EarningsAndAnalystsCard data={enrichmentQ.data} isLoading={enrichmentQ.isLoading} />
          </div>

          <div className="order-5 lg:order-none">
            <InsightCard symbol={symbol} />
          </div>

          <div className="order-8 lg:order-none">
            <Card>
            <CardContent className="p-3 sm:p-5">
              <Tabs defaultValue="position">
                <div className="overflow-x-auto">
                  <TabsList className="w-max">
                    <TabsTrigger value="position">Your position</TabsTrigger>
                    <TabsTrigger value="options">Options</TabsTrigger>
                    <TabsTrigger value="trades">Recent trades</TabsTrigger>
                    <TabsTrigger value="journal">Journal{symbolJournalEntries.length > 0 ? ` (${symbolJournalEntries.length})` : ""}</TabsTrigger>
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
                  <UnlockGate feature="options">
                    <div className="space-y-6">
                      <OptionChainView symbol={symbol} onSelectContract={(contract, side) => setOrderPanel({ open: true, mode: "buy", contract, side })} />
                      {symbolOptionPositions.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs uppercase tracking-wider text-muted-foreground">Your option positions in {symbol}</p>
                          <OptionPositionsList positions={symbolOptionPositions} onSell={(p) => setOrderPanel({ open: true, mode: "sell", position: p })} />
                        </div>
                      )}
                    </div>
                  </UnlockGate>
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
                <TabsContent value="journal" className="mt-4">
                  <div className="mb-3 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingJournalEntry(undefined);
                        setJournalDialogOpen(true);
                      }}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add note
                    </Button>
                  </div>
                  {symbolJournalEntries.length === 0 ? (
                    <EmptyState
                      icon={BookOpen}
                      title={`No journal entries for ${symbol}`}
                      description="Notes you write about this stock — standalone thoughts, or reasoning attached to a specific trade — will show up here, alongside what actually happened since."
                    />
                  ) : (
                    <div className="space-y-3">
                      {symbolJournalEntries.map((entry) => {
                        const tx = entry.transaction_id ? (txQ.data ?? []).find((t) => t.id === entry.transaction_id) : undefined;
                        const otx = entry.option_transaction_id ? (optionTxQ.data ?? []).find((t) => t.id === entry.option_transaction_id) : undefined;
                        const outcome = computeJournalOutcome(entry, {
                          transactions: txQ.data ?? [],
                          optionTransactions: optionTxQ.data ?? [],
                          heldSymbols: position ? new Set([symbol]) : new Set(),
                          openContractIds: new Set((optionPositionsQ.data ?? []).map((p) => p.contractId)),
                          optionPositions: optionPositionsQ.data ?? [],
                          stockQuotes: quotesQ.data,
                        });
                        const tradeSummary = tx ? stockTradeSummary(tx) : otx ? optionTradeSummary(otx) : undefined;
                        return (
                          <JournalEntryCard
                            key={entry.id}
                            entry={entry}
                            outcome={outcome}
                            tradeSummary={tradeSummary}
                            onEdit={() => {
                              setEditingJournalEntry(entry);
                              setJournalDialogOpen(true);
                            }}
                            onDelete={() => setDeletingJournalEntry(entry)}
                          />
                        );
                      })}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
            </Card>
          </div>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-2 lg:order-none">
            <OrderPanel
              price={quote?.price ?? 0}
              symbol={symbol}
              buyingPower={buyingPower}
              positionQty={position?.quantity ?? 0}
              ready={!!quote}
              cashBalance={cashBalance}
              marginLoan={marginLoan}
              marginEnabled={marginEnabled}
              interestRate={interestRate}
            />
          </div>

          <div className="order-6 lg:order-none">
            <AboutCard symbol={symbol} quote={quote} peers={enrichmentQ.data?.peers ?? []} />
          </div>

          <div className="order-7 lg:order-none">
            <NewsCard symbol={symbol} />
          </div>
        </div>
      </div>

      <OptionOrderPanel state={orderPanel} onClose={() => setOrderPanel({ open: false })} />

      <JournalEntryDialog
        open={journalDialogOpen}
        onOpenChange={setJournalDialogOpen}
        entry={editingJournalEntry}
        defaultSymbol={symbol}
        onSaved={() => void journalQc.invalidateQueries({ queryKey: ["journalEntries"] })}
      />

      <ConfirmDialog
        open={!!deletingJournalEntry}
        onOpenChange={(o) => !o && setDeletingJournalEntry(undefined)}
        title="Delete this entry?"
        consequence="This journal entry will be permanently deleted. This can't be undone."
        confirmLabel="Delete entry"
        variant="destructive"
        loading={deletingJournalBusy}
        onConfirm={async () => {
          if (!deletingJournalEntry) return;
          setDeletingJournalBusy(true);
          try {
            await deleteJournalEntry(deletingJournalEntry.id);
            await journalQc.invalidateQueries({ queryKey: ["journalEntries"] });
            setDeletingJournalEntry(undefined);
          } finally {
            setDeletingJournalBusy(false);
          }
        }}
      />
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

// Stock page enrichment, phase 2 (2026-08-14) — next earnings date, EPS
// surprise history, analyst recommendation trend. Genuinely empty for
// ETFs (Finnhub returns 200 with no data, not an error) — the whole card
// hides itself rather than showing a heading over nothing, same rule as
// Key Stats' FundamentalsRow below. Educational framing throughout: these
// are counts of estimates/opinions, never advice or a prediction.
function EarningsAndAnalystsCard({ data, isLoading }: { data?: StockEnrichment; isLoading: boolean }) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Earnings &amp; analysts</CardTitle></CardHeader>
        <CardContent><LoadingState label="Loading earnings & analyst data…" /></CardContent>
      </Card>
    );
  }
  const hasEarningsDate = !!data?.nextEarnings;
  const hasSurprises = (data?.earningsSurprises?.length ?? 0) > 0;
  const hasRecs = (data?.recommendationTrend?.length ?? 0) > 0;
  if (!hasEarningsDate && !hasSurprises && !hasRecs) return null;

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Earnings &amp; analysts</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        {hasEarningsDate && <NextEarningsRow earnings={data!.nextEarnings!} />}
        {hasSurprises && <EarningsSurpriseChart surprises={data!.earningsSurprises} />}
        {hasRecs && <AnalystRecommendationBar trend={data!.recommendationTrend} />}
        <p className="text-[11px] text-muted-foreground">
          Estimates and analyst counts are context for learning, not advice — a summary of publicly reported figures and current analyst opinions, never a prediction or a recommendation from us.
        </p>
      </CardContent>
    </Card>
  );
}

function NextEarningsRow({ earnings }: { earnings: NextEarnings }) {
  const dateLabel = new Date(`${earnings.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const hourLabel = earnings.hour === "bmo" ? "Before market open" : earnings.hour === "amc" ? "After market close" : earnings.hour === "dmh" ? "During market hours" : undefined;
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Next earnings</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-lg font-semibold">{dateLabel}</p>
        {hourLabel && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">{hourLabel}</span>}
      </div>
      {(earnings.epsEstimate != null || earnings.revenueEstimate != null) && (
        <p className="mt-1 text-sm text-muted-foreground">
          Consensus estimate:{" "}
          {earnings.epsEstimate != null && <>EPS {fmtUSD(earnings.epsEstimate)}</>}
          {earnings.epsEstimate != null && earnings.revenueEstimate != null && " · "}
          {earnings.revenueEstimate != null && <>Revenue ${fmtCompact(earnings.revenueEstimate)}</>}
        </p>
      )}
    </div>
  );
}

function EarningsSurpriseChart({ surprises }: { surprises: EarningsSurprise[] }) {
  // Oldest → newest, left to right — the natural reading order for a trend.
  const ordered = [...surprises].reverse();
  const maxAbs = Math.max(1, ...ordered.map((s) => Math.abs(s.surprisePercent ?? 0)));
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">EPS surprise, last {ordered.length} quarter{ordered.length === 1 ? "" : "s"}</p>
      <div className="mt-2 space-y-2">
        {ordered.map((s) => {
          const pct = s.surprisePercent;
          const beat = (pct ?? 0) >= 0;
          const halfWidthPct = pct != null ? (Math.abs(pct) / maxAbs) * 50 : 0;
          const label = s.quarter != null && s.year != null ? `Q${s.quarter} '${String(s.year).slice(2)}` : s.period;
          return (
            <div key={s.period} className="flex items-center gap-3 text-sm">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
              <div className="relative h-4 flex-1 rounded bg-surface-2">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                {pct != null && (
                  <div
                    className={cn("absolute inset-y-0 rounded", beat ? "bg-[color:var(--color-gain)]" : "bg-[color:var(--color-loss)]")}
                    style={beat ? { left: "50%", width: `${halfWidthPct}%` } : { right: "50%", width: `${halfWidthPct}%` }}
                  />
                )}
              </div>
              <span className={cn("w-16 shrink-0 text-right tabular text-xs font-medium", pct == null ? "text-muted-foreground" : beat ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                {pct != null ? `${beat ? "+" : ""}${pct.toFixed(1)}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Actual reported EPS vs. analyst consensus estimate, each of the last {ordered.length} reported quarters.</p>
    </div>
  );
}

function AnalystRecommendationBar({ trend }: { trend: RecommendationTrendPoint[] }) {
  const latest = trend[0];
  const total = latest.strongBuy + latest.buy + latest.hold + latest.sell + latest.strongSell;
  if (total === 0) return null;
  const periodLabel = new Date(`${latest.period}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const segments = [
    { label: "Strong buy", count: latest.strongBuy, className: "bg-[color:var(--color-gain)]" },
    { label: "Buy", count: latest.buy, className: "bg-[color:var(--color-gain)]/55" },
    { label: "Hold", count: latest.hold, className: "bg-muted-foreground/40" },
    { label: "Sell", count: latest.sell, className: "bg-[color:var(--color-loss)]/55" },
    { label: "Strong sell", count: latest.strongSell, className: "bg-[color:var(--color-loss)]" },
  ];
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Analyst ratings, as of {periodLabel}</p>
      <div className="mt-2 flex h-4 overflow-hidden rounded-full">
        {segments.map((s) => (s.count > 0 ? <div key={s.label} className={cn("h-full", s.className)} style={{ width: `${(s.count / total) * 100}%` }} title={`${s.label}: ${s.count}`} /> : null))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.filter((s) => s.count > 0).map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", s.className)} /> {s.label} ({s.count})
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{total} analysts — what analysts currently rate this stock, a count of opinions, not a prediction or a recommendation from us.</p>
    </div>
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

// Key Stats row 2 — fields already sitting in the /stock/metric response
// finnhub.server.ts fetches for every symbol (52-wk range came from the
// same call before this). Zero new API cost (2026-08-13 app audit, Part
// 4/6). ETFs return almost none of the stock-fundamentals fields below
// (no P/E, no margins — a real limitation of the instrument, not a fetch
// failure), so this renders whichever fields the quote actually carries
// and OMITS the rest entirely — never a dash grid. Each entry is built,
// then filtered, so a symbol with 2 populated fields shows exactly 2
// Stats, not 2 real values next to 8 placeholders.
function FundamentalsRow({ quote }: { quote: Quote }) {
  const entries: { label: string; value: string; tone?: "gain" | "loss" }[] = [];
  const push = (cond: number | undefined, label: string, format: (n: number) => { value: string; tone?: "gain" | "loss" }) => {
    if (cond == null || Number.isNaN(cond)) return;
    entries.push({ label, ...format(cond) });
  };

  // Stock fundamentals — absent by design for ETFs/funds.
  push(quote.peTTM, "P/E (TTM)", (n) => ({ value: n.toFixed(1) }));
  push(quote.epsTTM, "EPS (TTM)", (n) => ({ value: fmtUSD(n) }));
  push(quote.dividendYieldPct, "Dividend yield", (n) => ({ value: `${n.toFixed(2)}%` }));
  push(quote.netMarginPct, "Net margin", (n) => ({ value: fmtPct(n), tone: n >= 0 ? "gain" : "loss" }));
  push(quote.roePct, "ROE", (n) => ({ value: fmtPct(n), tone: n >= 0 ? "gain" : "loss" }));
  push(quote.debtToEquity, "Debt/equity", (n) => ({ value: `${n.toFixed(2)}×` }));
  push(quote.revenueGrowthYoYPct, "Revenue growth (YoY)", (n) => ({ value: fmtPct(n), tone: n >= 0 ? "gain" : "loss" }));
  push(quote.psTTM, "P/S (TTM)", (n) => ({ value: n.toFixed(1) }));
  push(quote.bookValuePerShare, "Book value/share", (n) => ({ value: fmtUSD(n) }));

  // ETF/fund substitute — populated whenever the metric call succeeds at
  // all, stocks and funds alike, so these fill the row for instruments
  // with none of the fields above.
  if (entries.length === 0) {
    push(quote.beta, "Beta", (n) => ({ value: n.toFixed(2) }));
    push(quote.priceReturn13wPct, "13-wk return", (n) => ({ value: fmtPct(n), tone: n >= 0 ? "gain" : "loss" }));
    push(quote.priceReturnYtdPct, "YTD return", (n) => ({ value: fmtPct(n), tone: n >= 0 ? "gain" : "loss" }));
  }

  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((e) => (
        <Stat key={e.label} label={e.label} value={e.value} tone={e.tone} />
      ))}
    </>
  );
}

// Moved out of the tab bar into the right column, below the order panel
// (2026-08-15, "News tab is too hidden" — Venky). Redesigned for the
// column's ~350px width rather than the old full-width tab layout:
// headline truncated to 2 lines (`line-clamp-2`, so a long headline
// doesn't push the source/time off screen or blow out row height), no
// separate wide "meta" row layout needed since everything already stacks
// naturally at this width. Still opens externally (`target="_blank"
// rel="noopener noreferrer"`) exactly as before.
function NewsCard({ symbol }: { symbol: string }) {
  const newsQ = useQuery({ queryKey: ["news", symbol], queryFn: () => getCompanyNews(symbol), staleTime: 10 * 60_000, retry: 1 });

  if (newsQ.isPending) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Newspaper className="h-4 w-4" /> News</CardTitle></CardHeader>
        <CardContent><LoadingState label="Loading news…" /></CardContent>
      </Card>
    );
  }
  if (newsQ.isError) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Newspaper className="h-4 w-4" /> News</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ErrorState message={(newsQ.error as Error)?.message ?? "Couldn't load news right now."} />
          <div className="text-center"><Button variant="outline" size="sm" onClick={() => newsQ.refetch()}>Try again</Button></div>
        </CardContent>
      </Card>
    );
  }
  const items = newsQ.data ?? [];
  // Genuinely no news this week (or an ETF with none at all) — hide the
  // whole card rather than an empty heading, same rule as Key Stats and
  // the Earnings & analysts card.
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Newspaper className="h-4 w-4" /> News</CardTitle></CardHeader>
      <CardContent className="p-0 pb-2">
        <ul className="divide-y divide-border/60 px-5">
          {items.slice(0, 8).map((n, i) => <NewsRowCompact key={i} item={n} />)}
        </ul>
      </CardContent>
    </Card>
  );
}

function NewsRowCompact({ item }: { item: NewsItem }) {
  const meta = [item.source, fmtRelativeTime(item.datetime)].filter(Boolean).join(" · ");
  const body = (
    <div className="min-w-0 flex-1">
      <p className={cn("line-clamp-2 text-sm font-medium leading-snug", item.url && "group-hover:underline")}>{item.headline}</p>
      {meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
    </div>
  );
  return (
    <li className="py-3 first:pt-3 last:pb-0">
      {item.url ? (
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2">
          {body}
          <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
      ) : (
        body
      )}
    </li>
  );
}

// Moved out of the tab bar into the right column, below the order panel
// (2026-08-15, "About tab is too hidden" — Venky), first in that column,
// News second. Already mostly label/value pairs, so it reads fine at the
// column's ~350px width without a redesign — `sm:grid-cols-3` from the old
// wide-tab layout never actually triggered at this width anyway (640px
// breakpoint, this column never gets that wide), so it's replaced with an
// explicit single-column stack rather than left as dead/misleading markup.
// No "hide entirely" case: unlike News, a loaded quote ALWAYS has at least
// a name/logo/exchange to show — even the ETF degradation path below
// renders a real, useful "Exchange-traded fund" label, never a blank card.
function AboutCard({ symbol, quote, peers }: { symbol: string; quote?: Quote; peers: string[] }) {
  const body = !quote ? (
    <LoadingState label="Loading company info…" />
  ) : (
    (() => {
      // Finnhub's /stock/profile2 is empty for ETFs/funds — no sector, no
      // market cap, no country. Degrade to a clear fund label instead of
      // blank gaps. `isLikelyFund` is the one shared detection mechanism
      // (lib/marketData/sector.ts) — also used by the Portfolio page's
      // "Allocation by sector" chart, so a fund is never misdetected
      // differently in two places.
      const isFund = isLikelyFund(quote);
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

          <div className="grid grid-cols-1 gap-3">
            <Stat label="Sector / type" value={isFund ? "Exchange-traded fund" : (quote.sector && quote.sector !== "—" ? quote.sector : "Unclassified")} />
            <Stat label="Market cap" value={quote.marketCap != null ? `$${fmtCompact(quote.marketCap)}` : "—"} />
            <Stat label="Country" value={quote.country ?? "—"} />
            {quote.ipo && <Stat label="IPO date" value={quote.ipo} />}
          </div>

          {quote.weburl && (
            <a href={quote.weburl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-[color:var(--color-primary)] hover:underline">
              <Globe className="h-3.5 w-3.5" /> Visit website
            </a>
          )}

          {/* Peers, phase 2 (2026-08-14): genuinely empty for ETFs — hide the
             whole section rather than an empty heading, same rule as everywhere
             else in this enrichment pass. */}
          {peers.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Related stocks</p>
              <div className="flex flex-wrap gap-2">
                {peers.map((p) => (
                  <Link
                    key={p}
                    to="/app/stock/$symbol"
                    params={{ symbol: p }}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium hover:border-[color:var(--color-primary)] hover:text-[color:var(--color-primary)]"
                  >
                    {p}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">Live quote &amp; company profile from Finnhub; historical price chart from Twelve Data.</p>
        </div>
      );
    })()
  );
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">About</CardTitle></CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
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

function OrderPanel({
  price,
  symbol,
  buyingPower,
  positionQty,
  ready,
  cashBalance,
  marginLoan,
  marginEnabled,
  interestRate,
}: {
  price: number;
  symbol: string;
  buyingPower: number;
  positionQty: number;
  ready: boolean;
  cashBalance: number;
  marginLoan: number;
  marginEnabled: boolean;
  interestRate?: number;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [mode, setMode] = useState<"shares" | "dollars">("shares");
  const [qtyInput, setQtyInput] = useState("1");
  const [amountInput, setAmountInput] = useState("50");
  const [limitInput, setLimitInput] = useState(String(price));
  const limit = parseNumberInput(limitInput) ?? 0;
  const [sellAll, setSellAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Optional, non-blocking "why this trade?" capture — opens automatically
  // right after a trade fills, skippable with one click, never required.
  const [tradeNotePrompt, setTradeNotePrompt] = useState<TradeLinkContext | null>(null);

  const execPrice = type === "market" ? price : limit;
  const qtyNum = parseNumberInput(qtyInput) ?? 0;
  const amountNum = parseNumberInput(amountInput) ?? 0;
  const estQtyForDollars = execPrice > 0 ? amountNum / execPrice : 0;
  const isSellAll = side === "sell" && sellAll;
  const hasPosition = positionQty > 0;

  // Live (not just on-click) validity, so the Trade button can be disabled
  // WITH a visible reason instead of only rejecting via a toast after the
  // user has already clicked it.
  const fieldValidation = isSellAll ? null : mode === "shares" ? validateSharesQty(qtyInput) : validateDollarAmount(amountInput);
  const fieldReason = fieldValidation && !fieldValidation.ok ? fieldValidation.error : null;

  const est = isSellAll ? positionQty * execPrice : mode === "shares" ? qtyNum * execPrice : amountNum;
  // Borrow-vs-cash disclosure (hardening-pass follow-up) — buys only; sells
  // never draw on the loan. Computed from cashBalance/marginLoan straight
  // from getMarginState, never a re-derivation of buying power/equity.
  const borrowSplit = computeBorrowSplit(est, cashBalance, marginEnabled, marginLoan);

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
      setTradeNotePrompt({
        transactionId: r.transactionId,
        symbol: r.symbol,
        label: `${r.side === "buy" ? "Buy" : "Sell"} ${fmtQty(r.quantity)} ${r.symbol} @ ${fmtUSD(r.price)}`,
      });
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
      ? (mode === "dollars"
          ? `Buy ${fmtUSD(amountNum)} of ${symbol} (≈${fmtQty(estQtyForDollars, 4)} shares)? This uses ${fmtUSD(est)} of your ${fmtUSD(buyingPower)} buying power.`
          : `Buy ${fmtQty(qtyNum)} ${symbol} for about ${fmtUSD(est)}? This uses ${fmtUSD(est)} of your ${fmtUSD(buyingPower)} buying power.`) +
        borrowSplitSentence(borrowSplit, interestRate)
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
                <NumberInput id="qty" decimals={6} value={qtyInput} onValueChange={setQtyInput} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="amount">Amount</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <NumberInput id="amount" decimals={2} value={amountInput} onValueChange={setAmountInput} className="pl-6" />
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
            <NumberInput id="limit" decimals={2} value={limitInput} onValueChange={setLimitInput} />
            <p className="text-[11px] text-muted-foreground">Limit orders aren't executed yet — use Market to trade now.</p>
          </div>
        )}

        <div className="rounded-md border border-border bg-surface p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Estimated {side === "buy" ? "cost" : "credit"}</span><span className="tabular font-medium">{fmtUSD(est)}</span></div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>Buying power</span><span className="tabular">{fmtUSD(buyingPower)}</span></div>
        </div>

        <Button
          disabled={!ready || pending || (type === "market" && !!fieldReason)}
          className={cn("h-12 w-full text-base", side === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)] hover:opacity-90" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)] hover:opacity-90")}
          onClick={onOpenConfirm}
        >
          {pending ? "Placing…" : confirmLabel}
        </Button>
        {type === "market" && fieldReason && <p className="text-xs text-[color:var(--color-loss)]">{fieldReason}</p>}
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
            {side === "buy" && borrowSplit.willBorrow && (
              <>
                <div className="mt-1.5 flex justify-between border-t border-border pt-1.5 text-xs text-muted-foreground">
                  <span>From cash</span>
                  <span className="tabular">{fmtUSD(borrowSplit.cashPortion)}</span>
                </div>
                <div className="flex justify-between text-xs text-[color:var(--color-loss)]">
                  <span>Borrowed on margin</span>
                  <span className="tabular">{fmtUSD(borrowSplit.borrowedPortion)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Margin loan</span>
                  <span className="tabular">{fmtUSD(borrowSplit.loanBefore)} → {fmtUSD(borrowSplit.loanAfter)}</span>
                </div>
              </>
            )}
          </div>
        }
        confirmLabel={confirmLabel}
        variant={isSellAll ? "destructive" : "default"}
        loading={pending}
        onConfirm={() => trade.mutate()}
      />

      <JournalEntryDialog
        open={!!tradeNotePrompt}
        onOpenChange={(o) => !o && setTradeNotePrompt(null)}
        tradeLink={tradeNotePrompt ?? undefined}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["journalEntries"] })}
      />
    </Card>
  );
}
