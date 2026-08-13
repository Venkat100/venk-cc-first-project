// A THIN, JWT-verified passthrough for the handful of analytics events that
// originate from client-only actions (watchlist add, journal entry create,
// Coach page view) rather than an existing server function — those write
// paths deliberately stayed client-side/RLS-only (see portfolio/queries.ts
// and journal/queries.ts's own header comments: "no money/price is
// involved... no server function needed"), so this is NOT a general-purpose
// event sink. `event` is a closed enum, not a free-text string, specifically
// so a scripted caller can't write arbitrary event names/properties into
// analytics_events. Every other new event in this pass (insight_generated,
// scenario_started/completed, margin_enabled, feature_unlocked, the Coach
// nudge trio) fires directly from its own existing server function instead —
// this file exists only for the 3 that have no server function to hang off.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyUser } from "@/lib/supabase/admin.server";
import { track } from "./track.server";

const CLIENT_EVENTS = [
  "watchlist_add",
  "journal_entry_created",
  "coach_visited",
  "coach_nudge_shown",
  "coach_nudge_clicked",
  "coach_nudge_dismissed",
] as const;

export const trackClientEventFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      event: z.enum(CLIENT_EVENTS),
      properties: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      const userId = await verifyUser(data.accessToken);
      void track(data.event, { userId, properties: data.properties });
    } catch {
      // Never let a tracking failure surface to the caller — this event is
      // never load-bearing for the feature it's attached to (same rule as
      // track() itself). An expired/invalid token just means no event.
    }
    return { ok: true };
  });
