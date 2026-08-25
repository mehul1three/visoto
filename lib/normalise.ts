import { Entity, Level, MATERIALS, Material, NBox } from "./level";

/**
 * Turn the model's reply into a level the engine can survive.
 *
 * Two jobs. First, translate Gemini's spatial conventions — boxes as
 * `[ymin, xmin, ymax, xmax]` and points as `[y, x]`, both normalised to
 * 0-1000 — into the {x, y, w, h} fractions the rest of the codebase uses. That
 * translation lives here, at the boundary, so the model's format never leaks
 * into the solver or the renderer.
 *
 * Second, distrust everything. The response schema constrains the shape, but the
 * solver and the renderer both assume finite numbers and a known material, and a
 * single NaN propagates into geometry that silently renders nothing. Validating
 * once, here, lets every downstream stage trust its input.
 */

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** `[ymin, xmin, ymax, xmax]` at 0-1000 -> normalised rect. */
function boxFrom(raw: unknown): NBox | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const v = raw.slice(0, 4);
  if (!v.every(finite)) return null;
  let [ymin, xmin, ymax, xmax] = v as number[];
  // The model occasionally transposes a pair; a flipped box is recoverable.
  if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
  if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
  return {
    x: xmin / 1000,
    y: ymin / 1000,
    w: (xmax - xmin) / 1000,
    h: (ymax - ymin) / 1000,
  };
}

/** `[y, x]` at 0-1000 -> normalised point. */
function pointFrom(raw: unknown, fallback: { x: number; y: number }) {
  if (!Array.isArray(raw) || raw.length < 2) return fallback;
  const [y, x] = raw;
  if (!finite(y) || !finite(x)) return fallback;
  return { x: x / 1000, y: y / 1000 };
}

interface RawEntity {
  label?: unknown;
  material?: unknown;
  reason?: unknown;
  box_2d?: unknown;
}

interface RawLevel {
  title?: unknown;
  tagline?: unknown;
  entities?: unknown;
  spawn?: unknown;
  goal?: unknown;
}

export function normalise(parsed: RawLevel): Level {
  const source = Array.isArray(parsed?.entities)
    ? (parsed.entities as RawEntity[])
    : [];

  const entities: Entity[] = [];
  for (const e of source) {
    if (!e || typeof e !== "object") continue;
    const box = boxFrom(e.box_2d);
    if (!box) continue;
    // Below the player's own footprint, so unusable as geometry.
    if (box.w <= 0.005 || box.h <= 0.004) continue;
    entities.push({
      id: `e${entities.length}`,
      label: String(e.label ?? "object").slice(0, 60),
      material: (MATERIALS as readonly string[]).includes(e.material as string)
        ? (e.material as Material)
        : "solid",
      reason: String(e.reason ?? "").slice(0, 140),
      box,
    });
  }

  return {
    version: 1,
    title: String(parsed?.title ?? "Untitled scene").slice(0, 60),
    tagline: String(parsed?.tagline ?? "").slice(0, 120),
    entities,
    spawn: pointFrom(parsed?.spawn, { x: 0.1, y: 0.5 }),
    goal: pointFrom(parsed?.goal, { x: 0.9, y: 0.4 }),
  };
}
