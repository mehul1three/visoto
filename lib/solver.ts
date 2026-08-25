/**
 * Level validation and repair.
 *
 * A vision model returns plausible boxes, not a playable level. Boxes overlap,
 * float, or leave the goal stranded across a gap no jump can cross. Shipping
 * that straight to the player means roughly one level in three is impossible,
 * which is indistinguishable from "the app is broken".
 *
 * So every generated level is proved completable before it is playable:
 *
 *   1. sanitise  - clamp, drop degenerate boxes, de-duplicate overlaps
 *   2. ground    - guarantee a floor so the player cannot spawn into the void
 *   3. graph     - model each solid's top edge as a node
 *   4. prove     - BFS using the ACTUAL jump arc from physics.ts
 *   5. repair    - if the goal is unreachable, insert bridge platforms and retry
 *
 * Step 4 is why the constants live in physics.ts and are imported rather than
 * copied: the solver must reason about the exact arc the player will fly.
 */

import {
  Entity,
  Level,
  MATERIAL_SPECS,
  Material,
  MonsterSpawn,
  NBox,
  Rect,
  WORLD_H,
  WORLD_W,
  toNorm,
  toWorld,
} from "./level";
import {
  BOUNCE_MULT,
  GRAVITY,
  JUMP_HEIGHT,
  JUMP_V,
  MOVE_SPEED,
  PLAYER_H,
  PLAYER_W,
} from "./physics";

/** Trim the theoretical arc: the player also has to aim, and boxes are approximate. */
const REACH_SAFETY = 0.78;
const RISE_SAFETY = 14;
/** Clearance a spawn point needs: stand up, plus room to actually jump. */
const MIN_HEADROOM = PLAYER_H + 70;

export interface SolveReport {
  ok: boolean;
  repairs: string[];
  surfaces: number;
  /** Fraction of surfaces the player can actually get to. Shown in the UI. */
  coverage: number;
}

interface Surface {
  x1: number;
  x2: number;
  y: number;
  material: Material;
  /** Top of the climbable column this surface belongs to, if any. */
  climbTop?: number;
}

/**
 * Horizontal distance covered by a jump that lands `rise` units ABOVE the
 * take-off point (negative rise = landing lower down). Returns -1 if the jump
 * cannot gain that much height at all.
 */
export function jumpReach(rise: number, launchV = JUMP_V): number {
  const disc = launchV * launchV - 2 * GRAVITY * rise;
  if (disc < 0) return -1;
  const t = (launchV + Math.sqrt(disc)) / GRAVITY;
  return MOVE_SPEED * t * REACH_SAFETY;
}

function area(b: NBox) {
  return b.w * b.h;
}

function iou(a: NBox, b: NBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (area(a) + area(b) - inter);
}

function clampBox(b: NBox): NBox {
  const x = Math.min(0.995, Math.max(0, b.x));
  const y = Math.min(0.995, Math.max(0, b.y));
  return {
    x,
    y,
    w: Math.max(0.025, Math.min(1 - x, b.w)),
    h: Math.max(0.02, Math.min(1 - y, b.h)),
  };
}

/** Step 1 + 2: make the entity list geometrically sane. */
function sanitise(entities: Entity[], repairs: string[]): Entity[] {
  const kept: Entity[] = [];
  let dropped = 0;

  const ordered = [...entities]
    .map((e) => ({ ...e, box: clampBox(e.box) }))
    .sort((a, b) => area(b.box) - area(a.box));

  for (const e of ordered) {
    // A box covering nearly the whole frame is the model describing the room,
    // not an object in it.
    if (area(e.box) > 0.72) {
      dropped++;
      continue;
    }
    if (kept.some((k) => iou(k.box, e.box) > 0.5)) {
      dropped++;
      continue;
    }
    kept.push(e);
  }
  if (dropped) {
    repairs.push(
      `Discarded ${dropped} overlapping or frame-sized box${dropped > 1 ? "es" : ""}.`,
    );
  }

  // Guarantee a floor if the scene has no solid footing near the bottom.
  const hasFloor = kept.some(
    (e) =>
      MATERIAL_SPECS[e.material].solid && e.box.y + e.box.h > 0.72,
  );
  if (!hasFloor) {
    kept.push({
      id: "floor",
      label: "ground plane",
      material: "solid",
      reason: "the surface everything in the photo rests on",
      box: { x: 0, y: 0.94, w: 1, h: 0.06 },
      synthetic: true,
    });
    repairs.push("Added a ground plane — the scene had no floor to stand on.");
  }

  return kept.map((e, i) => ({ ...e, id: e.id || `e${i}` }));
}

