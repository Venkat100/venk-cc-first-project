import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · PaperTrader" },
      { name: "description", content: "Sign in or create a paper trading account." },
    ],
  }),
  component: Auth,
});

function Auth() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  function handle(kind: "signin" | "signup") {
    setLoading(true);
    setTimeout(() => {
      toast.success(kind === "signin" ? "Welcome back" : "Account created — $100,000 funded");
      navigate({ to: "/app/dashboard" });
    }, 500);
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
              <Field id="si-email" label="Email" type="email" placeholder="you@example.com" />
              <Field id="si-pass" label="Password" type="password" placeholder="••••••••" />
              <Button onClick={() => handle("signin")} disabled={loading} className="w-full">Sign in</Button>
            </TabsContent>
            <TabsContent value="signup" className="mt-4 space-y-4">
              <Field id="su-name" label="Full name" placeholder="Jane Trader" />
              <Field id="su-email" label="Email" type="email" placeholder="you@example.com" />
              <Field id="su-pass" label="Password" type="password" placeholder="Min 8 characters" />
              <Button onClick={() => handle("signup")} disabled={loading} className="w-full">Create account</Button>
              <p className="text-center text-xs text-muted-foreground">
                You'll start with $100,000 in virtual cash.
              </p>
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
