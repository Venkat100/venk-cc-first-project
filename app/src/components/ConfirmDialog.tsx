// Shared confirmation primitive (C1) — used before every money-moving or
// destructive action in the app. Built on the existing shadcn Dialog (not
// AlertDialog): the spec requires Escape/backdrop-to-cancel, which Radix's
// AlertDialog deliberately disables (it forces an explicit choice) but plain
// Dialog supports natively. Renders as a bottom sheet on phones and a
// centered dialog from `sm:` up — the exact responsive pattern already used
// by OptionOrderPanel, via Tailwind breakpoints on one DialogContent (no
// separate mobile component).
//
// Double-submit guard: `loading` (pass the caller's mutation.isPending)
// disables the Confirm button AND blocks Escape/backdrop/X dismissal while
// in flight. A local ref adds a synchronous belt-and-suspenders check for a
// same-tick double-click that could otherwise race ahead of React's
// isPending re-render.

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Plain-English consequence line, stated with real numbers — not generic text. */
  consequence: React.ReactNode;
  /** Optional math/detail breakdown, rendered in a bordered box below the consequence line. */
  detail?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button for irreversible actions (sell-all, reset account, reject proposal). */
  variant?: "default" | "destructive";
  /** In-flight state — pass the caller's mutation.isPending. */
  loading?: boolean;
  /** When set (e.g. "DELETE"), the Confirm button stays disabled until the
   *  user types this exact text into a field rendered just above it — the
   *  strongest tier of confirmation, for the handful of truly unrecoverable
   *  actions (account deletion) where even a destructive-red button isn't
   *  enough friction. */
  requireTypedConfirmation?: string;
  onConfirm: () => void;
};

// One responsive className: bottom sheet on phones, centered dialog from `sm:` up
// — identical pattern to OptionOrderPanel's SHEET_CONTENT_CLASS.
const SHEET_CONTENT_CLASS =
  "inset-x-0 bottom-0 left-0 top-auto max-h-[85vh] w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-t-2xl rounded-b-none border-t p-0 sm:inset-auto sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:max-h-[90vh] sm:w-full sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  detail,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "default",
  loading = false,
  requireTypedConfirmation,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const firingRef = useRef(false);
  const [typedValue, setTypedValue] = useState("");
  useEffect(() => {
    if (!loading) firingRef.current = false;
  }, [loading]);
  // Reset the typed-confirmation field every time the dialog opens, so a
  // prior "DELETE" doesn't silently carry over to a different dialog use.
  useEffect(() => {
    if (open) setTypedValue("");
  }, [open]);

  const typedMismatch = requireTypedConfirmation != null && typedValue !== requireTypedConfirmation;

  function handleConfirm() {
    if (loading || firingRef.current || typedMismatch) return;
    firingRef.current = true;
    onConfirm();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (loading) return; // block Escape/backdrop/X while in flight
        onOpenChange(v);
      }}
    >
      <DialogContent
        className={SHEET_CONTENT_CLASS}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // With a typed-confirmation gate, focus that field first — the
          // Confirm button starts disabled anyway. Otherwise, Confirm.
          (requireTypedConfirmation ? typedInputRef.current : confirmRef.current)?.focus();
        }}
      >
        <DialogHeader className="border-b border-border px-4 py-3 text-left sm:px-5">
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-4 py-4 sm:px-5">
          <DialogDescription className="text-sm text-foreground">{consequence}</DialogDescription>
          {detail && <div className="rounded-md border border-border bg-surface p-3 text-sm">{detail}</div>}
          {requireTypedConfirmation != null && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-typed-input">
                Type <span className="font-semibold text-foreground">{requireTypedConfirmation}</span> to confirm
              </Label>
              <Input
                id="confirm-typed-input"
                ref={typedInputRef}
                value={typedValue}
                onChange={(e) => setTypedValue(e.target.value)}
                disabled={loading}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={requireTypedConfirmation}
                className="tabular"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 border-t border-border px-4 py-3 sm:px-5">
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)} className="sm:w-auto">
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={variant}
            disabled={loading || typedMismatch}
            onClick={handleConfirm}
            className="sm:w-auto"
          >
            {loading ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
