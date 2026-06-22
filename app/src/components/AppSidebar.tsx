import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, LineChart, FlaskConical, PieChart, Star, Settings, Sparkles, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { to: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/app/markets", label: "Markets", icon: LineChart },
  { to: "/app/simulator", label: "Simulator", icon: FlaskConical },
  { to: "/app/agent", label: "AI Agent", icon: Bot },
  { to: "/app/portfolio", label: "Portfolio", icon: PieChart },
  { to: "/app/watchlist", label: "Watchlist", icon: Star },
  { to: "/app/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">PaperTrader</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">paper · v1</span>
        </div>
      </div>
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {items.map((it) => {
          const Icon = it.icon;
          const active = pathname === it.to || (it.to !== "/app/dashboard" && pathname.startsWith(it.to));
          return (
            <Link
              key={it.to}
              to={it.to}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{it.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="mx-3 mb-4 rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-3">
        <p className="text-xs font-semibold">Paper account</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          You're trading with virtual cash. No real money is ever used.
        </p>
      </div>
    </aside>
  );
}
