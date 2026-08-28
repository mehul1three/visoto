/**
 * Visoto level format v1.
 *
 * This is the contract between the vision model, the physics engine, and the
 * exporters. Coordinates are NORMALISED (0..1, top-left origin) so a level
 * stays valid at any photo resolution; the engine scales them into world units
 * exactly once, at load.
 */

export const WORLD_W = 1280;
export const WORLD_H = 720;

/**
 * Semantic physics: an object's material is derived from *what it is*, not from
 * how it looks. This mapping is the core idea of the project — a pillow is
 * bouncy because pillows are soft, not because it happens to be a blue blob.
 */
export const MATERIALS = [
  "solid",
  "bouncy",
  "hazard",
  "climbable",
  "crumbling",
  "slippery",
  "collectible",
  "tunnel",
] as const;

export type Material = (typeof MATERIALS)[number];

export interface MaterialSpec {
  /** Shown in the X-ray legend. */
  display: string;
  /** Outline colour in X-ray mode. */
  color: string;
  /** Does the player land on it? */
  solid: boolean;
  /** One-line rule shown in the tooltip. */
  rule: string;
}

export const MATERIAL_SPECS: Record<Material, MaterialSpec> = {
  solid: {
    display: "Solid",
    color: "#38bdf8",
    solid: true,
    rule: "Stand on it. Rigid, load-bearing.",
  },
  bouncy: {
    display: "Bouncy",
    color: "#a3e635",
    solid: true,
    rule: "Launches you 1.7x your jump height.",
  },
  hazard: {
    display: "Hazard",
    color: "#fb7185",
    solid: false,
    rule: "Hot, sharp or wet. Touching it resets you.",
  },
  climbable: {
    display: "Climbable",
    color: "#c084fc",
    solid: true,
    rule: "Hold up against it to climb.",
  },
  crumbling: {
    display: "Crumbling",
    color: "#fbbf24",
    solid: true,
    rule: "Holds for 0.6s, then gives way.",
  },
  slippery: {
    display: "Slippery",
    color: "#67e8f9",
    solid: true,
    rule: "Almost no friction. You will overshoot.",
  },
  collectible: {
    display: "Collectible",
    color: "#fde047",
    solid: false,
    rule: "Pick it up. Optional, but scored.",
  },
  tunnel: {
    display: "Tunnel",
    color: "#f472b6",
    solid: true,
    rule: "Stand on it and press down to drop through.",
  },
};

/**
 * A patrolling enemy.
 *
 * Monsters are not entities: an entity is static geometry with a material, and
 * a monster moves, turns around and can be defeated. Keeping them in a separate
 * list means the solver, the exporters and the material system all stay exactly
 * as they were.
 */
export interface MonsterSpawn {
  id: string;
  /** Normalised position of the monster's feet at spawn. */
  x: number;
  y: number;
}

/** Normalised rect, 0..1, top-left origin. */
export interface NBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Entity {
  id: string;
  /** What the model saw, in plain words: "ceramic coffee mug". */
  label: string;
  material: Material;
  /**
   * Why this material was chosen. Surfaced in the UI on hover — this is the
   * project's thesis made visible, so it is a required field, not a nicety.
   */
  reason: string;
  box: NBox;
  /** Marks platforms inserted by the reachability solver, not by the model. */
  synthetic?: boolean;
}

export interface Level {
  version: 1;
  /** Level name the model invents from the scene. */
  title: string;
  /** One-line flavour text for the loading reveal. */
  tagline: string;
  entities: Entity[];
  spawn: { x: number; y: number };
  goal: { x: number; y: number };
  /** Solver notes, shown in the UI for transparency. */
  repairs?: string[];
  /** Patrolling enemies. Optional: older levels and exports simply have none. */
  monsters?: MonsterSpawn[];
  /** Stable identity, so coin payouts can be deduplicated per scene. */
  id?: string;
}

/** World-space rect, in WORLD_W x WORLD_H units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function toWorld(b: NBox): Rect {
  return {
    x: b.x * WORLD_W,
    y: b.y * WORLD_H,
    w: b.w * WORLD_W,
    h: b.h * WORLD_H,
  };
}

export function toNorm(r: Rect): NBox {
  return {
    x: r.x / WORLD_W,
    y: r.y / WORLD_H,
    w: r.w / WORLD_W,
    h: r.h / WORLD_H,
  };
}

/**
 * Schema handed to the model, kept in this file so it cannot drift from the
 * types above.
 *
 * Deliberately written in Gemini's *native* spatial conventions rather than in
 * this project's internal ones: boxes as `box_2d: [ymin, xmin, ymax, xmax]` and
 * points as `[y, x]`, both normalised to 0-1000. The model is trained to emit
 * exactly that, and asking it to translate into some other layout on the way out
 * measurably degrades the boxes. The conversion into the {x, y, w, h} form the
 * engine uses costs four divisions and happens once, in lib/normalise.ts.
 *
 * Only keywords the Gemini structured-output parser supports appear here —
 * notably no `additionalProperties`.
 */
export const LEVEL_JSON_SCHEMA = {
  type: "object",
  required: ["title", "tagline", "entities", "spawn", "goal"],
  properties: {
    title: {
      type: "string",
      description:
        "A short, playful level name derived from the actual scene, e.g. 'The Desk of Unfinished Coffee'. Max 40 characters.",
    },
    tagline: {
      type: "string",
      description:
        "One sentence of flavour text about this specific scene. Max 90 characters.",
    },
    entities: {
      type: "array",
      minItems: 4,
      maxItems: 22,
      description: "The objects that make up the level.",
      items: {
        type: "object",
        required: ["label", "material", "reason", "box_2d"],
        properties: {
          label: {
            type: "string",
            description:
              "What the object actually is, in 1-4 plain words: 'mechanical keyboard', 'stack of books'.",
          },
          material: {
            type: "string",
            enum: [...MATERIALS],
            description:
              "Physical behaviour implied by what the object IS. Rigid furniture/electronics -> solid. Soft compressible things (pillow, cushion, beanbag, bread) -> bouncy. Hot liquids, blades, flames, open water, sharp edges -> hazard. Ladders, curtains, cables, shelving uprights -> climbable. Flimsy or precarious things (paper stacks, cards, thin plastic) -> crumbling. Glass, polished metal, ice, screens -> slippery. Small prized objects (coins, keys, rings, fruit) -> collectible.",
          },
          reason: {
            type: "string",
            description:
              "Under 12 words, explaining the material from the object's real-world physical properties, e.g. 'ceramic full of hot liquid'. Never restate the material name.",
          },
          box_2d: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            description:
              "Tight bounding box as [ymin, xmin, ymax, xmax], normalised to 0-1000.",
            items: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
    spawn: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      description:
        "Where the player starts, as [y, x] normalised to 0-1000. Pick clear air in the LEFT third of the image, directly above a solid surface.",
      items: { type: "integer", minimum: 0, maximum: 1000 },
    },
    goal: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      description:
        "Where the player must reach, as [y, x] normalised to 0-1000. Pick the RIGHT third, ideally resting on the highest interesting object.",
      items: { type: "integer", minimum: 0, maximum: 1000 },
    },
  },
} as const;
