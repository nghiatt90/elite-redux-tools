# Descriptive report viability

_Verified — worst-case survival thresholding is exact, not a heuristic, because the ER AI's own damage estimate is the max roll; plus the real state of Wonder/Inverse Room in the engine_

Verified 2026-09-11 against the pinned checkouts. Settles open item **A** of the battle-sim
plan (does the demoted Section B survive as an honest deliverable).

## The cold review's objection does not apply to max-over-moveset

`AI_CalcDamage` (`battle_ai_util.c:650-765`) calls
`CalculateMoveDamage(..., CRIT_ROLL_ONLY_IF_GUARANTEED, FALSE, FALSE)`. The sixth argument is
`randomFactor`, and `DoMoveDamageCalc` applies the 85-100% spread only when it is true
(`battle_util.c:7791-7795`). So the AI's `simulatedDmg` is computed **at the maximum roll**,
then crit-blended at `battle_ai_util.c:673-676`:
`dmg = (critDmg + normalDmg * (critChance - 1)) / critChance`.

Consequences:
- `CanIndexMoveFaintTarget` (`battle_ai_util.c:1340-1347`) and `CanAIFaintTarget` (972-989)
  compare that max-roll figure against `gBattleMons[def].hp`. Max-roll survival is therefore
  **the exact predicate the AI evaluates**, not a conservative approximation of it.
- The engine already returns everything needed: `DamageCalcResult.rolls[15]` is the 100% roll,
  plus `critRolls` and `critChanceDenominator` (`web/src/engine/calculate.ts:145-174`). The
  AI's own number is reproducible exactly, no new engine work.

The "fixed point" objection is sound only against "survive its *best* move", where "best"
is AI-selected. Taking the max over the opponent's whole four-move set is an upper bound over
the AI's entire action set, so the AI's re-selection cannot escape it. Thresholding against
the whole moveset genuinely escapes the objection; it does not restate it.

**Verdict: ship it.** Do not call it a recommender. Two columns are exactly correct rather
than caveated: (a) max-roll damage taken per opposing move, (b) the AI's own crit-blended
`simulatedDmg`, i.e. what the AI *believes* it does. (b) is the more interesting one and the
plan does not mention it.

Asymmetry worth surfacing in the report: `SetBattlerData` (`battle_ai_util.c:520-543`) zeroes
the player's held item and unrevealed moves before every `AI_CalcDamage`, so the AI's estimate
of its damage into you ignores your item until it has triggered
(`BATTLE_HISTORY->itemEffects`). Note this is the *damage sim only* — the `HasMove*` predicate
family goes through `GetMovesArray` (`battle_ai_util.c:1349-1357`), which returns the true
moves array whenever `AI_FLAG_CHECK_FOE` is set, and the codegen sets it for every trainer.

Honest caveats to print: turn-one state only (no stat stages, status, hazards, weather set
mid-battle, Mega Evolution, or entry abilities), no residual damage, no accuracy.

## Prerequisites: both plan claims verified, both understated

**Inverse Room is unmodelled.** No occurrence of `inverse`/`INVERSE_ROOM` anywhere in
`web/src/engine/` (the only hits under `web/src` are `isoInverse` in `lib/randomizer.ts` and
`modularInverse`). The C path is `GetTypeModifier` (`battle_util.c:8021-8038`), which selects
`sInverseTypeEffectivenessTable` (a separate hand-written 20x20 array at
`battle_util.c:1015`, **not** derived from the forward table) and XORs the flag three ways:
`IsInverseRoomActive()`, Miracle Eye on either battler, and `B_FLAG_INVERSE_BATTLE`.

Scope omission the plan misses: this is a **pipeline** gap too, not only an engine gap.
`pipeline/src/erdata/typechart.py:14` hardcodes `_TABLE_NAME = "sTypeEffectivenessTable"`, so
the inverse table is never emitted. Closing Inverse Room means touching the pipeline, the data
snapshot and the engine.

**Wonder Room is wired but dead — and the wired half is the smaller half.** ER's Wonder Room
is two separate effects inside `CalculateStat`:
1. `battle_util.c:7111-7116` swaps `STAT_ATK` <-> `STAT_SPATK` (ER swaps the **offensive**
   stats, not Def/SpDef as in mainline). `statStage` is read at 7108 *before* the swap.
2. `battle_util.c:7182-7183` forces the stat stage to default for ATK/SPATK.

`web/src/engine/battleStat.ts:71` implements only (2). Effect (1) cannot live there at all —
`calculateBattleStat` starts from a `rawStat` the caller already chose, and the caller is
`calculate.ts`. So flipping the four `isWonderRoomActive: false` literals
(`calculate.ts:406, 408, 448, 450` — the plan lists three, there are four) would produce a
*wrong* answer, not a right one, until the stat selection in `calculate.ts` also swaps.

Also: `isWonderRoomActive()` (`battle_util.c:8707-8714`) returns true when the Monotype
Champion type is Normal and `gBattleResults.battleTurnCounter % 2 == 0`, independent of
`gFieldStatuses`; the Normal monochamp also alternates Trick Room on odd turns
(`battle_util.c:8674`). Both rooms are suppressed by `ABILITY_CLUELESS` on the field.

Minor: `battleStat.ts:43` cites `:7204` for the Wonder Room stage override. At the pinned SHA
that line is `statBase /= gStatStageRatios[statStage][1];`; the override is at 7182.

See [AI score-function state dependencies](er-ai-score-function-state-deps.md).
