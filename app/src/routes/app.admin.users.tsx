// Pure Outlet layout so app.admin.users.index.tsx (the list) and
// app.admin.users.$userId.tsx (the detail page) are siblings under it —
// same reason app.scenarios.tsx is a thin layout (PLAN.md §6 step 9).

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/admin/users")({
  component: () => <Outlet />,
});
