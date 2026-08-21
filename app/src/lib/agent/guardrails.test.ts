import { describe, it, expect } from "vitest";
import { suggestedMinFunding, GUARDRAILS } from "./guardrails";

describe("suggestedMinFunding", () => {
  it("balanced: matches the real production bug report exactly ($25)", () => {
    expect(suggestedMinFunding("balanced")).toBe(25);
  });

  it("conservative: higher minHoldings (5) and a larger cash buffer (0.25) than balanced", () => {
    // MIN_TRADE_DOLLARS(5) * minHoldings(5) / (1 - cashBuffer(0.25)) = 33.33 -> ceil to nearest $5 = 35
    expect(suggestedMinFunding("conservative")).toBe(35);
  });

  it("aggressive: fewer minHoldings (3) and a smaller cash buffer (0.08) than balanced", () => {
    // 5 * 3 / (1 - 0.08) = 16.30 -> ceil to nearest $5 = 20
    expect(suggestedMinFunding("aggressive")).toBe(20);
  });

  it("is a pure function of risk level only — same input always produces the same output", () => {
    expect(suggestedMinFunding("balanced")).toBe(suggestedMinFunding("balanced"));
  });

  it("every risk level in GUARDRAILS produces a positive, $5-rounded suggested minimum", () => {
    for (const risk of Object.keys(GUARDRAILS) as Array<keyof typeof GUARDRAILS>) {
      const min = suggestedMinFunding(risk);
      expect(min).toBeGreaterThan(0);
      expect(min % 5).toBe(0);
    }
  });
});