function buildSurfaces(entities: Entity[]): Surface[] {
  const out: Surface[] = [];
  for (const e of entities) {
    if (!MATERIAL_SPECS[e.material].solid) continue;
    const r = toWorld(e.box);
    if (r.w < PLAYER_W * 0.7) continue; // too narrow to land on
    out.push({
      x1: r.x,
      x2: r.x + r.w,
      y: r.y,
      material: e.material,
      climbTop: e.material === "climbable" ? r.y : undefined,
    });
  }
  return out;
}

function gapBetween(a: Surface, b: Surface): number {
  if (a.x2 >= b.x1 && b.x2 >= a.x1) return 0;
  return a.x2 < b.x1 ? b.x1 - a.x2 : a.x1 - b.x2;
}

/** Can the player get from surface `a` to surface `b` in one move? */
function canTraverse(a: Surface, b: Surface): boolean {
  const rise = a.y - b.y; // positive => b is higher
  const launch = a.material === "bouncy" ? JUMP_V * BOUNCE_MULT : JUMP_V;
  const maxRise =
    (launch * launch) / (2 * GRAVITY) - RISE_SAFETY - PLAYER_H * 0.15;
  if (rise > maxRise) return false;
  const reach = jumpReach(rise, launch);
  if (reach < 0) return false;
  return gapBetween(a, b) <= reach;
}

