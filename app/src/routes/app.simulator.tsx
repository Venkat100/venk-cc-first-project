import { createFileRoute } from "@tanstack/react-router";
import { SimulatorPanel } from "@/components/SimulatorPanel";

export const Route = createFileRoute("/app/simulator")({
  head: () => ({ meta: [{ title: "What-If Simulator · PaperTrader" }] }),
  component: () => <SimulatorPanel />,
});
