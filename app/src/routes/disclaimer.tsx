import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/LegalPage";
import disclaimerContent from "../../../legal/disclaimer.md?raw";

// PUBLIC route (NOT under /app) — usable while logged out. Content is
// sourced directly from legal/disclaimer.md via Vite's ?raw import, so
// editing the doc is the only thing needed to update this page.
export const Route = createFileRoute("/disclaimer")({
  head: () => ({
    meta: [
      { title: "Risk & Educational Disclaimer — PaperTrader" },
      { name: "description", content: "PaperTrader's Risk & Educational Disclaimer." },
    ],
  }),
  component: DisclaimerPage,
});

function DisclaimerPage() {
  return <LegalPage content={disclaimerContent} />;
}
