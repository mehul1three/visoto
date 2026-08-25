/**
 * Completability harness.
 *
 * The solver proves the goal is reachable on paper, using a jump-arc model.
 * This checks the claim empirically instead: it turns loose a swarm of bots on
 * the real physics engine and sees whether any of them actually finishes. If
 * the proof and the engine ever disagree, this is what catches it.
 *
 *   npm run verify
 */

import { SAMPLES } from "../lib/samples";
import { solve } from "../lib/solver";
import { MONSTER_H, PLAYER_H, PLAYER_W, World } from "../lib/physics";
import { WORLD_W, type Level } from "../lib/level";
import { normalise } from "../lib/normalise";
import { buildBonusWorld } from "../lib/bonus";

const TICK = 1000 / 120;
const MAX_SECONDS = 45;

/** Deterministic PRNG so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Trial {
  won: boolean;
  seconds: number;
  deaths: number;
  collected: number;
}

/**
 * A bot with three instincts: keep going right, jump when something blocks it,
 * and jump at random otherwise. Deliberately dumb — if a level needs finesse a
 * player will not have, this fails and the level was too hard.
 */
function trial(level: Level, seed: number): Trial {
  const rand = rng(seed);
  const w = new World(level);
  const goalX = level.goal.x * WORLD_W;
  let jumpHold = 0;
  let dir: 1 | -1 = w.player.x < goalX ? 1 : -1;
  let stuckFor = 0;
  let lastX = w.player.x;

  const maxTicks = (MAX_SECONDS * 1000) / TICK;
  for (let t = 0; t < maxTicks && !w.won; t++) {
    const p = w.player;

    if (Math.abs(p.x - lastX) < 0.4) stuckFor++;
    else stuckFor = 0;
    lastX = p.x;

    // Wedged against something: jump, and occasionally back off.
    if (stuckFor > 24 && jumpHold <= 0) {
      jumpHold = 46;
      stuckFor = 0;
      if (rand() < 0.3) dir = dir === 1 ? -1 : 1;
    }
    // Random hops keep it from settling into a loop.
    if (jumpHold <= 0 && rand() < 0.02) jumpHold = 30 + Math.floor(rand() * 24);
    // Head for the flag, the way a player who can see it would, with enough
    // noise to still stumble into alternative routes.
    if (rand() < 0.03) dir = p.x < goalX ? 1 : -1;
    if (rand() < 0.006) dir = dir === 1 ? -1 : 1;
    if (p.x < 40) dir = 1;
    if (p.x > WORLD_W - 60) dir = -1;

    w.step(
      {
        left: dir === -1,
        right: dir === 1,
        up: rand() < 0.35, down: false,
        jump: jumpHold > 0,
      },
      TICK,
    );
    if (jumpHold > 0) jumpHold--;
  }

  return {
    won: w.won,
    seconds: w.elapsed / 1000,
    deaths: w.deaths,
    collected: w.collected,
  };
}

