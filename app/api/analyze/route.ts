import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { LEVEL_JSON_SCHEMA } from "@/lib/level";
import { normalise } from "@/lib/normalise";
import { solve } from "@/lib/solver";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Model choice, and why there is a chain rather than one name.
 *
 * `gemini-3.7-flash` was the obvious default — newest, most capable Flash — but
 * it currently answers `503 "experiencing high demand"` on essentially every
 * call. A demo cannot be one capacity spike away from failing, so the default is
 * `gemini-3.5-flash`: verified working, and about 1.5s for this workload.
 *
 * On an overload or rate-limit the request is retried down the chain instead of
 * surfacing a failure the viewer will read as "the project is broken".
 */
const PRIMARY = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
/**
 * Fallbacks are verified against this endpoint, not merely listed by the API.
 * `models.list()` advertises models that `generateContent` will not serve, and
 * `gemini-2.5-flash` — the previous fallback — is retired for new keys and
 * answers every request with a 404. A fallback that cannot run is worse than no
 * fallback: it converts a passing retry into a hard failure.
 */
const MODEL_CHAIN = [PRIMARY, "gemini-3.6-flash", "gemini-3.5-flash-lite"].filter(
  (m, i, all) => all.indexOf(m) === i,
);

/**
 * Statuses no other model can rescue: a rejected key, a malformed request or an
 * oversized image will fail identically everywhere, so stop immediately.
 * Everything else — including a 404 from a retired model — is worth trying the
 * next one for.
 */
const FATAL = new Set([400, 401, 403, 413]);

/**
 * One budget for the whole attempt chain, not one per model.
 *
 * Each attempt used to get its own 50s abort, so three models could spend 150s
 * between them — against a 60s route limit and a 75s client timeout. The client
 * gave up long before the server did, and the user saw "took too long" while
 * the request was still running happily on model two.
 *
 * The budget is now shared: every attempt gets whatever is left, and once too
 * little remains to be worth starting, the chain stops and says so.
 */
const TOTAL_BUDGET_MS = 42_000;
/** Below this there is no point starting another model. */
const MIN_ATTEMPT_MS = 8_000;

const SYSTEM = `You convert a photograph of a real place into a playable 2D platformer level.

COORDINATES
Every box is [ymin, xmin, ymax, xmax] normalised to 0-1000 over the image, with
0,0 at the top-left. Points are [y, x] in the same space. The player is roughly
30 wide and 60 tall in these units, so anything smaller than about 30 x 20 is
not worth returning.

WHAT TO PICK
Choose 7 to 14 objects that are genuinely visible and that together form a
route: the player spawns on the left and must work rightward and generally
upward to the goal. Prefer objects whose TOP EDGE could plausibly be stood on.
Do not return one enormous box for the desk, the bed or the floor as a whole —
return the distinct things resting on it. Consecutive stepping stones should be
close enough to jump between: a horizontal gap of more than about 180, or a step
up of more than about 130, is beyond the player's jump.

MATERIALS ARE SEMANTIC
This is the heart of the design. Assign a material from what the object IS in
the real world and how it would physically behave, never from its colour or
shape. A mug of coffee is a hazard because it is full of scalding liquid. A
pillow is bouncy because it is soft and compressible. A glass tabletop is
slippery. A stack of loose paper is crumbling because it will not hold weight.
Give every object a distinct, concrete reason grounded in its material
properties.

Aim for variety — a level made entirely of "solid" is a boring level — but never
assign a material the object does not justify. If the scene genuinely contains
nothing hot or sharp, do not invent a hazard.

TITLE AND TAGLINE
Name the level after what is actually in the photo, with some wit. If you can
see a specific detail — a brand, a mess, a half-eaten thing — use it.`;


/**
 * Pull the HTTP status off a thrown SDK error.
 *
 * Not `instanceof`. The SDK exports a class called `ApiError`, but what it
 * actually throws is a `BadRequestError -> APIError -> GeminiNextGenAPIClientError`
 * chain in which the exported `ApiError` does not appear — so the instance check
 * silently fails and every API failure falls through to a generic 500. Verified
 * against the running SDK rather than its type definitions, which do not
 * describe the classes it really throws. Reading the numeric status off the
 * object is the check that holds.
 */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

/**
 * Dig a human-readable reason out of whatever the SDK attached to the error.
 *
 * The useful sentence ("API key not valid") arrives as a JSON string nested a
 * few levels inside the error body, so it is worth unwrapping — this text is
 * shown to the person using the app, and the raw blob tells them nothing.
 */
