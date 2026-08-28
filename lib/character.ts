/**
 * Player characters.
 *
 * All of these are drawn procedurally into the same canvas, so the game ships
 * no sprite sheets and a new character costs one function.
 *
 * Every character occupies the SAME collision box. That is not an aesthetic
 * choice — the solver proves each level completable using the player's exact
 * width, height and jump arc, so a character that was taller or wider would
 * silently invalidate every proof the app makes. Skins change how the player
 * looks and nothing else.
 */

export type CharacterKind =
  | "blob"
  | "ball"
  | "ghost"
  | "robot"
  | "cat"
  | "slime";

/**
 * `cost` is the coin total at which a character unlocks.
 *
 * Priced against what the shipped content actually yields: nine coins per scene
 * plus a two-coin clear bonus, so fully finishing all three built-ins lands on
 * thirty-three — enough for the first three characters. The last two are
 * deliberately out of reach of the demo scenes alone, because every uploaded
 * photo brings roughly sixteen more (nine on the level, two for clearing it,
 * five down the pipe). The expensive end of the list is a reason to point the
 * camera at something new, which is the whole point of the project.
 */
export const CHARACTERS: Array<{
  kind: CharacterKind;
  name: string;
  cost: number;
  blurb: string;
}> = [
  { kind: "blob", name: "Blob", cost: 0, blurb: "The default. Dependable, rectangular." },
  { kind: "ball", name: "Bean", cost: 8, blurb: "Rounder. Reads its own arc more clearly." },
  { kind: "ghost", name: "Spook", cost: 18, blurb: "Hem drifts as you move." },
  { kind: "robot", name: "Unit", cost: 32, blurb: "Visor instead of eyes. Antenna optional." },
  { kind: "cat", name: "Cat", cost: 50, blurb: "Ears, whiskers, and no sense of danger." },
  { kind: "slime", name: "Slime", cost: 72, blurb: "Squat, wet, and faintly pleased." },
];

export const PLAYER_COLORS = [
  { name: "Chalk", value: "#f8fafc" },
  { name: "Sky", value: "#38bdf8" },
  { name: "Lime", value: "#a3e635" },
  { name: "Amber", value: "#fbbf24" },
  { name: "Rose", value: "#fb7185" },
  { name: "Violet", value: "#c084fc" },
  { name: "Cyan", value: "#67e8f9" },
  { name: "Coral", value: "#fb923c" },
];

export const DEFAULT_CHARACTER: CharacterKind = "blob";
export const DEFAULT_COLOR = PLAYER_COLORS[0].value;

export function isCharacterKind(v: unknown): v is CharacterKind {
  return CHARACTERS.some((c) => c.kind === v);
}

export function isPlayerColor(v: unknown): v is string {
  return PLAYER_COLORS.some((c) => c.value === v);
}

export interface DrawOpts {
  kind: CharacterKind;
  color: string;
  /** Collision box, already squashed/stretched by the caller. */
  x: number;
  y: number;
  w: number;
  h: number;
  facing: 1 | -1;
  /** Milliseconds, for idle animation. */
  t: number;
  /** Suppresses wobble while paused, so a frozen frame looks deliberate. */
  frozen: boolean;
}

/** Slightly darker version of a hex colour, for outlines and shading. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) * amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) * amount));
  const b = Math.max(0, Math.min(255, (n & 255) * amount));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Two dots, offset toward whichever way the player is moving. */
