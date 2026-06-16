import { cn } from "@/lib/utils";

export function Delta({ value, suffix = "", className }: { value: number; suffix?: string; className?: string }) {
  const up = value >= 0;
  return (
    <span
      className={cn(
        "tabular font-medium",
        up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]",
        className,
      )}
    >
      {up ? "▲" : "▼"} {up ? "+" : "−"}
      {Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}
      {suffix}
    </span>
  );
}
