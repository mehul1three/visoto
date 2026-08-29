# 1. Prove completability before a level is ever shown

## Status

Accepted

## Context

A vision model returns *plausible* bounding boxes, not a *playable* level.
Boxes overlap, float in mid-air, sit flush against each other, or leave the
goal stranded across a gap no jump can cross. Shipping model output straight
to the player means a meaningful fraction of generated levels are impossible
to finish — and an impossible level is indistinguishable from a broken app.
The project's core pitch ("photograph anything, play it") fails immediately
if the first photo a judge or user tries produces a dead end.

## Decision

Every level — hand-authored sample or model-generated — passes through
`solve()` (`lib/solver.ts`) before the player ever sees it. `solve()`:

1. Sanitises the raw entity list (clamps boxes, drops frame-sized or
   duplicate ones, guarantees a floor).
2. Builds a graph where each solid's top edge is a node.
3. Proves reachability with a BFS across that graph, using the actual jump
   arc from `lib/physics.ts` (`canTraverse`) rather than a rough
   approximation of it.
4. Repairs anything unreachable — by choosing a better goal, laying stepping
   stones, or inserting bridge platforms — and re-proves the result.

The physics constants used by the proof (`JUMP_HEIGHT`, `JUMP_RANGE`,
`MOVE_SPEED`, `GRAVITY`) are imported from `lib/physics.ts`, not copied into
the solver. If the two ever drifted apart, the proof would describe a player
that doesn't exist.

## Consequences

- The player never sees an impossible level from this app. When the model's
  layout can't stand on its own, the solver's own construction (stepping
  stones, bridges) becomes part of what gets rendered — visibly marked as
  synthetic, and reported in the UI ("Laid N stepping stones...") rather
  than silently substituted.
- The solver's proof is only as good as its model of the physics engine. A
  gap between the two (the arc model not knowing about hazards, headroom, or
  landing clearance) produces "provably reachable, actually not" levels —
  see ADR 0007. `npm run verify`, a bot harness that plays levels on the
  *real* physics engine, exists specifically to catch that gap empirically
  rather than trust the proof blindly.
- Every repair pass adds latency and code complexity. This was judged worth
  it: a demo that occasionally hands a judge an unwinnable level is worse
  than a demo that's a few hundred milliseconds slower.
