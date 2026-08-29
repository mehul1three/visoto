# 8. The model fallback chain shares one timeout budget, not one per attempt

## Status

Accepted

## Context

`app/api/analyze/route.ts` tries a list of models in order and falls back to
the next one on a transient failure (rate limit, overload, a retired model
returning 404 — see the model-chain design this fallback depends on). Each
attempt originally got its own independent abort timeout. With three models
in the chain, the theoretical worst case was three full timeouts stacked
back to back — comfortably longer than both the serverless route's own
duration limit and the client's own abort timeout.

The failure mode this produced was worse than a plain timeout: the browser
gave up and showed "the analysis took too long" while the server was still
making progress on the second or third model in the chain, sometimes about
to succeed. The error message actively misdirected — it read as "your photo
is the problem," when the actual cause was arithmetic in the timeout
budget, unrelated to anything about the image.

## Decision

The whole attempt chain shares one budget (`TOTAL_BUDGET_MS`). Each model in
the chain gets *whatever time remains* when its turn comes, not a fixed
allowance of its own; once the time remaining drops below a floor worth
attempting (`MIN_ATTEMPT_MS`), the chain stops trying further models rather
than starting one it can't realistically finish. The client's own abort
timeout is set comfortably above the server's total budget, so the server
always gets to finish first and return its own explanation — the client
should essentially never need to invent a timeout message of its own.

## Consequences

- A slow-but-working request now succeeds instead of being abandoned
  mid-flight by an impatient client. This was, in practice, the majority of
  what looked like "random" analysis failures before the fix.
- When every model genuinely is too slow, the failure is now a clean,
  single, honest timeout from the server — with a message that says the
  service was busy, not that anything was wrong with the photo — rather
  than a race between two different timeout clocks that don't know about
  each other.
- This is a total-latency ceiling, not a per-model quality guarantee: a
  request that burns most of the budget on a slow first model leaves the
  fallback models very little room, even though each one individually might
  have been fast in isolation. That trade-off was accepted over the
  alternative (generous per-model timeouts that can stack past what the
  client or the route platform will tolerate).
