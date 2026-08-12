// Scenario Challenges — layout route. Pure <Outlet/> shell so the picker
// (app.scenarios.index.tsx) and the run-detail page (app.scenarios.$runId.tsx)
// are siblings under it rather than the detail page nesting invisibly inside
// the picker's own JSX (TanStack Router's file-based routing makes $runId a
// child of this route purely by filename prefix — it needs an Outlet to render).

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/scenarios")({
  component: () => <Outlet />,
});
