// Admin console — audit log (PLAN.md §6 step 10, B4). Read-only: every row
// here comes from admin_audit_log, which has no update/delete grant to any
// role, ever (0026_admin_console.sql) — there is no "clear log" button
// because there is no code path that could implement one.

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { getAuditLog } from "@/lib/admin/api";
import { ScrollText, Lock } from "lucide-react";

export const Route = createFileRoute("/app/admin/audit")({
  component: AdminAuditLogPage,
});

function prettyDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const ACTION_LABEL: Record<string, string> = {
  view_user: "Viewed user",
  suspend_user: "Suspended user",
  unsuspend_user: "Unsuspended user",
  delete_user: "Started deleting user",
  delete_user_completed: "Deleted user",
  delete_user_failed: "Failed to delete user",
};

function AdminAuditLogPage() {
  const logQ = useQuery({ queryKey: ["adminAuditLog"], queryFn: () => getAuditLog(200) });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Immutable — every admin action is logged here automatically and can never be edited or deleted.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          {logQ.isLoading ? (
            <LoadingState label="Loading audit log…" />
          ) : logQ.isError ? (
            <ErrorState message={(logQ.error as Error)?.message} />
          ) : (logQ.data ?? []).length === 0 ? (
            <EmptyState icon={ScrollText} title="No admin actions yet" description="Actions taken in this console will show up here." />
          ) : (
            <div className="divide-y divide-border/60">
              {logQ.data!.map((entry) => {
                // target_email is only populated when target_user_id was
                // still a valid auth.users row at write time — a post-delete
                // completion/failure row has no target left to look up, so
                // it falls back to detail.email (still captured, just not
                // in the indexed column — see lib/admin/functions.ts's
                // deleteUserFn).
                const displayEmail = entry.target_email ?? (typeof entry.detail?.email === "string" ? entry.detail.email : null);
                return (
                <div key={entry.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {ACTION_LABEL[entry.action] ?? entry.action}
                      {displayEmail && <span className="text-muted-foreground"> — {displayEmail}</span>}
                    </p>
                    <p className="tabular text-xs text-muted-foreground">{prettyDateTime(entry.created_at)}</p>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">by {entry.admin_email}</p>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
