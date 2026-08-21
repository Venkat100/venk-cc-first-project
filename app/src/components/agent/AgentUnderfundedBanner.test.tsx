import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentUnderfundedBanner } from "./AgentUnderfundedBanner";

// 2026-08-21 incident (HANDOFF.md): the banner used to read a STORED flag
// from the agent's last decision-log entry, so funding an underfunded
// account didn't clear it until the next scheduled thinker run (up to 24h
// later). It's now driven entirely by a pre-computed `isUnderfunded` prop
// the caller derives LIVE from current balance — these tests pin exactly
// what this component does with that prop, independent of how it's
// computed upstream.
describe("AgentUnderfundedBanner", () => {
  it("renders nothing when isUnderfunded is false — this IS the fix: funding enough must make it disappear with no other state change", () => {
    const { container } = render(<AgentUnderfundedBanner isUnderfunded={false} riskLevel="balanced" suggestedMin={25} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the warning, risk level, and suggested minimum when isUnderfunded is true", () => {
    render(<AgentUnderfundedBanner isUnderfunded={true} riskLevel="balanced" suggestedMin={25} />);
    expect(screen.getByText("This account is too small to invest.")).toBeInTheDocument();
    expect(screen.getByText(/balanced portfolio/)).toBeInTheDocument();
    expect(screen.getByText(/Consider funding at least \$25\.00\./)).toBeInTheDocument();
  });

  it("the suggested minimum is NOT hardcoded — reflects whatever value the caller passes, per risk level", () => {
    render(<AgentUnderfundedBanner isUnderfunded={true} riskLevel="aggressive" suggestedMin={18} />);
    expect(screen.getByText(/aggressive portfolio/)).toBeInTheDocument();
    expect(screen.getByText(/Consider funding at least \$18\.00\./)).toBeInTheDocument();
  });

  it("re-rendering with isUnderfunded flipped from true to false clears the banner immediately — the exact behavior the stale-flag bug broke", () => {
    const { rerender, container } = render(<AgentUnderfundedBanner isUnderfunded={true} riskLevel="balanced" suggestedMin={25} />);
    expect(screen.getByText("This account is too small to invest.")).toBeInTheDocument();
    rerender(<AgentUnderfundedBanner isUnderfunded={false} riskLevel="balanced" suggestedMin={25} />);
    expect(screen.queryByText("This account is too small to invest.")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
