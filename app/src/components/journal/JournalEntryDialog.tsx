// Create/edit dialog for a journal entry. Handles both standalone entries
// (no trade link) and trade-linked notes (the link, once created, is
// immutable — shown as read-only context, never editable, since a note's
// value as a journal is in what you thought THEN, not in re-pointing it
// later). Same responsive shell as ConfirmDialog (bottom sheet on phones,
// centered dialog from `sm:` up).

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createJournalEntry, updateJournalEntry, type NewJournalEntry } from "@/lib/journal/queries";
import type { JournalEntry } from "@/lib/supabase/types";
import { toast } from "sonner";

const SHEET_CONTENT_CLASS =
  "inset-x-0 bottom-0 left-0 top-auto max-h-[85vh] w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-t-2xl rounded-b-none border-t p-0 sm:inset-auto sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:max-h-[90vh] sm:w-full sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border";

export type TradeLinkContext = {
  transactionId?: string;
  optionTransactionId?: string;
  symbol: string;
  /** Plain-English trade summary, e.g. "Buy 5 NVDA @ $211.40 · Aug 10, 2026" */
  label: string;
};

export function JournalEntryDialog({
  open,
  onOpenChange,
  entry,
  tradeLink,
  defaultSymbol,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass to edit an existing entry. Omit to create a new one. */
  entry?: JournalEntry;
  /** Pass when creating a note FOR a specific trade (immutable once saved). */
  tradeLink?: TradeLinkContext;
  /** Pre-fill (editable) symbol for a new standalone entry, e.g. from a stock page. */
  defaultSymbol?: string;
  onSaved?: (entry: JournalEntry) => void;
}) {
  const isEdit = !!entry;
  const [title, setTitle] = useState("");
  const [symbol, setSymbol] = useState("");
  const [body, setBody] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(entry?.title ?? "");
    setSymbol(entry?.symbol ?? tradeLink?.symbol ?? defaultSymbol ?? "");
    setBody(entry?.body ?? "");
    setEntryDate(entry?.entry_date ?? new Date().toISOString().slice(0, 10));
  }, [open, entry, tradeLink, defaultSymbol]);

  const linkLabel = isEdit
    ? entry?.transaction_id || entry?.option_transaction_id
      ? "Linked to a trade — the link can't be changed, but you can still edit this note."
      : null
    : tradeLink?.label ?? null;

  async function handleSave() {
    if (!body.trim()) {
      toast.error("Write something first — or close this and skip it.");
      return;
    }
    setSaving(true);
    try {
      if (isEdit && entry) {
        const updated = await updateJournalEntry(entry.id, {
          title: title.trim() || null,
          symbol: symbol.trim() || null,
          body: body.trim(),
          entryDate,
        });
        toast.success("Entry updated");
        onSaved?.(updated);
      } else {
        const input: NewJournalEntry = {
          title: title.trim() || null,
          symbol: symbol.trim() || null,
          body: body.trim(),
          entryDate,
          transactionId: tradeLink?.transactionId,
          optionTransactionId: tradeLink?.optionTransactionId,
        };
        const created = await createJournalEntry(input);
        toast.success("Entry saved");
        onSaved?.(created);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className={SHEET_CONTENT_CLASS}>
        <div className="p-6">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit entry" : tradeLink ? "Why this trade?" : "New journal entry"}</DialogTitle>
          </DialogHeader>

          {linkLabel && (
            <p className="mt-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">{linkLabel}</p>
          )}

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="je-title">Title (optional)</Label>
              <Input id="je-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. AI momentum still building" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="je-body">{tradeLink ? "Why this trade? (optional)" : "Notes"}</Label>
              <Textarea
                id="je-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={tradeLink ? "What's your reasoning? Skip this if you'd rather not — it's optional." : "What are you thinking about the market, a position, or your own behavior?"}
                rows={5}
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="je-symbol">Symbol (optional)</Label>
                <Input
                  id="je-symbol"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="e.g. NVDA"
                  disabled={!!tradeLink}
                  className={tradeLink ? "opacity-70" : ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="je-date">Date</Label>
                <Input id="je-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </div>
            </div>
          </div>

          <DialogFooter className="mt-6 flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="w-full sm:w-auto">
              {tradeLink ? "Skip" : "Cancel"}
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Save entry"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
