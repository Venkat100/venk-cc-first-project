import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth/auth-context";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · PaperTrader" },
      { name: "description", content: "Sign in or create a paper trading account." },
    ],
  }),
  component: Auth,
});

// Turn Supabase's raw error text into something a human wants to read.
function friendlyError(message: string): string {
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
  return message;
}

function Auth() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);

  // Shared form state.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

  async function handleSignUp() {
    if (!email || !password) {
      toast.error("Enter your email and a password.");
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Stored in user_metadata; the handle_new_user DB trigger copies this
        // into profiles.display_name when the account is created.
        data: { display_name: name.trim() || null },
      },
    });
    setLoading(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    // If email confirmation is enabled, there's no session yet.
    if (data.session) {
      toast.success("Account created — $100,000 funded");
      navigate({ to: "/app/dashboard", replace: true });
    } else {
      toast.success("Account created — check your email to confirm, then sign in.");
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left brand panel */}
      <div className="relative hidden overflow-hidden border-r border-border bg-sidebar lg:flex lg:flex-col lg:justify-between p-10">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-semibold">PaperTrader</span>
        </Link>
        <div>
          <p className="text-2xl font-semibold leading-snug">
            "I tested 14 strategies before risking a dollar. PaperTrader made it click."
          </p>
          <p className="mt-3 text-sm text-muted-foreground">— a curious investor</p>
        </div>
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
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="font-semibold">PaperTrader</span>
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to PaperTrader</h1>
          <p className="mt-1 text-sm text-muted-foreground">Practice investing risk-free. Always.</p>

          <Tabs defaultValue="signin" className="mt-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value="signin" className="mt-4 space-y-4">
              <form
                onSubmit={(e) => { e.preventDefault(); void handleSignIn(); }}
                className="space-y-4"
              >
                <Field id="si-email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Field id="si-pass" label="Password" type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button type="submit" disabled={loading} className="w-full">{loading ? "Signing in…" : "Sign in"}</Button>
              </form>
            </TabsContent>
            <TabsContent value="signup" className="mt-4 space-y-4">
              <form
                onSubmit={(e) => { e.preventDefault(); void handleSignUp(); }}
                className="space-y-4"
              >
                <Field id="su-name" label="Full name" autoComplete="name" placeholder="Jane Trader" value={name} onChange={(e) => setName(e.target.value)} />
                <Field id="su-email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Field id="su-pass" label="Password" type="password" autoComplete="new-password" placeholder="Min 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button type="submit" disabled={loading} className="w-full">{loading ? "Creating account…" : "Create account"}</Button>
                <p className="text-center text-xs text-muted-foreground">
                  You'll start with $100,000 in virtual cash.
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
