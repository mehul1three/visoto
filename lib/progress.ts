/**
 * Persistent progress: coins earned, and what has already paid out.
 *
 * The anti-farming rule is the whole design. Coins are collectibles inside a
 * level, and a level can be restarted forever, so paying out on every pickup
 * would make the economy meaningless within about fifteen seconds. Instead each
 * individual coin pays exactly once, ever, keyed by level and entity, and each
 * level pays a clear bonus exactly once.
 *
 * That has a deliberate side effect: the way to earn more is to bring a new
 * photo. The economy rewards the thing the project is actually about.
 */

import { CHARACTERS, CharacterKind } from "./character";

export interface Progress {
  coins: number;
  /** "levelId:entityId" for every coin that has already paid. */
  banked: string[];
  /** Level ids that have already paid their clear bonus. */
  cleared: string[];
}

export const CLEAR_BONUS = 2;

const KEY = "playground.progress.v1";

export function emptyProgress(): Progress {
  return { coins: 0, banked: [], cleared: [] };
}

export function loadProgress(): Progress {
  if (typeof window === "undefined") return emptyProgress();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyProgress();
    const p = JSON.parse(raw) as Partial<Progress>;
    return {
      coins:
        typeof p.coins === "number" && Number.isFinite(p.coins) && p.coins >= 0
          ? Math.floor(p.coins)
          : 0,
      banked: Array.isArray(p.banked) ? p.banked.filter((s) => typeof s === "string") : [],
      cleared: Array.isArray(p.cleared) ? p.cleared.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(p: Progress) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private browsing or quota — progress just will not persist */
  }
}

/** Returns the updated progress, or null when this coin has already paid. */
export function bankCoin(
  p: Progress,
  levelId: string,
  entityId: string,
): Progress | null {
  const key = `${levelId}:${entityId}`;
  if (p.banked.includes(key)) return null;
  return { ...p, coins: p.coins + 1, banked: [...p.banked, key] };
}

/** Returns the updated progress, or null when this level has already paid. */
export function bankClear(p: Progress, levelId: string): Progress | null {
  if (p.cleared.includes(levelId)) return null;
  return {
    ...p,
    coins: p.coins + CLEAR_BONUS,
    cleared: [...p.cleared, levelId],
  };
}

export function isUnlocked(kind: CharacterKind, coins: number): boolean {
  const c = CHARACTERS.find((x) => x.kind === kind);
  return !c || coins >= c.cost;
}

/** The cheapest character still out of reach, for the "next up" hint. */
export function nextUnlock(coins: number) {
  return (
    [...CHARACTERS]
      .sort((a, b) => a.cost - b.cost)
      .find((c) => c.cost > coins) ?? null
  );
}

/**
 * Stable identity for a level, so the same scene cannot pay twice.
 * Built-in scenes carry their own key; generated ones are hashed from content,
 * which also means re-uploading the same photo correctly pays nothing.
 */
export function levelIdOf(level: {
  id?: string;
  title: string;
  entities: Array<{ label: string; box: { x: number; y: number } }>;
}): string {
  if (level.id) return level.id;
  const seed =
    level.title +
    "|" +
    level.entities
      .map((e) => `${e.label}@${e.box.x.toFixed(3)},${e.box.y.toFixed(3)}`)
      .join(";");
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "gen-" + (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ store */

/**
 * A tiny external store, read through `useSyncExternalStore`.
 *
 * Progress lives in localStorage, which does not exist during server
 * rendering. Seeding component state with `loadProgress()` therefore renders
 * zero coins on the server and the real balance on the client, and React
 * treats that as a hydration mismatch the moment any of it reaches the HTML.
 * An external store with an explicit server snapshot is the supported way to
 * read browser-only state: the server and the first client render agree, and
 * the real value arrives in the commit that follows.
 */

/** Stable identity, so the server snapshot never looks like a new value. */
const SERVER_SNAPSHOT: Progress = emptyProgress();

let current: Progress | null = null;
const listeners = new Set<() => void>();

export function getProgress(): Progress {
  if (!current) current = loadProgress();
  return current;
}

export function getServerProgress(): Progress {
  return SERVER_SNAPSHOT;
}

export function subscribeProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function commitProgress(next: Progress) {
  current = next;
  saveProgress(next);
  for (const l of listeners) l();
}
