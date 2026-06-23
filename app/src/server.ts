import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Token-protected snapshot trigger (Vercel Cron in Phase 9). Handled here
      // so it's a stable HTTP path independent of the app router. Dynamic import
      // keeps the server-only writer out of the SSR/client path.
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/cron/snapshot") {
        const { handleSnapshotRequest } = await import("./lib/snapshots/endpoint.server");
        return await handleSnapshotRequest(request);
      }
      // Agent autopilot crons (Phase 10.5): thinker daily (Vercel Cron), watchdog
      // intraday (GitHub Actions). Dynamic import keeps server-only code off the
      // SSR/client path.
      if (pathname === "/api/cron/agent-thinker") {
        const { handleAgentThinkerRequest } = await import("./lib/agent/cron.server");
        return await handleAgentThinkerRequest(request);
      }
      if (pathname === "/api/cron/agent-watchdog") {
        const { handleAgentWatchdogRequest } = await import("./lib/agent/cron.server");
        return await handleAgentWatchdogRequest(request);
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
