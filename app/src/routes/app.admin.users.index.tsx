// Admin console — user list/search (PLAN.md §6 step 10, B4).

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInputBox } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { listUsers } from "@/lib/admin/api";
import { fmtUSD } from "@/lib/mockData";
import { formatInstantDate } from "@/lib/format/datetime";
import { Users as UsersIcon } from "lucide-react";

export const Route = createFileRoute("/app/admin/users/")({
  component: AdminUsersListPage,
});

const prettyDate = formatInstantDate;

function AdminUsersListPage() {
  const [query, setQuery] = useState("");
  const usersQ = useQuery({ queryKey: ["adminUsers"], queryFn: () => listUsers() });

  const filtered = (usersQ.data ?? []).filter((u) => !query.trim() || u.email.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <SearchInputBox containerClassName="max-w-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by email…" />

      <Card>
        <CardContent className="p-0">
          {usersQ.isLoading ? (
            <LoadingState label="Loading users…" />
          ) : usersQ.isError ? (
            <ErrorState message={(usersQ.error as Error)?.message} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No users found" description="Try a different search." />
          ) : (
            <div className="divide-y divide-border/60">
              {filtered.map((u) => (
                <Link
                  key={u.id}
                  to="/app/admin/users/$userId"
                  params={{ userId: u.id }}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-accent/40"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-medium">
                      {u.email}
                      {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                      {u.suspendedAt && <Badge variant="destructive">Suspended</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Signed up {prettyDate(u.signupAt)} · Last sign-in {u.lastSignInAt ? prettyDate(u.lastSignInAt) : "never"}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-muted-foreground">{fmtUSD(u.cashBalance)}</p>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
