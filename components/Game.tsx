"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Entity,
  Level,
  MATERIAL_SPECS,
  WORLD_H,
  WORLD_W,
  toWorld,
} from "@/lib/level";
import {
  Input,
  MONSTER_H,
  MONSTER_W,
  Monster,
  PLAYER_H,
  PLAYER_W,
  StepEvent,
  World,
} from "@/lib/physics";
import { buildBonusWorld, isBonusLevel } from "@/lib/bonus";
import { Renderer3D, tryCreateRenderer3D } from "@/lib/render3d";
import { Particle, RenderMode } from "@/lib/renderer";
import { playSfx, resetCoinStreak, unlockAudio } from "@/lib/audio";
import {
  SETTING_LABELS,
  Settings,
  TOGGLE_KEYS,
  loadSettings,
  saveSettings,
} from "@/lib/settings";
import { CharacterKind, drawCharacter } from "@/lib/character";
import CharacterDashboard from "@/components/CharacterDashboard";
import {
  Progress,
  bankClear,
  bankCoin,
  isUnlocked,
  levelIdOf,
} from "@/lib/progress";

type Phase = "ready" | "playing" | "paused" | "dead" | "won";

export interface GameHandleState {
  title: string;
  collected: number;
  total: number;
  deaths: number;
  won: boolean;
  seconds: number;
}

interface Props {
  level: Level;
  image: HTMLImageElement | null;
  progress: Progress;
  onProgress: (p: Progress) => void;
  /** Owned by the page so the sidebar can open it too, rendered here so it
      still works when the game is in full screen. */
  showDashboard: boolean;
  onDashboard: (open: boolean) => void;
  onState?: (s: GameHandleState) => void;
}

const KEY_MAP: Record<string, keyof Input> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  Space: "jump",
  KeyZ: "jump",
};

const NO_INPUT: Input = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
};

