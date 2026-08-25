"use client";

import { useEffect, useRef } from "react";
import {
  CHARACTERS,
  CharacterKind,
  PLAYER_COLORS,
  drawCharacter,
} from "@/lib/character";
import { Progress, isUnlocked, nextUnlock } from "@/lib/progress";

/**
 * Character preview.
 *
 * Draws with the same `drawCharacter` the game uses, so a card can never drift
 * from what actually appears on screen — the preview *is* the renderer.
 */
function Preview({
  kind,
  color,
  size,
}: {
  kind: CharacterKind;
  color: string;
  size: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Match the player's 34:46 proportions inside the square.
    const h = size * 0.76;
    const w = h * (34 / 46);
    drawCharacter(ctx, {
      kind,
      color,
      x: (size - w) / 2,
      y: (size - h) / 2,
      w,
      h,
      facing: 1,
      t: 0,
      frozen: true,
    });
  }, [kind, color, size]);

  return (
    <canvas ref={ref} style={{ width: size, height: size }} aria-hidden />
  );
}

export default function CharacterDashboard({
  character,
  color,
  progress,
  onCharacter,
  onColor,
  onClose,
}: {
  character: CharacterKind;
  color: string;
  progress: Progress;
  onCharacter: (k: CharacterKind) => void;
  onColor: (c: string) => void;
  onClose: () => void;
}) {
  const next = nextUnlock(progress.coins);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-neutral-950/95 backdrop-blur-sm">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold text-white">Characters</h2>
          <span className="flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="font-mono text-sm text-amber-200">
              {progress.coins}
            </span>
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md border border-white/15 px-3 py-1 text-xs text-neutral-300 transition hover:border-white/35 hover:text-white"
        >
          Done
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CHARACTERS.map((c) => {
            const unlocked = isUnlocked(c.kind, progress.coins);
            const active = c.kind === character;
            const short = c.cost - progress.coins;
            return (
              <button
                key={c.kind}
                disabled={!unlocked}
                onClick={() => onCharacter(c.kind)}
                aria-pressed={active}
                className={`relative flex items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition ${
                  active
                    ? "border-sky-400/70 bg-sky-400/10"
                    : unlocked
                      ? "border-white/10 bg-white/[0.03] hover:border-white/30"
                      : "cursor-not-allowed border-white/5 bg-white/[0.02]"
                }`}
              >
                <span className={unlocked ? "" : "opacity-25 grayscale"}>
                  <Preview
                    kind={c.kind}
                    color={unlocked ? color : "#94a3b8"}
                    size={52}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`text-sm font-medium ${
                        unlocked ? "text-neutral-100" : "text-neutral-500"
                      }`}
                    >
                      {c.name}
                    </span>
                    {active && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                        wearing
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">
                    {unlocked ? c.blurb : `${short} more coin${short === 1 ? "" : "s"}`}
                  </span>
                </span>
                {!unlocked && (
                  <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full border border-white/10 bg-black/50 px-1.5 py-0.5">
                    <LockIcon />
                    <span className="font-mono text-[10px] text-neutral-400">
                      {c.cost}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="mt-5 text-sm text-neutral-100">Colour</p>
        <p className="text-[11px] text-neutral-500">
          Colours are free — they apply to whichever character you are wearing.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PLAYER_COLORS.map((c) => (
            <button
              key={c.value}
              onClick={() => onColor(c.value)}
              title={c.name}
              aria-label={c.name}
              aria-pressed={c.value === color}
              className={`h-8 w-8 rounded-full border-2 transition ${
                c.value === color
                  ? "scale-110 border-white"
                  : "border-white/20 hover:border-white/50"
              }`}
              style={{ background: c.value }}
            />
          ))}
        </div>

        <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
            Earning coins
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
            Each coin in a scene pays once, and clearing a scene pays two more.
            Replaying a scene you have already emptied earns nothing — so the
            fastest way to unlock the rest is to drop in a new photo, which
            arrives with coins of its own.
          </p>
          {next && (
            <p className="mt-2 text-xs text-sky-300">
              {next.cost - progress.coins} more to unlock {next.name}.
            </p>
          )}
          {!next && (
            <p className="mt-2 text-xs text-lime-300">
              Everything unlocked. Nicely done.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current text-neutral-400">
      <path d="M11.5 7V5.5a3.5 3.5 0 1 0-7 0V7H4a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5Zm-5.5-1.5a2 2 0 1 1 4 0V7H6V5.5Z" />
    </svg>
  );
}
