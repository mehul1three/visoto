# 2. Isolate the vision provider to one file, speaking its native format

## Status

Accepted

## Context

The project started against Claude's Messages API, then switched to Gemini
partway through — mainly because Gemini's free tier needs no billing account,
which matters for a project other people should be able to run with zero
setup cost. That switch had to be cheap, and a future switch (to whichever
model is best next month) has to be cheap too. The model does exactly one
job: image in, structured JSON level out. Nothing about the solver, the
physics, the renderer, or the exporters should need to know or care which
vendor answered that call.

Separately: Gemini's structured-output models are trained to emit bounding
boxes in a specific native convention — `box_2d: [ymin, xmin, ymax, xmax]`
and points as `[y, x]`, both normalised to 0–1000 — because that's the format
its object-detection training data used. Asking it to instead emit the
engine's own `{x, y, w, h}` fractional format meant asking it to do an extra
translation step in its head, and produced measurably worse boxes in testing.

## Decision

Exactly one file, `app/api/analyze/route.ts`, imports the model SDK and
knows which provider is in use. It is the only place `GEMINI_API_KEY` is
read and the only place a model ID string appears.

The JSON Schema handed to the model (`LEVEL_JSON_SCHEMA` in `lib/level.ts`)
is written in Gemini's *native* spatial conventions, not the engine's own.
The one-time translation from `box_2d`/`[y, x]` into the engine's
`{x, y, w, h}` fractional boxes happens in exactly one place,
`lib/normalise.ts`, at the boundary between "what the model said" and
"what everything else in the codebase understands." Nothing past that
boundary — the solver, the physics, the renderers, the exporters — has any
awareness that Gemini exists.

## Consequences

- Switching providers again means rewriting one route file and one
  normalisation function, not touching the ~4,000 lines of `lib/` that
  implement the actual game.
- The schema is provider-specific by design, which means it is *not*
  portable to a different vision API without translation. That's an
  accepted cost: box quality was judged more important than schema
  portability, given the schema's only consumer is one file.
- `lib/normalise.ts` carries real responsibility — it's the only place a
  malformed, truncated, or adversarial model response gets turned into
  something the rest of the app can trust. It has to be defensive (see the
  hostile-payload tests in `scripts/verify.ts`) precisely because nothing
  downstream double-checks its work.
