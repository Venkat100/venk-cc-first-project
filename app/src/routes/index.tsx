import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, LineChart, FlaskConical, ShieldCheck, Sparkles, TrendingUp, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PaperTrader — Practice investing risk-free" },
      { name: "description", content: "Trade stocks with $100,000 in virtual cash. Run what-if simulations against real market history. No real money, no risk." },
      { property: "og:title", content: "PaperTrader — Practice investing risk-free" },
      { property: "og:description", content: "Test what-if scenarios and learn investing with virtual money." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="text-base font-semibold tracking-tight">PaperTrader</span>
        </div>
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <a href="#features" className="hover:text-foreground">Features</a>
          <a href="#simulator" className="hover:text-foreground">Simulator</a>
          <a href="#how" className="hover:text-foreground">How it works</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/auth" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Sign in</Link>
          <Link to="/auth">
            <Button size="sm">Get started</Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-32 h-[460px] opacity-60"
          style={{ background: "radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--color-primary) 25%, transparent), transparent 70%)" }}
        />
        <div className="mx-auto max-w-7xl px-6 pt-12 pb-20 md:pt-20 md:pb-28">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-gain)]" />
                Live paper markets · No real money used
              </div>
              <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight md:text-6xl">
                Practice investing,<br/>
                <span className="text-[color:var(--color-gain)]">risk-free.</span>
              </h1>
              <p className="mt-5 max-w-xl text-balance text-base text-muted-foreground md:text-lg">
                Start with $100,000 in virtual cash. Trade real-feeling markets, build a portfolio, and run
                <span className="text-foreground"> "what if I had invested" </span>
                simulations against real market history.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link to="/auth">
                  <Button size="lg" className="gap-2">
                    Create free account <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link to="/simulator">
                  <Button size="lg" variant="outline" className="gap-2">
                    <FlaskConical className="h-4 w-4" /> Try the simulator
                  </Button>
                </Link>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">No credit card · Reset your account anytime</p>
            </div>

            {/* Hero card preview */}
            <div className="relative">
              <div className="rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Portfolio value</p>
                    <p className="mt-1 text-3xl font-semibold tabular">$142,318.74</p>
                  </div>
                  <div className="rounded-md bg-[color:var(--color-gain)]/15 px-2.5 py-1 text-xs font-medium text-[color:var(--color-gain)] tabular">
                    +$3,214 (+2.31%)
                  </div>
                </div>
                <div className="mt-4 h-44">
                  <svg viewBox="0 0 400 160" className="h-full w-full">
                    <defs>
                      <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-gain)" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="var(--color-gain)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path d="M0 120 L 30 110 L 60 115 L 90 95 L 120 100 L 150 80 L 180 90 L 210 70 L 240 75 L 270 55 L 300 60 L 330 40 L 360 50 L 400 28 L 400 160 L 0 160 Z" fill="url(#hg)" />
                    <path d="M0 120 L 30 110 L 60 115 L 90 95 L 120 100 L 150 80 L 180 90 L 210 70 L 240 75 L 270 55 L 300 60 L 330 40 L 360 50 L 400 28" fill="none" stroke="var(--color-gain)" strokeWidth="2.5" />
                  </svg>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  {["AAPL +1.02%", "NVDA +2.56%", "TSLA −1.63%"].map((s, i) => (
                    <div key={i} className="rounded-md border border-border bg-surface px-2 py-1.5 tabular text-muted-foreground">{s}</div>
                  ))}
                </div>
              </div>
              <div className="absolute -bottom-6 -left-6 hidden rounded-xl border border-border bg-card p-4 shadow-xl md:block">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">What-if · NVDA · 5y</p>
                <p className="mt-1 text-xl font-semibold tabular text-[color:var(--color-gain)]">+1,742%</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border bg-surface/50">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <h2 className="max-w-2xl text-3xl font-bold tracking-tight md:text-4xl">Everything you need to learn the market.</h2>
          <p className="mt-3 max-w-xl text-muted-foreground">
            A complete trading workbench — without the financial risk.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { icon: LineChart, title: "Live-feeling markets", body: "Trade believable tickers with charts across 1D to 5Y ranges." },
              { icon: FlaskConical, title: "What-if simulator", body: "Backtest any amount, any date, any stock — compare vs. the S&P 500." },
              { icon: BarChart3, title: "Portfolio analytics", body: "Allocation by stock and sector. Full transaction history. P&L tracking." },
              { icon: TrendingUp, title: "Watchlists & movers", body: "Curate tickers and track today's biggest movers at a glance." },
              { icon: ShieldCheck, title: "Risk-free by design", body: "$100,000 virtual cash. Reset to start fresh whenever you want." },
              { icon: Sparkles, title: "Built for learning", body: "Market & limit orders, position sizing, average cost — all the real concepts." },
            ].map((f) => (
              <div key={f.title} className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-[color:var(--color-primary)]/40">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-[color:var(--color-primary)]">
                  <f.icon className="h-4 w-4" />
                </div>
                <h3 className="mt-4 font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="how" className="mx-auto max-w-7xl px-6 py-20">
        <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-surface-2 p-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Start with $100,000 of virtual cash.</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            No real money, ever. Just a great way to practice strategies, learn how markets behave, and see your decisions play out.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link to="/auth"><Button size="lg" className="gap-2">Open paper account <ArrowRight className="h-4 w-4" /></Button></Link>
            <Link to="/simulator"><Button size="lg" variant="outline">Try the simulator</Button></Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} PaperTrader. Simulated trading only — no real money involved.</span>
          <span>For educational use.</span>
        </div>
      </footer>
    </div>
  );
}
