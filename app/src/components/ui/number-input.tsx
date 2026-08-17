import * as React from "react";
import { cn } from "@/lib/utils";

// The ONE numeric-input primitive for the whole app — trade quantity/dollar
// fields, limit price, agent funding, margin repay, the What-If Simulator
// amount, option contract count, scenario quantity.
//
// ROOT CAUSE this fixes: every prior numeric field either held a NUMBER in
// state (`useState(5000)`) with `onChange={(e) => setAmount(Number(e.target
// .value) || 0)}`, or used the bare `<input type="number">`. Clearing the
// field yields `""`; `Number("")` is `0`, not `NaN`, so the `|| 0` fallback
// (or the bare coercion) silently re-wrote the field back to "0" on the very
// next render — the keystroke registered, but "empty" was never a state the
// component could represent. Typing "0" then "5" produced "05" for the same
// reason: nothing ever normalized the string, because there WAS no string —
// only ever a number, immediately re-stringified by the DOM.
//
// The fix is structural: this component's value is ALWAYS a string, and it
// is only ever ADDITIVE/SUBTRACTIVE at the character level (sanitize +
// strip leading zeros) — never round-tripped through Number(). Empty stays
// empty. Coercing to an actual number is the caller's job, at
// submit/validation time, via `parseNumberInput()` below — never here.
export type NumberInputProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "inputMode"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimal places allowed. 0 = whole numbers only (e.g. option contracts). */
  decimals?: number;
  /** Whether a leading "-" may be typed. Off for every field in this app today — quantities, dollars, and prices are all magnitudes; sign (fund vs. withdraw) is chosen by a separate control, never typed into the amount itself. */
  allowNegative?: boolean;
};

// Strips leading zeros NOT followed by a digit-continuation — "05" -> "5",
// "007" -> "7" — but leaves a deliberate bare "0" and an in-progress
// decimal like "0.5" or "0." untouched (neither has a digit right after
// the leading zero).
function stripLeadingZeros(raw: string): string {
  const negative = raw.startsWith("-");
  const rest = negative ? raw.slice(1) : raw;
  const stripped = rest.replace(/^0+(?=\d)/, "");
  return (negative ? "-" : "") + stripped;
}

function sanitize(raw: string, decimals: number, allowNegative: boolean): string {
  const negative = allowNegative && raw.trim().startsWith("-");
  let v = raw.replace(/-/g, "").replace(/[^0-9.]/g, "");
  const firstDot = v.indexOf(".");
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
  }
  if (decimals <= 0) {
    v = v.split(".")[0];
  } else if (firstDot !== -1) {
    const [intPart, decPart = ""] = v.split(".");
    v = intPart + "." + decPart.slice(0, decimals);
  }
  return (negative ? "-" : "") + v;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onValueChange, decimals = 2, allowNegative = false, className, onBlur, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);
    // Cursor position to restore after a normalizing re-render — only ever
    // needed because we sometimes shorten the string from the FRONT
    // (stripping leading zeros) while the user is typing at/near the end;
    // tracked as "characters from the end" so it's correct regardless of
    // where in the field the edit happened.
    const pendingCursor = React.useRef<number | null>(null);

    React.useLayoutEffect(() => {
      if (pendingCursor.current != null && innerRef.current) {
        const pos = pendingCursor.current;
        innerRef.current.setSelectionRange(pos, pos);
        pendingCursor.current = null;
      }
    });

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const el = e.target;
      const raw = el.value;
      const selStart = el.selectionStart ?? raw.length;
      const charsFromEnd = raw.length - selStart;

      const normalized = stripLeadingZeros(sanitize(raw, decimals, allowNegative));

      pendingCursor.current = Math.max(0, normalized.length - charsFromEnd);
      onValueChange(normalized);
    }

    function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
      // Tidy a trailing "." left over from an abandoned decimal ("12." ->
      // "12") once the user is done typing — never done mid-keystroke, so
      // it can't fight with what they're actively entering.
      if (value.endsWith(".")) onValueChange(value.slice(0, -1));
      onBlur?.(e);
    }

    return (
      <input
        ref={innerRef}
        type="text"
        inputMode={decimals <= 0 ? "numeric" : "decimal"}
        autoComplete="off"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm tabular",
          className,
        )}
        {...props}
      />
    );
  },
);
NumberInput.displayName = "NumberInput";

/**
 * Coerces a NumberInput's string value to a number ONLY at submit/validation
 * time — the one place `Number()` should ever touch this string. Returns
 * `null` for empty/incomplete input ("", "-", ".") so callers can tell
 * "nothing entered" apart from a real 0, which `Number("") || 0`-style
 * coercion always collapsed together.
 */
export function parseNumberInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