function run(name: string, level: Level, trials = 400): boolean {
  const { level: solved, report } = solve(level);
  const results: Trial[] = [];
  for (let i = 0; i < trials; i++) results.push(trial(solved, i * 7919 + 13));

  const wins = results.filter((r) => r.won);
  const rate = wins.length / trials;
  const fastest = wins.length
    ? Math.min(...wins.map((r) => r.seconds)).toFixed(1) + "s"
    : "—";

  const ok = wins.length > 0;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} ` +
      `win ${(rate * 100).toFixed(1)}%`.padEnd(13) +
      `fastest ${fastest}`.padEnd(17) +
      `surfaces ${report.surfaces}  reachable ${Math.round(report.coverage * 100)}%` +
      (report.repairs.length ? `  repairs ${report.repairs.length}` : ""),
  );
  if (!ok) {
    console.log("      solver said reachable, but no bot finished. Repairs:");
    for (const r of report.repairs) console.log("        - " + r);
  }
  return ok;
}

/** Levels engineered to be hostile, to exercise the repair paths. */
const ADVERSARIAL: Array<{ name: string; level: Level }> = [
  {
    name: "goal across a chasm",
    level: {
      version: 1, title: "Chasm", tagline: "", spawn: { x: 0.05, y: 0.9 }, goal: { x: 0.92, y: 0.12 },
      entities: [
        { id: "a", label: "ledge", material: "solid", reason: "-", box: { x: 0, y: 0.9, w: 0.18, h: 0.1 } },
        { id: "b", label: "tower", material: "solid", reason: "-", box: { x: 0.86, y: 0.18, w: 0.14, h: 0.8 } },
      ],
    },
  },
  {
    name: "no floor at all",
    level: {
      version: 1, title: "Void", tagline: "", spawn: { x: 0.1, y: 0.5 }, goal: { x: 0.8, y: 0.4 },
      entities: [
        { id: "a", label: "flame", material: "hazard", reason: "-", box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } },
      ],
    },
  },
  {
    name: "degenerate boxes",
    level: {
      version: 1, title: "Junk", tagline: "", spawn: { x: 1.4, y: -0.3 }, goal: { x: 0.7, y: 0.2 },
      entities: [
        { id: "a", label: "whole room", material: "solid", reason: "-", box: { x: 0, y: 0, w: 1, h: 1 } },
        { id: "b", label: "shelf", material: "solid", reason: "-", box: { x: 0.3, y: 0.5, w: 0.2, h: 0.1 } },
        { id: "c", label: "shelf dupe", material: "solid", reason: "-", box: { x: 0.31, y: 0.51, w: 0.2, h: 0.1 } },
        { id: "d", label: "speck", material: "hazard", reason: "-", box: { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 } },
      ],
    },
  },
  {
    name: "spawn under an overhang",
    level: {
      version: 1, title: "Trap", tagline: "", spawn: { x: 0.06, y: 0.86 }, goal: { x: 0.9, y: 0.2 },
      entities: [
        { id: "f", label: "floor", material: "solid", reason: "-", box: { x: 0, y: 0.88, w: 1, h: 0.12 } },
        { id: "o", label: "low shelf", material: "solid", reason: "-", box: { x: 0, y: 0.74, w: 0.22, h: 0.05 } },
        { id: "w", label: "wall", material: "solid", reason: "-", box: { x: 0.22, y: 0.4, w: 0.06, h: 0.48 } },
        { id: "t", label: "top", material: "solid", reason: "-", box: { x: 0.8, y: 0.28, w: 0.2, h: 0.06 } },
      ],
    },
  },
];

let failures = 0;

console.log("\nsamples");
for (const s of SAMPLES) if (!run(s.name, s.level)) failures++;

console.log("\nadversarial");
for (const a of ADVERSARIAL) if (!run(a.name, a.level)) failures++;



/**
 * Mechanics.
 *
 * Stomp-versus-death is decided by one comparison, and getting it backwards
 * means either an unkillable monster or a game where walking into one is free.
 * Tunnel entry has to fire once, on the right pipe, and only while grounded.
 * None of that is visible in a completability run, so it is asserted directly.
 */
console.log("\nmechanics");
{
  const NONE = { left: false, right: false, up: false, down: false, jump: false };
  const checks: Array<[string, boolean]> = [];

  // --- tunnel entry ---------------------------------------------------
  {
    const level = solve(SAMPLES[0].level).level;
    const w = new World(level);
    const pipe = w.bodies.find((b) => b.entity.material === "tunnel")!;
    w.player.x = pipe.x + pipe.w / 2 - PLAYER_W / 2;
    w.player.y = pipe.y - PLAYER_H;

    // Settle onto the pipe first: entry requires being grounded.
    for (let i = 0; i < 20; i++) w.step(NONE, 1000 / 120);
    checks.push(["stands on the pipe", w.player.grounded]);

    const evs = w.step({ ...NONE, down: true }, 1000 / 120);
    const ev = evs.find((e) => e.type === "tunnel");
    checks.push(["down enters the tunnel", Boolean(ev)]);
    checks.push(["reports which pipe", ev?.id === pipe.entity.id]);

    // Mid-air presses must not warp the player.
    const w2 = new World(level);
    w2.player.y -= 200;
    const air = w2.step({ ...NONE, down: true }, 1000 / 120);
    checks.push(["airborne down does nothing", !air.some((e) => e.type === "tunnel")]);
  }

  // --- bonus world ----------------------------------------------------
  {
    const a = buildBonusWorld("desk", "pipe").level;
    const b = buildBonusWorld("desk", "pipe").level;
    checks.push([
      "bonus room is deterministic",
      JSON.stringify(a.entities) === JSON.stringify(b.entities),
    ]);
    checks.push([
      "different pipes give different rooms",
      JSON.stringify(buildBonusWorld("desk", "other").level.entities) !==
        JSON.stringify(a.entities),
    ]);
    const bw = new World(a);
    checks.push(["bonus room has coins", bw.totalCollectible >= 5]);
    checks.push([
      "bonus room has a way out",
      a.entities.some((e) => e.material === "tunnel"),
    ]);
  }

  // --- stomp versus death ---------------------------------------------
  {
    const level = solve(SAMPLES[0].level).level;

    const w = new World(level);
    const m = w.monsters[0];
    // Falling onto its head.
    w.player.x = m.x + m.w / 2 - PLAYER_W / 2;
    w.player.y = m.y - PLAYER_H + 2;
    w.player.vy = 300;
    const evs = w.step(NONE, 1000 / 120);
    checks.push(["falling on a monster stomps it", evs.some((e) => e.type === "stomp")]);
    checks.push(["stomped monster dies", !w.monsters[0].alive]);
    checks.push(["stomp bounces the player up", w.player.vy < 0]);

    const w2 = new World(level);
    const m2 = w2.monsters[0];
    // Walking into its side, rising rather than falling.
    w2.player.x = m2.x + 4;
    w2.player.y = m2.y + MONSTER_H - PLAYER_H;
    w2.player.vy = -50;
    const evs2 = w2.step(NONE, 1000 / 120);
    checks.push(["walking into one is fatal", evs2.some((e) => e.type === "death")]);
    checks.push(["monster survives a side hit", w2.monsters[0].alive]);

    // A death must put the whole patrol back, or a level could be cleared by
    // trading lives for enemies.
    const w3 = new World(level);
    w3.monsters[0].alive = false;
    w3.reset(false);
    checks.push(["death revives the patrol", w3.monsters[0].alive]);
  }

  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failures++;
  }
}

/**
 * Conversion correctness.
 *
 * Gemini speaks [ymin, xmin, ymax, xmax] at 0-1000; the engine speaks
 * {x, y, w, h} as fractions. Getting that transposition wrong would put every
 * box in the wrong place while still producing a level that looks superficially
 * plausible, so it is asserted rather than assumed.
 */
console.log("\ncoordinate conversion");
{
  const lvl = normalise({
    title: "t",
    tagline: "g",
    entities: [
      { label: "a", material: "bouncy", reason: "r", box_2d: [100, 200, 300, 600] },
      // Transposed pair — the model does this occasionally and it is recoverable.
      { label: "b", material: "solid", reason: "r", box_2d: [700, 900, 500, 400] },
    ],
    spawn: [250, 750],
    goal: [800, 125],
  });
  const checks: Array<[string, boolean]> = [
    ["ymin/xmin -> y/x", lvl.entities[0].box.x === 0.2 && lvl.entities[0].box.y === 0.1],
    ["extent -> w/h", lvl.entities[0].box.w === 0.4 && lvl.entities[0].box.h === 0.2],
    ["material preserved", lvl.entities[0].material === "bouncy"],
    [
      "flipped box recovered",
      Math.abs(lvl.entities[1].box.x - 0.4) < 1e-9 &&
        Math.abs(lvl.entities[1].box.w - 0.5) < 1e-9 &&
        Math.abs(lvl.entities[1].box.y - 0.5) < 1e-9 &&
        Math.abs(lvl.entities[1].box.h - 0.2) < 1e-9,
    ],
    ["point [y,x] -> {x,y}", lvl.spawn.x === 0.75 && lvl.spawn.y === 0.25],
    ["goal point", lvl.goal.x === 0.125 && lvl.goal.y === 0.8],
  ];
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failures++;
  }
}

/**
 * Hostile model output.
 *
 * The response schema constrains the reply, but nothing guarantees the numbers
 * are finite, the arrays are the right length, or the material is one we know.
 * These payloads are what a bad day looks like; none may throw, and each must
 * still yield a level someone could finish.
 */
const MALFORMED: Array<{ name: string; payload: unknown }> = [
  { name: "empty object", payload: {} },
  { name: "entities not an array", payload: { title: "x", entities: "nope" } },
  { name: "null entries", payload: { entities: [null, undefined, 42] } },
  {
    name: "missing box_2d",
    payload: { entities: [{ label: "a", material: "solid", reason: "r" }] },
  },
  {
    name: "short box_2d array",
    payload: { entities: [{ label: "a", material: "solid", reason: "r", box_2d: [1, 2] }] },
  },
  {
    name: "NaN and infinite boxes",
    payload: {
      entities: [
        { label: "a", material: "solid", reason: "r", box_2d: [NaN, 100, Infinity, 400] },
        { label: "b", material: "solid", reason: "r", box_2d: [600, 300, 700, 600] },
        { label: "c", material: "solid", reason: "r", box_2d: [300, 500, 400, 800] },
      ],
      spawn: [NaN, NaN],
      goal: [null, "high"],
    },
  },
  {
    name: "unknown material",
    payload: {
      entities: [
        { label: "a", material: "explosive", reason: "r", box_2d: [800, 100, 900, 400] },
        { label: "b", material: 7, reason: "r", box_2d: [600, 600, 700, 900] },
        { label: "c", material: null, reason: "r", box_2d: [400, 300, 500, 600] },
      ],
    },
  },
  {
    name: "sub-pixel specks only",
    payload: {
      entities: Array.from({ length: 5 }, (_, i) => ({
        label: "speck", material: "solid", reason: "r",
        box_2d: [500, 100 * i, 501, 100 * i + 1],
      })),
    },
  },
  {
    name: "coordinates far out of range",
    payload: {
      entities: [
        { label: "a", material: "solid", reason: "r", box_2d: [-5000, -900, 40000, 30000] },
        { label: "b", material: "bouncy", reason: "r", box_2d: [700, 400, 800, 700] },
      ],
      spawn: [99000, -99000],
      goal: [-3000, 7000],
    },
  },
];

console.log("\nmalformed model output");
for (const { name, payload } of MALFORMED) {
  try {
    const lvl = normalise(payload as Parameters<typeof normalise>[0]);
    if (lvl.entities.length === 0) {
      // The route rejects this with a clear 422 rather than shipping a blank level.
      console.log(`PASS  ${name.padEnd(28)} rejected cleanly (0 usable objects)`);
      continue;
    }
    if (!run(name, lvl, 200)) failures++;
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(28)} threw: ${(e as Error).message}`);
    failures++;
  }
}

console.log(
  failures === 0
    ? "\nall levels completable\n"
    : `\n${failures} level(s) could not be completed\n`,
);
process.exit(failures === 0 ? 1 && 0 : 1);
