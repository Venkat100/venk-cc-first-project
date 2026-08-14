import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { JournalEntryDialog } from "@/components/journal/JournalEntryDialog";
import { JournalEntryCard } from "@/components/journal/JournalEntryCard";
import { getJournalEntries, deleteJournalEntry } from "@/lib/journal/queries";
import { getTransactions, getHoldings } from "@/lib/portfolio/queries";
import { getOptionTransactions, getOptionPositions } from "@/lib/options/queries";
import { computeJournalOutcome } from "@/lib/journal/outcome";
import { stockTradeSummary, optionTradeSummary } from "@/lib/journal/format";
import { useQuotes } from "@/lib/marketData/useQuotes";
import type { JournalEntry } from "@/lib/supabase/types";

export const Route = createFileRoute("/app/journal")({
  head: () => ({ meta: [{ title: "Journal · My PaperTrader" }] }),
  // Lets the transaction-history note indicator and the stock page deep-link
  // straight into a symbol's entries (?symbol=NVDA), same convention as
  // /app/options.
  validateSearch: (search: Record<string, unknown>) => ({
    symbol: typeof search.symbol === "string" && search.symbol.trim() ? search.symbol.trim().toUpperCase() : undefined,
  }),
  component: Journal,
});

function Journal() {
  const { symbol: linkedSymbol } = Route.useSearch();
  const queryClient = useQueryClient();
  const entriesQ = useQuery({ queryKey: ["journalEntries"], queryFn: getJournalEntries });
  const txQ = useQuery({ queryKey: ["transactions"], queryFn: getTransactions });
  const optionTxQ = useQuery({ queryKey: ["optionTransactions"], queryFn: getOptionTransactions });
  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const optionPositionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });

  const entries = entriesQ.data ?? [];
  const transactions = txQ.data ?? [];
  const optionTransactions = optionTxQ.data ?? [];
  const holdings = holdingsQ.data ?? [];
  const optionPositions = optionPositionsQ.data ?? [];

  const heldSymbols = useMemo(() => new Set(holdings.map((h) => h.symbol)), [holdings]);
  const openContractIds = useMemo(() => new Set(optionPositions.map((p) => p.contractId)), [optionPositions]);

  // Only need live quotes for symbols a stock-linked entry actually cares
  // about (open buys need the current price; sells want it for context).
  const stockLinkedSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.transaction_id) {
        const tx = transactions.find((t) => t.id === e.transaction_id);
        if (tx) set.add(tx.symbol);
      }
    }
    return Array.from(set);
  }, [entries, transactions]);
  const quotesQ = useQuotes(stockLinkedSymbols);

  const [search, setSearch] = useState(linkedSymbol ?? "");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | undefined>(undefined);
  const [deletingEntry, setDeletingEntry] = useState<JournalEntry | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.symbol?.toUpperCase().includes(q) || e.title?.toUpperCase().includes(q) || e.body.toUpperCase().includes(q),
    );
  }, [entries, search]);

  const isLoading = entriesQ.isLoading || txQ.isLoading || optionTxQ.isLoading || holdingsQ.isLoading || optionPositionsQ.isLoading;
  const isError = entriesQ.isError;

  function refreshEntries() {
    void queryClient.invalidateQueries({ queryKey: ["journalEntries"] });
  }

  async function handleDelete() {
    if (!deletingEntry) return;
    setDeleting(true);
    try {
      await deleteJournalEntry(deletingEntry.id);
      refreshEntries();
      setDeletingEntry(undefined);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Journal</h1>
          <p className="text-sm text-muted-foreground">Your reasoning, captured before you know the outcome.</p>
        </div>
        <Button
          onClick={() => {
            setEditingEntry(undefined);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" /> New entry
        </Button>
      </div>

      {entries.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by symbol, title, or text…"
            className="pl-9"
          />
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingState label="Loading your journal…" />
          ) : isError ? (
            <ErrorState message={(entriesQ.error as Error)?.message} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="Nothing here yet"
              description="Serious traders keep journals — not for notes, but because writing down WHY you're making a trade, before you know how it turns out, is the only way to tell good reasoning from a lucky guess. Start with a standalone thought, or add a note the next time you buy or sell — it's always optional."
              action={
                <Button
                  onClick={() => {
                    setEditingEntry(undefined);
                    setDialogOpen(true);
                  }}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> Write your first entry
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon={Search} title="No matches" description={`Nothing matches "${search}". Try a different symbol or word.`} />
          ) : (
            <div className="space-y-3 p-4">
              {filtered.map((entry) => {
                const tx = entry.transaction_id ? transactions.find((t) => t.id === entry.transaction_id) : undefined;
                const otx = entry.option_transaction_id ? optionTransactions.find((t) => t.id === entry.option_transaction_id) : undefined;
                const outcome = computeJournalOutcome(entry, {
                  transactions,
                  optionTransactions,
                  heldSymbols,
                  openContractIds,
                  optionPositions,
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
                      setEditingEntry(entry);
                      setDialogOpen(true);
                    }}
                    onDelete={() => setDeletingEntry(entry)}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <JournalEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editingEntry}
        onSaved={refreshEntries}
      />

      <ConfirmDialog
        open={!!deletingEntry}
        onOpenChange={(o) => !o && setDeletingEntry(undefined)}
        title="Delete this entry?"
        consequence="This journal entry will be permanently deleted. This can't be undone."
        confirmLabel="Delete entry"
        variant="destructive"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
