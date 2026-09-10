# Plan corrections

_Running list of claims in the battle-simulator plan that were checked against the pinned source — which held, which did not_

Plan file: `~/.claude/plans/we-already-have-a-parsed-nova.md` (outside the repo).
Checked 2026-09-11 at the pinned SHA. Do not re-derive these.

## Verified correct — stop re-checking

- `battle_main.c:1819-1827` level derivation; `TrainerPartyGenerator.kt` emits no `.lvl`,
  no `.items`, no `.isAlpha`.
- `GetAiLogicData` fills only `simulatedDmg[1][0][0..3]`; `battle_ai_util.c:962` reads flat
  `4 + moveId`. Arithmetic is right.
- `s8 score[MAX_MON_MOVES]` at `include/battle.h:370`; the `u8` truncation is real
  (`currentMoveArray` / `consideredMoveArray` are `u8[4]`).
- `Random()` at `battle_ai_main.c:338, 1638, 2074, 4117` — all four line numbers exact.
- Ability hook counts (plan's "Missing pieces" table): onEntry 225, onAttacker 144,
  onDefender 122, onEndTurn 67, onBattlerFaints 55, onAccuracy 50, onStatusImmune 40,
  onPriority 19 — all match `data/v2.65beta/abilityHooks.json` exactly.
- Move behaviours "~358 of 460, 33 of the 391 alias to `BattleScript_EffectHit`":
  460 behaviours, 69 with no `legacyConfig`, 391 with one, 33 of those are
  `BattleScript_EffectHit`. Internally consistent.
- `GetMostSuitableMonToSwitchInto` at `battle_ai_switch_items.c:969`;
  `TryToSetFieldEffect` at `battle_util.c:4162`.
- Ability slot "1 of 3 plus 3 fixed innates": every species carries 3 ability slots and 3
  innate slots. 1751 of 1907 species have 3 *distinct* abilities, 149 have only 1.
- `SetBattlerData` (`battle_ai_util.c:520-543`) zeroes the player's item and unrevealed
  moves, ungated.

## Wrong or stale in the plan

1. **Section A.1 still says "Resolve `.ability` as a slot index against `species.json`".**
   `TrainerList.proto:248` declares `AbilityEnum ability = 5` — it is an ability id. CLAUDE.md
   was corrected in commit 12aae57; the plan was not. The already-written
   `pipeline/src/erdata/trainers.py` emits it correctly as an id, so only the plan text is
   stale.
2. **"`Random()` appears ~27 times across the AI files" undercounts by ~2.4x.** Counting
   `AI_RandLessThan` as well: `battle_ai_main.c` 37 + 7, `battle_ai_util.c` 3 + 8,
   `battle_ai_switch_items.c` 12 = ~66 call sites. Bears directly on the effort estimate for
   RNG-call-order exactness.
3. **"Any Ace-tier trainer works" is false for the Section C slice.** Only 36 of 895 ace
   parties are all-damaging-single-target. See [AI score-function state dependencies](er-ai-score-function-state-deps.md).
4. **Wonder Room: `calculate.ts` has four `isWonderRoomActive: false` sites, not three**
   (406, 408, 448, **450**), and the missing half of the effect is the ATK/SPATK swap, which
   is not in `battleStat.ts` at all. See [Descriptive report viability](er-descriptive-report-viability.md).
5. **Inverse Room is also a pipeline gap**, not only an engine gap —
   `pipeline/src/erdata/typechart.py:14` scrapes only `sTypeEffectivenessTable`.
6. **"The AI never uses healing items" is right but the plan omits that switching is
   mandatory.** `AI_FLAG_SMART_SWITCHING` and `AI_FLAG_CHECK_FOE` are emitted for every
   trainer, and the `noSwitching` flag is dead due to a bit collision
   (`battle_ai_switch_items.c:611`).
7. Minor: the plan cites `ChooseMoveOrAction_Singles:322` for the u8 comparison; 322 is
   `consideredMoveArray[0] = 0`. The truncating assignment is 321, the comparisons 327 and 331.
