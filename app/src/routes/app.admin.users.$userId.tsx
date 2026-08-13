// Admin console — single-user detail (PLAN.md §6 step 10, B4). Every field
// shown here comes from getUserDetailFn (lib/admin/functions.ts), which
// itself never queries journal_entries — deliberately, structurally: it
// has no service_role grant (0023_journal.sql). This page shows a static
// note instead of any journal content or count.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { getUserDetail, setUserSuspended, deleteUser } from "@/lib/admin/api";
import { fmtUSD } from "@/lib/mockData";
import { toast } from "sonner";
import { ShieldOff, ShieldCheck, Trash2, Lock, BookLock } from "lucide-react";

export const Route = createFileRoute("/app/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function prettyDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </div>
  );
}

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const userQ = useQuery({ queryKey: ["adminUserDetail", userId], queryFn: () => getUserDetail(userId) });

  const [confirmSuspendOpen, setConfirmSuspendOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const suspendMut = useMutation({
    mutationFn: (suspended: boolean) => setUserSuspended(userId, suspended),
    onSuccess: async (_res, suspended) => {
      await qc.invalidateQueries({ queryKey: ["adminUserDetail", userId] });
      await qc.invalidateQueries({ queryKey: ["adminUsers"] });
      setConfirmSuspendOpen(false);
      toast.success(suspended ? "User suspended" : "User unsuspended");
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't update suspension.");
      setConfirmSuspendOpen(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteUser(userId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["adminUsers"] });
      toast.success("Account deleted");
      navigate({ to: "/app/admin/users" });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't delete that account.");
      setConfirmDeleteOpen(false);
    },
  });

  if (userQ.isLoading) return <div className="py-16"><LoadingState label="Loading user…" /></div>;
  if (userQ.isError || !userQ.data) return <div className="py-16"><ErrorState message={(userQ.error as Error)?.message} /></div>;

  const u = userQ.data;
  const isSuspended = u.suspendedAt != null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {u.email}
            {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
            {isSuspended && <Badge variant="destructive">Suspended</Badge>}
          </h2>
          <p className="text-sm text-muted-foreground">Signed up {prettyDate(u.signupAt)} · Last sign-in {prettyDate(u.lastSignInAt)}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={isSuspended ? "default" : "outline"}
            className="gap-2"
            onClick={() => setConfirmSuspendOpen(true)}
          >
            {isSuspended ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
            {isSuspended ? "Unsuspend" : "Suspend"}
          </Button>
          <Button variant="destructive" className="gap-2" onClick={() => setConfirmDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" /> Delete account
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Account</CardTitle></CardHeader>
          <CardContent className="divide-y divide-border/40">
            <Row label="Cash balance" value={fmtUSD(u.cashBalance)} />
            <Row label="Starting capital" value={fmtUSD(u.startingCapital)} />
            <Row label="Holdings" value={`${u.holdingsCount} (${fmtUSD(u.holdingsCostBasisValue)} cost basis)`} />
            <Row label="Trades placed" value={u.transactionCount} />
            <Row label="Option positions" value={u.optionPositionsCount} />
            <Row label="Option trades" value={u.optionTransactionCount} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Margin & agent</CardTitle></CardHeader>
          <CardContent className="divide-y divide-border/40">
            <Row label="Margin" value={u.marginEnabled ? `Enabled — ${fmtUSD(u.marginLoan)} loan (${u.marginStatus})` : "Off"} />
            <Row label="AI agent" value={u.agentEnabled ? `Enabled — ${u.agentCash != null ? fmtUSD(u.agentCash) : "—"} cash, ${u.agentHoldingsCount} holdings` : "Off"} />
            <Row label="Scenario runs" value={`${u.scenarioRunsActive} active, ${u.scenarioRunsCompleted} completed`} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Compliance & unlocks</CardTitle></CardHeader>
          <CardContent className="divide-y divide-border/40">
            <Row label="Terms accepted" value={u.termsAcceptedAt ? `${prettyDate(u.termsAcceptedAt)} (v${u.termsVersion})` : "Not recorded"} />
            <Row label="Options unlocked" value={prettyDate(u.optionsUnlockedAt)} />
            <Row label="Margin unlocked" value={prettyDate(u.marginUnlockedAt)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex-row items-center gap-2"><BookLock className="h-4 w-4 text-muted-foreground" /><CardTitle className="text-base">Journal</CardTitle></CardHeader>
          <CardContent>
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              Journal entries are private and not visible in this console, by design — the database itself has no
              access path to them, not just a UI choice.
            </p>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmSuspendOpen}
        onOpenChange={setConfirmSuspendOpen}
        title={isSuspended ? "Unsuspend this account?" : "Suspend this account?"}
        consequence={
          isSuspended
            ? `${u.email} will be able to sign in again.`
            : `${u.email} will be blocked from signing in (and any active session will stop working within about an hour).`
        }
        confirmLabel={isSuspended ? "Unsuspend" : "Suspend"}
        variant={isSuspended ? "default" : "destructive"}
        loading={suspendMut.isPending}
        onConfirm={() => suspendMut.mutate(!isSuspended)}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete this account?"
        consequence={`This permanently deletes ${u.email} and every row tied to it — holdings, trades, options, margin history, agent data, scenario runs, journal entries, everything. This cannot be undone.`}
        confirmLabel="Delete account"
        variant="destructive"
        requireTypedConfirmation="DELETE"
        loading={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </div>
  );
}
