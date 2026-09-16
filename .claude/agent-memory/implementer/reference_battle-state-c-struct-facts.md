---
name: battle-state-c-struct-facts
description: Non-obvious initial values and shapes in ER's battle state structs — isFirstTurn starts at 2, switch-target sentinel is PARTY_SIZE not 0, statStages is 8 entries in 0..12, two separate switch-target arrays
metadata:
  type: reference
---

Facts that a state model derived from general Pokemon knowledge gets wrong. All at the
pinned SHA in `sources.lock.json`.

- **`gVolatileStructs[b].isFirstTurn` starts at 2**, not 1 and not a boolean — set
  immediately after `ZERO(...)` in both reset paths, `battle_main.c:2899`
  (SwitchInClearSetData) and `:2970` (FaintClearSetData). It is a two-turn countdown.
- **The "no pending switch" sentinel is `PARTY_SIZE` (6)**, not 0 and not 0xFF.
  `battle_main.c:3522` fills `monToSwitchIntoId[]` with it, `:2710` fills
  `AI_monToSwitchIntoId[]`, and readers test it by name
  (`battle_ai_switch_items.c:980`, `battle_ai_main.c:1408`). Zero would mean "already
  switching into party slot 0".
- **There are TWO switch-target arrays**, not one: `gBattleStruct->monToSwitchIntoId`
  (`battle.h:622`) and `gBattleStruct->AI_monToSwitchIntoId` (`battle.h:677`).
  `ShouldSwitch` reads the first (`battle_ai_switch_items.c:662-665`); `ShouldPivot`
  reads the second (`battle_ai_util.c:1884`). The state-deps research note names only
  the first.
- **`statStages` is 8 entries (`NUM_BATTLE_STATS`), stored 0..12 with 6 neutral.**
  Index 0 is STAT_HP and unused; 6/7 are accuracy/evasion, which the AI reads directly.
  Init at `battle_main.c:2809` and `:2951`. The damage calculator's own
  `BattlerBattleState.statStages` uses the -6..+6 external form — different convention,
  same underlying thing.
- **`VolatileStruct` has two differently-sized per-ability arrays**:
  `abilityState[NUM_INNATE_PER_SPECIES + 1]` = 4 and
  `switchInAbilityDone[TOTAL_ABILITY_COUNT + HELL_MODE_EXTRA_ABILITIES]` = 7.
  Conflating them truncates silently.
- **`BattleHistory.usedMoves[battler][slot]` is a per-SLOT reveal mask, not a history.**
  `SetBattlerData` (`battle_ai_util.c:520-543`) blanks any move slot whose entry is 0 and
  blanks the held item while `itemEffects[battler]` is 0. The actual last-three-moves ring
  buffer is `moveHistory[battler][0..2]` + `moveHistoryIndex`.
- **`gVolatileStructs[b].fear` and `STATUS4_FEAR` are different things.** ShouldSwitch
  (`battle_ai_switch_items.c:619`) and IsBattlerTrapped (`battle_ai_util.c:574`) test the
  VolatileStruct field, not the status bit. Both exist.
- **`AI_THINKING_STRUCT->aiFlags` is one value for the whole battle**, taken from
  opponent A only (`battle_ai_main.c:147`), so in a two-trainer fight opponent B's own
  flags are never read. `AI_FLAG_DOUBLE_BATTLE` is OR'd in at `:154`.
- `AI_RandLessThan(val)` is `(Random() % 0xFF) < val` (`battle_ai_util.c:441`) — modulus
  255, not 256. `Random()` returns u16 (`include/random.h:8`).

See [[battle-sim-section-c-state-model]] for where this landed.
