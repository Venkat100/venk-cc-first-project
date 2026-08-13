// Client entry point for the 3 client-only analytics events. Same
// fire-and-forget contract as track() itself: callers never await this and
// it never throws, so a slow/failed analytics call can't block or break the
// real action it's attached to.
import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import { trackClientEventFn } from "./functions";

type ClientEvent = "watchlist_add" | "journal_entry_created" | "coach_visited" | "coach_nudge_shown" | "coach_nudge_clicked" | "coach_nudge_dismissed";

export function trackClientEvent(event: ClientEvent, properties?: Record<string, unknown>): void {
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return;
      await trackClientEventFn({ data: { accessToken, event, properties } });
    } catch {
      // fire-and-forget — never surfaces to the caller
    }
  })();
}

/** Fire a client event exactly once per genuinely distinct `deps`, even if
 *  the calling component's mount effect runs more than once for the same
 *  logical visit (observed in dev — TanStack Router transition renders can
 *  double-invoke a route component's effects; this guard is defensive
 *  regardless of the exact cause, since a doubled page-view event would
 *  quietly inflate every count downstream of it, incl. the admin dashboard). */
export function useTrackOnce(event: ClientEvent, properties?: Record<string, unknown>, deps: React.DependencyList = []) {
  const fired = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(deps);
    if (fired.current === key) return;
    fired.current = key;
    trackClientEvent(event, properties);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
