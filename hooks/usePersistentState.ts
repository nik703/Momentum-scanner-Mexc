"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * localStorage-backed state. Renders `initial` on the server and first client
 * paint (no hydration mismatch), then adopts the stored value after mount.
 */
export function usePersistentState<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key) as T | null;
      if (raw && allowed.includes(raw)) setValue(raw);
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage blocked */
      }
    },
    [key],
  );

  return [value, set];
}
