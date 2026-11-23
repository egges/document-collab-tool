// A setting kept per device, in the window's local storage: how this person
// likes the app to look on this screen, not something to sync. Every
// component that shows it sees the same value, and changes apply at once.
import { useEffect, useState } from "react";

export interface DevicePref<T> {
  get: () => T;
  set: (value: T) => void;
  /** The value, kept up to date, for React. */
  use: () => T;
}

export function devicePref<T extends string>(
  key: string,
  /** The value a saved string stands for, or the default. */
  parse: (saved: string | null) => T,
  /** Show the value (called at startup by `load` and on every change). */
  apply: (value: T) => void,
): DevicePref<T> & { load: () => void } {
  let value: T | undefined;
  const listeners = new Set<(value: T) => void>();
  const get = () => {
    if (value === undefined) {
      try {
        value = parse(localStorage.getItem(key));
      } catch {
        value = parse(null);
      }
    }
    return value;
  };
  return {
    get,
    load: () => apply(get()),
    set: (next) => {
      value = next;
      apply(next);
      listeners.forEach((f) => f(next));
      try {
        localStorage.setItem(key, next);
      } catch {
        // Not kept: it resets on the next start, nothing worse.
      }
    },
    use: () => {
      const [now, setNow] = useState(get);
      useEffect(() => {
        listeners.add(setNow);
        setNow(get());
        return () => void listeners.delete(setNow);
      }, []);
      return now;
    },
  };
}
