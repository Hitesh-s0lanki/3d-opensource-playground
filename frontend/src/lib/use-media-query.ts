"use client";

import { useEffect, useState } from "react";

/** Subscribes to a media query. Starts false so the server and the first
 * client render agree, then corrects itself on mount - which is why every
 * caller has to treat the desktop/motion-safe branch as the enhancement and
 * not the baseline. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The CSS in `globals.css` already flattens every keyframe animation for
 * these users. SMIL inside an inline `<svg>` is out of its reach, so the one
 * component that uses SMIL asks here and renders a still frame instead. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
