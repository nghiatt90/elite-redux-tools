---
name: battle-sim-section-b-batch-3-held
description: Battle-sim plan Section B, batch 3 (per-battle field effects + forced-double disclosure on the web side) is complete, green, uncommitted, and unreviewed -- what's in it, what's least examined, and the Tate & Liza test case worked out by hand
metadata:
  type: project
---

Batch 3 is the web-side consumer of `encounters.json`'s `fieldEffects` /
`inverseBattles` lists (pipeline half already committed at `9cc8e69`), plus a
forced-double disclosure added on top of it. **Complete, green, uncommitted, and
has never been reviewed.** Do not commit without a review pass first.

## What it touches

`web/src/lib/types.ts` (`Encounters`/`FieldEffect`/`InverseBattle`/etc.),
`web/src/lib/data.ts` (`loadEncounters`), `web/src/lib/matchupReport.ts`
(`resolveTrickRoomActive`, `resolveInverseBattleActive`,
`MatchupReport.isTrickRoomActive`/`isInverseBattleActive`/`isForcedDouble`),
`web/src/lib/matchupReport.test.ts`,
`web/src/features/matchupReport/MatchupReportView.tsx` (three separate banners),
`web/src/features/matchupReport/useMatchupReportData.ts`,
`web/src/features/matchupReport/composition.test.ts`, `web/src/routes/TrainerMatchup.tsx`.

Verification run against this exact tree: `tsc -b --force` clean,
`npm --prefix web run lint` 0 errors / 6 pre-existing warnings (none in touched
files), `npm --prefix web test` **782/782 passing**.

## Newest and least-examined part: the forced-double banner

Three independent facts can be true of one fight, rendered as three separate
banners in `MatchupReportView.tsx` rather than merged:
1. **Trick Room** (`isTrickRoomActive`) -- presentation only, reverses
   `speedTiers`'s sort order. The report DOES account for this.
2. **Inverse Battle** (`isInverseBattleActive`) -- feeds
   `FieldBattleState.isInverseBattleFlagSet`, so damage numbers are genuinely
   computed under the inverted chart. The report DOES account for this too.
3. **Forced double** (`isForcedDouble`) -- straight passthrough of
   `Trainer.forcedDouble`. Added last, after the other two banners were already
   built. (None of the three has been reviewed; the whole batch is unreviewed.)
   Unlike the first two, this is NOT a condition the
   report accounts for -- it states that the report's singles-only model does
   not apply to that fight at all. Rendered first, in its own box, red border.
   This is the part of the batch that has had the least scrutiny: it was
   written in response to a late finding (that Tate & Liza, and 77 other
   trainers, are forced doubles), it is the only banner whose test coverage is
   uneven across the five example rows (see below), and no one besides the
   author has read its wording.

## Not verified: anything visual

No browser check has been done on any part of this batch, old or new. All
claims about how the three banners look together, whether the layout reads
clearly, and whether the picker's trainer-id display is legible next to the
banners are reasoned from code, not observed in a running app.

## The Tate & Liza gym: 5 trainer entries, 3 distinct banner combinations

Searching "Tate" in the picker returns 5 rows, `TRAINER_TATE_AND_LIZA_1`
through `_5`, not 3. Measured directly against `data/v2.65beta`:

| Trainer | forcedDouble | Trick Room | Inverse Battle | Banners shown |
|---|---|---|---|---|
| `_1` | true | true | true | all three |
| `_2` | true | true | false | double + Trick Room |
| `_3` | true | true | false | double + Trick Room |
| `_4` | true | false | false | double only |
| `_5` | true | false | false | double only |

All five carry `forcedDouble`. `_4`/`_5` appear in neither `fieldEffects` nor
`inverseBattles` because nothing in the scraped map-script corpus references
them for either mechanism -- treated as unconfirmed/out of scope, not inferred
to be plain. Test coverage: `_1` (all three conditions, in
`lib/matchupReport.test.ts`), `_3` (double + Trick Room, no Inverse), Sawyer as
the ordinary all-false case, plus a general passthrough test on
`TRAINER_GABBY_AND_TY_1` confirming `isForcedDouble` isn't special-cased to
this gym. `_2`, `_4`, `_5` have no dedicated test: `_2` is presumed identical
to `_3` (same rematch script shape, not independently verified), `_4`/`_5` are
covered only by the general "not in the list" reasoning.

## The two measured counts (re-derive if the data snapshot ever changes)

- **78 of 932 trainers** carry `forcedDouble: true`. Measured by loading
  `data/v2.65beta/trainers.json` and counting entries with that field set.
- **74 of those 78** have at least one non-empty party tier. Measured as:
  932 trainers total, 37 have every tier (ace/elite/hell) empty -> 895
  "usable" trainers; of the 78 forced-double trainers, 74 fall inside that
  895. This is the count that reflects how often a user would actually reach a
  populated report next to the double banner, rather than an empty-tier
  message. The picker itself does not filter by usability -- all 78 (all 932)
  are reachable by search regardless of party emptiness.
