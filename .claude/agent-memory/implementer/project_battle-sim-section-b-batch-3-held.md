---
name: battle-sim-section-b-batch-3-held
description: Battle-sim plan Section B, batch 3 (per-battle field effects + forced-double disclosure on the web side) is complete, green, reviewed twice and approved -- what's in it, and the Tate & Liza test case worked out by hand
metadata:
  type: project
---

Batch 3 is the web-side consumer of `encounters.json`'s `fieldEffects` /
`inverseBattles` lists (pipeline half already committed at `9cc8e69`), plus a
forced-double disclosure added on top of it. **Complete, green, reviewed twice,
and committed** (`c72c173`, then a browser-review follow-up at `612b60e` -- see
that update below).

**2026-09-15 update:** a first reviewer (facts saved to
`.claude/agent-memory/code-reviewer/project_trick-room-and-forced-double-facts.md`)
returned "commit after four changes" and a second implementer applied them --
banner reorder/restyle, rewritten double-battle text, a damage-number test for the
inverse wiring, a Double Battle Mode caveat, and a fix so `isInverseBattleActive` is
read off the field actually used rather than an independent lookup. A second review
pass then checked that test's own mutation claim: reverting the field-derivation fix
back to `input.field ?? neutralField()` makes two assertions fail, both on the
`isInverseBattleActive`/`isTrickRoomActive` flags -- one of which fires before the
damage assertion is ever reached, so that revert alone says nothing about whether
the damage figure is wired up. A second, narrower mutation -- leaving the field
wiring intact but forcing `isInverseBattleFlagSet` off only at the
`calculateMoveDamage` call site -- is what actually isolates the damage assertion:
exactly one test fails, on `expect(bodySlamInverse.maxRollDamage!).toBeGreaterThan(...)`,
confirming that specific line is the one check that catches a field that never
reaches the engine. The test's title was corrected to describe this. Several facts
below were WRONG and are corrected here.

**2026-09-15 browser-review update:** a real browser pass (the first for this batch)
found three things only a rendered page could show, plus one thing a browser pass
tried and couldn't reach. Fixed:
1. `MonSection`'s card header said "faster/slower than you" -- a turn-order claim
   that reads backwards under Trick Room (the table correctly lists a Trick-Room mon
   last when it acts after you, but the card still said "faster"). Reworded to
   "higher/lower/same Speed as you" -- a claim about the stat only, true under either
   ordering, rather than threading `isTrickRoomActive` into every card.
2. The Double Battle Mode caveat (`MATCHUP_REPORT_CAVEATS`) used to end "see the
   double-battle banner above", which points at nothing on an ordinary singles page
   (the banner only renders for `forcedDouble`). Reworded to stand alone; a one-line
   comment at each of the two sites (the banner's own JSX and this caveat) now
   cross-references the other instead.
3. Color split: `TRICK_ROOM_SPEED_TIER_NOTE` and `SPEED_TIER_CAVEAT` used to be one
   red string carried on `MatchupReport.speedTierNote`, mixing an APPLIED effect
   (Trick Room, which the report correctly accounts for) with a genuine limitation
   (priority is never modelled) under one danger color. Split into two constants,
   the Trick Room one neutral and rendered only when active, the priority one red and
   rendered unconditionally (it was always true regardless of Trick Room). Since the
   two no longer varied together, **the `speedTierNote` field was removed from
   `MatchupReport` entirely** -- every remaining mention of `speedTierNote` elsewhere
   in this note is now WRONG; `MatchupReportView.tsx` imports both constants
   directly, the same way it already imports `MATCHUP_REPORT_CAVEATS`. This also
   surfaced a second bug: the priority caveat's own example ("a lower-Speed mon using
   a priority move still acts first") reads backwards once it renders directly below
   the Trick Room note on the same page -- reworded to "a Pokemon listed lower in the
   table using a priority move can still act first", true under both orderings.
4. Couldn't reach in the browser: the empty-party case (`_4`/`_5` below), a
   search-input focus issue unrelated to this batch. Confirmed by test instead --
   see `lib/matchupReport.test.ts`'s `TRAINER_TATE_AND_LIZA_4/_5` test, which asserts
   the two inputs (`isForcedDouble`, empty party in every tier) rather than the render.

A follow-up review pass on the above then asked for five more small things: reword
the priority-caveat example again (still backwards, see point 3's own fix above --
this was corrected in the SAME batch before commit, not a second follow-up), delete
a since-pointless sanity test on the two constants' `typeof`/non-empty-ness (kept
only a single regression guard: `TRICK_ROOM_SPEED_TIER_NOTE` must not contain the
word "priority", the one plausible way the two could get merged back together),
retitle the `_4`/`_5` test to describe its inputs rather than the render it can't
see, add the two cross-reference comments in point 2 above, and fix this note's own
stale `speedTierNote` mentions (this update, and the table/list correction below).
See the verification line under "What it touches" above for the final, current
passing count. This browser-review follow-up batch landed as commit `612b60e`,
on top of the field-effect batch itself at `c72c173`, both on
`docs/agent-roles-and-project-notes`.

## What it touches

