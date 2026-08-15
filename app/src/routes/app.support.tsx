import { createFileRoute } from "@tanstack/react-router";
import { SupportPanel } from "@/components/SupportPanel";

export const Route = createFileRoute("/app/support")({
  head: () => ({ meta: [{ title: "Support · My PaperTrader" }] }),
  component: SupportPanel,
});
