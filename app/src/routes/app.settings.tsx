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
import { deleteAccount } from "@/lib/account/delete";
import { friendlyError } from "./auth";
import { toast } from "sonner";

const MIN_PASSWORD_LENGTH = 8;

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
  head: () => ({ meta: [{ title: "Settings · My PaperTrader" }] }),
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
      toast.success(`Paper account reset to ${fmtUSD(STARTING_CASH)}`, {
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

  // ── Change password ───────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  async function handleChangePassword() {
    if (!user?.email) return;
    if (!currentPassword) {
      toast.error("Enter your current password.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords don't match.");
      return;
    }
    setChangingPassword(true);
    // Re-verify the CURRENT password before allowing the change — Supabase's
    // updateUser() trusts the existing session and would otherwise let
    // anyone with an unlocked, unattended session change the password with
    // no proof they actually know it.
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (verifyError) {
      setChangingPassword(false);
      toast.error("Current password is incorrect.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setChangingPassword(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    toast.success("Password changed");
  }

  // ── Change email ───────────────────────────────────────────────────────
  const [newEmail, setNewEmail] = useState("");
  const [changingEmail, setChangingEmail] = useState(false);

  async function handleChangeEmail() {
    if (!newEmail || newEmail === user?.email) {
      toast.error("Enter a different email address.");
      return;
    }
    setChangingEmail(true);
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    setChangingEmail(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    toast.success("Confirmation email sent", {
      description: `We've sent a confirmation link to ${newEmail}. Your current email (${user?.email}) stays active until you confirm the change.`,
    });
    setNewEmail("");
  }

  // ── Delete account ─────────────────────────────────────────────────────
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const deleteMut = useMutation({
    mutationFn: deleteAccount,
    onSuccess: async () => {
      toast.success("Your account has been permanently deleted.");
      await signOut();
      navigate({ to: "/auth", replace: true });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't delete your account.");
      setConfirmDeleteOpen(false);
    },
  });

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
        <CardHeader><CardTitle className="text-base">Security</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Change password</p>
              <p className="text-xs text-muted-foreground">Requires your current password.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="current-password">Current password</Label>
                <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password-settings">New password</Label>
                <Input id="new-password-settings" type="password" autoComplete="new-password" placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password-settings">Confirm new password</Label>
                <Input id="confirm-password-settings" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
            </div>
            <Button onClick={() => void handleChangePassword()} disabled={changingPassword} className="w-fit">
              {changingPassword ? "Changing…" : "Change password"}
            </Button>
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Change email</p>
              <p className="text-xs text-muted-foreground">
                Current email: <span className="text-foreground">{user?.email}</span>. We'll send a confirmation link to your new address — your current email stays active and you'll keep signing in with it until you click that link.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="new-email">New email</Label>
                <Input id="new-email" type="email" autoComplete="email" placeholder="you@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              </div>
            </div>
            <Button onClick={() => void handleChangeEmail()} disabled={changingEmail} className="w-fit">
              {changingEmail ? "Sending…" : "Send confirmation to new email"}
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

      <Card className="border-[color:var(--color-loss)]/40">
        <CardHeader><CardTitle className="text-base text-[color:var(--color-loss)]">Danger zone</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Delete account</p>
              <p className="text-xs text-muted-foreground">Permanently deletes your account and every piece of data associated with it. This cannot be undone.</p>
            </div>
            <Button variant="destructive" disabled={deleteMut.isPending} onClick={() => setConfirmDeleteOpen(true)}>Delete account</Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete account"
        consequence="Permanently delete your account? This immediately and irreversibly erases your login, profile, cash balance, every stock and option position, your entire trade history, your AI agent and its history, your watchlist, and every other record tied to your account. There is no way to undo this or recover your data afterward."
        detail={
          <div className="space-y-1.5">
            <div className="flex justify-between"><span className="text-muted-foreground">Login &amp; profile</span><span className="font-medium">Deleted</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Cash, positions &amp; trade history</span><span className="font-medium">Deleted</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">AI agent &amp; its history</span><span className="font-medium">Deleted</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Watchlist</span><span className="font-medium">Deleted</span></div>
          </div>
        }
        requireTypedConfirmation="DELETE"
        confirmLabel="Permanently delete my account"
        variant="destructive"
        loading={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />

      <ConfirmDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        title="Reset paper account"
        consequence={`Reset your paper account back to a clean ${fmtUSD(STARTING_CASH)} start? This closes every stock and option position and clears your AI agent's holdings and settings. This cannot be undone.`}
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
