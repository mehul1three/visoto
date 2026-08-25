"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Game from "@/components/Game";
import Reveal from "@/components/Reveal";
import { EXPORTS, ExportKind } from "@/lib/export";
import { loadImage, prepareImage } from "@/lib/image";
import { Level, MATERIAL_SPECS, MATERIALS } from "@/lib/level";
import { SAMPLES } from "@/lib/samples";
import {
  commitProgress,
  getProgress,
  getServerProgress,
  nextUnlock,
  subscribeProgress,
} from "@/lib/progress";
import { SolveReport, solve } from "@/lib/solver";

type Phase = "loading" | "analyzing" | "revealing" | "playing" | "error";

export default function Page() {
  // solve() is pure and synchronous, so the opening level is initial state
  // rather than something an effect has to go and fetch. The page renders
  // playable on the first paint; only the artwork arrives asynchronously.
  const [initial] = useState(() => solve(SAMPLES[0].level));
  const [phase, setPhase] = useState<Phase>("playing");
  const [level, setLevel] = useState<Level | null>(initial.level);
  const [pending, setPending] = useState<Level | null>(null);
  const [report, setReport] = useState<SolveReport | null>(initial.report);
  const [pendingReport, setPendingReport] = useState<SolveReport | null>(null);
  // Bumped whenever a new level is committed. Used as the Game key so a fresh
  // level remounts the game and opens on its own Ready screen, rather than
  // silently swapping the world out from under a player mid-jump.
  const [levelKey, setLevelKey] = useState(0);
  // Which built-in scene is on screen, or null once the player supplies a photo.
  const [activeSample, setActiveSample] = useState<string | null>(SAMPLES[0].key);
  const progress = useSyncExternalStore(
    subscribeProgress,
    getProgress,
    getServerProgress,
  );
  const [showDashboard, setShowDashboard] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  // The photo being analysed is kept apart from the one currently in play. If
  // the analysis fails we still have a level for the old photo and none for the
  // new one, and showing the two together renders a level that does not exist.
  const [pendingImage, setPendingImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Load one of the built-in scenes. */
  const loadSample = useCallback(async (key: string) => {
    const sample = SAMPLES.find((s) => s.key === key);
    if (!sample) return;
    // Everything below happens after an await, so mounting this component does
    // not set state synchronously inside the effect.
    try {
      const img = await loadImage(sample.image);
      const { level: solved, report: rep } = solve(sample.level);
      setError(null);
      setPending(null);
      setImage(img);
      setLevel(solved);
      setReport(rep);
      setActiveSample(sample.key);
      setLevelKey((k) => k + 1);
      setPhase("playing");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadImage(SAMPLES[0].image)
      .then((img) => {
        if (!cancelled) setImage(img);
      })
      .catch(() => {
        /* the level is playable without its backdrop */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Send a photo to the model and turn the answer into a level. */
  const analyze = useCallback(async (file: File | Blob) => {
    setError(null);
    setPending(null);
    const started = performance.now();
    try {
      let prepared;
      try {
        prepared = await prepareImage(file);
      } catch {
        setError(
          "That image could not be decoded. Some phone photos are HEIC — " +
            "export or screenshot it as JPEG or PNG and try again.",
        );
        setPhase("error");
        return;
      }
      const img = await loadImage(prepared.dataUrl);
      setPendingImage(img);
      setPhase("analyzing");

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: prepared.dataUrl }),
        // The route caps itself at 60s; give it a little room, then give up
        // rather than leaving the scan animation running forever.
        signal: AbortSignal.timeout(75_000),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? `Analysis failed (${res.status}).`);
        setPendingImage(null);
        setPhase("error");
        return;
      }
      setElapsed((performance.now() - started) / 1000);
      setPendingReport(data.report);
      setPending(data.level as Level);
      setPhase("revealing");
    } catch (e) {
      const err = e as Error;
      setError(
        err.name === "TimeoutError" || err.name === "AbortError"
          ? "The analysis took too long and was cancelled. Try again, or use a simpler photo."
          : err.message,
      );
      setPendingImage(null);
      setPhase("error");
    }
  }, []);

  const onRevealDone = useCallback(() => {
    if (pending && pendingImage) {
      setLevel(pending);
      setImage(pendingImage);
      setReport(pendingReport);
      setActiveSample(null);
      setLevelKey((k) => k + 1);
    }
    setPendingImage(null);
    setPhase("playing");
  }, [pending, pendingImage, pendingReport]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith("image/")) analyze(file);
  };

  const download = (kind: ExportKind) => {
    if (!level) return;
    const spec = EXPORTS[kind];
    const blob = new Blob([spec.fn(level)], { type: spec.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(level.title)}.${spec.ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shown = phase === "revealing" ? pending : level;

  return (
    <main
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="min-h-screen bg-neutral-950 text-neutral-200"
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-sky-400 px-10 py-8 text-lg font-medium text-sky-200">
            Drop a photo to turn it into a level
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl px-5 py-10">
        <header className="mb-8">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Playground
            </h1>
            <p className="text-sm text-neutral-500">your room is the level</p>
          </div>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
            Photograph anything. Every object in it is read for what it{" "}
            <em className="not-italic text-neutral-200">is</em>, then given the
            physics that follows from that — a pillow is bouncy because foam
            compresses, a full mug is a hazard because the coffee is hot. The
            result is a playable platformer built from your actual desk, proved
            completable before you ever touch it.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <section>
            {phase === "error" && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}

            {(phase === "analyzing" || phase === "revealing") && pendingImage ? (
              <Reveal image={pendingImage} level={pending} onDone={onRevealDone} />
            ) : level ? (
              <Game
                key={levelKey}
                level={level}
                image={image}
                progress={progress}
                onProgress={commitProgress}
                showDashboard={showDashboard}
                onDashboard={setShowDashboard}
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-white/10 bg-black text-sm text-neutral-500">
                Loading…
              </div>
            )}

            {shown && (
              <p className="mt-3 text-sm text-neutral-500">
                <span className="text-neutral-300">{shown.title}</span> —{" "}
                {shown.tagline}
              </p>
            )}
          </section>

          <aside className="space-y-4">
            <button
              onClick={() => setShowDashboard(true)}
              className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-neutral-900/60 p-4 text-left transition hover:border-white/25"
            >
              <span>
                <span className="block text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
                  Characters
                </span>
                <span className="mt-1 block text-xs text-neutral-400">
                  {nextUnlock(progress.coins)
                    ? `${nextUnlock(progress.coins)!.cost - progress.coins} more to unlock ${nextUnlock(progress.coins)!.name}`
                    : "All unlocked"}
                </span>
              </span>
              <span className="flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                <span className="font-mono text-sm text-amber-200">
                  {progress.coins}
                </span>
              </span>
            </button>

            <Panel title="Source">
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200"
              >
                Upload a photo
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) analyze(f);
                  e.target.value = "";
                }}
              />
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                Or drag one anywhere on this page. Photos are cropped to 16:9 in
                your browser and never stored.
              </p>
              <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
                Or play a built-in scene
              </p>
              <div className="grid grid-cols-3 gap-2">
                {SAMPLES.map((s) => {
                  const active = activeSample === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => void loadSample(s.key)}
                      title={s.name}
                      aria-pressed={active}
                      className={`overflow-hidden rounded-lg border text-left transition ${
                        active
                          ? "border-sky-400/70 ring-1 ring-sky-400/40"
                          : "border-white/10 hover:border-white/30"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.image}
                        alt={s.name}
                        className="aspect-video w-full object-cover"
                      />
                      <span
                        className={`block truncate px-1.5 py-1 text-[10px] ${
                          active ? "text-sky-200" : "text-neutral-400"
                        }`}
                      >
                        {s.name}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-neutral-600">
                The three built-in scenes are illustrations, not photographs —
                upload a photo for the real thing.
              </p>
            </Panel>

            {report && (
              <Panel title="Solver">
                <dl className="space-y-1.5 text-xs">
                  <Row
                    k="Goal reachable"
                    v={<span className="text-emerald-400">proved</span>}
                  />
                  <Row k="Standable surfaces" v={String(report.surfaces)} />
                  <Row
                    k="Reachable"
                    v={`${Math.round(report.coverage * 100)}%`}
                  />
                  {elapsed > 0 && phase === "playing" && (
                    <Row k="Generated in" v={`${elapsed.toFixed(1)}s`} />
                  )}
                </dl>
                {report.repairs.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 border-t border-white/10 pt-3 text-xs text-neutral-400">
                    {report.repairs.map((r, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-amber-400">›</span>
                        <span className="leading-snug">{r}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 border-t border-white/10 pt-3 text-xs text-neutral-500">
                    No repairs needed — the scene was playable as detected.
                  </p>
                )}
              </Panel>
            )}

            {level && (
              <Panel title={`What the model saw · ${level.entities.length}`}>
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {level.entities.map((e) => (
                    <li key={e.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: MATERIAL_SPECS[e.material].color }}
                        />
                        <span className="truncate text-neutral-200">
                          {e.label}
                        </span>
                        <span
                          className="ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: MATERIAL_SPECS[e.material].color }}
                        >
                          {MATERIAL_SPECS[e.material].display}
                        </span>
                      </div>
                      <p className="mt-0.5 pl-4 leading-snug text-neutral-500">
                        {e.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {level && (
              <Panel title="Export">
                <p className="mb-2 text-xs leading-relaxed text-neutral-500">
                  Take the level somewhere real. Materials survive as node groups
                  and object properties.
                </p>
                <div className="space-y-1.5">
                  {(Object.keys(EXPORTS) as ExportKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => download(k)}
                      className="w-full rounded-md border border-white/10 px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-white/25 hover:bg-white/5"
                    >
                      {EXPORTS[k].label}
                      <span className="ml-1 text-neutral-600">
                        .{EXPORTS[k].ext}
                      </span>
                    </button>
                  ))}
                </div>
              </Panel>
            )}
          </aside>
        </div>

        <section className="mt-10 border-t border-white/10 pt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            The seven materials
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MATERIALS.map((m) => (
              <div
                key={m}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: MATERIAL_SPECS[m].color }}
                  />
                  <span className="text-sm font-medium text-neutral-200">
                    {MATERIAL_SPECS[m].display}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-snug text-neutral-500">
                  {MATERIAL_SPECS[m].rule}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-500">{k}</dt>
      <dd className="font-mono text-neutral-200">{v}</dd>
    </div>
  );
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "level"
  );
}
