---
name: battle-sim-section-b-batch4-mega-caveat
description: Matchup report now surfaces per-mon Mega/Primal transform info; the dispatching brief's premise that held items were already shown was wrong
metadata:
  type: project
---

Battle-sim plan step 2, batch 2 (the one after [[reference_mega-primal-form-schema]]):
made `MatchupReportView`/`lib/matchupReport.ts` report which opposing Pokemon will
transform and into what, using `formResolution.ts`'s resolver. No number changed --
`MatchupMonReport.speed`/`maxHp`/moves are still computed from the mon's base species
throughout, verified with a Garchomp Redux (Speed 110) vs. Garchomp Mega Redux (Speed
140) pair specifically because Kyogre/Kyogre Primal happen to share the same Speed and
so can't tell a base-form computation apart from a transformed one -- worth remembering
for any FUTURE regression guard in this report: don't reach for Kyogre/Groudon as the
"does this still read the base form" example, their HP and Speed are identical to their
Primal forms in this data.

**The dispatching brief said "the report already shows each one's held item" -- it did
not.** `MatchupMonReport` had no item field at all and neither did the render. Flagged
it, then added `itemId` display too (a `<HeldItemLine>` line under each mon's header)
since showing "becomes X" with no held-item context read as unexplained. Worth
double-checking a dispatching brief's stated-as-fact premises against the actual code
before building on them, especially for UI-state claims that are easy to assert from
memory of "how the page probably works."

`web/src/lib/matchupReport.ts` (`MatchupContext.formIndex`, `MatchupMonReport.itemId`/
`.transformsInto`), `web/src/features/matchupReport/MatchupReportView.tsx`
(`HeldItemLine`), `web/src/routes/TrainerMatchup.tsx` (builds the index once per
`useMemo` via `buildFormIndex(gameData.species)`).
