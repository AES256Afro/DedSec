# Design notes

Why the systems are shaped the way they are. The README covers what the game is;
this covers the decisions underneath it, including the ones that turned out to be
wrong the first time.

## The premise

Take the Watch Dogs 2 ctOS fantasy — a city that broadcasts its people at you —
and remove combat entirely. What is left has to carry the whole game, so the
profiling cannot be flavour text. It has to *be* the move set.

## Secrets are buttons, not lore

The single most important decision in the codebase: a `Secret` carries `hooks`,
and a hook names a hack verb.

```ts
{
  kind: "allergy",
  summary: "Tobias has a severe shellfish allergy — anaphylactic on his record.",
  hooks: [{ verb: "tamper_food_order", params: { allergen: "shellfish" } }],
}
```

`verbsForNpc()` returns the universal plays plus one entry per hook on every
*revealed* secret. Verbs flagged `leverageOnly` are not merely greyed out before
you have the fact — they do not appear at all. The dossier is the menu.

This is what stops profiling from being a collectathon. You never read a secret
and think "interesting"; you read it and a button appears.

## Layers must be earned, and the cost is spatial

L1 is one device. **L2 requires the handset plus a second, independent source** —
their home network, their employer's record store, the clinic. That constraint
exists to force a *journey*: the phone is in their pocket at work, the laptop is
in their flat across the city, the clinic is in another district. Deep profiling
means physically going somewhere, which is the only way "where you are standing"
matters in a game with no bullets.

`recomputeLayer` never trusts a stored number. It recomputes from
`player.breachedNodeIds` every time, and a secret is only legible when its layer
is unlocked **and** one of the specific nodes carrying its evidence has been
opened. There is no path to a fact you did not do the work for.

A pleasant emergent consequence: breaching an organisation's record store lifts
every dossier that store corroborates at once. One good breach pays for a whole
roster.

## Adjudication: three outcomes, not two

An impulse is a *claim*, and the target gets to evaluate it:

- **accept** — they act, you get your window;
- **doubt** — they stop and verify for a few minutes, then re-roll at a penalty;
- **reject** — they see through it, gain suspicion, and remember.

Doubt is the interesting one. Binary success/failure makes manipulation feel like
a dice roll; a hesitation state makes it feel like *watching someone decide*, and
it gives the player a few minutes of ambiguity in which the plan is neither
working nor dead.

Rejection is deliberately expensive. Suspicion decays at roughly 0.07/hour and
subtracts up to 0.45 from every subsequent belief score, so burning someone costs
you them for most of a shift — and their colleagues, since suspicion spreads by
conversation between people standing in the same room.

### Traits are not all shields (a bug worth recording)

The first implementation had one field, `resistedBy`, and scored every impulse as
`plausibility × (1 − trait)`. That is right for diligence and tech-literacy and
exactly backwards for curiosity: it made bait files work *worse* on curious
people. A test asserting "sceptical people are harder to move than credulous
ones" caught it.

The fix was `TRAIT_POLARITY`: `+1` traits are shields, `−1` traits are hooks, and
the field was renamed `hingesOn` because "resisted by" was the wrong idea, not
just the wrong sign.

### Showing the odds

A three-outcome model is only worth having if the player can see it. Fallible
verbs implement `forecast`, which builds a probe impulse and runs it through the
*same* `scoreImpulse` the live path uses, so the readout on the button and the
number that gets rolled against are the same value by construction — pinned by a
test to within a float.

Three bands rather than one percentage, because "checks first" is genuinely
different from "sees through it": the first costs you a few minutes, the second
costs you that person for the rest of the day and gets mentioned to their
colleagues. The button says so, including the exact suspicion penalty, whenever
refusal is likely.

The reasons matter as much as the number. `explainPlausibility` and
`scoreImpulse` return signed notes — `+ leans on something they actually care
about`, `− wrong time of day for this claim`, `− on a post they are accountable
for` — so a weak play is a decision the player is making rather than a surprise
they eat. It also makes timing legible: the same pretext is worth waiting an hour
for, and now you can see that.

Pinning a destination flows into the forecast too, rather than being merged in at
invoke time. That way "no destination pinned: they will only stop and stare"
shows up as a listed reason before you spend the attempt.

### Claims versus facts

The second version of that same mistake: environmental verbs were being
adjudicated too. A maximally diligent person could *disbelieve a sprinkler*.

Physical stimuli — a blaring speaker, a room driven to forty degrees, water
coming out of the ceiling — are facts, not claims. There is nothing to see
through. They now carry `source: "stimulus"` and bypass adjudication entirely.

