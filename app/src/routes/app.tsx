import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TopBar, MobileNavOverlay } from "@/components/TopBar";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
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
          { to: "/app/portfolio", label: "Portfolio" },
          { to: "/app/watchlist", label: "Watchlist" },
          { to: "/app/settings", label: "Settings" },
        ]}
      />
    </div>
  );
}
