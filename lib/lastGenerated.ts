/**
 * Persistence for the one level you most recently generated from a photo.
 *
 * Everything else in the app survives a refresh — settings, coin progress —
 * except the actual level a photo just became. That's backwards: the level is
 * the whole point, and losing it on an accidental reload (or just closing the
 * tab to come back later) means re-uploading the same photo and waiting
 * through the same analysis again.
 *
 * Deliberately scoped to *one* level, not a gallery. A gallery is a bigger
 * feature — browsing, naming, deleting entries — and this is solving a
 * narrower problem: don't lose the thing you just made.
 */

import { Level } from "./level";
import { SolveReport } from "./solver";

const KEY = "visoto.lastGenerated.v1";

export interface StoredLevel {
  level: Level;
  report: SolveReport;
  /** The 16:9 JPEG data URL the level was generated from. */
  image: string;
  savedAt: number;
}

function isStoredLevel(v: unknown): v is StoredLevel {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<StoredLevel>;
  return (
    !!s.level &&
    typeof s.level === "object" &&
    Array.isArray((s.level as Level).entities) &&
    !!s.report &&
    typeof s.image === "string" &&
    s.image.startsWith("data:image/") &&
    typeof s.savedAt === "number"
  );
}

export function loadLastGenerated(): StoredLevel | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isStoredLevel(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLastGenerated(entry: Omit<StoredLevel, "savedAt">) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...entry, savedAt: Date.now() }),
    );
  } catch {
    // Quota exceeded, private browsing, whatever — this is a convenience,
    // not a guarantee. The level still played; it just won't survive a
    // refresh this time.
  }
}

export function clearLastGenerated() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do if storage is unavailable */
  }
}

/* ------------------------------------------------------------ external store */

/**
 * Read through `useSyncExternalStore`, exactly like `lib/progress.ts`.
 *
 * `localStorage` doesn't exist during server rendering, so seeding this into
 * `useState`'s initializer — or setting it from a plain `useEffect` — renders
 * one thing on the server and another on the first client paint. React either
 * flags that as a hydration mismatch or, for a bare effect, flags the
 * synchronous `setState` itself as a footgun. An external store with an
 * explicit, stable server snapshot is the way this is meant to be done: server
 * and the first client render agree (both null), and the real value arrives in
 * the commit that follows.
 */

let current: StoredLevel | null | undefined;
const listeners = new Set<() => void>();

export function getLastGenerated(): StoredLevel | null {
  if (current === undefined) current = loadLastGenerated();
  return current;
}

export function getServerLastGenerated(): StoredLevel | null {
  return null;
}

export function subscribeLastGenerated(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function commitLastGenerated(entry: StoredLevel | null) {
  current = entry;
  if (entry) saveLastGenerated(entry);
  else clearLastGenerated();
  for (const l of listeners) l();
}
