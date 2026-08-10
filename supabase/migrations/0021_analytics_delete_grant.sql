-- Closes a real grant gap found during step 5's live verification: 0020
-- granted service_role only SELECT and INSERT on analytics_events,
-- forgetting DELETE — so the analytics_events prune job (privacy.md's
-- "retained for a limited period... then discarded" promise) has been
-- silently failing every cron run since 0020 was applied. Same class of
-- gap as 0017 (transactions/insights), same fix shape: add the missing
-- grant, nothing else changes.
grant delete on public.analytics_events to service_role;
