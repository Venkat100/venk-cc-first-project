import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthFeatureShowcase } from "@/components/AuthFeatureShowcase";
import { BrandIcon, BrandWordmark } from "@/components/Brand";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth/auth-context";

// Bumped whenever legal/terms.md or legal/privacy.md materially changes, so
// profiles.terms_version records exactly which wording a user agreed to.
// Matches the drafts' "Last updated" date.
export const LEGAL_VERSION = "2026-08-09";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · My PaperTrader" },
      { name: "description", content: "Sign in or create a paper trading account." },
    ],
  }),
  component: Auth,
});

// Turn Supabase's raw error text into something a human wants to read.
// Exported so /reset-password (and other auth-adjacent pages) share the
// exact same phrasing rather than drifting.
export function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Wrong email or password.";
  if (m.includes("already registered") || m.includes("already been registered"))
    return "That email is already registered — try signing in instead.";
  if (m.includes("password should be at least"))
    return "Password is too short — use at least 6 characters.";
  if (m.includes("unable to validate email") || m.includes("invalid email"))
    return "That doesn't look like a valid email address.";
  if (m.includes("email not confirmed"))
    return "Please confirm your email first — check your inbox.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Please wait a moment and try again.";
  if (m.includes("terms_not_accepted"))
    return "Please accept the Terms of Service and Privacy Policy to create an account.";
  return message;
}

