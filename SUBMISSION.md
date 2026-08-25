# Devpost submission copy

Paste-ready. Trim to taste — do not pad it.

---

## Project name

**Playground**

## Tagline (Devpost "elevator pitch", 200 char max)

> Photograph your desk and play it. Objects get physics from what they actually
> are — coffee burns, cushions bounce, glass slips — and every level is proved
> completable before you touch it.

---

## Inspiration

Every "AI builds a game level" demo I had seen detected rectangles and made them
all solid. The photo ends up as wallpaper: the level is technically built from
your room, but nothing in it behaves like the thing it is. A mug and a brick are
the same object.

That felt like the whole idea being left on the table. The interesting signal in
a photograph is not *where* things are — it is *what* they are. A model that can
tell a pillow from a plate already knows that one is soft and one is not. That
knowledge is a physics engine waiting to be read out.

## What it does

Drop in a photo of any room. Ten seconds later you are playing a platformer
built from it, where every object behaves the way that object would:

- a **cushion** is bouncy — soft foam compresses and springs back
- a **mug of coffee** is a hazard — ceramic full of scalding liquid
- a **monitor** is slippery — sheet glass, almost frictionless
- **loose paper** crumbles — single sheets with nothing beneath them
- a **hanging cable** is climbable — a flexible line long enough to haul up

Seven materials, each assigned from the object's real-world physical properties.
Hover anything to see what it was identified as and the reason it was given that
behaviour. The reason is not flavour text — it is the claim the system is
making, put somewhere you can check it.

Press **X** at any time to fade the photo and see the raw collision geometry,
and **F** for full screen. It plays like a game rather than a demo: a Ready
screen, pause and resume, and settings for sound, particles, screen shake and
object labels — with particles and shake defaulting to off when the system asks
for reduced motion. Three built-in scenes (desk, living room, washroom) mean it
is playable before you upload anything. Six player characters in eight colours, and the sound
effects are synthesised from oscillators at runtime, so the repo contains no
audio files and no sprite sheets.

The characters all share one collision box on purpose: the solver proves
completability from the player's exact size and jump arc, so a bigger character
would quietly invalidate every proof. Customisation is allowed to change how the
player looks and nothing else.

Every level exports to **Godot 4** and **Phaser/Tiled**, materials intact.

## How I built it

One model call does the perception: the photo goes to `gemini-3.5-flash` with a
JSON Schema describing the level format, and comes back as labelled boxes with
materials and reasons. Everything after that is ordinary engineering — and it is
most of the project.

The schema is written in Gemini's *native* spatial conventions — boxes as
`[ymin, xmin, ymax, xmax]`, points as `[y, x]`, normalised to 0-1000 — rather
than in the engine's own `{x, y, w, h}`. The model is trained to emit exactly
that layout, and making it translate on the way out costs box accuracy for
nothing. The conversion happens once, at the boundary, which also means exactly
one file knows which model provider is in use; the other ~2,900 lines do not.

The physics is a hand-written fixed-timestep AABB platformer, about 300 lines,
with coyote time, jump buffering and variable jump height. No game engine, for a
specific reason: the solver has to be able to reason about the jump arc
*exactly*, so the tuning constants are imported by the solver rather than
copied. If those two ever drift, the correctness proof becomes fiction.

Photos are cropped to 16:9 in the browser before upload, which makes the model's
normalised coordinates map onto the game world exactly — alignment for free,
instead of a class of bugs.

## The hard part

A vision model returns *plausible* boxes, not a *playable* level. Boxes overlap,
float, stack, or leave the goal stranded across a gap no jump can cross. Ship
that raw and roughly one level in three is impossible, which a player cannot
distinguish from "this app is broken".

So no level reaches the player until it is proved completable: each solid's top
edge becomes a node, and a BFS crosses that graph using the real jump arc,
inserting bridge platforms until the goal is reachable.

Then I wrote a harness that ignores the proof entirely and just turns bots loose
on the actual physics engine to see whether any of them finishes
(`npm run verify`). It immediately started failing levels the solver had already
certified, and every failure was a real bug:

- **Ceiling traps.** A jump arc only considers where you land, never what is
  over your head. An object above the route wedged the player permanently.
