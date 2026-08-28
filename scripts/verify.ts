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
import { jumpReach, solve } from "../lib/solver";
import {
  JUMP_HEIGHT,
  MONSTER_H,
  PLAYER_H,
  PLAYER_W,
  World,
  type StepEvent,
} from "../lib/physics";
import { MATERIAL_SPECS, WORLD_W, toWorld, type Level } from "../lib/level";
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

    // Falling onto the pipe is enough — no key, no press.
    let entered: StepEvent | undefined;
    for (let i = 0; i < 40 && !entered; i++) {
      entered = w.step(NONE, 1000 / 120).find((e) => e.type === "tunnel");
    }
    checks.push(["landing on a pipe enters it", Boolean(entered)]);
    checks.push(["reports which pipe", entered?.id === pipe.entity.id]);

    // ...but only on arrival. Standing on one must not fire again, or coming
    // back out of a chamber drops you straight back into it forever.
    const again = w.step(NONE, 1000 / 120).some((e) => e.type === "tunnel");
    checks.push(["standing on it does not re-fire", !again]);

    // Mid-air over a pipe is not standing on it.
    const w2 = new World(level);
    w2.player.x = pipe.x + pipe.w / 2 - PLAYER_W / 2;
    w2.player.y = pipe.y - PLAYER_H - 220;
    const air = w2.step(NONE, 1000 / 120);
    checks.push(["airborne over a pipe does nothing", !air.some((e) => e.type === "tunnel")]);
  }

  // --- bonus world ----------------------------------------------------
  {
    const a = buildBonusWorld("desk", "pipe").level;
    const b = buildBonusWorld("desk", "pipe").level;
    checks.push([
      "bonus room is deterministic",
      JSON.stringify(a.entities) === JSON.stringify(b.entities),
    ]);
    // The layout is deliberately identical; what must differ is the level id,
    // because that is what scopes the coin ledger. Two pipes sharing an id
    // would mean the second chamber you visit pays nothing.
    checks.push([
      "different pipes are separately paid",
      buildBonusWorld("desk", "other").level.id !== a.id &&
        buildBonusWorld("living", "pipe").level.id !== a.id,
    ]);
    const bw = new World(a);
    checks.push(["bonus room is well paid", bw.totalCollectible >= 15]);
    checks.push([
      "bonus room has a way out",
      a.entities.some((e) => e.material === "tunnel"),
    ]);

    /**
     * The chamber has to be climbable.
     *
     * Bonus rooms never pass through solve(), so nothing else would notice an
     * impossible climb. A random bot is the wrong instrument here — the room is
     * meant to be hard, so a bot failing proves nothing either way. Instead
     * every consecutive step of the intended route is measured against the
     * real jump arc.
     */
    const climb = ["bfloor", "bl0", "bl1", "bl2", "bl3", "bl4", "bl5"];
    const rectOf = (id: string) => {
      const e = a.entities.find((x) => x.id === id)!;
      return toWorld(e.box);
    };
    let climbOk = true;
    for (let i = 0; i < climb.length - 1; i++) {
      const from = rectOf(climb[i]);
      const to = rectOf(climb[i + 1]);
      const rise = from.y - to.y;
      const gap =
        from.x + from.w >= to.x && to.x + to.w >= from.x
          ? 0
          : from.x + from.w < to.x
            ? to.x - (from.x + from.w)
            : from.x - (to.x + to.w);
      const reach = jumpReach(rise);
      if (rise > JUMP_HEIGHT * 0.85 || reach < 0 || gap > reach * 0.85) {
        console.log(
          `      ${climb[i]} -> ${climb[i + 1]}: rise ${rise.toFixed(0)} gap ${gap.toFixed(0)} reach ${reach.toFixed(0)}`,
        );
        climbOk = false;
      }
    }
    checks.push(["every step of the climb is inside a jump", climbOk]);

    /**
     * Every standable thing needs room to stand.
     *
     * The climb test above measured the ledges and passed while the exit pipe
     * was unusable — its lip left 30px of clearance under the ceiling for a
     * 46px player, so the one surface that mattered was the one nothing
     * checked. A platform you cannot occupy is not a platform, and the failure
     * is invisible until someone walks up to it.
     */
    const solidRects = a.entities
      .filter((e) => MATERIAL_SPECS[e.material].solid)
      .map((e) => ({ id: e.id, r: toWorld(e.box) }));
    let headroomOk = true;
    for (const { id, r } of solidRects) {
      if (id === "bceil" || id === "bleft" || id === "bright") continue;
      // Scan along the surface: somewhere to stand is enough. Sampling only
      // the centre flags a ledge with a pipe sitting on its middle, which is
      // fine to walk around.
      let anyRoom = false;
      for (let x = r.x + PLAYER_W / 2; x <= r.x + r.w - PLAYER_W / 2; x += 12) {
        const stand = {
          x: x - PLAYER_W / 2,
          y: r.y - PLAYER_H,
          w: PLAYER_W,
          h: PLAYER_H,
        };
        const hit = solidRects.some(
          ({ id: other, r: o }) =>
            other !== id &&
            stand.x < o.x + o.w &&
            stand.x + stand.w > o.x &&
            stand.y < o.y + o.h &&
            stand.y + stand.h > o.y,
        );
        if (!hit) {
          anyRoom = true;
          break;
        }
      }
      if (!anyRoom) {
        console.log(`      "${id}" has no room to stand on it`);
        headroomOk = false;
      }
    }
    checks.push(["every surface has room to stand on", headroomOk]);
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
 * Randomised model output.
 *
 * The hand-written adversarial cases below were chosen by me, which means they
 * test the failures I already thought of. Real photographs produce shapes I did
 * not think of — that is how a spawn-adjacent goal, an unreachable goal and a
 * walk-in-a-straight-line level all shipped at once.
 *
 * So: many random levels, each asserted on the three properties that make a
 * level worth playing at all — the goal is reachable, the route is more than a
 * couple of jumps, and it crosses a decent part of the frame.
 */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MATERIAL_MIX: Array<Level["entities"][number]["material"]> = [
  "solid", "solid", "solid", "solid", "solid", "solid",
  "bouncy", "hazard", "slippery", "crumbling",
];

function randomLevel(seed: number): Level {
  const rand = mulberry(seed);
  const count = 5 + Math.floor(rand() * 10);
  const entities: Level["entities"] = [];
  for (let i = 0; i < count; i++) {
    const w = 0.05 + rand() * 0.22;
    const h = 0.02 + rand() * 0.13;
    entities.push({
      id: `e${i}`,
      label: `object ${i}`,
      material: MATERIAL_MIX[Math.floor(rand() * MATERIAL_MIX.length)],
      reason: "randomised",
      box: { x: rand() * (1 - w), y: 0.12 + rand() * (0.84 - h), w, h },
    });
  }
  return {
    version: 1,
    title: `Random ${seed}`,
    tagline: "generated",
    entities,
    spawn: { x: rand(), y: rand() },
    goal: { x: rand(), y: rand() },
  };
}

console.log("\nrandomised model output (60 levels)");
{
  const N = 60;
  let unreachable = 0;
  let tooShort = 0;
  let tooNarrow = 0;
  let botFailed = 0;
  let unusablePipes = 0;
  const hopList: number[] = [];

  for (let seed = 1; seed <= N; seed++) {
    const { level, report } = solve(randomLevel(seed));
    hopList.push(report.hops);

    if (report.hops === 0) {
      unreachable++;
      console.log(`FAIL  seed ${seed}: goal not reachable from spawn`);
      continue;
    }
    if (report.hops < 2) tooShort++;
    if (report.span < 0.3) tooNarrow++;

    // Anything the player is meant to stand on must have room to stand on it —
    // pipes especially, since an unusable pipe is a dead end that looks like a
    // feature.
    const rects = level.entities
      .filter((e) => MATERIAL_SPECS[e.material].solid)
      .map((e) => ({ e, r: toWorld(e.box) }));
    for (const { e, r } of rects) {
      if (e.material !== "tunnel") continue;
      const lip = {
        x: r.x,
        y: r.y - PLAYER_H - 4,
        w: r.w,
        h: PLAYER_H + 4,
      };
      const blocked = rects.some(
        ({ e: o, r: q }) =>
          o.id !== e.id &&
          lip.x < q.x + q.w &&
          lip.x + lip.w > q.x &&
          lip.y < q.y + q.h &&
          lip.y + lip.h > q.y,
      );
      if (blocked) {
        unusablePipes++;
        console.log(`FAIL  seed ${seed}: pipe "${e.id}" has no room to stand on`);
      }
    }

    // Empirical check on a sample, using the same bot the rest of the harness
    // uses. A weaker ad-hoc bot would make solver bugs and bot weakness
    // indistinguishable, which is worse than not testing it.
    if (seed % 6 === 0) {
      let won = false;
      for (let i = 0; i < 300 && !won; i++) {
        won = trial(level, seed * 7919 + i).won;
      }
      if (!won) {
        botFailed++;
        console.log(
          `FAIL  seed ${seed}: solver says ${report.hops} hops, no bot finished in 300 trials`,
        );
      }
    }
  }

  hopList.sort((a, b) => a - b);
  const median = hopList[Math.floor(hopList.length / 2)];
  console.log(
    `      hops: min ${hopList[0]}  median ${median}  max ${hopList[hopList.length - 1]}`,
  );
  const problems = unreachable + tooShort + tooNarrow + botFailed + unusablePipes;
  console.log(
    `${problems === 0 ? "PASS" : "FAIL"}  unreachable ${unreachable}  trivial(<2 hops) ${tooShort}  narrow(<30% span) ${tooNarrow}  bot-failed ${botFailed}  unusable-pipes ${unusablePipes}`,
  );
  failures += problems;
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
