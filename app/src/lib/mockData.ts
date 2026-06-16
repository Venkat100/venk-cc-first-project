// Mock data for PaperTrader. Swap to real APIs later.

export type Stock = {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  dayChange: number;
  dayChangePct: number;
  marketCap: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  week52High: number;
  week52Low: number;
  about: string;
};

export type PricePoint = { t: string; price: number };

export type Holding = {
  symbol: string;
  shares: number;
  avgCost: number;
};

export type Transaction = {
  id: string;
  date: string;
  type: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
};

export const STARTING_CASH = 100000;

export const STOCKS: Stock[] = [
  { symbol: "AAPL", name: "Apple Inc.", sector: "Technology", price: 228.42, dayChange: 2.31, dayChangePct: 1.02, marketCap: 3.45e12, open: 226.5, high: 229.1, low: 225.8, volume: 54_321_000, week52High: 237.49, week52Low: 164.08, about: "Designs, manufactures and sells smartphones, personal computers, tablets, wearables and accessories." },
  { symbol: "TSLA", name: "Tesla, Inc.", sector: "Consumer Cyclical", price: 248.71, dayChange: -4.12, dayChangePct: -1.63, marketCap: 7.92e11, open: 252.0, high: 253.4, low: 247.2, volume: 91_204_000, week52High: 299.29, week52Low: 138.80, about: "Designs, develops, manufactures, leases, and sells electric vehicles, and energy generation and storage systems." },
  { symbol: "NVDA", name: "NVIDIA Corporation", sector: "Technology", price: 138.07, dayChange: 3.45, dayChangePct: 2.56, marketCap: 3.39e12, open: 135.2, high: 139.1, low: 134.8, volume: 248_900_000, week52High: 153.13, week52Low: 39.23, about: "Designs graphics processing units (GPUs) for gaming and professional markets, and system on a chip units for the mobile computing and automotive market." },
  { symbol: "MSFT", name: "Microsoft Corporation", sector: "Technology", price: 425.18, dayChange: 1.92, dayChangePct: 0.45, marketCap: 3.16e12, open: 424.0, high: 427.2, low: 422.1, volume: 18_211_000, week52High: 468.35, week52Low: 309.45, about: "Develops, licenses, and supports software, services, devices, and solutions worldwide." },
  { symbol: "AMZN", name: "Amazon.com, Inc.", sector: "Consumer Cyclical", price: 192.55, dayChange: -0.82, dayChangePct: -0.42, marketCap: 2.02e12, open: 193.4, high: 194.0, low: 191.5, volume: 32_011_000, week52High: 201.20, week52Low: 118.35, about: "Engages in the retail sale of consumer products and subscriptions in North America and internationally." },
  { symbol: "GOOGL", name: "Alphabet Inc.", sector: "Communication Services", price: 167.32, dayChange: 0.91, dayChangePct: 0.55, marketCap: 2.05e12, open: 166.5, high: 168.1, low: 166.0, volume: 21_445_000, week52High: 191.75, week52Low: 121.46, about: "Provides various products and platforms in the United States, Europe, the Middle East, Africa, Asia-Pacific, Canada, and Latin America." },
  { symbol: "META", name: "Meta Platforms, Inc.", sector: "Communication Services", price: 568.31, dayChange: 5.22, dayChangePct: 0.93, marketCap: 1.44e12, open: 564.0, high: 570.0, low: 561.0, volume: 13_021_000, week52High: 602.95, week52Low: 274.38, about: "Builds technologies that help people connect, find communities, and grow businesses." },
  { symbol: "AMD",  name: "Advanced Micro Devices", sector: "Technology", price: 162.18, dayChange: -1.45, dayChangePct: -0.89, marketCap: 2.62e11, open: 163.5, high: 164.9, low: 161.0, volume: 38_440_000, week52High: 227.30, week52Low: 93.12, about: "Operates as a semiconductor company worldwide." },
  { symbol: "NFLX", name: "Netflix, Inc.", sector: "Communication Services", price: 712.45, dayChange: 8.12, dayChangePct: 1.15, marketCap: 3.06e11, open: 705.0, high: 714.2, low: 703.5, volume: 4_321_000, week52High: 736.42, week52Low: 414.65, about: "Provides entertainment services with TV series, documentaries, feature films, and mobile games across genres and languages." },
  { symbol: "JPM",  name: "JPMorgan Chase & Co.", sector: "Financial Services", price: 218.65, dayChange: 1.04, dayChangePct: 0.48, marketCap: 6.16e11, open: 217.5, high: 219.2, low: 216.9, volume: 8_900_000, week52High: 225.48, week52Low: 144.10, about: "Operates as a financial services company worldwide." },
];

