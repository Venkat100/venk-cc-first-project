// Tiny client-only theme controller. Dark default.
export type Theme = "dark" | "light";
const KEY = "papertrader-theme";

export function getTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem(KEY) as Theme) || "dark";
}

export function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(t);
  try { localStorage.setItem(KEY, t); } catch { /* noop */ }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
