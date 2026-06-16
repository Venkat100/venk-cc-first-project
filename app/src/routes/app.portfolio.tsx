import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HOLDINGS, TRANSACTIONS, getStock, fmtUSD, fmtPct } from "@/lib/mockData";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/portfolio")({
  head: () => ({ meta: [{ title: "Portfolio · PaperTrader" }] }),
  component: Portfolio,
});

const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)", "var(--color-primary)"];

function Portfolio() {
  const byStock = useMemo(() => HOLDINGS.map((h) => {
    const s = getStock(h.symbol)!;
    return { name: h.symbol, value: +(s.price * h.shares).toFixed(2) };
  }), []);

  const bySector = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of HOLDINGS) {
      const s = getStock(h.symbol)!;
      map.set(s.sector, (map.get(s.sector) ?? 0) + s.price * h.shares);
    }
    return Array.from(map, ([name, value]) => ({ name, value: +value.toFixed(2) }));
  }, []);

  const [page, setPage] = useState(1);
  const pageSize = 8;
  const totalPages = Math.ceil(TRANSACTIONS.length / pageSize);
  const txPage = [...TRANSACTIONS].sort((a, b) => b.date.localeCompare(a.date)).slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio & Activity</h1>
        <p className="text-sm text-muted-foreground">Allocation breakdown and full transaction history.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DonutCard title="Allocation by stock" data={byStock} />
        <DonutCard title="Allocation by sector" data={bySector} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Holdings detail</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="py-3 font-medium">Sector</th>
                <th className="py-3 font-medium text-right">Shares</th>
                <th className="py-3 font-medium text-right">Avg cost</th>
                <th className="py-3 font-medium text-right">Price</th>
                <th className="py-3 font-medium text-right">Market value</th>
                <th className="px-4 py-3 font-medium text-right">P&L</th>
              </tr>
            </thead>
            <tbody>
              {HOLDINGS.map((h) => {
                const s = getStock(h.symbol)!;
                const mv = s.price * h.shares;
                const pl = (s.price - h.avgCost) * h.shares;
                const up = pl >= 0;
                return (
                  <tr key={h.symbol} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3 font-semibold">{s.symbol}</td>
                    <td className="py-3 text-xs text-muted-foreground">{s.sector}</td>
                    <td className="py-3 text-right tabular">{h.shares}</td>
                    <td className="py-3 text-right tabular">{fmtUSD(h.avgCost)}</td>
                    <td className="py-3 text-right tabular">{fmtUSD(s.price)}</td>
                    <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                    <td className={cn("px-4 py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                      {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="text-xs opacity-80">({fmtPct(((s.price - h.avgCost) / h.avgCost) * 100)})</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Transaction history</CardTitle>
            <span className="text-xs text-muted-foreground">{TRANSACTIONS.length} transactions</span>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="py-3 font-medium">Type</th>
                <th className="py-3 font-medium">Symbol</th>
                <th className="py-3 font-medium text-right">Qty</th>
                <th className="py-3 font-medium text-right">Price</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {txPage.map((t) => (
                <tr key={t.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-3 tabular text-muted-foreground">{new Date(t.date).toLocaleDateString()}</td>
                  <td className="py-3">
                    <span className={cn(
                      "rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wider",
                      t.type === "buy"
                        ? "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]"
                        : "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]",
                    )}>{t.type}</span>
                  </td>
                  <td className="py-3 font-semibold">{t.symbol}</td>
                  <td className="py-3 text-right tabular">{t.qty}</td>
                  <td className="py-3 text-right tabular">{fmtUSD(t.price)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUSD(t.price * t.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <span>Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Prev</button>
              <button disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Next</button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DonutCard({ title, data }: { title: string; data: { name: string; value: number }[] }) {
  const total = data.reduce((a, b) => a + b.value, 0);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="h-[260px]">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2} stroke="var(--color-background)">
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip
                contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                formatter={(v: number, n) => [`${fmtUSD(v)} (${((v / total) * 100).toFixed(1)}%)`, n as string]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