export function getStock(symbol: string): Stock | undefined {
  return STOCKS.find((s) => s.symbol === symbol.toUpperCase());
}

// Deterministic pseudo-random for stable mock charts
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromSymbol(sym: string) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
  return h || 1;
}

export type Range = "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";

export function generateHistory(symbol: string, range: Range, endPrice?: number): PricePoint[] {
  const stock = getStock(symbol);
  const final = endPrice ?? stock?.price ?? 100;
  const cfg: Record<Range, { points: number; days: number; vol: number }> = {
    "1D": { points: 78, days: 1, vol: 0.004 },
    "1W": { points: 60, days: 7, vol: 0.012 },
    "1M": { points: 30, days: 30, vol: 0.02 },
    "3M": { points: 65, days: 90, vol: 0.035 },
    "1Y": { points: 120, days: 365, vol: 0.07 },
    "ALL": { points: 200, days: 365 * 5, vol: 0.18 },
  };
  const { points, days, vol } = cfg[range];
  const rand = mulberry32(seedFromSymbol(symbol + range));
  // Random walk back from final price
  const prices: number[] = new Array(points);
  prices[points - 1] = final;
  for (let i = points - 2; i >= 0; i--) {
    const step = (rand() - 0.5) * 2 * vol * final * 0.08;
    prices[i] = Math.max(1, prices[i + 1] - step);
  }
  // slight drift
  const start = prices[0];
  const driftTarget = final * (1 - (rand() * 0.4 - 0.1));
  const driftDelta = (driftTarget - start) / points;
  for (let i = 0; i < points; i++) prices[i] = Math.max(1, prices[i] + driftDelta * i * 0.2);
  prices[points - 1] = final;

  const now = Date.now();
  const stepMs = (days * 86400_000) / points;
  return prices.map((price, i) => ({
    t: new Date(now - (points - 1 - i) * stepMs).toISOString(),
    price: +price.toFixed(2),
  }));
}

export function sparkline(symbol: string, n = 24): number[] {
  const stock = getStock(symbol);
  const final = stock?.price ?? 100;
  const rand = mulberry32(seedFromSymbol(symbol + "spark"));
  const out: number[] = [];
  let p = final * (1 - (rand() - 0.5) * 0.08);
  for (let i = 0; i < n; i++) {
    p += (rand() - 0.5) * final * 0.01;
    out.push(+p.toFixed(2));
  }
  out[n - 1] = final;
  return out;
}

export const HOLDINGS: Holding[] = [
  { symbol: "AAPL", shares: 25, avgCost: 182.10 },
  { symbol: "NVDA", shares: 60, avgCost: 95.40 },
  { symbol: "MSFT", shares: 12, avgCost: 388.75 },
  { symbol: "TSLA", shares: 18, avgCost: 265.20 },
  { symbol: "AMZN", shares: 30, avgCost: 168.90 },
];

export const WATCHLIST: string[] = ["GOOGL", "META", "AMD", "NFLX"];

export const TRANSACTIONS: Transaction[] = [
  { id: "t1", date: "2025-05-12", type: "buy",  symbol: "AAPL", qty: 10, price: 175.20 },
  { id: "t2", date: "2025-05-14", type: "buy",  symbol: "NVDA", qty: 30, price: 88.10 },
  { id: "t3", date: "2025-06-02", type: "buy",  symbol: "MSFT", qty: 12, price: 388.75 },
  { id: "t4", date: "2025-06-18", type: "buy",  symbol: "AAPL", qty: 15, price: 186.50 },
  { id: "t5", date: "2025-07-08", type: "buy",  symbol: "TSLA", qty: 25, price: 248.30 },
  { id: "t6", date: "2025-07-21", type: "sell", symbol: "TSLA", qty: 7,  price: 282.10 },
  { id: "t7", date: "2025-08-15", type: "buy",  symbol: "NVDA", qty: 30, price: 102.70 },
  { id: "t8", date: "2025-09-03", type: "buy",  symbol: "AMZN", qty: 30, price: 168.90 },
  { id: "t9", date: "2026-01-22", type: "sell", symbol: "GOOGL", qty: 10, price: 152.40 },
  { id: "t10", date: "2026-02-14", type: "buy", symbol: "META", qty: 5,  price: 482.10 },
  { id: "t11", date: "2026-03-30", type: "buy", symbol: "AMD",  qty: 20, price: 158.20 },
  { id: "t12", date: "2026-04-19", type: "sell", symbol: "META", qty: 5,  price: 525.00 },
];

