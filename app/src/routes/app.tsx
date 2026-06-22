import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { TopBar, MobileNavOverlay } from "@/components/TopBar";
import { useAuth } from "@/lib/auth/auth-context";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Once the initial session check is done and there's no session, bounce
    // to the login screen. Done client-side because the Supabase session
    // lives in the browser (localStorage), not on the SSR server.
    if (!loading && !session) {
      navigate({ to: "/auth", replace: true });
    }
  }, [loading, session, navigate]);

  if (loading || !session) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {loading ? "Loading your account…" : "Redirecting to sign in…"}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <AuthGate>
      <div className="flex min-h-screen w-full bg-background text-foreground">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onOpenMobileNav={() => setMobileOpen(true)} />
          <main className="flex-1 px-4 py-6 md:px-8">
            <Outlet />
          </main>
        </div>
        <MobileNavOverlay
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          items={[
            { to: "/app/dashboard", label: "Dashboard" },
            { to: "/app/markets", label: "Markets" },
            { to: "/app/simulator", label: "Simulator" },
            { to: "/app/agent", label: "AI Agent" },
            { to: "/app/portfolio", label: "Portfolio" },
            { to: "/app/watchlist", label: "Watchlist" },
            { to: "/app/settings", label: "Settings" },
          ]}
        />
      </div>
    </AuthGate>
  );
}
