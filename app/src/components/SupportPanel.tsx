import { Link } from "@tanstack/react-router";
import { Mail, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtUSD, STARTING_CASH } from "@/lib/mockData";

const SUPPORT_EMAIL = "support@mypapertrader.com";

// Every FAQ answer here was checked against actual current app behavior
// before writing (2026-08-15) — not assumed — cross-referenced against
// CLAUDE.md/ARCHITECTURE.md (market data), lib/options/chain.server.ts
// (Black-Scholes pricing), app.settings.tsx (self-serve reset/delete), and
// components/coaching/UnlockGate.tsx (the options/margin unlock primer).
// If any of those behaviors change, this copy needs to change with them.
const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Is any of this real money?",
    a: "No. My PaperTrader is a simulation — every dollar is virtual. Nothing here ever touches a real brokerage or moves real money.",
  },
  {
    q: "Are the prices real?",
    a: "Yes. Quotes and charts are real, live market data, not simulated numbers — only the money you're trading with is virtual.",
  },
  {
    q: "Why do option premiums differ from my broker's?",
    a: "Free market-data tiers don't include real options-chain quotes, so premiums here are estimated with our own Black-Scholes pricing model from the stock's live price — not a live quote from an exchange. They'll be close, not identical.",
  },
  {
    q: "How do I reset my account?",
    a: (
      <>
        Self-serve — <Link to="/app/settings" className="underline underline-offset-2 hover:opacity-80">Settings → Reset paper account</Link>. Clears your positions and AI agent, resets your balance to {fmtUSD(STARTING_CASH)}, and keeps your login, watchlist, and trade history.
      </>
    ),
  },
  {
    q: "How do I delete my account and my data?",
    a: (
      <>
        Self-serve — <Link to="/app/settings" className="underline underline-offset-2 hover:opacity-80">Settings → Delete account</Link>. This is immediate and permanent: it erases your login, profile, balances, positions, trade history, agent, and watchlist. There's no way to undo it.
      </>
    ),
  },
  {
    q: "Why can't I see Options or Margin right away?",
    a: "Both are gated behind a short primer — a couple of minutes reading the real risks (e.g. a contract can expire worthless, a margin call can auto-sell your positions) plus a quick check that it landed, before either unlocks. It's a one-time thing per feature.",
  },
  {
    q: "Can you tell me what to invest in?",
    a: "No — see “What support isn't” above. We can help with account and app problems, not investment decisions.",
  },
  {
    q: "How much virtual cash do new accounts start with?",
    a: `New accounts start with ${fmtUSD(STARTING_CASH)} in virtual cash automatically — no funding step required.`,
  },
];

export function SupportPanel() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Support</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Questions, bugs, or something not working the way you expected — we want to hear about it.
        </p>
      </div>

      {/* Contact — the main ask, kept prominent and above everything else */}
      <Card>
        <CardContent className="flex flex-col items-start gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium text-foreground">Email us — {SUPPORT_EMAIL}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                My PaperTrader is a one-person project. We read every message and aim to reply within a few business days.
              </p>
            </div>
          </div>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="w-full shrink-0 sm:w-auto">
            <Button className="w-full sm:w-auto">Email support</Button>
          </a>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">What to include</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>The faster we can help, the less back-and-forth — include:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>The email address you signed up with</li>
              <li>What you were doing when it happened</li>
              <li>What you expected to happen, vs. what actually happened</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-4 py-4 text-sm text-foreground">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning,#d97706)]" />
          <div>
            <p className="font-medium">What support isn't</p>
            <p className="mt-1 text-muted-foreground">
              We can't give investment advice, recommend securities, or comment on whether a trade is a good idea. My PaperTrader is an educational simulation, not a financial advisor — same as every disclaimer elsewhere in the app.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Frequently asked questions</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {FAQ.map((item) => (
            <div key={item.q} className="rounded-lg border border-border bg-card p-4">
              <p className="font-medium text-foreground">{item.q}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Data & privacy requests</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Most requests are instant and self-serve in{" "}
            <Link to="/app/settings" className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80">Settings</Link>
            {" "}— reset your account or permanently delete it and every piece of data tied to it, right there. For anything else (access, correction, or a rights request under your local privacy law), email {SUPPORT_EMAIL} and we'll help — see our{" "}
            <Link to="/privacy" className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80">Privacy Policy</Link> for the full detail.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-6 text-sm text-muted-foreground">
        <span>Read more:</span>
        <Link to="/terms" className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80">Terms of Service</Link>
        <Link to="/privacy" className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80">Privacy Policy</Link>
        <Link to="/disclaimer" className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80">Disclaimer</Link>
      </div>
    </div>
  );
}
