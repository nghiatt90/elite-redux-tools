---
name: inverse-wonder-room-closed
description: Inverse Room and Wonder Room prerequisites for the battle-sim descriptive report are closed as of 2026-09-11 -- what landed, what's still deliberately unmodelled
metadata:
  type: project
---

Both gaps `docs/battle-sim/er-descriptive-report-viability.md` flagged as blocking
Section B (the descriptive report) of `~/.claude/plans/we-already-have-a-parsed-nova.md`
are closed, in three commits on `docs/agent-roles-and-project-notes`:

1. Pipeline: `pipeline/src/erdata/typechart.py` now also scrapes
   `sInverseTypeEffectivenessTable` (`parse_inverse_type_chart`), emitted as
   `data/<version>/typesInverse.json` alongside the existing `types.json`.
2. Engine: `web/src/engine/typeEffectiveness.ts`'s new `getTypeModifier` ports
   `GetTypeModifier` (battle_util.c:8021-8038) faithfully, including the three-way
   XOR (Inverse Room field effect, either battler's Miracle Eye, `B_FLAG_INVERSE_BATTLE`)
   and the counterintuitive Dark-vs-Psychic-forced-to-0 special case under Miracle Eye.
3. Engine: Wonder Room's ATK<->SPATK swap (`CalculateStat`, battle_util.c:7111-7116)
   is now wired via `calculate.ts`'s `wonderRoomStatSwap`, applied inside `computeStat`
   itself so it also covers the secondary-stat blend's own recursion. The stat-stage
   default-override half (`battleStat.ts`) was already ported but had never been
   exercised by a real caller or a test until this batch.

**Why:** these were the only two things standing between the project and the
descriptive report (Section B), per the plan-reviewer's verified writeup -- see
[[battle-sim-section-a]] for the sibling Section A (trainer/encounter data) status.

**Deliberately left unmodelled, not guessed at:** the Monotype Champion Normal
turn-parity alternation that also triggers Wonder Room/Trick Room every other turn
(`isWonderRoomActive`/`IsTrickRoomActive`, battle_util.c:8674,8710) and the
`ABILITY_CLUELESS`-on-field suppression both Rooms (and Gravity) share -- this
calculator has no turn-loop or ability-census concept to derive either from, so
`FieldBattleState.isInverseRoomActive`/`isWonderRoomActive` are flat caller-supplied
booleans that collapse all of the C's OR/suppression logic into one fact, same
precedent as the pre-existing `gravityActive` field.

**How to apply:** if Section B (the descriptive report UI/logic) gets built next, it
can now assume both Rooms are fully modelled for a static turn-one scenario. If
Section C (turn loop) ever gets un-parked, the turn-parity alternation would need a
real per-turn counter it currently has nowhere to live -- don't try to retrofit it
onto the current flat-boolean fields.

Also produced [[sprite-png-nondeterminism-cause]] as a side-finding while regenerating
the data snapshot for this work.
