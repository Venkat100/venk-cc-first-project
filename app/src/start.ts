import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { captureServerError } from "./lib/sentry/server";

// Catches anything that escapes a server function's OWN try/catch — see
// lib/sentry/server.ts's header for why this is one of the two Sentry
// seams (not one call site per server function).
const errorMiddleware = createMiddleware().server(async ({ next, pathname, serverFnMeta }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    captureServerError(error, { route: pathname, action: serverFnMeta?.name });
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
}));
