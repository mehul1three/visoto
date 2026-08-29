# 7. Reachability must simulate the whole jump arc, not just its endpoints

## Status

Accepted

## Context

`canTraverse`, the function underneath every completability proof (ADR
0001), originally decided whether a jump from surface A to surface B was
possible using only distance and height: is the gap within the jump's
horizontal reach, and is the rise within the jump's vertical reach. That's
sufficient when the space between A and B is empty air. It is not sufficient
when a hazard sits in that space — the check answered "can a jump physically
cover this distance," which is a different question from "does this jump
kill the player," and only the second question is the one that actually
matters. A route straight through an open flame registered as fully
reachable, because reachability was only ever checked at the two endpoints.

Fixing the endpoint check alone made the pipeline temporarily *worse*, not
better, and that failure is itself part of the decision: `bridgeToward` (the
function that plugs unreachable gaps with an inserted platform) and the
final goal-relocation rescue were both still reasoning about jumps using
only distance and height. Once `canTraverse` correctly started rejecting
hazardous arcs, those two kept proposing routes the now-stricter proof would
then reject, with no fallback — so more levels came back "unreachable," not
fewer. One rescue path in particular picked a landing spot by checking
headroom against solids only, since standing on the ground is never blocked
by fire; it could — and did — place the goal in mid-air, inside a hazard,
having verified clearance against a check that couldn't see hazards at all.

## Decision

`arcClearOfHazards` (`lib/solver.ts`) walks the same parabola the physics
engine would actually fly for a given jump — same gravity, launch velocity,
and horizontal speed as `lib/physics.ts` — and samples it at multiple points
against every hazard's rectangle, not merely at takeoff and landing. Every
function that reasons about whether a jump is possible now takes the hazard
list as a parameter and threads it through: `canTraverse`, `reachableSet`,
`reachableDepths`, `goalReachable`, `bridgeToward`, and the goal-relocation
rescue all agree on the same, hazard-aware definition of "reachable." A
final invariant check runs after every other repair stage, re-verifying
reachability from the final spawn regardless of which earlier stage the
level came through — closing the class of bug where a fix three stages
upstream stopped applying by the time a later stage moved something again.

## Consequences

- A route the solver certifies "reachable" is now provably survivable, not
  merely physically coverable. This directly fixed the class of level a
  player reported: a tunnel next to a hazard, generated as completable,
  that in fact required flying through fire.
- Every reachability-adjacent function grew a `hazards: Rect[]` parameter.
  That's a real API cost — one more thing to remember to thread through any
  future function that reasons about jumps — accepted because the
  alternative (some functions hazard-aware, others not) is exactly the
  half-fixed state that made things temporarily worse.
- The fix surfaced, and had to separately account for, the fact that a
  headroom check and a hazard check are not the same check — solid geometry
  blocks standing; hazards don't block standing but do block *surviving*.
  Any future geometry validation in this codebase needs to ask both
  questions, not assume one implies the other.
