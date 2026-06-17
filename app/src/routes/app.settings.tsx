import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { STARTING_CASH, fmtUSD } from "@/lib/mockData";
import { applyTheme, getTheme } from "@/lib/theme";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth/auth-context";
import { toast } from "sonner";

export const Route = createFileRoute("/app/settings")({
  head: () => ({ meta: [{ title: "Settings · PaperTrader" }] }),
  component: Settings,
});

function Settings() {
  const [dark, setDark] = useState(true);
  useEffect(() => { setDark(getTheme() === "dark"); }, []);

  const navigate = useNavigate();
  const { user, profile, signOut, refreshProfile } = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

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
              <p className="text-xs text-muted-foreground">Clears all positions and resets virtual balance to {fmtUSD(STARTING_CASH)}.</p>
            </div>
            <Button variant="destructive" onClick={() => toast.success("Paper account reset to $100,000")}>Reset account</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
