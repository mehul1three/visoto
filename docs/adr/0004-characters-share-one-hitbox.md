# 4. Every character shares one collision box; customisation is cosmetic only

## Status

Accepted

## Context

Player customisation (six characters, eight colours) was added for
engagement — a reason to keep playing beyond the first level. The obvious
implementation lets each character have its own size: a rounder, bigger
Bean; a taller, narrower Spook.

But `lib/physics.ts` exports fixed constants — `PLAYER_W`, `PLAYER_H`,
`JUMP_HEIGHT`, `JUMP_RANGE` — and the solver's entire completability proof
(ADR 0001) is computed against those exact numbers. A level proved
completable for a 34×46 player is not thereby proved completable for a
40×52 one; the jump arc, the headroom needed to stand under an overhang, and
the gap a jump can cross would all be wrong.

## Decision

`drawCharacter` (`lib/character.ts`) takes the *already-computed* collision
box — position, width, height, squash/stretch — as input, and only changes
how that box is painted: a rounded square, an ellipse, a ghost with a
scalloped hem, whatever the chosen character is. No character kind is
allowed to report a different width or height than any other. The squash
and stretch applied on landing/takeoff is purely visual (it deforms the
*drawing*, never the *hitbox* the physics engine collides against) — the
game loop keeps the two separate on purpose.

## Consequences

- A new character costs one function in `lib/character.ts` and nothing
  else changes — no re-tuning the solver, no re-verifying old levels.
- Every completability proof in the codebase holds regardless of which
  character the player is wearing, without the solver needing to know
  characters exist at all.
- This rules out gameplay-affecting cosmetics (a smaller hitbox as a
  "hard mode" skin, for instance) under the current architecture. That
  trade-off was accepted deliberately: skins are for the coin economy and
  personal expression, not for varying the difficulty of a level the solver
  already proved solvable for one specific player size.
