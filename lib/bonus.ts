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

  /**
   * The chamber is a climb, not a corridor.
   *
   * You drop in at the top left and land near the bottom; the way out is a pipe
   * at the top right. Between them is a zigzag of ledges with a rise of 85 —
   * comfortably inside a 140 jump, so every step is fair — while the floor
   * below is mostly molten, so a missed landing costs the run rather than a
   * step. That asymmetry is the whole design: easy to fall into, expensive to
   * leave, and worth it for what is lying around.
   *
   * The layout is fixed rather than random. A generated chamber would sometimes
   * be unclimbable, and unlike a photographed level there is no solver pass to
   * catch it — bonus rooms are constructed here and played directly.
   */
  const entities: Entity[] = [
    px("bfloor", "chamber floor", "solid", "packed earth", 0, 640, 1280, 80),
    px("bleft", "chamber wall", "solid", "solid rock", 0, 0, 40, 720),
    px("bright", "chamber wall", "solid", "solid rock", 1240, 0, 40, 720),
    px("bceil", "chamber ceiling", "solid", "solid rock", 0, 0, 1280, 40),

    // The floor is a punishment, not a rest. Two narrow safe strips remain.
    px("blava", "molten seam", "hazard", "still glowing from below", 300, 620, 700, 100),

    // The climb. Rise 85 a step, gaps 100-120 — inside a jump, but only just.
    px("bl0", "ledge", "solid", "cut stone", 100, 555, 190, 20),
    px("bl1", "ledge", "crumbling", "cracked and shifting", 400, 470, 180, 20),
    px("bl2", "ledge", "solid", "cut stone", 700, 385, 180, 20),
    px("bl3", "ledge", "slippery", "slick with condensation", 400, 300, 180, 20),
    px("bl4", "ledge", "solid", "cut stone", 700, 215, 180, 20),
    px("bl5", "high shelf", "solid", "cut stone", 980, 200, 220, 20),

    // A soft landing back at the bottom, so a fall is recoverable if you are
    // quick — on the right safe strip, clear of the molten seam.
    // On the right strip, not the left: the left one lies directly under bl0,
    // which left 35px of clearance for a 46px player. A pad you cannot stand
    // on is not a soft landing.
    px("bpad", "fungus", "bouncy", "spongy and load-bearing", 1040, 610, 160, 30),

    // The way out, sitting on the highest shelf.
    // Sits low enough that a player standing on its lip still clears the
    // ceiling. At the old height the pipe top left 30px under a 40px ceiling
    // for a 46px player: mountable on paper, impossible in fact, and the way
    // out of the room.
    px("bexit", "return pipe", "tunnel", "it goes back up", 1060, 150, 90, 50),
  ];

  /**
   * Coins, and a lot of them: the chamber is the best-paying place in the game
   * because it is the most expensive to leave. The riskiest positions — over
   * the molten seam, and on the crumbling ledge — carry the densest clusters.
   */
  const coinSpots: Array<[number, number]> = [
    // Along the descent, collected on the way down whether you like it or not.
    [150, 180], [150, 300], [150, 420],
    // Above each ledge of the climb.
    [150, 500], [230, 500],
    [440, 415], [520, 415],
    [740, 330], [820, 330],
    [440, 245], [520, 245],
    [740, 160], [820, 160],
    // Beside the pipe rather than above it — standing on the pipe leaves the
    // room instantly, so anything on top of it could never be collected.
    [990, 150], [1160, 150],
    // Dangling over the molten seam: pure greed.
    [520, 570], [660, 555], [800, 570],
    // Tucked against the far wall, needing a deliberate detour.
    [1180, 300], [1180, 420],
  ];
  coinSpots.forEach(([x, y], i) => {
    entities.push(
      px(`bcoin${i}`, "coin", "collectible", "buried treasure", x, y, 32, 32),
    );
  });

  return {
    fromTunnel: tunnelId,
    level: {
      version: 1,
      id: `bonus:${seed}`,
      title: "Bonus chamber",
      tagline: "Easy to fall into. Bring something back up.",
      spawn: { x: 120 / WORLD_W, y: 90 / WORLD_H },
      // Unreachable on purpose: the exit pipe is how you leave, so there is no
      // goal flag to trip over and no way to "win" a bonus room.
      goal: { x: -1, y: -1 },
      entities,
      // Two patrols on the wide solid ledges, so the climb is not a free ride.
      monsters: [
        { id: "bm0", x: 790 / WORLD_W, y: 385 / WORLD_H },
        { id: "bm1", x: 790 / WORLD_W, y: 215 / WORLD_H },
      ],
    },
  };
}

/** A bonus room has no goal; it is left through its return tunnel. */
export function isBonusLevel(level: Level): boolean {
  return Boolean(level.id?.startsWith("bonus:"));
}
