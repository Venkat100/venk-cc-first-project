import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/LegalPage";
import termsContent from "../../../legal/terms.md?raw";

// PUBLIC route (NOT under /app) — usable while logged out. Content is
// sourced directly from legal/terms.md via Vite's ?raw import, so editing
// the doc is the only thing needed to update this page.
export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — My PaperTrader" },
      { name: "description", content: "My PaperTrader's Terms of Service." },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return <LegalPage content={termsContent} />;
}