`web/src/lib/types.ts` (`Encounters`/`FieldEffect`/`InverseBattle`/etc.),
`web/src/lib/data.ts` (`loadEncounters`), `web/src/lib/matchupReport.ts`
(`resolveTrickRoomActive`, `resolveInverseBattleActive`,
`MatchupReport.isTrickRoomActive`/`isInverseBattleActive`/`isForcedDouble`),
`web/src/lib/matchupReport.test.ts`,
`web/src/features/matchupReport/MatchupReportView.tsx` (two banners -- double
battle and Inverse Battle -- plus the Trick Room speed-tier note),
`web/src/features/matchupReport/useMatchupReportData.ts`,
`web/src/features/matchupReport/composition.test.ts`, `web/src/routes/TrainerMatchup.tsx`.

Verification run against this exact tree: `tsc -b --force` clean,
`npm --prefix web run lint` 0 errors / 6 pre-existing warnings (none in touched
files), `npm --prefix web test` **782/782 passing**. Re-verified 2026-09-15 after
the review-findings batch above: same three checks clean, **783/783 passing** (one
net new test). Re-verified again 2026-09-15 after the browser-review follow-up
batch below: same three checks clean, **784/784 passing**.

## Newest and least-examined part: the forced-double banner

Three independent facts can be true of one fight, rendered as TWO separate
banners in `MatchupReportView.tsx` plus the speed-tier note (not three banners --
**correction: Trick Room gets no banner of its own**, only `TRICK_ROOM_SPEED_TIER_NOTE`
(imported directly by the view, not carried on `MatchupReport` -- see that
constant's own doc for the 2026-09-15 browser-review color split) next to the
speed-tier table; see resolveTrickRoomActive's own doc for why it never touches a
damage number and so needs no separate banner the way Inverse Battle does):
1. **Trick Room** (`isTrickRoomActive`) -- presentation only, reverses
   `speedTiers`'s sort order and swaps in `TRICK_ROOM_SPEED_TIER_NOTE`. The report
   DOES account for this. No banner.
2. **Inverse Battle** (`isInverseBattleActive`) -- feeds
   `FieldBattleState.isInverseBattleFlagSet`, so damage numbers are genuinely
   computed under the inverted chart. The report DOES account for this too. Its own
   banner, styled informational (normal border, no danger color) after the 2026-09-15
   review -- the numbers genuinely reflect the inversion, so nothing here should read
   as "distrust this page".
3. **Forced double** (`isForcedDouble`) -- straight passthrough of
   `Trainer.forcedDouble`. Added last, after the Trick Room/Inverse work. Unlike the
   other two, this is NOT a condition the report accounts for -- it states that the
   report's singles-only model does not apply to that fight at all. Rendered first
   (moved above the "what this report is" scope box in the 2026-09-15 review), in its
   own box, red border -- the only banner with the danger color now.
   This was the part of the batch that had the least scrutiny before review: it was
   written in response to a late finding (that Tate & Liza, and 77 other
   trainers, are forced doubles).

## Not verified: anything visual

No browser check has been done on any part of this batch, old or new. All
claims about how the two banners look together, whether the layout reads
clearly, and whether the picker's trainer-id display is legible next to the
banners are reasoned from code, not observed in a running app.

## The Tate & Liza gym: 5 trainer entries, 3 distinct page combinations

Searching "Tate" in the picker returns 5 rows, `TRAINER_TATE_AND_LIZA_1`
through `_5`, not 3. Measured directly against `data/v2.65beta`:

| Trainer | forcedDouble | Trick Room | Inverse Battle | What the page shows |
|---|---|---|---|---|
| `_1` | true | true | true | double banner + Inverse Battle banner + Trick Room speed-tier note |
| `_2` | true | true | false | double banner + Trick Room speed-tier note |
| `_3` | true | true | false | double banner + Trick Room speed-tier note |
| `_4` | true | false | false | double banner + "no configured party" message |
| `_5` | true | false | false | double banner + "no configured party" message |

All five carry `forcedDouble`. **Correction: `_4` and `_5` have empty parties in
every tier** (measured directly: `ace`/`elite`/`hell` all length 0 for both) --
they're two of the four forced-double trainers with no usable party at all (the
other two are `KIRA_AND_DAN_5` and `LILA_AND_ROY_5`, per the code-reviewer's facts
memory), which is why they show the double banner plus the empty-party message
rather than a populated report. Test coverage: `_1` (all three conditions, in
`lib/matchupReport.test.ts`), `_1` again for the damage-comparison test added in
the 2026-09-15 review, `_3` (Trick Room, no Inverse), Sawyer as the ordinary
all-false case, plus a general passthrough test on `TRAINER_GABBY_AND_TY_1`
confirming `isForcedDouble` isn't special-cased to this gym. `_2` has no dedicated
test in `lib/matchupReport.test.ts` but IS independently confirmed in
`encounters.json`'s `fieldEffects` list: it carries its own unguarded
`STATUS_FIELD_TRICK_ROOM` row (script `MossdeepCity_Gym_EventScript_TateAndLizaDoublesRematch`,
distinct from `_3`'s own row, script `...TateAndLizaRematch`) and does not appear
in `inverseBattles` -- Trick Room without the inverse flag, same combination as
`_3`, confirmed directly rather than presumed. `_4`/`_5` are covered only by the
general "not in either list" reasoning plus the empty-party fact above.

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
