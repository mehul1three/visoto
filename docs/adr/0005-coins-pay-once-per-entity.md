# 5. Coins pay out once per entity, ever — not once per pickup

## Status

Accepted

## Context

Character unlocks (ADR 0004's cosmetics) are funded by coins collected in
levels. A level — built-in or generated — can be restarted freely, and
restarting resets the in-level coin counter to zero so the HUD makes sense
for that run. If restarting also re-paid every coin into the player's
permanent balance, the entire economy would be worth nothing: the fastest
way to afford the most expensive character would be standing on the first
coin and hitting Restart in a loop for fifteen seconds, not photographing a
new room.

## Decision

Permanent progress (`lib/progress.ts`) is tracked as a ledger, not a
counter. Each individual coin has a stable id (`{levelId}:{entityId}`), and
`bankCoin` only credits the player's balance the first time that exact key
appears — every subsequent pickup of the same coin, across any number of
restarts, is free but pays nothing. Clearing a level pays a one-off bonus
through the same mechanism, keyed by level id alone. Level ids are either
fixed strings for the hand-authored scenes or a content hash of the
generated level's title and entity positions (`levelIdOf`), so re-uploading
the exact same photo doesn't mint a second payout for what is, functionally,
the same level.

## Consequences

- The only way to grow the balance is to bring genuinely new content — a
  level that hasn't paid its coins yet. This was a deliberate design choice,
  not just an anti-cheat measure: it makes "photograph something new" the
  literal in-game incentive, which is the behaviour the whole project exists
  to encourage.
- The ledger (`banked: string[]`, `cleared: string[]`) grows without bound
  as a player explores more levels. Accepted for now — realistic play
  sessions won't approach a size where an array scan in `localStorage`
  becomes a performance problem.
- `localStorage` is trivially editable by anyone who opens devtools. No
  attempt is made to defend against that. This is a single-player,
  no-backend project; the ledger design defends against accidental
  self-farming through normal play (restarting a level), not against a
  player who deliberately wants to cheat their own single-player save.
