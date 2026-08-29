# 3. Gameplay stays on a 2D plane; the diorama renderer is a view, not a world

## Status

Accepted

## Context

A WebGL diorama — each detected object extruded out of the photo, lit and
shadowed in 3D — was a natural extension once the flat canvas renderer
worked. The obvious next step for "let's make it 3D" is to let the player
move in three dimensions.

But the entire completability guarantee (ADR 0001) is built on a
two-dimensional jump-arc model: `canTraverse` reasons about horizontal
distance and vertical rise between two surfaces on a single plane. Adding a
depth axis the player can actually move along means the solver would need
to prove reachability through a 3D space instead of a 2D graph — a
substantially harder problem, and one with no existing proof to build on,
days before a submission deadline.

## Decision

Physics (`lib/physics.ts`) stays strictly 2D: the player, monsters, and every
collision live on a single `z = 0` plane, exactly as before. The 3D renderer
(`lib/render3d.ts`) is purely a *view* of that 2D state — it extrudes each
flat object into a slab facing the camera, adds lighting and shadows and a
parallax camera that drifts toward the player, but every position it draws
comes directly from the same 2D simulation the flat canvas renderer draws
from. Renderers share one interface (`lib/renderer.ts`) and are swappable at
runtime; `lib/physics.ts` and `lib/solver.ts` have zero awareness that a 3D
option exists.

## Consequences

- The completability proof from ADR 0001 stays valid no matter which
  renderer is active — 3D is a skin, not a new game.
- The 3D renderer gets the full visual payoff (depth, lighting, a photo
  literally standing up out of its own boxes) without a rewrite of the
  solver, at the cost of not being a *true* 3D platformer — there is no
  jumping toward or away from the camera, and there never will be under this
  architecture.
- Because the interface is small (`render(world, opts)` / `dispose()`), a
  WebGL context that fails to initialise falls back to the flat canvas
  renderer with no special-casing elsewhere in the game loop (see
  `tryCreateRenderer3D`, which returns `null` on failure rather than
  throwing) — a robustness win that fell out of the 2D/3D split for free.
