import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SupportPanel } from "@/components/SupportPanel";
import { SiteFooter } from "@/components/SiteFooter";
import { useAuth } from "@/lib/auth/auth-context";
import { BrandIcon, BrandWordmark } from "@/components/Brand";

// PUBLIC route (NOT under /app) — usable while logged out, same pattern as
// simulator.tsx and the legal pages (terms/privacy/disclaimer): a
// self-contained header with an auth-aware CTA, no sidebar/topbar chrome.
// The logged-in version with full app chrome lives at /app/support
// (app.support.tsx) — both share this same SupportPanel content.
export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Support — My PaperTrader" },
      { name: "description", content: "Contact My PaperTrader support, find answers to common questions, and manage your account data." },
    ],
  }),
  component: PublicSupport,
});

function PublicSupport() {
  const { session } = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/" className="flex items-center gap-2">
            <BrandIcon size={32} />
            <BrandWordmark />
          </Link>
          <div className="flex items-center gap-2">
            {session ? (
              <Link to="/app/dashboard">
                <Button size="sm">Go to dashboard</Button>
              </Link>
            ) : (
              <>
                <Link to="/auth" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
                  Sign in
                </Link>
                <Link to="/auth">
                  <Button size="sm">Get started</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        <SupportPanel />
      </main>

      <SiteFooter />
    </div>
  );
}