function Auth() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  // Shared form state.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  // If already signed in, don't show the form — go to the dashboard.
  useEffect(() => {
    if (!authLoading && session) {
      navigate({ to: "/app/dashboard", replace: true });
    }
  }, [authLoading, session, navigate]);

  async function handleSignIn() {
    if (!email || !password) {
      toast.error("Enter your email and password.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    toast.success("Welcome back");
    navigate({ to: "/app/dashboard", replace: true });
  }

  async function handleForgotPassword() {
    if (!email) {
      toast.error("Enter your email first.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    // Supabase itself doesn't reveal whether the email is registered (an
    // anti-enumeration protection) — errors here are real problems (rate
    // limit, malformed address), never "no such account".
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    setForgotSent(true);
  }

  async function handleSignUp() {
    if (!email || !password) {
      toast.error("Enter your email and a password.");
      return;
    }
    if (!termsAccepted) {
      toast.error("You must accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Stored in user_metadata; the handle_new_user DB trigger copies this
        // into profiles.display_name when the account is created, and REQUIRES
        // terms_accepted_version (raises and aborts the signup if missing) —
        // a data-integrity guarantee that no profile can exist without a
        // consent record, not a security control (see 0022_terms_acceptance.sql).
        data: { display_name: name.trim() || null, terms_accepted_version: LEGAL_VERSION },
      },
    });
    setLoading(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    // If email confirmation is enabled, there's no session yet.
    if (data.session) {
      toast.success("Account created — $25,000 funded");
      navigate({ to: "/app/dashboard", replace: true });
    } else {
      toast.success("Account created — check your email to confirm, then sign in.");
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left brand panel */}
      {/* `overflow-clip`, not `overflow-hidden` (2026-08-15 graphic-pass fix):
         the decorative gradient glow below is deliberately positioned
         `-bottom-32 -right-32`, spilling past the panel's own box on purpose
         — with `overflow-hidden` that still makes the panel a genuine
         scroll container (scrollHeight > clientHeight), and focusing a dot
         button (real click OR keyboard Tab) triggers the browser's default
         scroll-into-view on that container, silently shifting scrollTop and
         clipping the logo off the top. `overflow-clip` clips identically but
         never creates a scroll container in the first place — immune to
         this regardless of how tall any future content here gets. */}
      <div className="relative hidden overflow-clip border-r border-border bg-sidebar lg:flex lg:flex-col p-10">
        {/* Absolutely positioned, out of flow, so AuthFeatureShowcase's
           flex-1 below centers against the FULL panel height rather than
           just the space left over after the logo's flex row (2026-08-15
           follow-up — centering the showcase, not leaving it bottom-left). */}
        <Link to="/" className="absolute left-10 top-10 z-10 flex items-center gap-2">
          <BrandIcon size={36} />
          <BrandWordmark />
        </Link>
        {/* Was a fabricated testimonial ("a curious investor") — this
           product is careful about honesty everywhere else (no invented
           AI cost numbers, no fake analyst price targets, real Top Movers
           data, etc.), so a made-up quote here was inconsistent with that.
           Removed rather than "transparently reframed" — a labeled-fake
           quote still isn't worth the space a real feature tour earns
           instead (2026-08-15). */}
        <AuthFeatureShowcase />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full opacity-30"
          style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--color-primary) 60%, transparent), transparent 70%)" }}
        />
      </div>

      {/* Right form panel */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-6 flex items-center gap-2 lg:hidden">
            <BrandIcon size={32} />
            <BrandWordmark />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to My PaperTrader</h1>
          <p className="mt-1 text-sm text-muted-foreground">Practice investing risk-free. Always.</p>

          <Tabs defaultValue="signin" className="mt-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value="signin" className="mt-4 space-y-4">
              {forgotMode ? (
                forgotSent ? (
                  <div className="space-y-4 text-sm">
                    <p className="text-foreground">
                      If an account exists for <span className="font-medium">{email}</span>, we've sent a password reset link. Check your inbox (and spam folder) — the link expires after a while, so use it soon.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => { setForgotMode(false); setForgotSent(false); }}
                    >
                      Back to sign in
                    </Button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => { e.preventDefault(); void handleForgotPassword(); }}
                    className="space-y-4"
                  >
                    <p className="text-sm text-muted-foreground">Enter your email and we'll send you a link to reset your password.</p>
                    <Field id="fp-email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <Button type="submit" disabled={loading} className="w-full">{loading ? "Sending…" : "Send reset link"}</Button>
                    <button
                      type="button"
                      onClick={() => setForgotMode(false)}
                      className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Back to sign in
                    </button>
                  </form>
                )
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); void handleSignIn(); }}
                  className="space-y-4"
                >
                  <Field id="si-email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <Field id="si-pass" label="Password" type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button
                    type="button"
                    onClick={() => setForgotMode(true)}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Forgot password?
                  </button>
                  <Button type="submit" disabled={loading} className="w-full">{loading ? "Signing in…" : "Sign in"}</Button>
                </form>
              )}
            </TabsContent>
            <TabsContent value="signup" className="mt-4 space-y-4">
              <form
                onSubmit={(e) => { e.preventDefault(); void handleSignUp(); }}
                className="space-y-4"
              >
                <Field id="su-name" label="Full name" autoComplete="name" placeholder="Jane Trader" value={name} onChange={(e) => setName(e.target.value)} />
                <Field id="su-email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Field id="su-pass" label="Password" type="password" autoComplete="new-password" placeholder="Min 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="su-terms"
                    checked={termsAccepted}
                    onCheckedChange={(checked) => setTermsAccepted(checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="su-terms" className="cursor-pointer text-xs font-normal leading-relaxed text-muted-foreground">
                    I agree to the{" "}
                    <Link to="/terms" target="_blank" className="text-foreground underline underline-offset-2 hover:opacity-80">
                      Terms of Service
                    </Link>{" "}
                    and{" "}
                    <Link to="/privacy" target="_blank" className="text-foreground underline underline-offset-2 hover:opacity-80">
                      Privacy Policy
                    </Link>
                    , and I understand My PaperTrader is an educational simulation, not financial advice.
                  </Label>
                </div>
                <Button type="submit" disabled={loading || !termsAccepted} className="w-full">{loading ? "Creating account…" : "Create account"}</Button>
                <p className="text-center text-xs text-muted-foreground">
                  You'll start with $25,000 in virtual cash.
                </p>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function Field({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...rest} />
    </div>
  );
}
