"use client";

import { useEffect, useRef, useState } from "react";
import { Level, MATERIAL_SPECS, WORLD_H, WORLD_W, toWorld } from "@/lib/level";

/**
 * The analysis reveal.
 *
 * The vision round-trip takes about ten seconds, which is long enough for a
 * spinner to read as "broken". So the wait is the show: the scene is scanned on
 * screen, then every box the model returned snaps into place one at a time with
 * its label and its reason. It is the clearest possible explanation of what the
 * system actually does, and it costs nothing because the time was going to pass
 * anyway.
 */

const STATUS = [
  "Reading the scene",
  "Identifying objects",
  "Inferring physical properties",
  "Assigning materials",
  "Laying out a route",
  "Proving the goal is reachable",
];

interface Props {
  image: HTMLImageElement;
  level: Level | null;
  onDone: () => void;
}

export default function Reveal({ image, level, onDone }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [statusIdx, setStatusIdx] = useState(0);
  const [shown, setShown] = useState(0);
  const doneRef = useRef(false);

  // Rotate the status line while we wait on the model.
  useEffect(() => {
    if (level) return;
    const t = setInterval(
      () => setStatusIdx((i) => Math.min(STATUS.length - 2, i + 1)),
      1900,
    );
    return () => clearInterval(t);
  }, [level]);

  // Once the level lands, snap the boxes in one at a time.
  useEffect(() => {
    if (!level) return;
    const n = level.entities.length;
    let i = 0;
    const t = setInterval(() => {
      i++;
      setShown(i);
      if (i >= n) {
        clearInterval(t);
        setTimeout(() => {
          if (!doneRef.current) {
            doneRef.current = true;
            onDone();
          }
        }, 620);
      }
    }, Math.max(55, Math.min(130, 900 / Math.max(1, n))));
    return () => clearInterval(t);
  }, [level, onDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WORLD_W * dpr;
    canvas.height = WORLD_H * dpr;

    let raf = 0;
    const start = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const t = now - start;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, WORLD_W, WORLD_H);
      ctx.drawImage(image, 0, 0, WORLD_W, WORLD_H);
      ctx.fillStyle = "rgba(4,6,12,.45)";
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);

      if (!level) {
        // sweeping scan line
        const y = ((t / 1700) % 1) * WORLD_H;
        const grad = ctx.createLinearGradient(0, y - 90, 0, y + 90);
        grad.addColorStop(0, "rgba(56,189,248,0)");
        grad.addColorStop(0.5, "rgba(56,189,248,.22)");
        grad.addColorStop(1, "rgba(56,189,248,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, y - 90, WORLD_W, 180);
        ctx.strokeStyle = "rgba(125,211,252,.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(WORLD_W, y);
        ctx.stroke();
      } else {
        level.entities.slice(0, shown).forEach((e, i) => {
          const r = toWorld(e.box);
          const spec = MATERIAL_SPECS[e.material];
          const age = Math.min(1, (shown - i) / 2.2);
          ctx.globalAlpha = 0.18 * age;
          ctx.fillStyle = spec.color;
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = age;
          ctx.strokeStyle = spec.color;
          ctx.lineWidth = i === shown - 1 ? 3.5 : 2;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
          ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = spec.color;
          ctx.fillText(e.label, r.x + 3, Math.max(14, r.y - 6));
          ctx.globalAlpha = 1;
        });
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [image, level, shown]);

  // Derived rather than stored: once the level lands we are, by definition, on
  // the last step.
  const displayStatus = level ? STATUS[STATUS.length - 1] : STATUS[statusIdx];
  const current = level?.entities[Math.max(0, shown - 1)];

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">
      <canvas ref={canvasRef} className="block w-full" style={{ aspectRatio: "16 / 9" }} />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <div className="rounded-lg border border-white/10 bg-black/70 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
            </span>
            <span className="text-sm font-medium text-white">
              {displayStatus}
              <span className="text-neutral-500">…</span>
            </span>
            {level && (
              <span className="ml-auto font-mono text-xs text-neutral-400">
                {shown}/{level.entities.length}
              </span>
            )}
          </div>
          {current && (
            <p className="mt-2 truncate text-xs text-neutral-400">
              <span
                className="font-medium"
                style={{ color: MATERIAL_SPECS[current.material].color }}
              >
                {current.label}
              </span>
              {" → "}
              {MATERIAL_SPECS[current.material].display.toLowerCase()}
              <span className="text-neutral-600"> · {current.reason}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
