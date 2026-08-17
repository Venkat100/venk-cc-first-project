import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

// The ONE search-box chrome for the whole app (top-bar search, Markets,
// Watchlist "Add a ticker", Options "Browse chains", Journal filter, Admin
// user search). Previously six near-identical implementations, three of
// which paired a `border + bg-surface` wrapper div with the base shadcn
// `<Input>` — whose own un-overridden `shadow-sm` + `rounded-md` then drew
// a second, nested rounded rectangle inside the wrapper. Invisible in dark
// mode (the shadow's near-black tint barely registers against an
// already-dark surface); a clearly visible "bubble within a bubble" in
// light mode against a near-white surface. Fixed structurally, not by
// remembering to override more classes: the inner element here is a bare
// `<input>` with NO border/shadow/radius of its own, so there is only ever
// one visual box, in both themes, everywhere it's used.
export const SearchInputBox = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & {
  containerClassName?: string;
  inputClassName?: string;
  onClear?: () => void;
  rightSlot?: React.ReactNode;
}>(({ containerClassName, inputClassName, onClear, rightSlot, value, className: _className, ...props }, ref) => {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2", containerClassName)}>
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        ref={ref}
        value={value}
        className={cn(
          "h-6 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground",
          inputClassName,
        )}
        {...props}
      />
      {onClear && typeof value === "string" && value.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}
      {rightSlot}
    </div>
  );
});
SearchInputBox.displayName = "SearchInputBox";
