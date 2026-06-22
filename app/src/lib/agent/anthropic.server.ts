// AI Agent — AI layer (server-only). One structured-output call to Claude that
// reads recent news/sentiment for the quant shortlist and helps pick + size a
// portfolio. Claude chooses ONLY from the shortlist — it never invents tickers.
//
// Model is configurable via the server-only AGENT_MODEL env var so it can be
// swapped (e.g. for cost) without code edits. Defaults to claude-sonnet-4-6.

import Anthropic from "@anthropic-ai/sdk";
import { requireServerEnv, serverEnv } from "@/lib/marketData/env.server";

const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";
export function agentModel(): string {
  return serverEnv("AGENT_MODEL") || DEFAULT_AGENT_MODEL;
}

export type ClaudePick = { symbol: string; include: boolean; weight_hint: number; reason: string };
export type ClaudeReasoning = { picks: ClaudePick[]; commentary: string };

export type ShortlistEntry = {
  symbol: string;
  name: string;
  signals: Record<string, number>;
  news: Array<{ headline: string; summary?: string }>;
};

const SYSTEM = [
  "You are the research analyst for an EDUCATIONAL paper-trading simulator's AI portfolio agent.",
  "It trades VIRTUAL money only — no real funds are involved, and nothing you produce is financial advice.",
  "You are given a SHORTLIST of tickers that already passed a quantitative screen, each with its signals and recent news headlines.",
  "Assess news sentiment and risk, then help choose a diversified portfolio for the stated risk level.",
  "HARD RULES: Choose ONLY from the provided shortlist — never invent or suggest tickers outside it. Prefer diversification over concentration. Keep each reason to one sentence grounded in the signals or news. Output must match the JSON schema exactly.",
].join(" ");

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          include: { type: "boolean" },
          weight_hint: { type: "number" },
          reason: { type: "string" },
        },
        required: ["symbol", "include", "weight_hint", "reason"],
        additionalProperties: false,
      },
    },
    commentary: { type: "string" },
  },
  required: ["picks", "commentary"],
  additionalProperties: false,
} as const;

export async function claudeReason(input: { riskLevel: string; shortlist: ShortlistEntry[] }): Promise<ClaudeReasoning> {
  const client = new Anthropic({ apiKey: requireServerEnv("ANTHROPIC_API_KEY") });

  const userContent = JSON.stringify(
    {
      risk_level: input.riskLevel,
      task: "For each shortlisted symbol set include (bool), weight_hint (0..1 relative target size), and a one-line reason. Then write 2-3 sentences of overall portfolio commentary for this risk level.",
      candidates: input.shortlist,
    },
    null,
    2,
  );

  const res = await client.messages.create({
    model: agentModel(),
    max_tokens: 2000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: userContent }],
  });

  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Claude returned no text");
  return JSON.parse(text.text) as ClaudeReasoning;
}
