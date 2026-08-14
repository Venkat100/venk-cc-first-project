import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/LegalPage";
import privacyContent from "../../../legal/privacy.md?raw";

// PUBLIC route (NOT under /app) — usable while logged out. Content is
// sourced directly from legal/privacy.md via Vite's ?raw import, so editing
// the doc is the only thing needed to update this page.
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — My PaperTrader" },
      { name: "description", content: "My PaperTrader's Privacy Policy." },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return <LegalPage content={privacyContent} />;
}
