import { describe, it, expect } from "vitest";
import { fingerprint, computeFingerprints, diffFingerprints, FINGERPRINTED_ENV_VARS } from "./fingerprint";

describe("fingerprint", () => {
  it("is deterministic for the same value", () => {
    const a = fingerprint("sk-ant-api03-realistic-length-secret-value-abc123");
    const b = fingerprint("sk-ant-api03-realistic-length-secret-value-abc123");
    expect(a).toBe(b);
  });

  it("changes when the value changes, even by one character", () => {
    const a = fingerprint("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = fingerprint("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab");
    expect(a).not.toBe(b);
  });

  it("returns null for unset values, distinct from any real hash", () => {
    expect(fingerprint(undefined)).toBeNull();
    expect(fingerprint(null)).toBeNull();
    expect(fingerprint("")).toBeNull();
  });

  it("is exactly 8 lowercase hex characters — never the raw value or any length-revealing encoding of it", () => {
    const secret = "sk-ant-api03-d5B-fAsT93LEElVpMMrrYu1DsFklp2OTEB9UFIv98M59qoAkuZhStiPGW9E8Oau";
    const fp = fingerprint(secret);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).not.toBe(secret);
  });

  it("never emits the raw secret or any substring of it in the fingerprint", () => {
    const secret = "sk-ant-api03-uNiQuESuBsTrInGmArKeR9f8e7d6c5b4a";
    const fp = fingerprint(secret)!;
    // The hash is hex; check no chunk of the raw secret (beyond trivial
    // single-hex-char coincidences, which are expected and meaningless)
    // reappears literally in the 8-char output.
    for (let i = 0; i <= secret.length - 4; i++) {
      const chunk = secret.slice(i, i + 4).toLowerCase();
      if (/^[0-9a-f]{4}$/.test(chunk)) continue; // a 4-hex-char coincidence is possible and harmless
      expect(fp.includes(chunk)).toBe(false);
    }
  });
});

describe("computeFingerprints", () => {
  it("computes one fingerprint per tracked var, reading through the supplied function", () => {
    const fake: Record<string, string> = { ANTHROPIC_API_KEY: "key-one-value-here-long-enough", CRON_SECRET: "cron-secret-value-long-enough" };
    const result = computeFingerprints((name) => fake[name]);
    expect(Object.keys(result).sort()).toEqual([...FINGERPRINTED_ENV_VARS].sort());
    expect(result.ANTHROPIC_API_KEY).toBe(fingerprint("key-one-value-here-long-enough"));
    expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeNull(); // not in `fake`
  });
});

describe("diffFingerprints", () => {
  it("reports match when both sides agree", () => {
    const local = computeFingerprints(() => "same-value-on-both-sides-long-enough");
    const remote = computeFingerprints(() => "same-value-on-both-sides-long-enough");
    const rows = diffFingerprints(local, remote);
    expect(rows.every((r) => r.status === "match")).toBe(true);
  });

  it("reports mismatch when the values differ -- the exact 2026-08-17 ANTHROPIC_API_KEY shape: both present, different value", () => {
    const local = computeFingerprints((name) => (name === "ANTHROPIC_API_KEY" ? "new-rotated-key-value-long-enough" : "shared-value-long-enough"));
    const remote = computeFingerprints((name) => (name === "ANTHROPIC_API_KEY" ? "old-stale-key-value-long-enough" : "shared-value-long-enough"));
    const rows = diffFingerprints(local, remote);
    const anthropicRow = rows.find((r) => r.name === "ANTHROPIC_API_KEY")!;
    expect(anthropicRow.status).toBe("mismatch");
    expect(rows.filter((r) => r.name !== "ANTHROPIC_API_KEY").every((r) => r.status === "match")).toBe(true);
  });

  it("reports remote-missing when local has it but production doesn't -- the exact 2026-08-17 Sentry shape (set locally, never reached the deploy)", () => {
    const local = computeFingerprints(() => "value-set-locally-long-enough-for-this-test");
    const remote = computeFingerprints(() => undefined);
    const rows = diffFingerprints(local, remote);
    expect(rows.every((r) => r.status === "remote-missing")).toBe(true);
  });

  it("reports local-missing when production has it but the local .env doesn't", () => {
    const local = computeFingerprints(() => undefined);
    const remote = computeFingerprints(() => "value-set-only-in-production-long-enough");
    const rows = diffFingerprints(local, remote);
    expect(rows.every((r) => r.status === "local-missing")).toBe(true);
  });

  it("reports both-missing (not a false mismatch) when neither side has it configured", () => {
    const local = computeFingerprints(() => undefined);
    const remote = computeFingerprints(() => undefined);
    const rows = diffFingerprints(local, remote);
    expect(rows.every((r) => r.status === "both-missing")).toBe(true);
  });
});
