# Architecture Decision Records

Short records of the decisions in this codebase that were genuinely
load-bearing — the ones where a different, reasonable-looking choice would
have led somewhere worse, and where the reasoning is worth keeping next to
the code rather than only in commit messages.

Format: status, context (the problem and the constraint that made it hard),
decision, consequences (including the honest costs, not just the wins).

| | |
|---|---|
| [0001](0001-prove-completability-before-play.md) | Prove completability before a level is ever shown |
| [0002](0002-vision-provider-isolated-to-one-file.md) | Isolate the vision provider to one file, speaking its native format |
| [0003](0003-gameplay-stays-2d-rendering-can-be-3d.md) | Gameplay stays on a 2D plane; the diorama renderer is a view, not a world |
| [0004](0004-characters-share-one-hitbox.md) | Every character shares one collision box; customisation is cosmetic only |
| [0005](0005-coins-pay-once-per-entity.md) | Coins pay out once per entity, ever — not once per pickup |
| [0006](0006-bonus-chambers-are-hand-authored.md) | Bonus chambers are a fixed layout, not procedurally generated |
| [0007](0007-reachability-must-simulate-the-arc-not-just-the-endpoints.md) | Reachability must simulate the whole jump arc, not just its endpoints |
| [0008](0008-shared-timeout-budget-across-the-model-chain.md) | The model fallback chain shares one timeout budget, not one per attempt |
