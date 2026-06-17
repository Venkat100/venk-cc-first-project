import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Search, Sun, Moon, Bell, Menu, X } from "lucide-react";
import { STOCKS, fmtUSD, fmtPct } from "@/lib/mockData";
import { applyTheme, getTheme, type Theme } from "@/lib/theme";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth/auth-context";
import { cn } from "@/lib/utils";

function initialsFrom(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name && name.trim()) || (email ? email.split("@")[0] : "");
  if (!source) return "PT";
  const parts = source.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { user, profile, signOut } = useAuth();

  const displayName = profile?.display_name || user?.email || "Account";
  const email = user?.email ?? "";

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/auth", replace: true });
  }

  useEffect(() => { setTheme(getTheme()); }, []);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const matches = useMemo(() => {
    if (!q.trim()) return [];
    const term = q.toLowerCase();
    return STOCKS.filter((s) => s.symbol.toLowerCase().includes(term) || s.name.toLowerCase().includes(term)).slice(0, 6);
  }, [q]);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
      <button onClick={onOpenMobileNav} className="md:hidden -ml-1 grid h-9 w-9 place-items-center rounded-md hover:bg-accent">
        <Menu className="h-5 w-5" />
      </button>

      <div ref={ref} className="relative flex-1 max-w-xl">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            placeholder="Search stocks (AAPL, Tesla…)"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">/</kbd>
        </div>
        {open && matches.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            {matches.map((s) => {
              const up = s.dayChangePct >= 0;
              return (
                <button
                  key={s.symbol}
                  onClick={() => { navigate({ to: "/app/stock/$symbol", params: { symbol: s.symbol } }); setOpen(false); setQ(""); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-xs font-bold">{s.symbol.slice(0, 2)}</div>
                    <div className="min-w-0">
                      <div className="font-semibold">{s.symbol}</div>
                      <div className="truncate text-xs text-muted-foreground">{s.name}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="tabular">{fmtUSD(s.price)}</span>
                    <span className={cn("tabular text-xs", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(s.dayChangePct)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
      <Button variant="ghost" size="icon" aria-label="Notifications" className="hidden sm:inline-flex">
        <Bell className="h-4 w-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 rounded-full p-1 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
              {initialsFrom(profile?.display_name, email)}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{displayName}</span>
            {email && <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ to: "/app/settings" })}>
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleSignOut()}>
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

export function MobileNavOverlay({ open, onClose, items }: {
  open: boolean;
  onClose: () => void;
  items: { to: string; label: string }[];
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-background/80 backdrop-blur" onClick={onClose} />
      <div className="absolute left-0 top-0 h-full w-72 border-r border-border bg-sidebar p-4">
        <div className="flex items-center justify-between">
          <span className="font-semibold">Menu</span>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <nav className="mt-4 space-y-1">
          {items.map((it) => (
            <Link key={it.to} to={it.to} onClick={onClose} className="block rounded-md px-3 py-2 text-sm hover:bg-accent">{it.label}</Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
