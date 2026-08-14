import { Link } from "@tanstack/react-router";

// Shared footer used on the public landing page, inside the authenticated
// app shell, and on the legal pages themselves — the one place Terms /
// Privacy / Disclaimer links live, so they can't drift out of sync.
export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
        <span>© {new Date().getFullYear()} My PaperTrader. Simulated trading only — no real money involved.</span>
        <nav className="flex items-center gap-4">
          <Link to="/terms" className="hover:text-foreground hover:underline">
            Terms
          </Link>
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            Privacy
          </Link>
          <Link to="/disclaimer" className="hover:text-foreground hover:underline">
            Disclaimer
          </Link>
        </nav>
      </div>
    </footer>
  );
}
