/**
 * Bonus worlds.
 *
 * A tunnel drops the player into a small sealed chamber stuffed with coins and
 * a way back out. Two properties matter:
 *
 *  - It is generated deterministically from the tunnel's id, so the same pipe
 *    always leads to the same room. That is what lets coins there pay out once
 *    and only once, exactly like coins in a hand-authored scene.
 *  - It is entirely optional. The main level's completability proof never
 *    depends on it, so a tunnel can never make a level unwinnable.
 */

import { Entity, Level, WORLD_H, WORLD_W } from "./level";

/** Small deterministic PRNG, so a given tunnel always builds the same room. */
function seeded(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function px(
  id: string,
  label: string,
  material: Entity["material"],
  reason: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Entity {
  return {
    id,
    label,
    material,
    reason,
    box: { x: x / WORLD_W, y: y / WORLD_H, w: w / WORLD_W, h: h / WORLD_H },
  };
}

export interface BonusWorld {
  level: Level;
  /** The tunnel this room belongs to, so we know where to put the player back. */
  fromTunnel: string;
}

/**
 * Build the chamber behind one tunnel.
 *
 * `parentId` scopes the coin ids to the scene as well as the tunnel, so two
 * different photos that happen to produce the same tunnel id do not share a
 * payout ledger.
 */
export function buildBonusWorld(parentId: string, tunnelId: string): BonusWorld {
  const seed = `${parentId}/${tunnelId}`;
  const rand = seeded(seed);

  const entities: Entity[] = [
    px("bfloor", "chamber floor", "solid", "packed earth", 0, 620, 1280, 100),
    px("bleft", "chamber wall", "solid", "solid rock", 0, 0, 40, 720),
    px("bright", "chamber wall", "solid", "solid rock", 1240, 0, 40, 720),
    px("bceil", "chamber ceiling", "solid", "solid rock", 0, 0, 1280, 40),
  ];

  // Three staggered ledges, each with a coin above it.
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const y = 500 - i * 130;
    const w = 190 + Math.floor(rand() * 70);
    const x = 140 + Math.floor(rand() * (900 - w));
    entities.push(
      px(`bledge${i}`, "ledge", i === 1 ? "bouncy" : "solid",
        i === 1 ? "spongy fungus" : "cut stone", x, y, w, 20),
    );
    entities.push(
      px(`bcoin${i}`, "coin", "collectible", "buried treasure",
        x + w / 2 - 16, y - 74, 32, 32),
    );
  }

  // Two more coins along the floor, so a quick visit still pays.
  entities.push(
    px("bcoin3", "coin", "collectible", "buried treasure", 380, 546, 32, 32),
    px("bcoin4", "coin", "collectible", "buried treasure", 700, 546, 32, 32),
  );

  // The way back. Standing on it and pressing down returns you to the scene.
  entities.push(
    px("bexit", "return tunnel", "tunnel", "it goes back up", 1080, 560, 120, 60),
  );

  return {
    fromTunnel: tunnelId,
    level: {
      version: 1,
      id: `bonus:${seed}`,
      title: "Bonus chamber",
      tagline: "Somewhere under the scene. Take what you can carry.",
      spawn: { x: 120 / WORLD_W, y: 610 / WORLD_H },
      // Unreachable on purpose: the exit tunnel is how you leave, so there is
      // no goal flag to trip over and no way to "win" a bonus room.
      goal: { x: -1, y: -1 },
      entities,
    },
  };
}

/** A bonus room has no goal; it is left through its return tunnel. */
export function isBonusLevel(level: Level): boolean {
  return Boolean(level.id?.startsWith("bonus:"));
}
