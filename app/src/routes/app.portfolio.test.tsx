import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { DonutCard } from "./app.portfolio";
import { mockRechartsContainer } from "@/test/rechartsJsdom";

// MOBILE-AUDIT.md: DonutCard intermittently rendered a completely blank ring
// (zero Recharts <path> elements) on a fresh load, roughly half the time, at
// any viewport width — a Recharts ResponsiveContainer+Pie mount-timing race
// (the animation state machine computing its initial geometry against a
// stale/zero measurement and never self-correcting once real data arrives).
// Fixed with isAnimationActive={false} on <Pie>. jsdom has no real layout,
// so give it a real (fake) container size — see rechartsJsdom.ts — the
// SAME gap that let a rendering-only bug like this ship through the
// data/logic-only verify-*.ts suite in the first place.
beforeEach(() => mockRechartsContainer());

const READY_DATA = [
  { name: "Technology", value: 12000 },
  { name: "ETFs & funds", value: 8000 },
  { name: "Banking", value: 5000 },
];

describe("DonutCard", () => {
  it("renders one pie slice per allocation segment, never a blank ring", () => {
    const { container } = render(<DonutCard title="Allocation by sector" data={READY_DATA} state={{ isLoading: false, isError: false, error: null }} ready={true} />);
    const slicePaths = container.querySelectorAll(".recharts-pie .recharts-pie-sector path");
    expect(slicePaths.length).toBe(READY_DATA.length);
  });
});
