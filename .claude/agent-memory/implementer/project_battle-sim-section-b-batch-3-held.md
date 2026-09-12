---
name: battle-sim-section-b-batch-3-held
description: Battle-sim plan Section B, batch 3 (per-battle field effects on the web side) is complete and uncommitted, held for a reviewer with interface context -- what's in it, what hasn't been checked, and the exact state of the Tate & Liza test case
metadata:
  type: project
---

**As of 2026-09-13, session pausing near a usage limit.** Batch 3 (the web-side
consumer of `encounters.json`'s `fieldEffects`/`inverseBattles` lists, from the
pipeline batch already committed at `9cc8e69`) is finished and green, but
**uncommitted** -- left in the working tree deliberately, not half-done. Do not
commit it without a review pass; the team lead was routing it to "the reviewer that
already has the interface context" when this session paused.

## What's in the tree, uncommitted

`web/src/lib/types.ts` (`Encounters`/`FieldEffect`/`InverseBattle`/etc.),
`web/src/lib/data.ts` (`loadEncounters`), `web/src/lib/matchupReport.ts`
(`resolveTrickRoomActive`, `resolveInverseBattleActive`, `MatchupReport.isTrickRoomActive`
/`isInverseBattleActive`/`isForcedDouble`), `web/src/lib/matchupReport.test.ts`,
`web/src/features/matchupReport/MatchupReportView.tsx` (three separate banners),
`web/src/features/matchupReport/useMatchupReportData.ts`,
`web/src/features/matchupReport/composition.test.ts`, `web/src/routes/TrainerMatchup.tsx`.

Verified as of the last commands run this session: `tsc -b --force` clean,
`npm --prefix web run lint` 0 errors / 6 pre-existing warnings (none in touched files),
`npm --prefix web test` 782/782.

**Not verified: anything visual.** No browser tool was available to me in this
environment at any point in this batch. Every claim about how the three banners look
together, whether the layout reads clearly, and whether the picker's now-visible
trainer ids are legible next to the banners is reasoned from data and code, not
observed. The team lead said they have a browser session and intends to click through
it themselves once this is reviewed and committed -- that has NOT happened yet as of
this note.

## The three banners, and why they're kept separate

One fight can have three independent facts true of it, and `MatchupReportView.tsx`
renders each as its own thing rather than merging them:
1. **Trick Room** (`isTrickRoomActive`) -- presentation only, reverses `speedTiers`'s
   sort and swaps `speedTierNote` to `TRICK_ROOM_SPEED_TIER_NOTE`. A condition the
   report DOES account for.
2. **Inverse Battle** (`isInverseBattleActive`) -- maps to the engine's existing
   `FieldBattleState.isInverseBattleFlagSet`, so every damage number for that fight is
   genuinely computed under the inverted chart. Also a condition the report DOES
   account for. Own banner, above the speed section.
3. **Forced double** (`isForcedDouble`) -- a straight passthrough of
   `Trainer.forcedDouble` (already-parsed data, no lookup needed). This is NOT a
   condition the report accounts for -- it's a statement that the whole report doesn't
   apply to that fight (singles-only engine, per the plan's own literal
   `FieldBattleState.isDoubleBattle: false`). Rendered FIRST, in its own box, reading
   "treat the rest of this page as unreliable for this specific trainer."

## The Tate & Liza gym: 5 trainer entries, 3 distinct banner combinations

Searching "Tate" in the picker returns **5** rows (`TRAINER_TATE_AND_LIZA_1` through
`_5`), not 3 -- a real finding from this batch, not something the plan or earlier
citations mentioned. Measured directly against `data/v2.65beta`:

| Trainer | forcedDouble | Trick Room | Inverse Battle | Banners shown |
|---|---|---|---|---|
| `_1` | true | true | true | all three |
| `_2` | true | true | false | double + Trick Room |
| `_3` | true | true | false | double + Trick Room |
| `_4` | true | false | false | double only |
| `_5` | true | false | false | double only |

All five carry `forcedDouble` (every Tate & Liza fight is a double, confirmed --
`forcedDouble` is a per-trainer flag, independent of which field effects that
trainer's own map-script entry happens to set). `_4`/`_5` appear in neither
`fieldEffects` nor `inverseBattles` at all -- not because they're confirmed to lack
those effects, but because nothing in the scraped map-script corpus references them
for either mechanism, so they're correctly treated as unconfirmed/out of scope rather
than inferred to be plain. Test coverage as of this note: `_1` (all three, in
`lib/matchupReport.test.ts`), `_3` (double + Trick Room, no Inverse), Sawyer as the
ordinary/all-false case, plus a general passthrough test using
`TRAINER_GABBY_AND_TY_1` to confirm `isForcedDouble` isn't special-cased to this gym.
**`_2`, `_4`, `_5` have no dedicated test** -- `_2` is presumed identical to `_3` (same
rematch script shape, not independently verified), and `_4`/`_5` are covered only by
the general "not in the list" reasoning, not a test naming them specifically. Worth
adding if this is picked back up, not blocking.

## Measured, not assumed, counts (re-derive if the data snapshot ever changes)

- 78 of 932 trainers carry `forcedDouble`.
- 74 of those 78 have at least one non-empty party tier (932 - 37 all-tiers-empty
  trainers = 895 "usable"; 74 of the 895 are forced doubles). This is the number that
  reflects how often a user would actually see a full report next to the double
  caveat, as opposed to the empty-tier message.
- The picker itself does NOT filter by party-usability -- all 78 (in fact all 932) are
  reachable by search regardless of whether the trainer has a configured party for the
  selected tier.

## Standing instruction from this thread

Hold. Do not commit batch 3. Report to the team lead was the last action before this
session paused; the next session should check for a reply/review outcome before doing
anything else with this batch, not assume it's clear to commit just because the code
is green.
