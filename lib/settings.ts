/**
 * Player settings, persisted across sessions.
 *
 * Deliberately small. Each entry exists either because a player will genuinely
 * want it off (sound, in a quiet room), because it is an accessibility concern
 * (screen shake, and the reduced-motion defaults), or because it is theirs to
 * choose (the character).
 */

import { RenderMode } from "./renderer";
import {
  CharacterKind,
  DEFAULT_CHARACTER,
  DEFAULT_COLOR,
  isCharacterKind,
  isPlayerColor,
} from "./character";

export interface Settings {
  sound: boolean;
  particles: boolean;
  shake: boolean;
  /** Draw each object's name over it during play, not only in X-ray. */
  labels: boolean;
  character: CharacterKind;
  color: string;
  /** Diorama (WebGL) or flat canvas. Falls back to 2D if WebGL will not start. */
  render: RenderMode;
}

/** The subset rendered as on/off switches. */
export type ToggleKey = "sound" | "particles" | "shake" | "labels";

const KEY = "playground.settings.v3";

export function defaultSettings(): Settings {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return {
    sound: true,
    particles: !reduced,
    shake: !reduced,
    labels: false,
    character: DEFAULT_CHARACTER,
    color: DEFAULT_COLOR,
    render: "3d",
  };
}

export function loadSettings(): Settings {
  const base = defaultSettings();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Settings>;
    const bool = (v: unknown, fallback: boolean) =>
      typeof v === "boolean" ? v : fallback;
    return {
      sound: bool(saved.sound, base.sound),
      particles: bool(saved.particles, base.particles),
      shake: bool(saved.shake, base.shake),
      labels: bool(saved.labels, base.labels),
      // Validate rather than trust: a stale or hand-edited value would
      // otherwise reach the renderer as an unknown character and draw nothing.
      character: isCharacterKind(saved.character) ? saved.character : base.character,
      color: isPlayerColor(saved.color) ? saved.color : base.color,
      render: saved.render === "2d" || saved.render === "3d" ? saved.render : base.render,
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private browsing, quota, etc. — settings just will not persist */
  }
}

export const SETTING_LABELS: Record<ToggleKey, { name: string; hint: string }> = {
  sound: { name: "Sound effects", hint: "Jumps, coins, bounces and the win jingle." },
  particles: { name: "Particles", hint: "Bursts on bounce, pickup and death." },
  shake: { name: "Screen shake", hint: "A short kick when you die or bounce." },
  labels: { name: "Object labels", hint: "Name every object during play, not only in X-ray." },
};

export const TOGGLE_KEYS = Object.keys(SETTING_LABELS) as ToggleKey[];