This turned an inconsistency into the game's central trade-off:

- **social verbs** are quiet, precise, and can fail;
- **environmental verbs** always work and always cost trace.

The flagship mission is winnable either way, and the grade you get afterwards is
the difference.

## The building does the work

The strongest plays are the ones where you never touch anything.

`requisition_asset` does not open the case and take the chip. It raises a
transfer order. The lab's own inventory system unlocks the case, the ceiling arm
carries the item to another room, and the audit trail shows a valid user
following an approved procedure. `tamper_food_order` does not poison anyone — it
edits a field on a ticket already in flight, and the kitchen faithfully makes
what the ticket says.

Orders are one type — food, parcel, work order, requisition — precisely because
the player manipulates them all the same way: intercept in flight, change a
field, let the world execute it. Adding a new order kind adds gameplay to every
verb that touches orders.

## Three pressures, kept separate

Merging these would flatten the design:

- **trace** is live and decays. It models ctOS noticing *now*. Saturating it
  opens an investigation: guards get twitchy, cloned badges get re-keyed within
  twelve minutes, and breached nodes get audited back off the network one at a
  time.
- **suspicion** is per-person and sticky, and propagates through the social
  graph rather than by telepathy. A sociable witness is worse than a diligent
  one.
- **evidence** never decays and is never visible in-world. It is the entire
  basis of the ghost score.

The forensic report is written from the perspective of an investigator
reconstructing the day afterwards: *"3 order records show an out-of-band edit; 2
staff can describe something that did not add up."* An untouched city scores
100/100, which is what makes your smudges legible.

## Missions as predicates

An objective is a function from world state to boolean, evaluated every tick and
latched once true:

```ts
{
  id: "lab_clear",
  label: "Empty the prototype lab of staff",
  done: (state) => !occupantsOf(state, labPlaceId(state)).some((n) => n.orgId === "org_nodalis"),
}
```

Nothing in that cares *how* the room emptied. Forged auction win, work order,
climate surge, or simply waiting for lunch — all identical to the objective, all
wildly different in what they cost you on the forensic report. There is no
intended solution, so there is nothing to fail to guess.

Latching matters: the world keeps moving, and an objective that un-completed
because someone wandered back into a room would make progress feel arbitrary.

## Determinism

Every stochastic decision flows through an `Rng` derived from the world seed, and
world generation draws from a stream separate from the runtime. Two runs with the
same seed and the same inputs produce byte-identical state — asserted in
`test/determinism.test.ts` by fingerprinting every person, order, and log line.

This is not a nicety. The ghost score compares your run against what the city
would have done anyway, and mission objectives are predicates over world state.
Neither is reproducible if the world is not.

## Things the tests caught

Worth listing, because each was invisible by inspection and obvious once
asserted:

- **Tenants were locked inside their own flats.** The residential block's access
  control applied to residents, so nobody could leave home, so the entire city
  read as having abandoned its posts, so security filed 42 reports on day one.
  People can now always pass doors inside the building they live in.
- **Café back rooms were sealed off from the world.** Floor circulation hung off
  a corridor or lobby, and a café has neither, so no intra-floor edges were
  generated at all. A reachability test over every place found it.
- **Two routines drew the same handover time twice**, leaving an unscheduled hole
  in the evening — and a person with no routine block does not go anywhere.
- **Residents had no daytime at all**, because the routine builder only filled
  working hours when there was a job.
- **Streets were pure corridors.** Nobody ever *stood* outdoors, so the "watch
  the building from across the plaza" fantasy was impossible. Hangouts now
  include plazas and parks, and people with nowhere to be spend the day out.
- **`invoke()` never enforced the breach requirement** — only the UI's listing
  path did, so anything calling the API directly could fire a verb against an
  unbreached node. Structural gates now live in one function that both paths run.
- **The world booted cold**, with fifty people standing in their bedrooms at half
  nine in the morning. `warmStart` places everyone where their routine says they
  already are.
- **Reading someone's phone did not tell you their name.** `identity` was only
  set by a passive scan, so a fully breached handset could still render as
  "UNIDENTIFIED". Layer 1 now implies it.

## What playtesting caught

`scripts/playtest.mjs` drives the real client the way a player would and prints
what they would actually see: what the opening screen offers, whether the first
device they click explains itself, how far ten minutes of ordinary play gets
them. It is not pass/fail — it is a read-out for judging *friction*, which unit
tests are structurally unable to see.

The first run found two things, both invisible from the code:

- **The most useful device on the street read as a dead end.** The first thing a
  new player clicks is the junction box, and its panel said "Nothing applies
  here" — technically true, since a relay's only capability is `route`, and
  completely misleading, since breaching it is the single best opening move.
  Infrastructure nodes now say what they are *for*.
- **The reach list buried everything actionable.** It sorted breached devices to
  the top, so the longer you played the further you had to scroll to find
  anything you could still take. Flipping it — nearest-unbreached first, opened
  ones in a labelled group underneath — tripled how many people the same ten
  minutes of play profiled, from one to three.

Neither was a bug in the sense a test could assert. Both were the difference
between a systemic game and an opaque one.

## A shipped contract nobody could finish

Three of the four contracts had never been driven to completion by anything.
`heist.test.ts` proved Specimen A7 worked; the rest were assumed.

**Back Room was impossible.** Its target room sits behind a `mechanical` door,
which by design has no lock to hack and gets no network node. `playerCanPass`
returns false for mechanical unconditionally, and the one override — `failOpen`,
via the fire alarm — needs a PA, sprinkler or HVAC node. The Paper Lantern has
none of the three. No sequence of verbs could get a player into that room.

What made it worse is that the mission text described a mechanic that did not
exist: *"you get in by arranging for the person with the key to be somewhere
else."* There was no person with a key, and no way to exploit them if there had
been. So the fix was to build the described mechanic rather than weaken the door:

- **Nobody re-locks behind themselves.** Walking through a mechanical door leaves
  it unlocked for a while. That is the only way through one, which makes
  "arrange for the keyholder to be elsewhere" a real play instead of flavour.
- **Somebody has to actually use the room.** A door nobody opens is a wall. The
  Lantern got a `venue_manager` — a bar does not run on the 08:30 `manager`
  archetype's office hours, and staffing it that way left the back office empty
  every evening the venue was alive.
- **The window is 25 minutes, not 4.** The first tuning was unplayable for a
  reason worth recording: the only person who opens that door is the manager,
  and she is still crossing the bar on her way out when a 4-minute window shuts.
  The contract asks for two manipulations to overlap; the window has to be long
  enough that they can.

The resulting play is the one the brief always described. Lure the manager out
with something her own dossier unlocked, and she leaves the door open behind
her; have the bar already cleared; walk in before it swings shut.

Completability is now an invariant with a test behind it — `contracts.test.ts`
plays every contract on the board to completion, and asserts that no room a
mission names sits behind a mechanical door with nobody rostered to work there.

### A note on how the bot plays

The first version of that test hammered the same person with a fresh lure every
tick — sixty phishing attempts an hour — and drove their suspicion to 0.95. That
is not the game being unfair; it is the suspicion model working exactly as
designed and the test playing badly. It now waits between attempts, presses
harder only while the gap is actually open, and never pushes someone already
past 0.35. Which is, usefully, also the advice a player needs.

## The casual loop, and why it needed a second client

The contract board is a good game and the wrong opening. It is a sequence of
jobs with briefs, constraints and grades — pressure from the first minute. What
the sandbox turned out to be missing was a reason to simply *be* in the city.

### Cases are pairs

A case is something you notice rather than something you accept. The rule that
makes it work is that **every case has two people in it**: one carrying the
harm, one carrying the cost.

A lone "bad person" is a label. You read it, you agree, and nothing happens. A
bad person *attached to somebody they are hurting* is a situation, and a
situation is the only thing a player can be moved by. So `shakedown` is not a
loan shark, it is a loan shark **and the person four months behind**; `squeeze`
is not a slum landlord, it is a landlord **and the tenant who has logged the
same repair request since spring**.

`undertow` exists to keep that from becoming a morality tale. Nobody is doing it
to them. They have not slept in a month, and there is no version of this week
where it gets easier. If every need implies a villain, the city stops being a
place and becomes a list of targets.

### Read out of the city, not sprinkled on it

Every template requires a configuration the population generator already
produced: someone with a gambling secret, a manager who already has a report, an
org with somebody skimming it. Where the case creates a relationship — creditor,
dealer, landlord, ex — it writes it into `npc.relationships` rather than keeping
a private note.

That is not tidiness. It means the dossier lists the tie, the verb layer can act
on it, and suspicion propagates along it, all without a single one of those
systems knowing that cases exist.

**A bug this caught.** `coercion` needs a manager, and it never once fired. The
generator was linking `pair(manager, report, "manager")`, but a relationship's
`kind` names the *other* party's role — the dossier renders it as "manager ·
Ines Abara". Every dossier in the game had been listing its subject's boss as
their report, and nobody noticed until a case template tried to look one up.

### Nothing here can be failed