function detailOf(err: unknown): string {
  const e = err as { error?: unknown; body?: unknown; message?: unknown };

  const fromObject = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const rec = o as { message?: unknown; error?: { message?: unknown } };
    const msg = rec.error?.message ?? rec.message;
    return typeof msg === "string" && msg.trim() ? msg : undefined;
  };

  for (const candidate of [e?.error, e?.body, e?.message]) {
    if (candidate && typeof candidate === "object") {
      const m = fromObject(candidate);
      if (m) return m.slice(0, 300);
    }
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate.replace(/^[^[{]*/, ""));
        const m = Array.isArray(parsed)
          ? parsed.map(fromObject).find(Boolean)
          : fromObject(parsed);
        if (m) return m.slice(0, 300);
      } catch {
        /* not JSON; fall through to the raw string */
      }
      return candidate.slice(0, 300);
    }
  }
  return "Unknown error.";
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "no_key",
        message:
          "GEMINI_API_KEY is not set on the server. The sample levels still work.",
      },
      { status: 503 },
    );
  }

  let image: string;
  try {
    ({ image } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const match = /^data:(image\/(?:png|jpeg|webp|heic|heif));base64,([\s\S]+)$/.exec(
    image ?? "",
  );
  if (!match) {
    return NextResponse.json(
      {
        error: "bad_image",
        message: "Expected a PNG, JPEG, WebP, HEIC or HEIF data URL.",
      },
      { status: 400 },
    );
  }
  const [, mimeType, data] = match;

  // Inline image bytes share a 20MB ceiling with the rest of the request.
  if (data.length * 0.75 > 15 * 1024 * 1024) {
    return NextResponse.json(
      { error: "too_large", message: "Image is over 15MB after encoding." },
      { status: 413 },
    );
  }

  const client = new GoogleGenAI({ apiKey });

  const startedAt = Date.now();
  let ranOutOfTime = false;
  let text: string | undefined;
  let used = "";
  let lastError: unknown;
  /** Which model produced lastError, so failures name the right one. */
  let failedModel = PRIMARY;

  try {
    for (const model of MODEL_CHAIN) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining < MIN_ATTEMPT_MS) {
        ranOutOfTime = true;
        break;
      }
      try {
        const response = await client.models.generateContent({
          model,
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: "application/json",
            responseSchema: LEVEL_JSON_SCHEMA,
            abortSignal: AbortSignal.timeout(remaining),
            // Finding boxes and naming materials is perception, not reasoning.
            // Gemini 3.x thinks by default, which on this workload buys nothing
            // and costs most of the wall-clock the user spends staring at a
            // progress bar.
            thinkingConfig: { thinkingBudget: 0 },
          },
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data } },
                {
                  text: "Turn this photo into a level. Return only the structured level.",
                },
              ],
            },
          ],
        });

        const finish = response.candidates?.[0]?.finishReason;
        if (finish && finish !== "STOP") {
          // MAX_TOKENS truncates the JSON; SAFETY returns nothing usable.
          lastError = new Error(`Generation stopped early (${finish}).`);
          continue;
        }
        text = response.text;
        used = model;
        if (text) break;
        lastError = new Error("The model returned an empty response.");
      } catch (err) {
        lastError = err;
        failedModel = model;
        const status = statusOf(err);
        if (status !== undefined && FATAL.has(status)) throw err;
      }
    }

    if (!text) {
      if (ranOutOfTime || String((lastError as Error)?.name) === "TimeoutError") {
        return NextResponse.json(
          {
            error: "slow",
            message:
              "The model did not answer in time. It is usually busy rather than broken — try again in a moment.",
          },
          { status: 504 },
        );
      }
      const status = statusOf(lastError);
      if (status === 404) {
        return NextResponse.json(
          {
            error: "bad_model",
            message: `"${failedModel}" is unavailable: ${detailOf(lastError)} Set GEMINI_MODEL to a model your key can reach.`,
          },
          { status: 502 },
        );
      }
      if (status && status >= 500) {
        return NextResponse.json(
          {
            error: "overloaded",
            message: `Every model was busy (${MODEL_CHAIN.join(", ")}). This is usually temporary — try again in a moment.`,
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        {
          error: "empty",
          message: `No level came back. ${detailOf(lastError)}`,
        },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          error: "unparseable",
          message: "The model's reply was not valid level JSON. Try again.",
        },
        { status: 502 },
      );
    }

    const raw = normalise(parsed as Parameters<typeof normalise>[0]);
    if (raw.entities.length === 0) {
      return NextResponse.json(
        {
          error: "nothing_found",
          message:
            "No usable objects were found in that image. Try a photo with distinct things in it — a desk, a shelf, a room.",
        },
        { status: 422 },
      );
    }

    // Never hand an unproven level to the player.
    const { level, report } = solve(raw);

    return NextResponse.json({ level, report, model: used });
  } catch (err) {
    const status = statusOf(err);
    const detail = detailOf(err);

    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: "auth", message: "GEMINI_API_KEY was rejected." },
        { status: 401 },
      );
    }
    if (status === 429) {
      return NextResponse.json(
        {
          error: "rate_limit",
          message:
            "Rate limited by the free tier. Wait a moment, or set GEMINI_MODEL to a lighter model.",
        },
        { status: 429 },
      );
    }
    if (status === 404) {
      return NextResponse.json(
        {
          error: "bad_model",
          message: `"${failedModel}" is unavailable: ${detail} Set GEMINI_MODEL to a model your key can reach.`,
        },
        { status: 502 },
      );
    }
    if (status === 400) {
      // An invalid or malformed key lands here rather than on 401, so say so.
      return NextResponse.json(
        {
          error: "bad_request",
          message: `The API rejected the request — most often an invalid GEMINI_API_KEY. ${detail}`,
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "unknown", message: detail },
      { status: status && status >= 400 ? status : 500 },
    );
  }
}
