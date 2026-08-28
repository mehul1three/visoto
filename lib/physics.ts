/**
 * Deterministic fixed-timestep AABB platformer.
 *
 * Tuning constants are exported because the reachability solver has to reason
 * about the exact same jump arc the player will experience — if these two
 * drift, the solver will certify levels that are not actually completable.
 */

import {
  Entity,
  Level,
  MATERIAL_SPECS,
  MonsterSpawn,
  Rect,
  WORLD_H,
  WORLD_W,
  toWorld,
} from "./level";

export const GRAVITY = 2400;
export const MOVE_SPEED = 400;
export const JUMP_V = 820;
export const BOUNCE_MULT = 1.7;
export const CLIMB_SPEED = 260;
export const PLAYER_W = 34;
export const PLAYER_H = 46;
export const CRUMBLE_MS = 600;
export const COYOTE_MS = 90;
export const JUMP_BUFFER_MS = 120;
export const MAX_FALL = 1400;
export const FIXED_DT = 1 / 120;

export const MONSTER_W = 38;
export const MONSTER_H = 32;
export const MONSTER_SPEED = 110;
/** Upward kick given to the player for a successful stomp. */
export const STOMP_BOUNCE = 620;

/** Peak height of a standing jump, in world units. Derived, never hardcoded. */
export const JUMP_HEIGHT = (JUMP_V * JUMP_V) / (2 * GRAVITY);
/** Horizontal distance covered over a full jump arc from flat ground. */
export const JUMP_RANGE = MOVE_SPEED * ((2 * JUMP_V) / GRAVITY);

export interface Body extends Rect {
  entity: Entity;
  /** Set while a crumbling platform is collapsing. */
  crumbleAt?: number;
  /** Wall-clock ms at which a crumbled platform returns. */
  respawnAt?: number;
  taken?: boolean;
}

export interface Input {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
}

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  climbing: boolean;
  facing: 1 | -1;
  /** ms since last grounded, for coyote time. */
  airborneFor: number;
  /** ms since jump was pressed, for input buffering. */
  jumpBuffered: number;
}

export interface Monster extends Rect {
  id: string;
  dir: 1 | -1;
  vy: number;
  alive: boolean;
  /** Wall-clock ms at which a squashed monster stops being drawn. */
  goneAt?: number;
  /** Where it started, so a reset can put it back. */
  home: { x: number; y: number };
}

