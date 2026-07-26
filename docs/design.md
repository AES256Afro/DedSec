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

## Deliberate omissions

No save/load, no audio, no skill tree beyond a single stub, no mobile layout. The
four contracts are a vertical slice. The interesting extension is not more verbs
but more *order kinds* and more *secret templates*, since both multiply against
the existing verb set rather than adding to it linearly.
