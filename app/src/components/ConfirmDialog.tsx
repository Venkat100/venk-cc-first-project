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

import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const firingRef = useRef(false);
  useEffect(() => {
    if (!loading) firingRef.current = false;
  }, [loading]);

  function handleConfirm() {
    if (loading || firingRef.current) return;
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
          confirmRef.current?.focus();
        }}
      >
        <DialogHeader className="border-b border-border px-4 py-3 text-left sm:px-5">
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-4 py-4 sm:px-5">
          <DialogDescription className="text-sm text-foreground">{consequence}</DialogDescription>
          {detail && <div className="rounded-md border border-border bg-surface p-3 text-sm">{detail}</div>}
        </div>

        <DialogFooter className="gap-2 border-t border-border px-4 py-3 sm:px-5">
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)} className="sm:w-auto">
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={variant}
            disabled={loading}
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