export interface StepEvent {
  type:
    | "bounce"
    | "collect"
    | "death"
    | "win"
    | "crumble"
    | "land"
    | "stomp"
    | "tunnel";
  x?: number;
  y?: number;
  /** Which collectible, so progress can pay each coin exactly once. */
  id?: string;
  /** What killed the player, so the retry screen can say so. */
  cause?: string;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export class World {
  level: Level;
  bodies: Body[] = [];
  player: PlayerState;
  goal: Rect;
  spawn: { x: number; y: number };
  monsters: Monster[] = [];
  /**
   * The pipe the player is currently standing on.
   *
   * Entry is edge-triggered off this: a pipe fires when the player *arrives* on
   * it, never while they remain there. Without that, returning from a chamber
   * drops you back onto the pipe you came out of and you fall straight back in,
   * forever.
   */
  standingOnTunnel: string | null = null;
  collected = 0;
  totalCollectible = 0;
  deaths = 0;
  stomped = 0;
  won = false;
  /** ms of gameplay elapsed, used for the run timer. */
  elapsed = 0;
  private now = 0;

  constructor(level: Level) {
    this.level = level;
    this.bodies = level.entities.map((e) => ({ ...toWorld(e.box), entity: e }));
    this.totalCollectible = this.bodies.filter(
      (b) => b.entity.material === "collectible",
    ).length;
    this.spawn = {
      x: level.spawn.x * WORLD_W - PLAYER_W / 2,
      y: level.spawn.y * WORLD_H - PLAYER_H,
    };
    this.goal = {
      x: level.goal.x * WORLD_W - 22,
      y: level.goal.y * WORLD_H - 44,
      w: 44,
      h: 44,
    };
    this.monsters = (level.monsters ?? []).map((m: MonsterSpawn) => ({
      id: m.id,
      x: m.x * WORLD_W - MONSTER_W / 2,
      y: m.y * WORLD_H - MONSTER_H,
      w: MONSTER_W,
      h: MONSTER_H,
      dir: -1 as const,
      vy: 0,
      alive: true,
      home: { x: m.x * WORLD_W - MONSTER_W / 2, y: m.y * WORLD_H - MONSTER_H },
    }));
    this.player = this.freshPlayer();
  }

  private freshPlayer(): PlayerState {
    return {
      x: this.spawn.x,
      y: this.spawn.y,
      vx: 0,
      vy: 0,
      grounded: false,
      climbing: false,
      facing: 1,
      airborneFor: 999,
      jumpBuffered: 999,
    };
  }

  reset(full = false) {
    this.player = this.freshPlayer();
    this.standingOnTunnel = null;
    // Always revive the patrol. Leaving a stomped monster dead after the player
    // dies would let you clear a level by trading lives for enemies, and
    // leaving a live one mid-lunge can kill you again the instant you respawn.
    for (const m of this.monsters) {
      m.x = m.home.x;
      m.y = m.home.y;
      m.dir = -1;
      m.vy = 0;
      m.alive = true;
      m.goneAt = undefined;
    }
    if (full) {
      this.collected = 0;
      this.deaths = 0;
      this.stomped = 0;
      this.won = false;
      this.elapsed = 0;
      for (const b of this.bodies) {
        b.taken = false;
        b.crumbleAt = undefined;
        b.respawnAt = undefined;
      }
    }
  }

  /**
   * Restart the run: clock, coins and collapsed platforms back to the start.
   *
   * Deliberately keeps the fall count. It is the one number that should survive
   * a retry — it says how many attempts this has taken, which is exactly what a
   * player wants to know and what a fresh zero would hide.
   */
  restartRun() {
    const falls = this.deaths;
    this.reset(true);
    this.deaths = falls;
  }

  /** Advances one fixed tick. Returns events for the renderer/audio to react to. */
  step(input: Input, dtMs: number): StepEvent[] {
    const events: StepEvent[] = [];
    if (this.won) return events;

    const dt = FIXED_DT;
    this.now += dtMs;
    this.elapsed += dtMs;
    const p = this.player;

    // --- restore crumbled platforms -------------------------------------
    for (const b of this.bodies) {
      if (b.respawnAt !== undefined && this.now >= b.respawnAt) {
        b.respawnAt = undefined;
        b.crumbleAt = undefined;
      }
    }

    const activeSolids = this.bodies.filter(
      (b) =>
        MATERIAL_SPECS[b.entity.material].solid && b.respawnAt === undefined,
    );

    // --- climbing -------------------------------------------------------
    const playerRect = { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H };
    const onLadder = this.bodies.some(
      (b) => b.entity.material === "climbable" && overlaps(playerRect, b),
    );
    p.climbing = onLadder && input.up;

    // --- horizontal -----------------------------------------------------
    const standingOn = this.groundBodyUnder(p, activeSolids);
    const slippery = standingOn?.entity.material === "slippery";
    const accel = slippery ? 900 : 3400;
    const friction = slippery ? 260 : 3400;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    if (dir !== 0) {
      p.vx += dir * accel * dt;
      p.vx = Math.max(-MOVE_SPEED, Math.min(MOVE_SPEED, p.vx));
      p.facing = dir > 0 ? 1 : -1;
    } else {
      const drop = friction * dt;
      p.vx = Math.abs(p.vx) <= drop ? 0 : p.vx - Math.sign(p.vx) * drop;
    }

    // --- vertical -------------------------------------------------------
    p.jumpBuffered = input.jump ? 0 : p.jumpBuffered + dtMs;
    p.airborneFor = p.grounded ? 0 : p.airborneFor + dtMs;

    if (p.climbing) {
      p.vy = -CLIMB_SPEED;
      p.airborneFor = 0;
    } else {
      p.vy += GRAVITY * dt;
      if (p.vy > MAX_FALL) p.vy = MAX_FALL;
    }

    const canJump =
      p.jumpBuffered <= JUMP_BUFFER_MS &&
      (p.airborneFor <= COYOTE_MS || p.climbing);
    if (canJump) {
      p.vy = -JUMP_V;
      p.jumpBuffered = 999;
      p.airborneFor = 999;
      p.grounded = false;
    }
    // Variable jump height: releasing early cuts the arc short.
    if (!input.jump && p.vy < -JUMP_V * 0.35) p.vy = -JUMP_V * 0.35;

    // --- integrate + resolve, axis at a time ----------------------------
    p.x += p.vx * dt;
    for (const b of activeSolids) {
      const r = { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H };
      if (!overlaps(r, b)) continue;
      if (p.vx > 0) p.x = b.x - PLAYER_W;
      else if (p.vx < 0) p.x = b.x + b.w;
      p.vx = 0;
    }

    const wasGrounded = p.grounded;
    p.grounded = false;
    p.y += p.vy * dt;
    for (const b of activeSolids) {
      const r = { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H };
      if (!overlaps(r, b)) continue;

      if (p.vy > 0) {
        // landed on top
        p.y = b.y - PLAYER_H;
        if (b.entity.material === "bouncy") {
          p.vy = -JUMP_V * BOUNCE_MULT;
          events.push({ type: "bounce", x: p.x, y: p.y });
        } else {
          p.vy = 0;
          p.grounded = true;
          if (!wasGrounded) events.push({ type: "land", x: p.x, y: p.y });
          if (b.entity.material === "crumbling" && b.crumbleAt === undefined) {
            b.crumbleAt = this.now;
          }
        }
      } else if (p.vy < 0) {
        p.y = b.y + b.h;
        p.vy = 0;
      }
    }

    // --- crumbling ------------------------------------------------------
    for (const b of activeSolids) {
      if (
        b.entity.material === "crumbling" &&
        b.crumbleAt !== undefined &&
        this.now - b.crumbleAt >= CRUMBLE_MS
      ) {
        b.respawnAt = this.now + 2600;
        events.push({ type: "crumble", x: b.x, y: b.y });
      }
    }

    // --- monsters -------------------------------------------------------
    for (const m of this.monsters) {
      if (!m.alive) continue;

      m.vy = Math.min(MAX_FALL, m.vy + GRAVITY * dt);
      m.y += m.vy * dt;
      for (const b of activeSolids) {
        if (!overlaps(m, b)) continue;
        if (m.vy > 0) {
          m.y = b.y - m.h;
          m.vy = 0;
        } else if (m.vy < 0) {
          m.y = b.y + b.h;
          m.vy = 0;
        }
      }

      const prevX = m.x;
      m.x += m.dir * MONSTER_SPEED * dt;

      // Turn at walls.
      let blocked = activeSolids.some((b) => overlaps(m, b));
      // Turn at ledges: probe for footing just beyond the leading edge, so a
      // patrol stays on its platform instead of marching into the void.
      if (!blocked) {
        const probe = {
          x: m.dir > 0 ? m.x + m.w : m.x - 6,
          y: m.y + m.h + 2,
          w: 6,
          h: 6,
        };
        blocked = !activeSolids.some((b) => overlaps(probe, b));
      }
      if (blocked) {
        m.x = prevX;
        m.dir = m.dir > 0 ? -1 : 1;
      }
      if (m.x < 0 || m.x + m.w > WORLD_W) {
        m.x = Math.max(0, Math.min(WORLD_W - m.w, m.x));
        m.dir = m.dir > 0 ? -1 : 1;
      }
    }

    // --- world bounds ---------------------------------------------------
    if (p.x < 0) {
      p.x = 0;
      p.vx = 0;
    }
    if (p.x + PLAYER_W > WORLD_W) {
      p.x = WORLD_W - PLAYER_W;
      p.vx = 0;
    }

    const rect = { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H };

    // --- collectibles ---------------------------------------------------
    for (const b of this.bodies) {
      if (b.entity.material !== "collectible" || b.taken) continue;
      if (overlaps(rect, b)) {
        b.taken = true;
        this.collected++;
        events.push({
          type: "collect",
          x: b.x + b.w / 2,
          y: b.y + b.h / 2,
          id: b.entity.id,
        });
      }
    }

    // --- monsters vs player ---------------------------------------------
    for (const m of this.monsters) {
      if (!m.alive || !overlaps(rect, m)) continue;
      // Landing on one from above is a stomp; anything else is fatal. This is
      // the Mario rule, and the descending check is what stops a player who
      // walks into a monster's side from being credited with a kill.
      const shallow = p.y + PLAYER_H - m.y < m.h * 0.65;
      if (p.vy > 0 && shallow) {
        m.alive = false;
        m.goneAt = this.now + 400;
        p.vy = -STOMP_BOUNCE;
        this.stomped++;
        events.push({ type: "stomp", x: m.x + m.w / 2, y: m.y });
      } else {
        this.deaths++;
        events.push({ type: "death", x: p.x, y: p.y, cause: "monster" });
        this.reset(false);
        return events;
      }
    }

    // --- tunnels ----------------------------------------------------------
    // Walking onto a pipe is enough; there is no key to press. A pipe you can
    // stand on top of without falling in is a pipe players walk past.
    const under = p.grounded
      ? this.bodies.find(
          (b) =>
            b.entity.material === "tunnel" &&
            overlaps({ x: p.x, y: p.y + PLAYER_H, w: PLAYER_W, h: 4 }, b),
        )
      : undefined;
    const nowOn = under ? under.entity.id : null;
    const arrived = nowOn !== null && nowOn !== this.standingOnTunnel;
    this.standingOnTunnel = nowOn;
    if (arrived) {
      events.push({ type: "tunnel", id: nowOn, x: p.x, y: p.y });
      return events;
    }

    // --- hazards + the floor of the world -------------------------------
    const hazard = this.bodies.find(
      (b) => b.entity.material === "hazard" && overlaps(rect, b),
    );
    if (hazard || p.y > WORLD_H + 80) {
      this.deaths++;
      events.push({
        type: "death",
        x: p.x,
        y: p.y,
        cause: hazard ? hazard.entity.label : "fell",
      });
      this.reset(false);
      return events;
    }

    // --- goal -----------------------------------------------------------
    if (overlaps(rect, this.goal)) {
      this.won = true;
      events.push({ type: "win", x: p.x, y: p.y });
    }

    return events;
  }

  private groundBodyUnder(p: PlayerState, solids: Body[]): Body | undefined {
    const probe = { x: p.x, y: p.y + PLAYER_H, w: PLAYER_W, h: 3 };
    return solids.find((b) => overlaps(probe, b));
  }
}