function eyes(
  ctx: CanvasRenderingContext2D,
  o: DrawOpts,
  cy: number,
  spread: number,
  radius: number,
) {
  const cx = o.x + o.w / 2 + o.facing * o.w * 0.14;
  ctx.fillStyle = "#0b1220";
  ctx.beginPath();
  ctx.arc(cx - spread, cy, radius, 0, Math.PI * 2);
  ctx.arc(cx + spread, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function drawCharacter(ctx: CanvasRenderingContext2D, o: DrawOpts) {
  const { x, y, w, h, color } = o;
  const wobble = o.frozen ? 0 : Math.sin(o.t / 220) * 0.9;

  ctx.save();
  ctx.shadowColor = color + "88";
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;

  switch (o.kind) {
    case "blob": {
      roundRect(ctx, x, y, w, h, w * 0.28);
      ctx.fill();
      ctx.restore();
      eyes(ctx, o, y + h * 0.36, w * 0.15, w * 0.085);
      return;
    }

    case "ball": {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // A highlight sells the roundness.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(x + w * 0.34, y + h * 0.26, w * 0.16, h * 0.11, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      eyes(ctx, o, y + h * 0.44, w * 0.16, w * 0.09);
      return;
    }

    case "ghost": {
      const tailH = h * 0.18;
      const bodyH = h - tailH;
      ctx.beginPath();
      ctx.moveTo(x, y + bodyH);
      ctx.lineTo(x, y + w * 0.45);
      ctx.arc(x + w / 2, y + w * 0.45, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, y + bodyH);
      // Three scallops along the hem.
      const n = 3;
      for (let i = 0; i < n; i++) {
        const x1 = x + w - (w / n) * i;
        const x2 = x + w - (w / n) * (i + 1);
        ctx.quadraticCurveTo(
          (x1 + x2) / 2,
          y + bodyH + tailH * (i % 2 === 0 ? 1.5 : 0.6) + wobble,
          x2,
          y + bodyH,
        );
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      eyes(ctx, o, y + h * 0.34, w * 0.17, w * 0.1);
      return;
    }

    case "robot": {
      roundRect(ctx, x, y + h * 0.1, w, h * 0.9, w * 0.16);
      ctx.fill();
      ctx.restore();
      // Antenna
      ctx.strokeStyle = shade(color, 0.75);
      ctx.lineWidth = Math.max(1.5, w * 0.06);
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + h * 0.1);
      ctx.lineTo(x + w / 2, y);
      ctx.stroke();
      ctx.fillStyle = "#fb7185";
      ctx.beginPath();
      ctx.arc(x + w / 2, y - h * 0.01, w * 0.09, 0, Math.PI * 2);
      ctx.fill();
      // Visor rather than eyes.
      const vx = x + w * 0.14 + o.facing * w * 0.04;
      ctx.fillStyle = "#0b1220";
      roundRect(ctx, vx, y + h * 0.3, w * 0.72, h * 0.2, h * 0.08);
      ctx.fill();
      ctx.fillStyle = "#67e8f9";
      ctx.beginPath();
      ctx.arc(vx + w * 0.5 + o.facing * w * 0.1, y + h * 0.4, w * 0.07, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    case "cat": {
      const earH = h * 0.16;
      // Ears first, so the body overlaps their base.
      ctx.beginPath();
      ctx.moveTo(x + w * 0.1, y + earH * 1.4);
      ctx.lineTo(x + w * 0.26, y);
      ctx.lineTo(x + w * 0.44, y + earH * 1.4);
      ctx.closePath();
      ctx.moveTo(x + w * 0.56, y + earH * 1.4);
      ctx.lineTo(x + w * 0.74, y);
      ctx.lineTo(x + w * 0.9, y + earH * 1.4);
      ctx.closePath();
      ctx.fill();
      roundRect(ctx, x, y + earH * 0.7, w, h - earH * 0.7, w * 0.3);
      ctx.fill();
      ctx.restore();
      const ey = y + h * 0.46;
      eyes(ctx, o, ey, w * 0.17, w * 0.085);
      // Whiskers
      ctx.strokeStyle = shade(color, 0.6);
      ctx.lineWidth = 1.2;
      const wx = x + w / 2 + o.facing * w * 0.14;
      for (const dy of [-2.5, 2.5]) {
        ctx.beginPath();
        ctx.moveTo(wx - w * 0.3, ey + h * 0.16 + dy);
        ctx.lineTo(wx - w * 0.52, ey + h * 0.13 + dy * 1.6);
        ctx.moveTo(wx + w * 0.3, ey + h * 0.16 + dy);
        ctx.lineTo(wx + w * 0.52, ey + h * 0.13 + dy * 1.6);
        ctx.stroke();
      }
      return;
    }

    case "slime": {
      /**
       * Squat and puddle-shaped, sitting in the lower two thirds of the box.
       * A full-height dome is almost indistinguishable from the ghost once it
       * is 20px wide in a swatch, and two characters that read the same are
       * one character.
       */
      const top = y + h * 0.3;
      const base = y + h;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.04, base);
      ctx.bezierCurveTo(
        x - w * 0.1,
        top + (base - top) * 0.15 + wobble,
        x + w * 1.1,
        top + (base - top) * 0.15 - wobble,
        x + w * 1.04,
        base,
      );
      ctx.closePath();
      ctx.fill();
      // A couple of drips over the base give it the wet, heavy silhouette.
      ctx.beginPath();
      ctx.ellipse(x + w * 0.16, base, w * 0.16, h * 0.045, 0, 0, Math.PI * 2);
      ctx.ellipse(x + w * 0.82, base, w * 0.13, h * 0.035, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = "#ffffff";
      // Anchored to the real crown, not to `top`: the bezier control points
      // pull the visible curve well below the nominal top, and a highlight
      // placed there lands outside the body as a grey smudge on the backdrop.
      ctx.beginPath();
      ctx.ellipse(
        x + w * 0.3,
        top + (base - top) * 0.42,
        w * 0.12,
        h * 0.055,
        -0.4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
      eyes(ctx, o, y + h * 0.68, w * 0.17, w * 0.085);
      return;
    }
  }
}
