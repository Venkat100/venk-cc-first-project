import * as React from "react";

/** True if the OS/browser has "reduce motion" set. Same matchMedia +
 *  live-update pattern as useIsMobile — checked once on mount and kept in
 *  sync if the preference changes while the page is open (e.g. a user
 *  toggling it in System Settings without reloading). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    setReduced(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
