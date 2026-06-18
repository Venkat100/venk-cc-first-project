// Client entry point for the What-If Simulator. Unwraps the server function's
// { ok, error } envelope into value-or-throw. No auth required (public).

import { runSimulationFn, type SimResult } from "./functions";

export async function runSimulation(input: { symbol: string; date: string; amount: number }): Promise<SimResult> {
  const res = await runSimulationFn({
    data: { symbol: input.symbol.toUpperCase().trim(), date: input.date, amount: input.amount },
  });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { SimResult, SimPoint } from "./functions";
