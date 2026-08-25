/**
 * The contract every renderer implements.
 *
 * The game loop, the physics and the solver know nothing about how the world is
 * drawn. That separation is what lets a WebGL renderer sit beside the canvas one
 * and be swapped at runtime — and, more importantly, what lets the 2D path stay
 * as a fallback when WebGL is unavailable or refuses to initialise.
 */

import { Entity } from "./level";
import { World } from "./physics";
import { Settings } from "./settings";
import { CharacterKind } from "./character";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  r: number;
}

export interface RenderOpts {
  image: HTMLImageElement | null;
  /** 0 = photo only, 1 = collision geometry only. */
  xray: number;
  particles: Particle[];
  hover: Entity | null;
  shake: number;
  settings: Settings;
  wearing: CharacterKind;
  frozen: boolean;
}

export interface Renderer {
  render(world: World, opts: RenderOpts): void;
  dispose(): void;
}

export type RenderMode = "2d" | "3d";