- **Spawning inside walls.** Clearance overhead says nothing about a wall
  running through where the player is about to stand.
- **Vertical shafts** — built by my own repair step. Five bridges stacked
  directly above each other, 63px apart, for a 46px-tall player. An inserted
  platform must not seal the surface below it *and* must not land the player
  somewhere already sealed.
- **Towers over empty floors.** With the goal floating high above a bare scene,
  the proof could be satisfied by erecting a tower in mid-air — a correct answer
  to the wrong question. A photo of a bare wall should not become a
  tower-climbing game, so the goal is lowered to a height the scene supports.

Integrating the model had its own version of the same lesson. The obvious
default, `gemini-3.7-flash`, turned out to answer `503 "experiencing high
demand"` on essentially every call — and the SDK's newer `interactions` API
*hung* rather than surfacing that, so the failure looked like my bug for a while.
Two fixes: the classic `generateContent` surface, which is roughly seven times
faster on the same prompt and fails loudly instead of silently, and a fallback
chain so one busy model cannot take the demo down. Worth noting the SDK also
exports an `ApiError` class that it never actually throws — `instanceof` against
it always fails, which would have quietly funnelled every API error into a
generic 500.

The lesson I did not expect: a correctness proof is only as honest as its model
of the world, and the cheapest way to find out what your model is missing is to
let something dumb try to play it.

## Accomplishments

The empirical harness — writing the thing that could prove me wrong, and then
believing it. Five real bugs came out of it, four of which the reachability
maths was structurally incapable of noticing.

Also the X-ray toggle. "AI generated this playable level" is trivial to fake
with a video, and one keypress should be enough to show that it isn't.

## What I learned

That the model was never the hard part. The single API call was working within
an hour; the remaining days went into the unglamorous problem of turning
plausible output into something guaranteed not to waste the player's time.
Generative systems fail softly — they hand you something that looks right — so
the engineering that matters is whatever can tell the difference.

## What's next

Multiplayer ghosts racing through the same room. A shareable link so other
people can play *your* desk. And an auto-player that walks the solver's own
proof on screen, so you can watch the level being solved by the thing that
certified it.

## Built with

`typescript` `next.js` `react` `gemini-3.5-flash` `google-gemini-api` `canvas`
`tailwindcss` `godot` `phaser`

---

# 90-second demo video script

Judges watch on mute and at speed. Lead with the payoff, prove it, then explain.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:08 | Photo of your actual desk, mid-analysis, boxes snapping in with labels | "This is my desk. Watch." |
| 0:08–0:20 | Character running along the keyboard, bouncing off a cushion, jumping the mug | "Ten seconds later, I'm playing it." |
| 0:20–0:35 | Hover the mug → tooltip. Hover the cushion → tooltip. | "Objects don't just become platforms. The coffee is a hazard because it's hot. The cushion bounces because foam compresses. Physics comes from what the thing *is*." |
| 0:35–0:45 | Press **X**. Photo fades to collision geometry. | "That's the real collision geometry. Nothing here is faked." |
| 0:45–1:00 | Solver panel: surfaces, reachable %, repair notes | "Every level is proved completable before you play it — the solver checks the goal is reachable using the actual jump arc, and builds bridges if it isn't." |
| 1:00–1:12 | `npm run verify` scrolling green in a terminal | "And a swarm of bots plays every level to check the proof was telling the truth. It found five bugs." |
| 1:12–1:22 | Click Godot export, open the `.tscn` | "Levels export to Godot and Phaser, materials intact." |
| 1:22–1:30 | A second photo — somewhere unlike a desk — becoming a level | "Any photo. Your room is the level." |

**Recording notes**

- Shoot at 1280×720 or higher, and let the analysis play in real time — the
  reveal animation is the best ten seconds you have. Do not cut it.
- Use two genuinely different photos. One desk shot reads as a special case.
- Record in full screen (**F**) for the gameplay sections — the browser chrome
  around a small canvas is what makes a project read as a class assignment.
- Leave sound on. It is most of the difference between a tech demo and a game.
- Show at least one death on the coffee mug. Consequence is what makes the
  materials legible.
- No intro card, no logo animation. First frame should be the photo.