export function holdingsValue() {
  return HOLDINGS.reduce((sum, h) => {
    const s = getStock(h.symbol);
    return sum + (s?.price ?? 0) * h.shares;
  }, 0);
}

export function holdingsCost() {
  return HOLDINGS.reduce((sum, h) => sum + h.avgCost * h.shares, 0);
}

export const CASH = 32_410.55;

export function portfolioValue() {
  return holdingsValue() + CASH;
}

export function todaysChange() {
  // sum of (dayChange * shares) for holdings
  let abs = 0;
  let baseline = 0;
  for (const h of HOLDINGS) {
    const s = getStock(h.symbol);
    if (!s) continue;
    abs += s.dayChange * h.shares;
    baseline += (s.price - s.dayChange) * h.shares;
  }
  return { abs, pct: baseline > 0 ? (abs / baseline) * 100 : 0 };
}

export function totalReturn() {
  const val = holdingsValue();
  const cost = holdingsCost();
  return { abs: val - cost, pct: cost > 0 ? ((val - cost) / cost) * 100 : 0 };
}

export function topMovers() {
  return [...STOCKS].sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct)).slice(0, 5);
}

export function fmtUSD(n: number, opts: Intl.NumberFormatOptions = {}) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, ...opts });
}

export function fmtCompact(n: number) {
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function fmtPct(n: number, digits = 2) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtSigned(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${fmtUSD(Math.abs(n))}`;
}

// What-if helper: simulate $amount invested at past date in symbol
export function whatIf(symbol: string, startDate: Date, amount: number) {
  const stock = getStock(symbol);
  if (!stock) return null;
  const rand = mulberry32(seedFromSymbol(symbol + "wi" + startDate.getTime()));
  const days = Math.max(7, Math.round((Date.now() - startDate.getTime()) / 86400_000));
  const points = Math.min(180, Math.max(30, Math.round(days / 7)));
  // Pick a believable historical price (back-walk from current)
  const drift = 1 + (rand() - 0.2) * 1.4; // current vs historical multiplier
  const startPrice = +(stock.price / drift).toFixed(2);
  const shares = amount / startPrice;
  const stepMs = (days * 86400_000) / points;
  const series: { t: string; stock: number; sp500: number }[] = [];
  let p = startPrice;
  let sp = 1; // index relative
  const stockTarget = stock.price;
  const spTarget = 1 + (rand() * 0.5 + 0.05) * (days / 365);
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1);
    const noise = (rand() - 0.5) * 0.04;
    p = startPrice + (stockTarget - startPrice) * frac + p * noise * 0.5;
    sp = 1 + (spTarget - 1) * frac + sp * noise * 0.2;
    series.push({
      t: new Date(startDate.getTime() + i * stepMs).toISOString(),
      stock: +(shares * Math.max(1, p)).toFixed(2),
      sp500: +(amount * Math.max(0.5, sp)).toFixed(2),
    });
  }
  // pin endpoints
  series[0] = { t: startDate.toISOString(), stock: amount, sp500: amount };
  series[series.length - 1] = {
    t: new Date().toISOString(),
    stock: +(shares * stockTarget).toFixed(2),
    sp500: +(amount * spTarget).toFixed(2),
  };
  const finalValue = shares * stockTarget;
  return {
    startPrice,
    shares,
    finalValue,
    totalReturnAbs: finalValue - amount,
    totalReturnPct: ((finalValue - amount) / amount) * 100,
    sp500FinalValue: amount * spTarget,
    sp500ReturnPct: (spTarget - 1) * 100,
    series,
  };
}
