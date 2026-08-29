# 6. Bonus chambers are a fixed layout, not procedurally generated

## Status

Accepted

## Context

Tunnels drop the player into a bonus room stuffed with coins, reachable only
by walking onto a pipe. The first version generated each chamber
procedurally, seeded from the tunnel's id, so a given pipe always led to the
same room. That's appealing for the same reason procedural placement is used
elsewhere in the codebase (monsters, extra coins, tunnels themselves, all in
`lib/solver.ts`) — it scales to arbitrary uploaded photos without hand
authoring.

The difference is verification. Every *level* a player can generate from a
photo passes through `solve()` (ADR 0001) before it's shown, so an
unclimbable layout gets caught and repaired automatically. Bonus chambers
never pass through `solve()` — they're built directly by `buildBonusWorld`
(`lib/bonus.ts`) and played immediately. A procedurally generated chamber
therefore had no safety net: an unlucky seed could place the exit pipe
somewhere the ledge layout couldn't reach, and nothing in the pipeline would
notice or fix it.

## Decision

The chamber layout in `buildBonusWorld` is fixed: the same ledges, the same
hazard placement, the same exit pipe position, every time. Only the coin
identities are unique per pipe (scoped by `{parentId}/{tunnelId}`, per ADR
0005), so two different pipes leading to the visually identical room still
pay out independently. Because the geometry never varies, it only has to be
proven climbable once, by hand, rather than proven correct by an automated
pass on every generation.

## Consequences

- Every player who falls into a bonus chamber sees the same room. That's a
  real cost — the built-in scenes vary per photo, but the bonus room
  doesn't, and a player who visits several pipes will notice the repetition.
- The room can be tuned by hand for feel — asymmetric difficulty (easy to
  fall into, deliberately hard to climb back out of), tight jump margins,
  hazard placement that rewards a specific route — in a way that's much
  harder to guarantee from a generator without also building a `solve()`-
  equivalent verification pass just for chambers.
- `scripts/verify.ts` still asserts the chamber is escapable, but by
  measuring the *fixed* route's geometry against the real jump arc directly
  (`every step of the climb is inside a jump`), not by running the solver
  against it — there's nothing for the solver to solve.
- If chambers are ever made to vary by photo (using detected objects from
  the source room, for instance), this decision would need revisiting: that
  richness only becomes safe once chambers gain their own completability
  proof, mirroring ADR 0001 for regular levels.
