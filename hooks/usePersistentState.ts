"use client";

import { useCallback, useSyncExternalStore } from "react";

// Same-tab subscribers per key. Cross-tab changes arrive through the `storage` event.
const listeners = new Map<string, Set<() => void>>();
// In-memory fallback for when localStorage is blocked (private mode, sandboxed iframes).
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

/**
 * localStorage-backed string-union state, kept in sync across tabs.
 * The server and the first client render use `initial` (no hydration mismatch). After that,
 * the stored value wins if it is one of `allowed`.
 */
export function usePersistentState<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const subscribe = useCallback(
    (fn: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(fn);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) fn();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(fn);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );

  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : initial;

  const set = useCallback(
    (v: T) => {
      memory.set(key, v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* storage blocked: the memory fallback still holds the value for this tab */
      }
      notify(key);
    },
    [key],
  );

  return [value, set];
}
