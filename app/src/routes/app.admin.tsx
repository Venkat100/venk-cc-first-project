// Super-admin console (PLAN.md §6 step 10, B4) — layout route. Pure
// <Outlet/> + a client-side admin gate + a small subnav, following the
// exact split app.scenarios.tsx established (PLAN.md §6 step 9): a route
// that has its own children (app.admin.index.tsx, app.admin.users.tsx,
// app.admin.audit.tsx) must be a thin layout, or TanStack Router's
// filename-prefix nesting silently traps the child's content invisibly
// inside this file's own JSX.
//
// THIS GATE IS UX ONLY, NOT THE SECURITY BOUNDARY. Every admin server
// function (lib/admin/functions.ts) independently re-verifies is_admin
// server-side via requireAdmin() — hiding this nav/route from a non-admin
// changes nothing about what a tampered/direct call to those functions can
// do, and verify-admin-live.ts proves that by calling them directly with a
// non-admin token.

import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/auth/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/admin")({
  head: () => ({ meta: [{ title: "Admin · PaperTrader" }] }),
  component: () => (
    <AdminGate>
      <AdminShell />
    </AdminGate>
  ),
});

function AdminGate({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && profile && !profile.is_admin) {
      navigate({ to: "/app/dashboard", replace: true });
    }
  }, [loading, profile, navigate]);

  if (loading || !profile) {
    return (
      <div className="grid min-h-[40vh] place-items-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      </div>
    );
  }

  if (!profile.is_admin) {
    return (
      <div className="grid min-h-[40vh] place-items-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm"><ShieldAlert className="h-4 w-4" /> Redirecting…</div>
      </div>
    );
  }

  return <>{children}</>;
}

const TABS = [
  { to: "/app/admin", label: "Overview" },
  { to: "/app/admin/users", label: "Users" },
  { to: "/app/admin/audit", label: "Audit Log" },
] as const;

function AdminShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-[color:var(--color-primary)]" />
        <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
      </div>
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = t.to === "/app/admin" ? pathname === "/app/admin" : pathname.startsWith(t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active ? "border-[color:var(--color-primary)] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}