function nearestSurfaceIndex(surfaces: Surface[], x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  surfaces.forEach((s, i) => {
    const cx = Math.max(s.x1, Math.min(s.x2, x));
    const d = Math.hypot(cx - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}


/**
 * Vertical clearance above a point standing on a surface.
 *
 * Real photos are full of overhangs - a shelf above a desk, a lamp above a
 * bookcase. Spawning under one is fatal in a way that looks like a broken game:
 * the player cannot jump over the obstacle beside them and cannot walk through
 * it, so they are wedged forever. The jump-arc maths alone will happily certify
 * that trap, because it only ever looks at where you are landing, never at what
 * is directly over your head.
 */
function headroomAt(x: number, surfaceY: number, solids: Rect[]): number {
  let ceiling = -Infinity;
  for (const r of solids) {
    if (x < r.x || x > r.x + r.w) continue;
    const bottom = r.y + r.h;
    if (bottom > surfaceY - 1) continue; // at or below our feet - not a ceiling
    if (bottom > ceiling) ceiling = bottom;
  }
  return ceiling === -Infinity ? Infinity : surfaceY - ceiling;
}

/**
 * Longest uninterrupted stretch of a surface that has room to jump from.
 *
 * A single clear point is not enough. Squeezing a 34px player into a 44px slot
 * between two slabs satisfies a per-point headroom test while being impossible
 * to actually use, so what matters is a contiguous run wide enough to stand in
 * and launch from.
 */
function clearRun(
  surface: Surface,
  solids: Rect[],
): { span: number; centre: number } {
  const lo = surface.x1 + PLAYER_W / 2;
  const hi = surface.x2 - PLAYER_W / 2;
  if (hi <= lo) return { span: 0, centre: (surface.x1 + surface.x2) / 2 };
  const stepPx = 8;
  let best = 0;
  let bestEnd = lo;
  let run = 0;
  for (let x = lo; x <= hi; x += stepPx) {
    if (
      standingClear(x, surface.y, solids) &&
      headroomAt(x, surface.y, solids) >= MIN_HEADROOM
    ) {
      run += stepPx;
      if (run > best) {
        best = run;
        bestEnd = x;
      }
    } else {
      run = 0;
    }
  }
  return { span: best, centre: bestEnd - best / 2 };
}

function clearSpanOn(surface: Surface, solids: Rect[]): number {
  return clearRun(surface, solids).span;
}

/** A launch pad needs room to stand and run, not just a gap to stand in. */
const MIN_LAUNCH_SPAN = PLAYER_W * 3;

const GOAL_LANDING_NOTE =
  "Built a landing under the goal — it was floating in mid-air.";

/**
 * Would the player's body be inside something if it stood here?
 *
 * Headroom asks what is overhead; this asks what is already occupying the space
 * the player is about to fill. Photos are full of objects resting on other
 * objects, so a point on a surface being clear above says nothing about whether
 * a chair leg or a wall runs straight through it.
 */
function standingClear(x: number, surfaceY: number, solids: Rect[]): boolean {
  const bx = x - PLAYER_W / 2;
  const by = surfaceY - PLAYER_H;
  return !solids.some(
    (r) =>
      bx < r.x + r.w &&
      bx + PLAYER_W > r.x &&
      by < r.y + r.h &&
      by + PLAYER_H > r.y,
  );
}

/** Pick a start that is close to what the model asked for and not wedged under anything. */
function chooseSpawn(
  surfaces: Surface[],
  solids: Rect[],
  wantX: number,
  wantY: number,
): { idx: number; x: number; trapped: boolean } {
  const order = surfaces
    .map((s, idx) => {
      const cx = Math.max(s.x1, Math.min(s.x2, wantX));
      return { idx, d: Math.hypot(cx - wantX, s.y - wantY) };
    })
    .sort((a, b) => a.d - b.d);

  for (const { idx } of order) {
    const s = surfaces[idx];
    const lo = s.x1 + PLAYER_W;
    const hi = s.x2 - PLAYER_W;
    if (hi < lo) continue;
    let best: number | null = null;
    let bestScore = Infinity;
    for (let i = 0; i <= 24; i++) {
      const x = lo + ((hi - lo) * i) / 24;
      if (!standingClear(x, s.y, solids)) continue;
      if (headroomAt(x, s.y, solids) < MIN_HEADROOM) continue;
      const score = Math.abs(x - wantX);
      if (score < bestScore) {
        bestScore = score;
        best = x;
      }
    }
    if (best !== null) return { idx, x: best, trapped: false };
  }

  const idx = order[0]?.idx ?? 0;
  const s = surfaces[idx];
  return {
    idx,
    x: Math.max(s.x1 + PLAYER_W, Math.min(s.x2 - PLAYER_W, wantX)),
    trapped: true,
  };
}

/** Step 4: BFS over the jump graph. */
function reachableSet(surfaces: Surface[], startIdx: number): Set<number> {
  const seen = new Set<number>([startIdx]);
  const queue = [startIdx];
  while (queue.length) {
    const cur = queue.shift()!;
    for (let i = 0; i < surfaces.length; i++) {
      if (seen.has(i)) continue;
      if (canTraverse(surfaces[cur], surfaces[i])) {
        seen.add(i);
        queue.push(i);
      }
    }
  }
  return seen;
}

function goalReachable(
  surfaces: Surface[],
  reach: Set<number>,
  goalX: number,
  goalY: number,
): boolean {
  // The goal is a point in space; treat it as a one-player-wide landing pad.
  const pad: Surface = {
    x1: goalX - PLAYER_W,
    x2: goalX + PLAYER_W,
    y: goalY,
    material: "solid",
  };
  for (const i of reach) {
    if (canTraverse(surfaces[i], pad)) return true;
  }
  return false;
}


/**
 * Is there something directly beneath the goal to stand on?
 *
 * A goal hanging in open air can only be collected by clipping it at the top of
 * a jump. That is a precision demand the level never advertised, and it is the
 * difference between "hard" and "feels broken". Giving the goal a floor turns
 * the last move back into a landing.
 */
function goalHasSupport(entities: Entity[], goalX: number, goalY: number): boolean {
  return entities.some((e) => {
    if (!MATERIAL_SPECS[e.material].solid) return false;
    const r = toWorld(e.box);
    return (
      goalX >= r.x - PLAYER_W &&
      goalX <= r.x + r.w + PLAYER_W &&
      r.y >= goalY - 4 &&
      r.y <= goalY + 80
    );
  });
}

/**
 * Step 5: walk a bridge platform from the reachable region toward the goal.
 * Each inserted platform is placed strictly within one jump of somewhere the
 * player can already stand, so progress is monotonic and the loop terminates.
 */
function bridgeToward(
  surfaces: Surface[],
  reach: Set<number>,
  goalX: number,
  goalY: number,
  solids: Rect[],
): Entity | null {
  let from: Surface | null = null;
  let bestD = Infinity;
  for (const i of reach) {
    const s = surfaces[i];
    const cx = Math.max(s.x1, Math.min(s.x2, goalX));
    const d = Math.hypot(cx - goalX, s.y - goalY);
    if (d < bestD) {
      bestD = d;
      from = s;
    }
  }
  if (!from) return null;

  const launch = from.material === "bouncy" ? JUMP_V * BOUNCE_MULT : JUMP_V;
  const maxRise = (launch * launch) / (2 * GRAVITY) - RISE_SAFETY;

  const W = 200;
  const H = 18;
  /**
   * Consecutive steps must barely overlap. Anything more and the upper slab
   * becomes a ceiling over the lower one: the player is left with less
   * clearance than their own height and cannot jump at all. Stacking bridges
   * vertically is the single easiest way to "fix" a level into an unplayable
   * shaft, so the geometry forbids it outright.
   */
  const MIN_LATERAL = W * 0.8;

  // Shallow hops on purpose: a flatter arc carries much further horizontally,
  // which is what buys the sideways room the staircase needs.
  const rise = Math.max(-260, Math.min(maxRise * 0.42, from.y - goalY));
  const y = from.y - rise;
  const reachAt = jumpReach(rise, launch);
  if (reachAt < 0) return null;

  const maxLateral = reachAt * 0.86;
  const centre = (from.x1 + from.x2) / 2;
  const toGoal = goalX - centre;
  // Prefer a big sideways step; fall back to whatever the arc allows.
  const lateral = Math.min(maxLateral, Math.max(MIN_LATERAL, Math.abs(toGoal)));

  /**
   * Head for the goal; when it is directly overhead the step deliberately
   * overshoots, so the next hop comes back the other way and the staircase
   * switchbacks up beneath it.
   */
  const preferred = toGoal >= 0 ? 1 : -1;

  for (const dir of [preferred, -preferred as 1 | -1]) {
    for (let nudge = 0; nudge <= 6; nudge++) {
      const px = Math.max(
        0,
        Math.min(WORLD_W - W, centre + dir * (lateral - nudge * 22) - W / 2),
      );
      const candidate: Surface = { x1: px, x2: px + W, y, material: "solid" };

      // Must be a jump the player can actually make...
      if (gapBetween(from, candidate) > reachAt) continue;

      /**
       * Two-sided clearance, which is the invariant every inserted platform has
       * to satisfy: it must not seal the surface it launches from, and it must
       * not land the player somewhere already sealed by something above. Check
       * only the first and staircases tuck themselves under existing geometry;
       * check only the second and they bury the ground they came from.
       */
      const withNew = [...solids, { x: px, y, w: W, h: H }];
      if (clearSpanOn(from, withNew) < MIN_LAUNCH_SPAN) continue;
      if (clearSpanOn(candidate, withNew) < MIN_LAUNCH_SPAN) continue;

      return {
        id: `bridge-${Math.round(px)}-${Math.round(y)}`,
        label: "solver bridge",
        material: "solid",
        reason: "inserted so the goal is provably reachable",
        box: { x: px / WORLD_W, y: y / WORLD_H, w: W / WORLD_W, h: H / WORLD_H },
        synthetic: true,
      };
    }
  }
  return null;
}


/** Minimum surface width worth putting a patrol on. */
const PATROL_MIN_W = 200;
const TUNNEL_W = 90;
const TUNNEL_H = 60;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * Put patrols on wide surfaces the player can actually reach.
 *
 * Monsters never touch level geometry, so they cannot invalidate the
 * completability proof — but they can absolutely ruin a level by standing on
 * the spawn. Hence the exclusion zone: nothing within a screen-third of where
 * the player appears, and never on the surface they start on.
 */
function placeMonsters(
  surfaces: Surface[],
  reach: Set<number>,
  spawnIdx: number,
  spawnX: number,
): MonsterSpawn[] {
  const candidates = [...reach]
    .filter((i) => i !== spawnIdx)
    .map((i) => surfaces[i])
    .filter((s) => s.x2 - s.x1 >= PATROL_MIN_W)
    .filter((s) => Math.abs((s.x1 + s.x2) / 2 - spawnX) > 260)
    .sort((a, b) => b.x2 - b.x1 - (a.x2 - a.x1));

  return candidates.slice(0, 2).map((s, i) => ({
    id: `m${i}`,
    x: (s.x1 + s.x2) / 2 / WORLD_W,
    y: s.y / WORLD_H,
  }));
}

/**
 * Find somewhere for a pipe to sit: flat on a reachable surface, clear of every
 * other object, and not on top of the player or the goal.
 *
 * The caller re-proves the level afterwards and drops the pipe if it broke
 * anything, so this only has to be plausible, not provably safe.
 */
function placeTunnel(
  entities: Entity[],
  surfaces: Surface[],
  reach: Set<number>,
  spawnX: number,
  goalX: number,
): Entity | null {
  const solids = entities.map((e) => toWorld(e.box));

  const ordered = [...reach]
    .map((i) => surfaces[i])
    .filter((s) => s.x2 - s.x1 >= TUNNEL_W + 60)
    .sort((a, b) => b.x2 - b.x1 - (a.x2 - a.x1));

  for (const s of ordered) {
    // Walk the surface looking for a slot nothing already occupies.
    for (let x = s.x1 + 20; x + TUNNEL_W <= s.x2 - 20; x += 30) {
      const box: Rect = { x, y: s.y - TUNNEL_H, w: TUNNEL_W, h: TUNNEL_H };
      const cx = x + TUNNEL_W / 2;
      if (Math.abs(cx - spawnX) < 160) continue;
      if (Math.abs(cx - goalX) < 160) continue;
      if (solids.some((r) => rectsOverlap(box, r))) continue;
      return {
        id: "tunnel",
        label: "service duct",
        material: "tunnel",
        reason: "an opening that goes somewhere else",
        box: toNorm(box),
        synthetic: true,
      };
    }
  }
  return null;
}

/**
 * Validate and repair a raw level. Always returns a playable level — the report
 * says how much surgery that took, and the UI shows it rather than hiding it.
 */
export function solve(raw: Level): { level: Level; report: SolveReport } {
  const repairs: string[] = [];
  let entities = sanitise(raw.entities, repairs);

  let spawn = { ...raw.spawn };
  let goal = { ...raw.goal };

  // Keep spawn and goal inside the frame and apart from each other.
  spawn.x = Math.min(0.9, Math.max(0.04, spawn.x));
  spawn.y = Math.min(0.9, Math.max(0.05, spawn.y));
  goal.x = Math.min(0.96, Math.max(0.04, goal.x));
  goal.y = Math.min(0.92, Math.max(0.04, goal.y));
  if (Math.hypot(goal.x - spawn.x, goal.y - spawn.y) < 0.25) {
    goal.x = spawn.x > 0.5 ? 0.1 : 0.9;
    repairs.push("Moved the goal — it was spawn-adjacent, so there was no level.");
  }

  let surfaces = buildSurfaces(entities);
  if (surfaces.length === 0) {
    entities.push({
      id: "floor",
      label: "ground plane",
      material: "solid",
      reason: "fallback footing",
      box: { x: 0, y: 0.94, w: 1, h: 0.06 },
      synthetic: true,
    });
    surfaces = buildSurfaces(entities);
    repairs.push("No standable surface was detected; added a ground plane.");
  }

  let goalX = goal.x * WORLD_W;
  let goalY = goal.y * WORLD_H;

  /**
   * Give the goal something to stand on.
   *
   * Runs again after any step that moves the goal — lowering a floating goal
   * puts it back in open air, so the guarantee has to be re-established rather
   * than assumed to hold.
   */
  const ensureGoalSupport = () => {
    if (goalHasSupport(entities, goalX, goalY)) return;
    const pw = 200;
    const px = Math.max(0, Math.min(WORLD_W - pw, goalX - pw / 2));
    entities = entities.filter((e) => e.id !== "goal-platform");
    entities.push({
      id: "goal-platform",
      label: "goal platform",
      material: "solid",
      reason: "the goal was hanging in open air",
      box: {
        x: px / WORLD_W,
        y: (goalY + 6) / WORLD_H,
        w: pw / WORLD_W,
        h: 18 / WORLD_H,
      },
      synthetic: true,
    });
    surfaces = buildSurfaces(entities);
    if (!repairs.includes(GOAL_LANDING_NOTE)) repairs.push(GOAL_LANDING_NOTE);
  };

  ensureGoalSupport();

  // Drop the player onto a real surface with room over its head, rather than
  // into a void or under an overhang.
  const solidRects = () =>
    entities
      .filter((e) => MATERIAL_SPECS[e.material].solid)
      .map((e) => toWorld(e.box));

  const placed = chooseSpawn(
    surfaces,
    solidRects(),
    spawn.x * WORLD_W,
    spawn.y * WORLD_H,
  );
  if (placed.trapped) {
    repairs.push(
      "Every candidate start was wedged under an overhang; used the roomiest one.",
    );
  } else if (Math.abs(placed.x - spawn.x * WORLD_W) > PLAYER_W) {
    repairs.push(
      "Moved the start clear of an overhang the player could not jump out of.",
    );
  }
  let spawnIdx = placed.idx;
  spawn = {
    x: placed.x / WORLD_W,
    y: (surfaces[spawnIdx].y - 6) / WORLD_H,
  };

  let reach = reachableSet(surfaces, spawnIdx);

  /**
   * Cap how far the goal can float above the scene.
   *
   * If the model drops the goal high over an empty floor, the reachability
   * proof can still be satisfied — by erecting a tower of invented platforms in
   * open air. That is a correct answer to the wrong question: a photo of a bare
   * wall should not become a tower-climbing game, and a staircase that long is
   * miserable to climb. Bringing the goal down to a height the scene can
   * actually support keeps the level faithful to the photo, and leaves bridging
   * to do what it is good at — spanning a gap or two.
   */
  const MAX_CLIMB = JUMP_HEIGHT * 2.2;
  {
    let highest = Infinity;
    let highestSurface: Surface | null = null;
    for (const i of reach) {
      if (surfaces[i].y < highest) {
        highest = surfaces[i].y;
        highestSurface = surfaces[i];
      }
    }
    if (highestSurface && goalY < highest - MAX_CLIMB) {
      goalY = highest - JUMP_HEIGHT * 1.15;
      goalX = Math.max(
        highestSurface.x1 + PLAYER_W,
        Math.min(highestSurface.x2 - PLAYER_W, goalX),
      );
      goal = { x: goalX / WORLD_W, y: goalY / WORLD_H };
      repairs.push(
        "Lowered the goal — it floated far above anything in the scene.",
      );
      // Moving the goal invalidates its landing, so rebuild both.
      ensureGoalSupport();
      spawnIdx = nearestSurfaceIndex(
        surfaces,
        spawn.x * WORLD_W,
        spawn.y * WORLD_H,
      );
      reach = reachableSet(surfaces, spawnIdx);
    }
  }

  let bridges = 0;

  for (let attempt = 0; attempt < 16; attempt++) {
    if (goalReachable(surfaces, reach, goalX, goalY)) break;
    const bridge = bridgeToward(surfaces, reach, goalX, goalY, solidRects());
    if (!bridge) break;
    // Never drop a bridge on top of a hazard - that would "fix" the level into
    // an instant death.
    const br = toWorld(bridge.box);
    const onHazard = entities.some((e) => {
      if (e.material !== "hazard") return false;
      const h = toWorld(e.box);
      return (
        br.x < h.x + h.w && br.x + br.w > h.x && br.y < h.y + h.h && br.y + br.h > h.y
      );
    });
    if (onHazard) bridge.box.y -= 46 / WORLD_H;

    entities.push(bridge);
    surfaces = buildSurfaces(entities);
    spawnIdx = nearestSurfaceIndex(surfaces, spawn.x * WORLD_W, spawn.y * WORLD_H);
    reach = reachableSet(surfaces, spawnIdx);
    bridges++;
  }

  if (bridges > 0) {
    repairs.push(
      `Inserted ${bridges} bridge platform${bridges > 1 ? "s" : ""} to guarantee the goal is reachable.`,
    );
  }

  /**
   * Final pass, recomputed from scratch.
   *
   * Every repair above changes the geometry the previous ones reasoned about,
   * so nothing earlier is trusted here. If the goal still is not provably
   * reachable, it is parked on the reachable surface with the most room to
   * stand — a duller level than intended, but a finishable one, which is the
   * promise the app actually makes.
   */
  surfaces = buildSurfaces(entities);
  const finalSolids = solidRects();
  const finalSpawn = chooseSpawn(
    surfaces,
    finalSolids,
    spawn.x * WORLD_W,
    spawn.y * WORLD_H,
  );
  spawnIdx = finalSpawn.idx;
  spawn = {
    x: finalSpawn.x / WORLD_W,
    y: (surfaces[spawnIdx].y - 6) / WORLD_H,
  };
  reach = reachableSet(surfaces, spawnIdx);

  if (!goalReachable(surfaces, reach, goalX, goalY)) {
    let bestIdx = spawnIdx;
    let bestSpan = -1;
    for (const i of reach) {
      const { span } = clearRun(surfaces[i], finalSolids);
      // Prefer a roomy landing; break ties by height, for a level worth playing.
      if (span > bestSpan || (span === bestSpan && surfaces[i].y < surfaces[bestIdx].y)) {
        bestSpan = span;
        bestIdx = i;
      }
    }
    const target = surfaces[bestIdx];
    const { centre } = clearRun(target, finalSolids);
    goalX = centre;
    goalY = target.y - 10;
    goal = { x: goalX / WORLD_W, y: goalY / WORLD_H };
    repairs.push("Relocated the goal onto a verified-reachable surface.");
  }

  const ok = goalReachable(surfaces, reach, goalX, goalY);

  // --- inhabitants ------------------------------------------------------
  const spawnIdxFinal = nearestSurfaceIndex(
    surfaces,
    spawn.x * WORLD_W,
    spawn.y * WORLD_H,
  );
  // Auto-placement fills a gap; it never overrides a hand-authored scene. The
  // built-in levels position their patrols and pipes deliberately, and a
  // generic pass would quietly throw that work away.
  const monsters =
    raw.monsters && raw.monsters.length > 0
      ? raw.monsters
      : placeMonsters(surfaces, reach, spawnIdxFinal, spawn.x * WORLD_W);

  const alreadyHasTunnel = entities.some((e) => e.material === "tunnel");
  const tunnel = alreadyHasTunnel
    ? null
    : placeTunnel(
        entities,
        surfaces,
        reach,
        spawn.x * WORLD_W,
        goal.x * WORLD_W,
      );
  if (tunnel) {
    // A pipe is solid, so it can cap a surface the route depended on. Add it,
    // re-prove the level, and take it back out if the proof no longer holds.
    const trial = [...entities, tunnel];
    const trialSurfaces = buildSurfaces(trial);
    const trialIdx = nearestSurfaceIndex(
      trialSurfaces,
      spawn.x * WORLD_W,
      spawn.y * WORLD_H,
    );
    const trialReach = reachableSet(trialSurfaces, trialIdx);
    if (
      goalReachable(
        trialSurfaces,
        trialReach,
        goal.x * WORLD_W,
        goal.y * WORLD_H,
      )
    ) {
      entities = trial;
    } else {
      repairs.push("Skipped a tunnel that would have blocked the route.");
    }
  }

  return {
    level: { ...raw, entities, spawn, goal, repairs, monsters },
    report: {
      ok,
      repairs,
      surfaces: surfaces.length,
      coverage: surfaces.length ? reach.size / surfaces.length : 1,
    },
  };
}
