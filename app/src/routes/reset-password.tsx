// Landing page for Supabase's password-recovery email link
// (`resetPasswordForEmail`'s `redirectTo`, set to `${origin}/reset-password`
// in auth.tsx). Supabase's client (flowType: "pkce", detectSessionInUrl:
// true — lib/supabase/client.ts) auto-exchanges the `?code=` in the URL for
// a session on load and fires `PASSWORD_RECOVERY` via onAuthStateChange —
// THAT event, not just "is there a session", is the signal this page is in
// a legitimate recovery context (a stale bookmark to this URL with no code
// should never let someone set a password with no proof of email access).
//
// Expired/invalid links: Supabase's code-exchange fails silently from this
// page's point of view (no PASSWORD_RECOVERY event ever fires) — handled
// with a timeout that shows a clear "get a new link" state rather than an
// infinite spinner.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { friendlyError } from "./auth";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password · PaperTrader" },
      { name: "description", content: "Set a new password for your PaperTrader account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ResetPassword,
});

const MIN_PASSWORD_LENGTH = 8;

type LinkState = "checking" | "ready" | "invalid" | "done";

function ResetPassword() {
  const navigate = useNavigate();
  const [state, setState] = useState<LinkState>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const settledRef = useRef(false);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        settledRef.current = true;
        setState("ready");
      }
    });
    // Fallback: the PASSWORD_RECOVERY event can already have fired (and been
    // missed) if the code-exchange completed before this listener attached.
    // A genuine recovery session is still a real, current session — check it.
    supabase.auth.getSession().then(({ data }) => {
      if (settledRef.current) return;
      if (data.session) {
        settledRef.current = true;
        setState("ready");
      }
    });
    // MANUAL FALLBACK — confirmed necessary by live testing, not theoretical:
    // this client is configured with flowType:"pkce" (lib/supabase/client.ts),
    // and Supabase's actual recovery email link (the classic
    // `{{ .ConfirmationURL }}` template, delivered via the `/auth/v1/verify`
    // redirect) lands with the session in a `#access_token=&refresh_token=`
    // HASH fragment — the pre-PKCE "implicit" format — not a `?code=` query
    // param. supabase-js's own `detectSessionInUrl` under PKCE mode does NOT
    // reliably auto-process that hash shape (verified: with a real, valid,
    // freshly-issued recovery hash in the URL, detectSessionInUrl left
    // getSession() empty and fired no PASSWORD_RECOVERY event at all — yet
    // manually calling setSession() with the SAME tokens worked immediately).
    // Without this, every real user's password-reset link would land on
    // "invalid or expired" — parse the hash ourselves as a belt-and-suspenders.
    if (!settledRef.current) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const access_token = hashParams.get("access_token");
      const refresh_token = hashParams.get("refresh_token");
      if (access_token && refresh_token && hashParams.get("type") === "recovery") {
        supabase.auth.setSession({ access_token, refresh_token }).then(({ data, error }) => {
          if (settledRef.current) return;
          if (data.session && !error) {
            settledRef.current = true;
            setState("ready");
          }
        });
      }
    }
    // Give the code-exchange a bounded window; if nothing resolved it by
    // then, the link is genuinely bad (expired/already used/malformed).
    const timeout = setTimeout(() => {
      if (!settledRef.current) setState("invalid");
    }, 5000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit() {
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords don't match.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    setState("done");
    toast.success("Password updated");
  }

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-semibold">PaperTrader</span>
        </Link>

        {state === "checking" && (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Verifying your link…</h1>
            <p className="text-sm text-muted-foreground">One moment.</p>
          </div>
        )}

        {state === "invalid" && (
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">This link is invalid or expired</h1>
            <p className="text-sm text-muted-foreground">
              Password reset links only work once and expire after a while. Request a new one from the sign-in page.
            </p>
            <Button className="w-full" onClick={() => navigate({ to: "/auth" })}>
              Back to sign in
            </Button>
          </div>
        )}

        {state === "ready" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
            <p className="mt-1 text-sm text-muted-foreground">Choose a new password for your account.</p>
            <form onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }} className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat your new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={saving} className="w-full">
                {saving ? "Saving…" : "Set new password"}
              </Button>
            </form>
          </>
        )}

        {state === "done" && (
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">Password updated</h1>
            <p className="text-sm text-muted-foreground">You're signed in with your new password.</p>
            <Button className="w-full" onClick={() => navigate({ to: "/app/dashboard" })}>
              Go to your dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
