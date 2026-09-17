---
name: trick-room-and-forced-double-facts
description: Settled C facts for matchup-report field effects: Trick Room never touches damage, forced doubles are always doubles, Double Battle Mode doubles everyone; plus measured counts (78/74)
metadata:
  type: project
---

Verified 2026-09-15 against pinned eliteredux-source while reviewing Section B batch 3. Do not re-derive.

**Trick Room is turn-order only.** Every reference to `STATUS_FIELD_TRICK_ROOM` / `IsTrickRoomActive` in `src/`:
turn order (`battle_main.c:4325`, `~effectiveSpeed`, ties preserved), AI scoring (`battle_ai_*`), end-turn timer
(`battle_util.c:2052`), script set (`battle_util.c:4244`), Room Service item (`battle_util.c:8609`, -1 Speed on entry),
Twisted Dimension (`abilities.cc:4460`, no-op if already active). Nothing in the damage path.
`IsTrickRoomActive` (`battle_util.c:8671`) returns FALSE when ABILITY_CLUELESS is on field (only SPECIES_QUAGSIRE_MEGA,
as an innate) or monochamp type is FLYING. Clueless suppresses Inverse ROOM (`:8680`) but NOT `B_FLAG_INVERSE_BATTLE` (`:8028`).
Monochamp NORMAL turns on Wonder Room on even turn counters, i.e. turn one (`:8710`) -- damage-relevant, unhandled, behind a dialogue guard.

**Forced double = always double.** `battle_main.c:1910-1913` ORs `gTrainers[].doubleBattle` (TRUE == 1 == BATTLE_TYPE_DOUBLE)
into gBattleTypeFlags even on the `isDoubleBattle = FALSE` branch. Separately the player option
`gSaveBlock2Ptr->doubleBattleMode` (`option_plus_menu.c:1038`) makes EVERY trainer with >=2 mons a double (`:1757`).
Double-only damage terms: spread 0.75x (`battle_util.c:7498`), partner Friend Guard/Caretaker/Food Lovers 0.5x (`:7638-7640`), screens 0.66 (`:7625`).

**Counts (data/v2.65beta):** 78/932 forcedDouble; 74 have a non-empty tier; the 4 empty are KIRA_AND_DAN_5, LILA_AND_ROY_5,
TATE_AND_LIZA_4/_5. No forced-double tier has exactly 1 mon. encounters.json: 23 fieldEffects (3 unguarded Trick Room rows =
TATE_AND_LIZA_1/_2/_3; 2 guarded Gravity, 18 guarded monochamp), 1 inverseBattles row (TATE_AND_LIZA_1, unguarded).

**Recurring test defect seen here:** tests assert a resolved flag is `true` but never that it changes an output number, so
un-wiring the flag from the engine call still passes. Ask for a with/without comparison on a known type pair
(e.g. Body Slam into Lunatone: 0.5x forward, 2x inverse). When verifying such a test by mutation, cut the value at the
ENGINE CALL (e.g. `field: { ...field, isInverseBattleFlagSet: false }` in evaluateMoveEntry), not at the field default: once
the reported flag is read off the field, a default-field revert trips the flag assertion first and masks the damage one.
Done 2026-09-15: engine-call mutation fails only the damage assertion (48 vs 48, matchupReport.test.ts:452).

See [[encounters-guard-field-semantics]], [[react-layer-review-gates]].
