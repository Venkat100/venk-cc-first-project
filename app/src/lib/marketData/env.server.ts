// Server-only env access for market-data secrets.
//
// The `.server.ts` suffix guarantees this never lands in the client bundle.
// In production the key comes from the host's real environment (process.env).
// In local dev we also parse app/.env as a fallback, because Vite only injects
// VITE_-prefixed vars into the runtime — server-only secrets must be read here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let fileEnv: Record<string, string> | null = null;

function loadDotEnv(): Record<string, string> {
  if (fileEnv) return fileEnv;
  fileEnv = {};
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  } catch {
    // No .env file (e.g. production) — rely on process.env only.
  }
  return fileEnv;
}

export function serverEnv(name: string): string | undefined {
  return process.env[name] ?? loadDotEnv()[name];
}

export function requireServerEnv(name: string): string {
  const v = serverEnv(name);
  if (!v) throw new Error(`Missing server env var ${name}. Set it in app/.env (server-only, no VITE_ prefix).`);
  return v;
}
