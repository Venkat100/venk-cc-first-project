import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Search, SearchX, Sun, Moon, Bell, Menu, X } from "lucide-react";
import { useSymbolSearch } from "@/lib/marketData/useSymbolSearch";
import { WatchlistStar } from "@/components/WatchlistStar";
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
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user, profile, signOut } = useAuth();

  // Live Finnhub-backed search — same path as the Markets tab, finds any ticker.
  const search = useSymbolSearch(q, 8);
  const results = search.matches;

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

  // "/" focuses the search box (unless already typing somewhere).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Reset the highlighted result whenever the query changes.
  useEffect(() => { setActive(0); }, [q]);

  function goTo(symbol: string) {
    navigate({ to: "/app/stock/$symbol", params: { symbol } });
    setOpen(false);
    setQ("");
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (results.length === 0) {
      if (e.key === "Enter" && results[0]) goTo(results[0].symbol);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[active] ?? results[0]; if (r) goTo(r.symbol); }
  }

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
            ref={inputRef}
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search any ticker — AAPL, QQQ, VOO…"
            aria-label="Search stocks and ETFs"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">/</kbd>
        </div>
        {open && q.trim().length > 0 && (
          <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            {search.pending && results.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">Searching “{q}”…</div>
            ) : search.isError ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">Search is busy right now (rate limit). Try again in a moment.</div>
            ) : results.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <SearchX className="h-4 w-4" /> No tickers match “{q}”.
              </div>
            ) : (
              results.map((m, i) => (
                <div
                  key={m.symbol}
                  className={cn("flex items-center gap-2 px-2 py-1.5", i === active && "bg-accent")}
                  onMouseEnter={() => setActive(i)}
                >
                  <button
                    onClick={() => goTo(m.symbol)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left text-sm"
                  >
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-xs font-bold">{m.symbol.slice(0, 2)}</div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{m.symbol}</span>
                        {m.type && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{m.type}</span>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{m.name}</div>
                    </div>
                  </button>
                  <WatchlistStar symbol={m.symbol} />
                </div>
              ))
            )}
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