export default function Game({
  level,
  image,
  progress,
  onProgress,
  showDashboard,
  onDashboard,
  onState,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(new World(level));
  /** Holds the scene while the player is down a tunnel. */
  const mainWorldRef = useRef<World | null>(null);
  const activeLevelIdRef = useRef<string>("");
  /** Blocks an instant re-entry on the frame you arrive. */
  const tunnelLockRef = useRef(0);
  const inputRef = useRef<Input>({ ...NO_INPUT });
  const particlesRef = useRef<Particle[]>([]);
  const xrayRef = useRef(0);
  const hoverRef = useRef<Entity | null>(null);
  const shakeRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("ready");
  const [xrayOn, setXrayOn] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * Fallback for when the Fullscreen API is unavailable or refused — embedded
   * iframes without `allow="fullscreen"`, some locked-down browsers, and any
   * context where the gesture is not trusted. The button silently doing nothing
   * is the worst outcome, so we fill the viewport with CSS instead.
   */
  const [maximised, setMaximised] = useState(false);
  /** Set when WebGL refuses to start, so the UI can explain the fall back. */
  const [webglFailed, setWebglFailed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Read once on mount. Nothing settings-dependent is in the initial HTML, so
  // this cannot cause a hydration mismatch.
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const levelId = useMemo(() => levelIdOf(level), [level]);
  /** A character can be selected and then become locked again if progress is
      cleared; never render something the player has not earned. */
  const wearing = isUnlocked(settings.character, progress.coins)
    ? settings.character
    : "blob";
  const [hud, setHud] = useState<GameHandleState>({
    title: level.title,
    collected: 0,
    total: 0,
    deaths: 0,
    won: false,
    seconds: 0,
  });
  const [tip, setTip] = useState<{ e: Entity; x: number; y: number } | null>(null);
  /** What killed the player, shown on the retry screen. */
  const [cause, setCause] = useState<string>("fell");

  // Mirrors, so the animation loop can read current values without restarting.
  const phaseRef = useRef(phase);
  const settingsRef = useRef(settings);
  const progressRef = useRef(progress);
  const onProgressRef = useRef(onProgress);
  const levelIdRef = useRef(levelId);
  const wearingRef = useRef(wearing);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);
  useEffect(() => {
    levelIdRef.current = levelId;
    activeLevelIdRef.current = levelId;
  }, [levelId]);
  useEffect(() => {
    wearingRef.current = wearing;
  }, [wearing]);

  const mode: RenderMode = settings.render;

  const sfx = useCallback((name: Parameters<typeof playSfx>[0]) => {
    if (settingsRef.current.sound) playSfx(name);
  }, []);

  const updateSetting = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [k]: v };
      saveSettings(next);
      return next;
    });
    if (k !== "sound" || v) playSfx("ui");
  }, []);

  const start = useCallback(() => {
    unlockAudio();
    resetCoinStreak();
    setPhase("playing");
  }, []);

  const retry = useCallback(() => {
    worldRef.current.restartRun();
    particlesRef.current = [];
    resetCoinStreak();
    inputRef.current = { ...NO_INPUT };
    setPhase("playing");
  }, []);

  const restart = useCallback(() => {
    worldRef.current.reset(true);
    particlesRef.current = [];
    resetCoinStreak();
    inputRef.current = { ...NO_INPUT };
    setPhase("playing");
  }, []);

  const togglePause = useCallback(() => {
    setPhase((p) => {
      if (p === "playing") {
        inputRef.current = { ...NO_INPUT };
        return "paused";
      }
      if (p === "paused") return "playing";
      return p;
    });
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      setMaximised(false);
      return;
    }
    if (maximised) {
      setMaximised(false);
      return;
    }

    /**
     * Ask for real fullscreen but never wait on it. The promise is not
     * guaranteed to settle — in some embedded and automated contexts it stays
     * pending forever, which would leave the button dead. Maximising straight
     * away makes the control feel instant everywhere; the fullscreenchange
     * handler below clears it if the real thing engages, so the browser's own
     * fullscreen wins whenever it is actually available.
     */
    setMaximised(true);
    void el.requestFullscreen?.().catch(() => {});
  }, [maximised]);

  useEffect(() => {
    const onChange = () => {
      const on = Boolean(document.fullscreenElement);
      setFullscreen(on);
      if (on) setMaximised(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // --- input ------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Never swallow keys while the player is typing somewhere.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

      if (e.code === "Escape" || e.code === "KeyP") {
        // Unwind one layer per press, in the order a player expects: close
        // settings, then pause, then leave the maximised view. Pausing comes
        // before un-maximising because Escape means "pause" in a game long
        // before it means "give me my window back".
        if (showDashboard) onDashboard(false);
        else if (showSettings) setShowSettings(false);
        else if (e.code === "Escape" && maximised && phaseRef.current === "paused")
          setMaximised(false);
        else togglePause();
        e.preventDefault();
        return;
      }
      if (e.code === "KeyF") {
        void toggleFullscreen();
        e.preventDefault();
        return;
      }
      if (e.code === "KeyX") {
        setXrayOn((v) => !v);
        e.preventDefault();
        return;
      }
      if (e.code === "KeyR") {
        restart();
        e.preventDefault();
        return;
      }
      if (
        (e.code === "Space" || e.code === "Enter") &&
        (phaseRef.current === "ready" ||
          phaseRef.current === "won" ||
          phaseRef.current === "dead")
      ) {
        if (phaseRef.current === "ready") start();
        else if (phaseRef.current === "dead") retry();
        else restart();
        e.preventDefault();
        return;
      }
      const k = KEY_MAP[e.code];
      if (k) {
        inputRef.current[k] = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.code];
      if (k) {
        inputRef.current[k] = false;
        e.preventDefault();
      }
    };
    // Losing focus mid-jump would otherwise leave a key stuck down.
    const blur = () => {
      inputRef.current = { ...NO_INPUT };
      setPhase((p) => (p === "playing" ? "paused" : p));
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [
    restart,
    retry,
    start,
    togglePause,
    toggleFullscreen,
    showSettings,
    showDashboard,
    onDashboard,
    maximised,
  ]);

  // --- main loop --------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // A canvas can only ever hand out one kind of context, so the element is
    // keyed by mode in the markup and this effect re-runs against a fresh one.
    let r3d: Renderer3D | null = null;
    let ctx: CanvasRenderingContext2D | null = null;

    if (mode === "3d") {
      r3d = tryCreateRenderer3D(canvas);
      if (!r3d) setWebglFailed(true);
    }
    if (!r3d) {
      ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = WORLD_W * dpr;
      canvas.height = WORLD_H * dpr;
    }

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let hudClock = 0;
    const STEP = 1000 / 120;

    const burst = (x: number, y: number, color: string, n: number, power: number) => {
      if (!settingsRef.current.particles) return;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random();
        particlesRef.current.push({
          x,
          y,
          vx: Math.cos(a) * power * (0.5 + Math.random()),
          vy: Math.sin(a) * power * (0.5 + Math.random()) - power * 0.4,
          life: 1,
          color,
          r: 2 + Math.random() * 3,
        });
      }
    };

    const shake = (amount: number) => {
      if (settingsRef.current.shake) shakeRef.current = amount;
    };

    let now = 0;
    const handle = (events: StepEvent[]) => {
      for (const ev of events) {
        switch (ev.type) {
          case "bounce":
            burst(ev.x! + PLAYER_W / 2, ev.y! + PLAYER_H, "#a3e635", 10, 180);
            shake(4);
            sfx("bounce");
            break;
          case "collect": {
            burst(ev.x!, ev.y!, "#fde047", 14, 220);
            sfx("coin");
            const banked = ev.id
              ? bankCoin(progressRef.current, activeLevelIdRef.current, ev.id)
              : null;
            // null means this exact coin has already paid out, in this scene,
            // at some point in the past. Picking it up again is free.
            if (banked) onProgressRef.current(banked);
            break;
          }
          case "death":
            burst(ev.x! + PLAYER_W / 2, ev.y! + PLAYER_H / 2, "#fb7185", 18, 260);
            shake(11);
            sfx("death");
            setCause(ev.cause ?? "fell");
            setPhase("dead");
            break;
          case "win": {
            burst(ev.x! + PLAYER_W / 2, ev.y! + PLAYER_H / 2, "#38bdf8", 26, 300);
            sfx("win");
            const cleared = bankClear(progressRef.current, levelIdRef.current);
            if (cleared) onProgressRef.current(cleared);
            setPhase("won");
            break;
          }
          case "crumble":
            burst(ev.x!, ev.y!, "#fbbf24", 10, 140);
            sfx("crumble");
            break;
          case "land":
            sfx("land");
            break;
          case "stomp":
            burst(ev.x!, ev.y!, "#fb7185", 12, 190);
            shake(5);
            sfx("stomp");
            break;
          case "tunnel": {
            if (now < tunnelLockRef.current) break;
            tunnelLockRef.current = now + 600;
            sfx("tunnel");
            shake(6);
            if (mainWorldRef.current) {
              // Coming back up.
              worldRef.current = mainWorldRef.current;
              mainWorldRef.current = null;
              activeLevelIdRef.current = levelIdRef.current;
            } else {
              const bonus = buildBonusWorld(levelIdRef.current, ev.id ?? "t");
              mainWorldRef.current = worldRef.current;
              worldRef.current = new World(bonus.level);
              activeLevelIdRef.current = bonus.level.id!;
            }
            particlesRef.current = [];
            break;
          }
        }
      }
    };

    const frame = (ts: number) => {
      now = ts;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(now - last, 100);
      last = now;

      const w = worldRef.current;
      if (phaseRef.current === "playing") {
        acc += dt;
        while (acc >= STEP) {
          handle(w.step(inputRef.current, STEP));
          acc -= STEP;
        }
      } else {
        acc = 0;
      }

      // Particles and easing keep running while paused so the frame stays alive.
      const ps = particlesRef.current;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.vy += 900 * (dt / 1000);
        p.x += p.vx * (dt / 1000);
        p.y += p.vy * (dt / 1000);
        p.life -= dt / 700;
        if (p.life <= 0) ps.splice(i, 1);
      }
      shakeRef.current *= Math.max(0, 1 - dt / 220);
      if (shakeRef.current < 0.15) shakeRef.current = 0;

      const target = xrayOn ? 1 : 0;
      xrayRef.current += (target - xrayRef.current) * Math.min(1, dt / 120);

      const bonus = isBonusLevel(w.level);
      const frozen = phaseRef.current !== "playing";
      if (r3d) {
        r3d.render(w, {
          image: bonus ? null : image,
          xray: xrayRef.current,
          particles: ps,
          hover: hoverRef.current,
          shake: shakeRef.current,
          settings: settingsRef.current,
          wearing: wearingRef.current,
          frozen,
        });
      } else if (ctx) {
        draw(
          ctx,
          dpr,
          w,
          bonus ? null : image,
          xrayRef.current,
          ps,
          hoverRef.current,
          shakeRef.current,
          settingsRef.current,
          wearingRef.current,
          frozen,
        );
      }

      hudClock += dt;
      if (hudClock > 100) {
        hudClock = 0;
        setHud({
          title: w.level.title,
          collected: w.collected,
          total: w.totalCollectible,
          deaths: w.deaths,
          won: w.won,
          seconds: w.elapsed / 1000,
        });
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      r3d?.dispose();
    };
  }, [image, xrayOn, sfx, mode]);

  useEffect(() => {
    onState?.(hud);
  }, [hud, onState]);

  // --- hover tooltips ---------------------------------------------------
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const wx = ((e.clientX - rect.left) / rect.width) * WORLD_W;
    const wy = ((e.clientY - rect.top) / rect.height) * WORLD_H;

    let found: Entity | null = null;
    for (const ent of level.entities) {
      const r = toWorld(ent.box);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        found = ent;
        break;
      }
    }
    hoverRef.current = found;
    setTip(
      found
        ? {
            e: found,
            x: ((e.clientX - rect.left) / rect.width) * 100,
            y: ((e.clientY - rect.top) / rect.height) * 100,
          }
        : null,
    );
  };

  const onLeave = () => {
    hoverRef.current = null;
    setTip(null);
  };

  const overlayOpen = phase !== "playing" || showSettings || showDashboard;
  const big = fullscreen || maximised;

  return (
    <div className="w-full">
      <div
        ref={shellRef}
        className={
          big
            ? "fixed inset-0 z-50 flex h-screen w-screen items-center justify-center bg-black"
            : "w-full"
        }
      >
        <div
          className={`relative overflow-hidden bg-black ${
            big ? "" : "aspect-video w-full rounded-xl border border-white/10 shadow-2xl"
          }`}
          style={
            big
              ? { aspectRatio: "16 / 9", height: "100%", width: "auto", maxWidth: "100%", maxHeight: "100%" }
              : undefined
          }
        >
          <canvas
            key={mode}
            ref={canvasRef}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            className="absolute inset-0 h-full w-full"
          />

          {tip && !overlayOpen && (
            <div
              className="pointer-events-none absolute z-20 max-w-[15rem] -translate-x-1/2 -translate-y-full rounded-lg border border-white/15 bg-neutral-950/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
              style={{
                left: `${Math.min(88, Math.max(12, tip.x))}%`,
                top: `${Math.max(9, tip.y - 2)}%`,
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: MATERIAL_SPECS[tip.e.material].color }}
                />
                <span className="font-medium text-white">{tip.e.label}</span>
                <span
                  className="ml-auto text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: MATERIAL_SPECS[tip.e.material].color }}
                >
                  {MATERIAL_SPECS[tip.e.material].display}
                </span>
              </div>
              <p className="mt-1 leading-snug text-neutral-400">{tip.e.reason}</p>
              <p className="mt-1 leading-snug text-neutral-500">
                {MATERIAL_SPECS[tip.e.material].rule}
              </p>
            </div>
          )}

          {/* HUD */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3 text-xs">
            <div className="truncate rounded-lg border border-white/10 bg-black/55 px-3 py-1.5 backdrop-blur">
              <span className="font-semibold text-white">{hud.title}</span>
            </div>
            <div className="flex shrink-0 gap-2">
              <Stat label="coins" value={`${hud.collected}/${hud.total}`} />
              <Stat label="falls" value={String(hud.deaths)} />
              <Stat label="time" value={`${hud.seconds.toFixed(1)}s`} />
            </div>
          </div>

          {/* In-canvas controls, above the overlays: full screen and settings
              have to stay reachable from the Ready and Paused screens too. */}
          <div className="absolute inset-x-0 bottom-0 z-40 flex items-center justify-between gap-2 p-3">
            <div className="flex gap-1.5">
              {phase === "playing" && (
                <IconButton label="Pause  ·  Esc" onClick={togglePause}>
                  <PauseIcon />
                </IconButton>
              )}
              {phase === "paused" && (
                <IconButton label="Resume  ·  Esc" onClick={togglePause}>
                  <PlayIcon />
                </IconButton>
              )}
              <IconButton label="Restart  ·  R" onClick={restart}>
                <RestartIcon />
              </IconButton>
            </div>
            <div className="flex gap-1.5">
              <IconButton
                label="X-ray  ·  X"
                active={xrayOn}
                onClick={() => setXrayOn((v) => !v)}
              >
                <XrayIcon />
              </IconButton>
              <IconButton
                label="Settings"
                active={showSettings}
                onClick={() => {
                  setShowSettings((v) => !v);
                  if (phase === "playing") togglePause();
                }}
              >
                <GearIcon />
              </IconButton>
              <IconButton
                label={big ? "Exit full screen  ·  Esc" : "Full screen  ·  F"}
                active={big}
                onClick={() => void toggleFullscreen()}
              >
                {big ? <ExitFullIcon /> : <FullIcon />}
              </IconButton>
            </div>
          </div>

          {/* ---------------------------------------------------- overlays */}
          {phase === "ready" && !showSettings && !showDashboard && (
            <Overlay>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300">
                Ready
              </p>
              <h2 className="mt-2 max-w-lg text-center text-3xl font-semibold text-white">
                {level.title}
              </h2>
              <p className="mt-2 max-w-md text-center text-sm text-neutral-300">
                {level.tagline}
              </p>
              <button
                onClick={start}
                className="mt-6 rounded-lg bg-white px-7 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
              >
                Start
              </button>
              <p className="mt-3 text-xs text-neutral-500">
                or press <Kbd>space</Kbd>
              </p>
              <ControlLegend />
            </Overlay>
          )}

          {phase === "paused" && !showSettings && !showDashboard && (
            <Overlay>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-400">
                Paused
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{level.title}</h2>
              <div className="mt-6 flex flex-col gap-2">
                <button
                  onClick={togglePause}
                  className="rounded-lg bg-white px-7 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
                >
                  Resume
                </button>
                <button
                  onClick={restart}
                  className="rounded-lg border border-white/15 px-7 py-2 text-sm text-neutral-200 transition hover:border-white/35"
                >
                  Restart
                </button>
                <button
                  onClick={() => onDashboard(true)}
                  className="rounded-lg border border-white/15 px-7 py-2 text-sm text-neutral-200 transition hover:border-white/35"
                >
                  Characters
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="rounded-lg border border-white/15 px-7 py-2 text-sm text-neutral-200 transition hover:border-white/35"
                >
                  Settings
                </button>
              </div>
              <ControlLegend />
            </Overlay>
          )}

          {phase === "dead" && !showSettings && !showDashboard && (
            <Overlay>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-rose-300">
                {cause === "fell"
                  ? "You fell"
                  : cause === "monster"
                    ? "Caught"
                    : "Ouch"}
              </p>
              <h2 className="mt-2 max-w-md text-center text-2xl font-semibold text-white">
                {cause === "fell"
                  ? "Off the edge of the world."
                  : cause === "monster"
                    ? "Something was patrolling there."
                    : `The ${cause} got you.`}
              </h2>
              <p className="mt-2 text-sm text-neutral-400">
                {hud.deaths} fall{hud.deaths === 1 ? "" : "s"} so far
              </p>
              <button
                onClick={retry}
                className="mt-6 rounded-lg bg-white px-7 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
              >
                Try again
              </button>
              <p className="mt-3 text-xs text-neutral-500">
                or press <Kbd>space</Kbd> · the clock restarts
              </p>
            </Overlay>
          )}

          {phase === "won" && !showSettings && !showDashboard && (
            <Overlay>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300">
                Cleared
              </p>
              <h2 className="mt-2 text-3xl font-semibold text-white">
                {hud.seconds.toFixed(1)}s
              </h2>
              <p className="mt-1 text-sm text-neutral-300">
                {hud.collected}/{hud.total} coins · {hud.deaths} fall
                {hud.deaths === 1 ? "" : "s"}
              </p>
              <button
                onClick={restart}
                className="mt-6 rounded-lg bg-white px-7 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
              >
                Play again
              </button>
              <p className="mt-3 text-xs text-neutral-500">
                or drop in another photo
              </p>
            </Overlay>
          )}

          {showDashboard && (
            <CharacterDashboard
              character={settings.character}
              color={settings.color}
              progress={progress}
              onCharacter={(k) => updateSetting("character", k)}
              onColor={(c) => updateSetting("color", c)}
              onClose={() => onDashboard(false)}
            />
          )}

          {showSettings && !showDashboard && (
            <Overlay>
              <div className="flex max-h-full w-full max-w-sm flex-col px-6 py-4">
                <div className="flex shrink-0 items-center justify-between px-3">
                  <h2 className="text-lg font-semibold text-white">Settings</h2>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="rounded-md border border-white/15 px-2.5 py-1 text-xs text-neutral-300 transition hover:border-white/35"
                  >
                    Done
                  </button>
                </div>
                <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                  <button
                    onClick={() => {
                      setShowSettings(false);
                      onDashboard(true);
                    }}
                    className="mb-3 flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-white/30"
                  >
                    <span>
                      <span className="block text-sm text-neutral-100">
                        Characters
                      </span>
                      <span className="block text-xs text-neutral-500">
                        Pick a look and spend your coins.
                      </span>
                    </span>
                    <span className="font-mono text-sm text-amber-200">
                      {progress.coins}
                    </span>
                  </button>
                  <div className="border-t border-white/10 pt-3">
                    <p className="px-3 text-sm text-neutral-100">Renderer</p>
                    <p className="px-3 text-xs text-neutral-500">
                      {webglFailed
                        ? "WebGL would not start on this machine, so the flat renderer is in use."
                        : "The diorama extrudes every object out of the photo."}
                    </p>
                    <div className="mt-2 flex gap-1.5 px-3">
                      {(["3d", "2d"] as RenderMode[]).map((m) => (
                        <button
                          key={m}
                          disabled={m === "3d" && webglFailed}
                          onClick={() => updateSetting("render", m)}
                          aria-pressed={settings.render === m}
                          className={`flex-1 rounded-lg border px-3 py-2 text-xs transition ${
                            settings.render === m
                              ? "border-sky-400/70 bg-sky-400/15 text-sky-100"
                              : "border-white/10 text-neutral-300 hover:border-white/30 disabled:opacity-40"
                          }`}
                        >
                          {m === "3d" ? "Diorama (3D)" : "Flat (2D)"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 border-t border-white/10 pt-3">
                    {TOGGLE_KEYS.map((k) => (
                      <Toggle
                        key={k}
                        on={settings[k]}
                        name={SETTING_LABELS[k].name}
                        hint={SETTING_LABELS[k].hint}
                        onClick={() => updateSetting(k, !settings[k])}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </Overlay>
          )}
        </div>
      </div>

      {!big && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-neutral-500">
          <span className="flex items-center gap-1">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>space</Kbd> jump
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd> climb
          </span>
          <span className="flex items-center gap-1">
            <span className="text-pink-300">pipes</span> drop you in
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> pause
          </span>
          <span className="flex items-center gap-1">
            <Kbd>x</Kbd> x-ray
          </span>
          <span className="flex items-center gap-1">
            <Kbd>f</Kbd> full screen
          </span>
          <span className="flex items-center gap-1">
            <Kbd>r</Kbd> restart
          </span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- chrome */

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm">
      {children}
    </div>
  );
}

function ControlLegend() {
  return (
    <div className="mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-neutral-500">
      <span className="flex items-center gap-1">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd> move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>space</Kbd> jump
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↑</Kbd> climb
      </span>
      <span className="flex items-center gap-1">
        <span className="text-pink-300">pipes</span> drop you in
      </span>
      <span className="flex items-center gap-1">
        <Kbd>x</Kbd> x-ray
      </span>
      <span className="flex items-center gap-1">
        <Kbd>f</Kbd> full screen
      </span>
    </div>
  );
}

function Toggle({
  on,
  name,
  hint,
  onClick,
}: {
  on: boolean;
  name: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/5"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          on ? "bg-sky-500" : "bg-neutral-700"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-neutral-100">{name}</span>
        <span className="block text-xs leading-snug text-neutral-500">{hint}</span>
      </span>
    </button>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-8 w-8 place-items-center rounded-lg border backdrop-blur transition ${
        active
          ? "border-sky-400/60 bg-sky-400/20 text-sky-200"
          : "border-white/10 bg-black/55 text-neutral-300 hover:border-white/30 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-center backdrop-blur">
      <div className="font-mono text-sm text-white">{value}</div>
      <div className="text-[9px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
      {children}
    </kbd>
  );
}

const ico = "h-4 w-4 fill-current";
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" className={ico}><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 16 16" className={ico}><path d="M5 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 5 3.5Z" /></svg>
);
const RestartIcon = () => (
  <svg viewBox="0 0 16 16" className="h-4 w-4 stroke-current" fill="none" strokeWidth="1.6" strokeLinecap="round"><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5V5h-2.5" /></svg>
);
const XrayIcon = () => (
  <svg viewBox="0 0 16 16" className="h-4 w-4 stroke-current" fill="none" strokeWidth="1.5"><rect x="2.2" y="4.2" width="11.6" height="7.6" rx="1.4" /><path d="M2.2 8h11.6M8 4.2v7.6" strokeDasharray="2 1.6" /></svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 16 16" className={ico}><path d="M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4Zm0 4.1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" /><path d="m13.6 9.3-.9-.5a4.9 4.9 0 0 0 0-1.6l.9-.5a.6.6 0 0 0 .2-.8l-.9-1.5a.6.6 0 0 0-.8-.2l-.9.5a4.8 4.8 0 0 0-1.4-.8V3a.6.6 0 0 0-.6-.6H7.3a.6.6 0 0 0-.6.6v1a4.8 4.8 0 0 0-1.4.8l-.9-.5a.6.6 0 0 0-.8.2l-.9 1.5a.6.6 0 0 0 .2.8l.9.5a4.9 4.9 0 0 0 0 1.6l-.9.5a.6.6 0 0 0-.2.8l.9 1.5a.6.6 0 0 0 .8.2l.9-.5c.4.3.9.6 1.4.8v1c0 .3.3.6.6.6h1.4c.3 0 .6-.3.6-.6v-1c.5-.2 1-.5 1.4-.8l.9.5a.6.6 0 0 0 .8-.2l.9-1.5a.6.6 0 0 0-.2-.8Z" /></svg>
);
const FullIcon = () => (
  <svg viewBox="0 0 16 16" className="h-4 w-4 stroke-current" fill="none" strokeWidth="1.6" strokeLinecap="round"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" /></svg>
);
const ExitFullIcon = () => (
  <svg viewBox="0 0 16 16" className="h-4 w-4 stroke-current" fill="none" strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" /></svg>
);

/* -------------------------------------------------------------- drawing */

function draw(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  w: World,
  image: HTMLImageElement | null,
  xray: number,
  particles: Particle[],
  hover: Entity | null,
  shake: number,
  settings: Settings,
  wearing: CharacterKind,
  frozen: boolean,
) {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);
  ctx.fillStyle = "#07080d";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  ctx.save();
  /**
   * Upward camera follow, matching the 3D renderer.
   *
   * The canvas maps the world 1:1, so a player who jumps above y = 0 simply
   * leaves the picture. They can: standing on the highest platform still leaves
   * a full jump of headroom above the world. Pan only when they would otherwise
   * be lost, and never downward — there is nothing under the world to show.
   */
  const lift = Math.max(0, PLAYER_H * 2.2 - (w.player.y + PLAYER_H / 2));
  if (lift > 0) ctx.translate(0, lift);
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  }

  if (image) {
    ctx.globalAlpha = 1 - xray * 0.86;
    ctx.drawImage(image, 0, 0, WORLD_W, WORLD_H);
    ctx.globalAlpha = 1;
  }
  if (xray > 0.01) {
    ctx.fillStyle = `rgba(4,6,12,${xray * 0.55})`;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = `rgba(56,189,248,${xray * 0.07})`;
    ctx.lineWidth = 1;
    for (let x = 0; x <= WORLD_W; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_H);
      ctx.stroke();
    }
    for (let y = 0; y <= WORLD_H; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
      ctx.stroke();
    }
  }

  for (const b of w.bodies) {
    const spec = MATERIAL_SPECS[b.entity.material];
    const isHover = hover?.id === b.entity.id;
    const gone = b.respawnAt !== undefined;
    if (b.entity.material === "collectible" && b.taken) continue;
    const baseAlpha = gone ? 0.12 : 1;

    if (b.entity.material === "collectible") {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const bob = Math.sin(w.elapsed / 260 + cx) * 3;
      ctx.globalAlpha = baseAlpha;
      ctx.beginPath();
      ctx.arc(cx, cy + bob, Math.min(b.w, b.h) / 2.4, 0, Math.PI * 2);
      ctx.fillStyle = spec.color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }

    if (b.entity.material === "tunnel") {
      drawPipe(ctx, b, xray);
      continue;
    }

    const fill = xray * (isHover ? 0.34 : 0.2);
    if (fill > 0.01) {
      ctx.globalAlpha = fill * baseAlpha;
      ctx.fillStyle = spec.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = (0.35 + xray * 0.65) * baseAlpha * (isHover ? 1 : 0.9);
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = isHover ? 3 : 2;
    if (b.entity.synthetic) ctx.setLineDash([9, 7]);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (spec.solid && !gone) {
      const crumbling = b.entity.material === "crumbling" && b.crumbleAt !== undefined;
      ctx.globalAlpha = crumbling ? 0.4 + Math.sin(w.elapsed / 40) * 0.3 : 0.95;
      ctx.strokeStyle = spec.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(b.x + 2, b.y + 2);
      ctx.lineTo(b.x + b.w - 2, b.y + 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const labelAlpha = Math.max(
      xray > 0.35 ? (xray - 0.35) / 0.65 : 0,
      settings.labels ? 0.75 : 0,
    );
    if (labelAlpha > 0.01) {
      ctx.globalAlpha = labelAlpha;
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = spec.color;
      const text = b.entity.synthetic ? `${b.entity.label} (solver)` : b.entity.label;
      ctx.fillText(text, b.x + 4, Math.max(14, b.y - 6));
      ctx.globalAlpha = 1;
    }
  }

  const g = w.goal;
  const pulse = 0.6 + Math.sin(w.elapsed / 260) * 0.4;
  ctx.globalAlpha = 0.25 + pulse * 0.25;
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(g.x + g.w / 2, g.y + g.h / 2, g.w * (0.8 + pulse * 0.35), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#e0f2fe";
  ctx.fillRect(g.x + g.w / 2 - 2, g.y, 4, g.h);
  ctx.beginPath();
  ctx.moveTo(g.x + g.w / 2 + 2, g.y + 3);
  ctx.lineTo(g.x + g.w / 2 + 24, g.y + 11);
  ctx.lineTo(g.x + g.w / 2 + 2, g.y + 19);
  ctx.closePath();
  ctx.fillStyle = "#38bdf8";
  ctx.fill();

  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const m of w.monsters) drawMonster(ctx, m, w.elapsed, frozen);
  drawPlayer(ctx, w, settings, wearing, frozen);
  ctx.restore();
  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  w: World,
  settings: Settings,
  wearing: CharacterKind,
  frozen: boolean,
) {
  const p = w.player;
  // Squash and stretch sells the weight of the jump. It deforms how the
  // character is DRAWN, never the box it collides with.
  const stretch = frozen ? 0 : Math.max(-0.22, Math.min(0.22, p.vy / 4200));
  const h = PLAYER_H * (1 + stretch);
  const wd = PLAYER_W * (1 - stretch * 0.75);

  drawCharacter(ctx, {
    kind: wearing,
    color: settings.color,
    x: p.x + (PLAYER_W - wd) / 2,
    y: p.y + (PLAYER_H - h),
    w: wd,
    h,
    facing: p.facing,
    t: w.elapsed,
    frozen,
  });
}

/**
 * A pipe, drawn over the tunnel's collision box. The lip is deliberately drawn
 * flush with the top of the box: the player stands on that edge, and a pipe
 * whose art sits above its collider is a pipe players fall through.
 */
function drawPipe(
  ctx: CanvasRenderingContext2D,
  b: { x: number; y: number; w: number; h: number },
  xray: number,
) {
  const lip = Math.min(22, b.h * 0.42);
  ctx.save();
  ctx.globalAlpha = 0.55 + xray * 0.45;

  ctx.fillStyle = "#2f7d55";
  ctx.fillRect(b.x + 8, b.y + lip, b.w - 16, b.h - lip);
  ctx.fillStyle = "#3f9d6b";
  ctx.fillRect(b.x + 14, b.y + lip, (b.w - 16) * 0.28, b.h - lip);

  ctx.fillStyle = "#2a6f4b";
  ctx.fillRect(b.x, b.y, b.w, lip);
  ctx.fillStyle = "#46a877";
  ctx.fillRect(b.x, b.y, b.w, Math.max(4, lip * 0.32));

  // Mouth, so it reads as something you can enter.
  ctx.fillStyle = "#0d2419";
  ctx.fillRect(b.x + 10, b.y + 3, b.w - 20, Math.max(3, lip * 0.34));

  ctx.globalAlpha = 1;
  ctx.strokeStyle = MATERIAL_SPECS.tunnel.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  ctx.restore();
}

/** Patrolling monster: a squat body, feet that shuffle, and a scowl. */
function drawMonster(
  ctx: CanvasRenderingContext2D,
  m: Monster,
  t: number,
  frozen: boolean,
) {
  if (!m.alive) {
    // Squashed: flatten into the surface for a moment, then vanish.
    const left = (m.goneAt ?? 0) - t;
    if (left <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, left / 400));
    ctx.fillStyle = "#a3405a";
    const h = MONSTER_H * 0.28;
    roundRect(ctx, m.x - 3, m.y + MONSTER_H - h, MONSTER_W + 6, h, h / 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const step = frozen ? 0 : Math.sin(t / 90) * 2.5;
  ctx.save();
  ctx.shadowColor = "rgba(251,113,133,.5)";
  ctx.shadowBlur = 14;

  // Feet first, so the body overlaps them.
  ctx.fillStyle = "#7f2740";
  roundRect(ctx, m.x + 3 + step, m.y + MONSTER_H - 7, 12, 8, 3);
  ctx.fill();
  roundRect(ctx, m.x + MONSTER_W - 15 - step, m.y + MONSTER_H - 7, 12, 8, 3);
  ctx.fill();

  ctx.fillStyle = "#e0556f";
  roundRect(ctx, m.x, m.y, MONSTER_W, MONSTER_H - 5, 11);
  ctx.fill();
  ctx.restore();

  // Eyes look the way it is walking.
  const ex = m.x + MONSTER_W / 2 + m.dir * 5;
  const ey = m.y + MONSTER_H * 0.4;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(ex - 7, ey, 5.4, 0, Math.PI * 2);
  ctx.arc(ex + 7, ey, 5.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#20101a";
  ctx.beginPath();
  ctx.arc(ex - 7 + m.dir * 1.8, ey, 2.6, 0, Math.PI * 2);
  ctx.arc(ex + 7 + m.dir * 1.8, ey, 2.6, 0, Math.PI * 2);
  ctx.fill();

  // Brow: the difference between a monster and a bean.
  ctx.strokeStyle = "#20101a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ex - 12, ey - 7);
  ctx.lineTo(ex - 3, ey - 4);
  ctx.moveTo(ex + 12, ey - 7);
  ctx.lineTo(ex + 3, ey - 4);
  ctx.stroke();
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
