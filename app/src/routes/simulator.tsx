import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimulatorPanel } from "@/components/SimulatorPanel";
import { useAuth } from "@/lib/auth/auth-context";

// PUBLIC route (NOT under /app) — usable while logged out. The auth gate only
// wraps /app/*, so this page is reachable by anyone.
export const Route = createFileRoute("/simulator")({
  head: () => ({
    meta: [
      { title: "What-If Simulator — PaperTrader" },
      { name: "description", content: "See what investing in any stock back then would be worth today, vs. the S&P 500. Free, no account needed." },
    ],
  }),
  component: PublicSimulator,
});

function PublicSimulator() {
  const { session } = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/" className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="h-4 w-4" /></div>
            <span className="font-semibold">PaperTrader</span>
          </Link>
          <div className="flex items-center gap-2">
            {session ? (
              <Link to="/app/dashboard"><Button size="sm">Go to dashboard</Button></Link>
            ) : (
              <>
                <Link to="/auth" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Sign in</Link>
                <Link to="/auth"><Button size="sm">Get started</Button></Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <SimulatorPanel />
      </main>
    </div>
  );
}
