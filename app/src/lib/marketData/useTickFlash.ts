// Compares a numeric value across renders and returns which CSS class (if
// any) should be applied right now for a brief tick-flash — green on an
// increase, red on a decrease, nothing on the first render or when the
// value is unchanged/unknown. Pairs with the `.price-flash-up`/
// `.price-flash-down` keyframes in styles.css (which already respect
// prefers-reduced-motion, so this hook doesn't need to check that itself).

import { useEffect, useRef, useState } from "react";

const FLASH_MS = 700; // matches the CSS animation-duration in styles.css

export function useTickFlash(value: number | undefined): string | undefined {
  const prevRef = useRef<number | undefined>(value);
  const [flashClass, setFlashClass] = useState<string | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (value == null || prev == null || value === prev) return;
    const cls = value > prev ? "price-flash-up" : "price-flash-down";
    setFlashClass(cls);
    const t = setTimeout(() => setFlashClass(undefined), FLASH_MS);
    return () => clearTimeout(t);
  }, [value]);

  return flashClass;
}
