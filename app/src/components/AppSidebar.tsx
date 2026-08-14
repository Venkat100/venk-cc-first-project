import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, LineChart, FlaskConical, PieChart, Star, Settings, Bot, Landmark, SplitSquareHorizontal, BookOpen, Compass, History, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/auth-context";
import { BrandIcon, BrandWordmark } from "@/components/Brand";

// AUDIT.md Part 6(b) item 6 (2026-08-14 Tier-2 fix pass): 12 flat, equal-
// weight items gave a new user no signal about what to try first. Grouped
// by what a user actually does with each page, not by build order:
//   Trade  — core loop + the things you trade (incl. Watchlist: it's a
//            pre-trade staging list, not a "learning" surface).
//   Learn  — no real position risk here (Simulator is a public preview;
//            Scenarios/Journal/Coach are reflective, not transactional; the
//            AI Agent trades a SEPARATE isolated sub-portfolio, so using it
//            is closer to "watch a strategy" than "manage my own risk").
//   Account — settings/admin, not part of the trading or learning loop.
// Pure markup/grouping — no new data, no new logic, nav targets unchanged.
const SECTIONS = [
  {
    label: "Trade",
    items: [
      { to: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/app/markets", label: "Markets", icon: LineChart },
      { to: "/app/options", label: "Options", icon: SplitSquareHorizontal },
      { to: "/app/margin", label: "Margin", icon: Landmark },
      { to: "/app/portfolio", label: "Portfolio", icon: PieChart },
      { to: "/app/watchlist", label: "Watchlist", icon: Star },
    ],
  },
  {
    label: "Learn",
    items: [
      { to: "/app/simulator", label: "Simulator", icon: FlaskConical },
      { to: "/app/scenarios", label: "Scenarios", icon: History },
      { to: "/app/journal", label: "Journal", icon: BookOpen },
      { to: "/app/coach", label: "Coach", icon: Compass },
      { to: "/app/agent", label: "AI Agent", icon: Bot },
    ],
  },
  {
    label: "Account",
    items: [{ to: "/app/settings", label: "Settings", icon: Settings }],
  },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { profile } = useAuth();
  // Purely a UX convenience — hiding this item is not the security
  // boundary. Every admin server function independently re-checks
  // is_admin server-side (lib/admin/requireAdmin.server.ts).
  const sections = profile?.is_admin
    ? SECTIONS.map((s) => (s.label === "Account" ? { ...s, items: [...s.items, { to: "/app/admin", label: "Admin", icon: ShieldAlert }] } : s))
    : SECTIONS;

  return (
    <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <BrandIcon size={36} />
        <div className="flex flex-col leading-tight">
          <BrandWordmark className="text-sm" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">paper · v1</span>
        </div>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{section.label}</p>
            <div className="space-y-0.5">
              {section.items.map((it) => {
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
            </div>
          </div>
        ))}
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