`resolveCase` cannot fail. Everything else in this game can be doubted, refused,
traced or seen through; this is the one surface where deciding to do something
*is* doing it.

That is not softness, it is the genre. A casual loop with a failure state is not
a casual loop, and the interesting question was never "can you" — it was "will
you, and which way". Help quietly, expose the person doing it, warn the person
it is happening to, or keep walking. Walking away is a listed option on every
case, costs nothing and counts for nothing, and is a real answer.

Progress is a ledger — `7 helped · 2 exposed · 61 profiled` — with no
denominator and no completion percentage. There is nothing to clear.

## Three dimensions, one simulation

The street client is a *view*. It contains no game rules; every mutation goes
through the same `src/` functions the tests drive.

The whole port rested on one property of the simulation: it was already
coordinate-first. Places carry metres and a floor index because that is what a
top-down map needed, and it turns out to be exactly what an extrusion needs too.
Sim `x` is world X, sim `y` is world Z, a floor is a height. Nothing in `src/`
changed to make the city three-dimensional.

### Continuous player, discrete world

The sim moves people between graph nodes. The player does not — they move in
metres, and every few metres the client asks which outdoor place they are
nearest and hands that answer back. Line of sight, radio range, who is standing
next to you: all of it keeps working untouched.

### The cards stay DOM

Watch Dogs draws them the same way and for the same reason. Text in a 3D scene
either fights the renderer or goes illegible at distance, and everything the
profiler already knows how to render is HTML. The 3D layer supplies one number
per person — where they are on screen — and the card is a div that gets told
where to sit. Which is most of why this was a port rather than a rewrite.

Cards stack rather than overlap: nearest keeps its spot and everyone behind it
slides upward, which is both readable and a correct depth cue.

### ctOS reads handsets, not faces

`visibleNpcs` answers "who can you see", which is right for anything involving a
lens or a witness. The street needed a different question. At eleven in the
morning two-thirds of the city is indoors, and a client that could only profile
what it could see was a client with five people in it.

So `profilableNpcs` grants layer 0 to everyone in range regardless of walls — a
name, a job, an income and a quirk, all public records, surfaced by their own
devices. Every layer above it still costs a breach. People behind a wall get a
dashed card so the overlay never pretends you are looking at someone you are
not.

### Infill

The simulation models eight buildings across roughly a square mile. On a
top-down map that is a city; at eye level it is a business park. So the gaps
between the simulated buildings get filled with blocks that are scenery and
nothing else — no doors, no rooms, no network, nobody inside — laid out around
the real streets and the real buildings.

Only the eight buildings the game is actually played in are labelled, which
makes the labels a navigation aid and an honesty marker at the same time.

Two tuning notes worth keeping, because both produced a wrong-looking city from
correct-looking code:

- **A cell that straddles a street is dropped whole**, so the infill grid's own
  coarseness *becomes* the street width. At 44-metre cells a twenty-metre road
  came out over a hundred metres wide and the place read as a ring road.
- **Dark ground, lit facades.** Up-facing surfaces catch the sky light and
  side-facing ones do not, so a pavement the same grey as a wall reads
  *brighter* than the wall and flattens the entire street. The first pass used
  the terminal's panel greys directly and rendered, correctly and uselessly,
  black: a Lambert surface multiplies its colour by the light, and a 10%-grey
  building under a 16%-grey ambient is 1.6% grey.

### What the smoke test can and cannot see

A 3D client fails in ways a unit test structurally cannot: three fails to
resolve through the import map, the canvas gets no GL context, the crowd renders
at the origin, cards project behind the camera.

One trap worth recording. The obvious check — read the canvas back and count
non-background pixels — always fails, because a WebGL canvas without
`preserveDrawingBuffer` reads back blank once the frame has been composited. A
perfectly good scene scores zero. Asking the renderer what it drew
(`renderer.info.render.triangles`) is both cheaper and actually true.

The second trap was the test asserting on where a free walk ended up. It passed
and failed on alternate runs depending on which way the player happened to be
facing. It now stands somewhere there provably *is* somebody and looks straight
at them.

## Deliberate omissions

No save/load, no audio, no skill tree beyond a single stub, no mobile layout. The
four contracts are a vertical slice. The interesting extension is not more verbs
but more *order kinds* and more *secret templates*, since both multiply against
the existing verb set rather than adding to it linearly — and now also more
*case templates*, which multiply against the population generator the same way.

The street client is outdoors only. Buildings are solid; going inside one is
still the field terminal's job. Interiors would need the graph's indoor places
extruded and doors made traversable in 3D, which is a real piece of work rather
than a missing constant.
