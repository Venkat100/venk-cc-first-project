import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { STARTING_CASH, fmtUSD } from "@/lib/mockData";
import { applyTheme, getTheme } from "@/lib/theme";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth/auth-context";
import { resetPaperAccount } from "@/lib/account/reset";
import { toast } from "sonner";

// Every react-query key touched by a reset — everything financial, deliberately
// EXCLUDING watchlist (a preference, not a position — explicitly kept, see
// 0015's header) and market-data/insights keys (quote/candles/news/insight/…,
// unrelated to any one account's state).
const RESET_AFFECTED_QUERY_KEYS = [
  "holdings",
  "transactions",
  "optionPositions",
  "optionTransactions",
  "snapshots",
  "agentConfig",
  "agentHoldings",
  "agentDecisions",
  "agentProposal",
  "agentSnapshots",
] as const;

export const Route = createFileRoute("/app/settings")({
  head: () => ({ meta: [{ title: "Settings · PaperTrader" }] }),
  component: Settings,
});

function Settings() {
  const [dark, setDark] = useState(true);
  useEffect(() => { setDark(getTheme() === "dark"); }, []);

  const navigate = useNavigate();
  const { user, profile, signOut, refreshProfile } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  const resetMut = useMutation({
    mutationFn: resetPaperAccount,
    onSuccess: async (r) => {
      await Promise.all([
        refreshProfile(),
        ...RESET_AFFECTED_QUERY_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })),
      ]);
      setConfirmResetOpen(false);
      const cleared = r.holdingsCleared + r.optionPositionsCleared + r.agentHoldingsCleared;
      toast.success("Paper account reset to $100,000.00", {
        description:
          cleared > 0 || r.marginLoanForgiven > 0
            ? `Cleared ${cleared} position${cleared === 1 ? "" : "s"}${r.marginLoanForgiven > 0 ? ` and forgave a ${fmtUSD(r.marginLoanForgiven)} margin loan` : ""}. Your watchlist and trade history are unchanged.`
            : "Your watchlist and trade history are unchanged.",
      });
    },
    onError: (e: Error) => {
      toast.error(e.message || "The reset couldn't be completed.");
      setConfirmResetOpen(false);
    },
  });

  // Seed the name field from the loaded profile.
  useEffect(() => { setName(profile?.display_name ?? ""); }, [profile?.display_name]);

  async function saveProfile() {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: name.trim() || null })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    await refreshProfile();
    toast.success("Profile saved");
  }

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your profile and paper account.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Profile</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={user?.email ?? ""} disabled readOnly />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void saveProfile()} disabled={saving} className="w-fit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button variant="outline" onClick={() => void handleSignOut()} className="w-fit">
              Log out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Dark mode</p>
            <p className="text-xs text-muted-foreground">Bloomberg-style dark UI by default.</p>
          </div>
          <Switch checked={dark} onCheckedChange={(v) => { setDark(v); applyTheme(v ? "dark" : "light"); }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Paper account</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Cash balance</p>
            <p className="mt-1 text-2xl font-semibold tabular">{fmtUSD(profile?.cash_balance ?? STARTING_CASH)}</p>
            <p className="mt-1 text-xs text-muted-foreground">No real money is involved at any point.</p>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Reset paper account</p>
              <p className="text-xs text-muted-foreground">Clears your positions and AI agent, and resets your virtual balance to {fmtUSD(STARTING_CASH)}. Keeps your login, watchlist, and trade history.</p>
            </div>
            <Button variant="destructive" disabled={resetMut.isPending} onClick={() => setConfirmResetOpen(true)}>Reset account</Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        title="Reset paper account"
        consequence="Reset your paper account back to a clean $100,000 start? This closes every stock and option position and clears your AI agent's holdings and settings. This cannot be undone."
        detail={
          <div className="space-y-1.5">
            <div className="flex justify-between"><span className="text-muted-foreground">Cash balance</span><span className="tabular font-medium">→ {fmtUSD(STARTING_CASH)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Stock &amp; option positions</span><span className="font-medium">Closed</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">AI agent</span><span className="font-medium">Deactivated, cleared</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Outstanding margin loan, if any</span><span className="font-medium">Forgiven</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Your watchlist</span><span className="font-medium">Kept</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Your past trade history</span><span className="font-medium">Stays visible</span></div>
          </div>
        }
        confirmLabel="Reset account"
        variant="destructive"
        loading={resetMut.isPending}
        onConfirm={() => resetMut.mutate()}
      />
    </div>
  );
}
