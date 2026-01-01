import { useCallback, useRef } from "react";

type UseSafeNavigationArgs = {
  beforeNavigate?: () => void | Promise<void>;
};

type UseSafeNavigationResult = {
  navigateSafely: (nav: () => void) => void;
};

export function useSafeNavigation({
  beforeNavigate,
}: UseSafeNavigationArgs): UseSafeNavigationResult {
  const inFlightRef = useRef(false);

  const navigateSafely = useCallback(
    (nav: () => void) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      void (async () => {
        try {
          await beforeNavigate?.();
        } catch (e) {
          console.warn("beforeNavigate failed", e);
        }
        nav();
      })();
    },
    [beforeNavigate]
  );

  return { navigateSafely };
}
