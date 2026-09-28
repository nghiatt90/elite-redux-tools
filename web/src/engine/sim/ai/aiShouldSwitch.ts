// ShouldSwitch (battle_ai_switch_items.c:602-697) and every helper it calls, in
// the C's own order, plus AI_TrySwitchOrUseItem (:699-766) and ShouldUseItem
// (:1082-1235). Read alongside aiSwitching.ts, which already ports
// GetMostSuitableMonToSwitchInto -- this module is the layer ABOVE it: deciding
// WHETHER to switch at all, and which party slot to write into
// `AI_monToSwitchIntoId`/`monToSwitchIntoId` before that port ever runs.
//
// GetAIPartyIndexes' singles-only else branch (firstId=0, lastId=6) is used
// throughout, same precedent as aiSwitching.ts's own header.
//
// TWO STATE-MODEL GAPS, both named "gapped by name, only when reached" per this
// batch's brief:
//
//   - `gLastLandedMoves[battler]` / `gLastHitBy[battler]` (the last move that
//     landed ON this battler, and who threw it) have NO WRITER anywhere in
//     engine/sim -- turn.ts's own header lists `gLastLandedMoves[attacker] = 0`
//     among the HandleAction_ActionFinished statements it deliberately does NOT
//     port. This sim can therefore only ever read them as the C's own
//     zero-init default (MOVE_NONE / "nothing has hit this battler"), which is
//     the true value at the start of a fresh battle but silently stays wrong
//     for the rest of it. `findMonThatAbsorbsOpponentsMove` and
//     `findMonWithFlagsAndSuperEffective` both gate their very first line on
//     `gLastLandedMoves[gActiveBattler] == 0`, which is unconditionally TRUE
//     under this gap -- both helpers always take their "nothing landed"
//     early-return branch, and this module reports that once, by name, every
//     time either is reached (which is every ShouldSwitch call, since every
//     caller of `findMonWithFlagsAndSuperEffective` is on a path that always
//     runs it).
//   - `AI_THINKING_STRUCT->switchMon` (`ShouldSwitchIfAllBadMoves`, :49) is set
//     only by `AI_CheckBadMove`'s own "every move deals no/little damage"
//     branch (battle_ai_main.c:314) -- AI_CheckBadMove is `checkBadMoveStub`
//     in aiPipeline.ts (a batch 2-3 stub, out of this batch's scope), so
//     `switchMon` can never become true anywhere reachable from this sim.
//     `ShouldSwitchIfAllBadMoves` is therefore always FALSE, gapped by name.

import type { BattleState } from '../state'
import {
  DEFAULT_STAT_STAGE,
  NUM_BATTLE_STATS,
  PARTY_SIZE,
  STAT_ATK,
  STAT_SPATK,
  STATUS1_SLEEP,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_WRAPPED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  hasFlag,
} from '../constants'
import { battlerHasAbility } from '../../abilities/dispatch'
import { UQ_ONE, idiv } from '../../fixed'
import { aiGetTypeEffectiveness, type AiDamageDeps } from './aiCalcDamage'
import { isAbilityPreventingEscape, type AiChoice } from './aiPipeline'
import { canIndexMoveFaintTarget } from './aiScorers'
import { getWhoStrikesFirst, type ChosenAction, type TurnOrderMoveView } from '../turnOrder'

/** `include/constants/battle.h:66` -- see this module's own citation on the
 * DISABLE_SWITCHING quirk below for why this is the constant `ShouldSwitch`'s
 * own check REALLY tests. */
const BATTLE_TYPE_PALACE = 1 << 17
/** `include/constants/battle.h:18` -- same value aiSwitching.ts's own header
 * cites for `BATTLE_TYPE_ARENA`, duplicated locally per this codebase's own
 * precedent (aiPipeline.ts does the same rather than importing it). */
const BATTLE_TYPE_ARENA = 1 << 18

const NEUTRAL_SWITCH: { shouldSwitch: false; unmodelled: string[] } = { shouldSwitch: false, unmodelled: [] }

type SwitchHelperResult = { decided: boolean; chosenPartyIndex: number; unmodelled: string[] }

const NOT_DECIDED: SwitchHelperResult = { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled: [] }

/** A reserve slot ShouldSwitch's own loops skip: fainted, empty, the active
 * battler's own slot, or the slot already queued via `monToSwitchIntoId`
 * (singles: `battlerIn1 === battlerIn2 === gActiveBattler`, so both of the C's
 * duplicate checks collapse to one, same precedent as aiSwitching.ts's own
 * singles collapse). */
function isInvalidReserveSlot(state: BattleState, battlerId: number, index: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return true
  const mon = state.sides[battlerId & 1].party[index]
  return !mon || mon.speciesId === null || mon.hp === 0 || index === battler.partyIndex || index === battler.monToSwitchIntoId
}

/** ShouldSwitchIfAllBadMoves, :49-62 -- always FALSE. See this module's header
 * for why `AI_THINKING_STRUCT->switchMon` can never be TRUE here. */
function shouldSwitchIfAllBadMoves(): SwitchHelperResult {
  return {
    decided: false,
    chosenPartyIndex: PARTY_SIZE,
    unmodelled: [
      "ShouldSwitchIfAllBadMoves (battle_ai_switch_items.c:49) always reads switchMon as FALSE -- it is set only by AI_CheckBadMove's 'every move deals no/little damage' branch (battle_ai_main.c:314), which is a checkBadMoveStub no-op in this sim",
    ],
  }
}

/** ShouldSwitchIfPerishSong, :64-77. */
function shouldSwitchIfPerishSong(state: BattleState, battlerId: number): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  if (hasFlag(battler.statuses3, STATUS3_PERISH_SONG) && battler.volatiles.perishSongTimer === 0) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled: [] }
  }
  return NOT_DECIDED
}

/** HasSuperEffectiveMoveAgainstOpponents, :320-343 -- singles-only (no
 * BATTLE_TYPE_DOUBLE partner loop). `noRng=true` short-circuits on the FIRST
 * super-effective move found; `noRng=false` draws `Random() % 10 != 0` per
 * super-effective move found and only stops on a hit (a `% 10 == 0` miss
 * keeps scanning the remaining move slots, it does not abort the loop). */
function hasSuperEffectiveMoveAgainstOpponents(state: BattleState, battlerId: number, noRng: boolean, deps: AiDamageDeps): { result: boolean; unmodelled: string[] } {
  const battler = state.battlers[battlerId]
  const opposingId = battlerId ^ 1
  const opposing = state.battlers[opposingId]
  const unmodelled: string[] = []
  if (!battler || !opposing) return { result: false, unmodelled }

  for (const moveId of battler.mon.moves) {
    if (!moveId) continue
    const { effectiveness, unmodelled: u } = aiGetTypeEffectiveness(state, moveId, battlerId, opposingId, deps)
    unmodelled.push(...u)
    if (effectiveness >= UQ_ONE * 2) {
      if (noRng) return { result: true, unmodelled }
      if (state.rng.random16() % 10 !== 0) return { result: true, unmodelled }
    }
  }
  return { result: false, unmodelled }
}

/** FindMonThatAbsorbsOpponentsMove, :147-263. The `HasSuperEffectiveMoveAgainstOpponents(TRUE)`
 * guard draws ONE `Random() % 3` roll whenever the AI currently holds a
 * super-effective move (a real, reachable draw independent of the
 * lastLandedMoves gap below) -- everything past it is unreachable under that
 * gap (see this module's header). */
function findMonThatAbsorbsOpponentsMove(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const seResult = hasSuperEffectiveMoveAgainstOpponents(state, battlerId, true, deps)
  const unmodelled = [...seResult.unmodelled]
  if (seResult.result && state.rng.random16() % 3 !== 0) {
    return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  unmodelled.push(
    'FindMonThatAbsorbsOpponentsMove (battle_ai_switch_items.c:147): gLastLandedMoves is not tracked by this sim (no writer anywhere in engine/sim); read as MOVE_NONE, so this always returns FALSE past the HasSuperEffectiveMoveAgainstOpponents guard',
  )
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** FindMonWithFlagsAndSuperEffective, :414-500 -- always FALSE under the
 * lastLandedMoves gap (its own FIRST line is `gLastLandedMoves == 0`), so no
 * RNG is ever drawn here. Ported as a constant rather than a full port because
 * every reachable call already knows the answer. */
function findMonWithFlagsAndSuperEffective(): { result: false; unmodelled: string[] } {
  return {
    result: false,
    unmodelled: [
      'FindMonWithFlagsAndSuperEffective (battle_ai_switch_items.c:414) always reads gLastLandedMoves as MOVE_NONE (not tracked by this sim; no writer anywhere in engine/sim), so it always returns FALSE at its own first line',
    ],
  }
}

/** ShouldSwitchIfNaturalCure, :265-299. Reached only when asleep and holding
 * one of the three Natural-Cure-family abilities. Every branch below draws
 * from `state.rng` in the C's own order; see this module's header for why the
 * lastLandedMoves-gated branches are deterministic under this sim's gap. */
function shouldSwitchIfNaturalCure(state: BattleState, battlerId: number): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  if (!hasFlag(battler.mon.status1, STATUS1_SLEEP)) return NOT_DECIDED
  const hasNaturalCure = battlerHasAbility(battler.mon.abilities, 'ABILITY_NATURAL_CURE', () => false)
  const hasSelfRepair = battlerHasAbility(battler.mon.abilities, 'ABILITY_SELF_REPAIR', () => false)
  const hasNaturalRecovery = battlerHasAbility(battler.mon.abilities, 'ABILITY_NATURAL_RECOVERY', () => false)
  if (!hasNaturalCure && !hasSelfRepair && !hasNaturalRecovery) return NOT_DECIDED

  const unmodelled = [
    'ShouldSwitchIfNaturalCure (battle_ai_switch_items.c:265): gLastLandedMoves is not tracked by this sim (no writer anywhere in engine/sim); read as MOVE_NONE, matching the C at battle start but not after any move has actually landed on this battler',
  ]

  // :275 -- `(gLastLandedMoves == 0 || == 0xFFFF) && Random() & 1`. Under the
  // gap above the left side is always TRUE, so this always draws a bit.
  if (state.rng.random16() & 1) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  // :280 -- `else if (gBattleMoves[MOVE_NONE].power == 0 && Random() & 1)`.
  // MOVE_NONE has no move data (power reads as 0 through deps.moveData), so
  // the left side is always TRUE too, and this ALSO always draws a bit.
  if (state.rng.random16() & 1) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }

  const flagCheck1 = findMonWithFlagsAndSuperEffective()
  unmodelled.push(...flagCheck1.unmodelled)
  const flagCheck2 = findMonWithFlagsAndSuperEffective()
  unmodelled.push(...flagCheck2.unmodelled)

  // :293 -- the final unconditional `Random() & 1`.
  if (state.rng.random16() & 1) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** ShouldSwitchIfEncored, :300-317. Reached only while Encored. */
function shouldSwitchIfEncored(state: BattleState, battlerId: number): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  if (battler.volatiles.encoredMove === null) return NOT_DECIDED

  const flagCheck1 = findMonWithFlagsAndSuperEffective()
  const flagCheck2 = findMonWithFlagsAndSuperEffective()
  const unmodelled = [...flagCheck1.unmodelled, ...flagCheck2.unmodelled]

  if (state.rng.random16() & 1) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** ShouldSwitchIfWonderGuard, :79-145. Singles-only (`BATTLE_TYPE_DOUBLE`
 * always false). `AI_GetTypeEffectiveness(move, gActiveBattler, opposingBattler)`
 * is called with `gActiveBattler` as the attacker for EVERY candidate move,
 * including a reserve mon's own move -- the same "the currently active
 * battler casts it, not the candidate" quirk aiSwitching.ts's
 * `getBestMonOffensive` already documents and reproduces. */
function shouldSwitchIfWonderGuard(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  const opposingId = battlerId ^ 1
  const opposing = state.battlers[opposingId]
  const unmodelled: string[] = []
  if (!battler || !opposing) return NOT_DECIDED
  if (!battlerHasAbility(opposing.mon.abilities, 'ABILITY_WONDER_GUARD', () => false)) return NOT_DECIDED

  for (const moveId of battler.mon.moves) {
    if (!moveId) continue
    const { effectiveness, unmodelled: u } = aiGetTypeEffectiveness(state, moveId, battlerId, opposingId, deps)
    unmodelled.push(...u)
    if (effectiveness >= UQ_ONE * 2) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }

  const party = state.sides[battlerId & 1].party
  for (let i = 0; i < 6; i++) {
    if (isInvalidReserveSlot(state, battlerId, i)) continue
    const reserve = party[i]
    if (!reserve) continue
    for (const moveId of reserve.moves) {
      if (!moveId) continue
      const { effectiveness, unmodelled: u } = aiGetTypeEffectiveness(state, moveId, battlerId, opposingId, deps)
      unmodelled.push(...u)
      if (effectiveness >= UQ_ONE * 2 && state.rng.random16() % 3 < 2) {
        return { decided: true, chosenPartyIndex: i, unmodelled }
      }
    }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** AreStatsRaised, :373-386. No RNG, no switch target -- ShouldSwitch's own
 * caller treats TRUE here as "don't switch" (see `shouldSwitch` below), so
 * this never itself decides a switch. */
function areStatsRaised(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  let buffed = 0
  for (let i = 0; i < NUM_BATTLE_STATS; i++) {
    const stage = battler.mon.statStages[i] ?? DEFAULT_STAT_STAGE
    if (stage > DEFAULT_STAT_STAGE) buffed += stage - DEFAULT_STAT_STAGE
  }
  return buffed > 3
}

/** AreAttackingStatsLowered, :388-412. Always decides TRUE once reached (every
 * path either finds a specific mon via FindMonWithFlagsAndSuperEffective or
 * falls to the unconditional PARTY_SIZE switch at :396-398) -- matching the
 * C's own shape, not simplified. */
function areAttackingStatsLowered(state: BattleState, battlerId: number): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spatkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const atk = battler.mon.rawStats.atk
  const spatk = battler.mon.rawStats.spatk

  if (atkStage > DEFAULT_STAT_STAGE - 2 && atk >= spatk) return NOT_DECIDED
  if (spatkStage > DEFAULT_STAT_STAGE - 2 && spatk >= atk) return NOT_DECIDED

  const flagCheck1 = findMonWithFlagsAndSuperEffective()
  const flagCheck2 = findMonWithFlagsAndSuperEffective()
  const unmodelled = [...flagCheck1.unmodelled, ...flagCheck2.unmodelled]
  return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** IsMonHealthyEnoughToSwitch, :503-518. `CalculateHazardDamage` is always 0
 * (no hazard timer/side-status this sim ever sets -- switchIn.ts's own header
 * establishes this precedent), so its own `> battlerHp` branch can never fire
 * and is not separately gapped, matching switchIn.ts's "no real condition
 * exists" reasoning for the same fact. */
function isMonHealthyEnoughToSwitch(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return true
  let battlerHp = battler.mon.hp
  if (battlerHasAbility(battler.mon.abilities, 'ABILITY_REGENERATOR', () => false)) {
    battlerHp = idiv(battlerHp * 133, 100)
  }
  return battlerHp >= idiv(battler.mon.maxHp, 8)
}

/**
 * ShouldSwitch, battle_ai_switch_items.c:602-697.
 *
 * The DISABLE_SWITCHING quirk (:611): `if (gBattleTypeFlags &
 * AI_FLAG_DISABLE_SWITCHING) return FALSE;` reads `gBattleTypeFlags` (the
 * battle-wide `BATTLE_TYPE_*` bitmask, `state.battleTypeFlags`), NOT
 * `AI_THINKING_STRUCT->aiFlags` (`state.aiFlags`, what the trainer's own
 * `noSwitching` toggle actually sets -- aiFlags.ts's `AI_FLAG_DISABLE_
 * SWITCHING`). `AI_FLAG_DISABLE_SWITCHING` and `BATTLE_TYPE_PALACE` share the
 * SAME bit value, `1 << 17` (include/constants/battle_ai.h:61 vs
 * include/constants/battle.h:66) -- so this line is really testing "is this a
 * Battle Palace battle", and Battle Palace is not a battle type any of the 40
 * fights this tool targets can ever be (same "never set" precedent as
 * `BATTLE_TYPE_ARENA`, aiSwitching.ts's own header). The upshot: a trainer's
 * `noSwitching` flag (Trent 1-5) has NO EFFECT on `ShouldSwitch` at all --
 * `state.battleTypeFlags` never carries `BATTLE_TYPE_PALACE`, so this check is
 * always FALSE and every OTHER early return/helper below still runs
 * normally. Reproduced exactly as the C reads it (from `battleTypeFlags`),
 * matching `chooseMoveOrActionSingles`'s own `BATTLE_TYPE_PALACE` precedent
 * (aiPipeline.ts) rather than "fixed" to read `aiFlags` instead.
 */
export function shouldSwitch(state: BattleState, battlerId: number, deps: AiDamageDeps): { shouldSwitch: boolean; unmodelled: string[] } {
  const battler = state.battlers[battlerId]
  if (!battler) return NEUTRAL_SWITCH

  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_PALACE)) return NEUTRAL_SWITCH
  if (hasFlag(battler.mon.status2, STATUS2_WRAPPED | STATUS2_ESCAPE_PREVENTION)) return NEUTRAL_SWITCH
  if (hasFlag(battler.statuses3, STATUS3_ROOTED)) return NEUTRAL_SWITCH
  if (hasFlag(battler.statuses4, STATUS4_COMMANDED)) return NEUTRAL_SWITCH
  if (battler.volatiles.fear) return NEUTRAL_SWITCH
  const escapeCheck = isAbilityPreventingEscape(state, battlerId)
  if (escapeCheck.prevents) return { shouldSwitch: false, unmodelled: escapeCheck.unmodelled }
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) return { shouldSwitch: false, unmodelled: escapeCheck.unmodelled }
  if (battler.volatiles.skyDropped) return { shouldSwitch: false, unmodelled: escapeCheck.unmodelled }

  let availableToSwitch = 0
  for (let i = 0; i < 6; i++) {
    if (!isInvalidReserveSlot(state, battlerId, i)) availableToSwitch++
  }
  if (availableToSwitch === 0) return { shouldSwitch: false, unmodelled: escapeCheck.unmodelled }

  const unmodelled = [...escapeCheck.unmodelled]
  const decide = (r: SwitchHelperResult): boolean => {
    unmodelled.push(...r.unmodelled)
    if (r.decided) battler.aiMonToSwitchIntoId = r.chosenPartyIndex
    return r.decided
  }

  if (decide(shouldSwitchIfAllBadMoves())) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfPerishSong(state, battlerId))) return { shouldSwitch: true, unmodelled }
  if (decide(findMonThatAbsorbsOpponentsMove(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }
  if (!isMonHealthyEnoughToSwitch(state, battlerId)) return { shouldSwitch: false, unmodelled }
  if (decide(shouldSwitchIfEncored(state, battlerId))) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfWonderGuard(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfNaturalCure(state, battlerId))) return { shouldSwitch: true, unmodelled }

  const seResult = hasSuperEffectiveMoveAgainstOpponents(state, battlerId, false, deps)
  unmodelled.push(...seResult.unmodelled)
  if (seResult.result) return { shouldSwitch: false, unmodelled }

  if (areStatsRaised(state, battlerId)) return { shouldSwitch: false, unmodelled }
  if (decide(areAttackingStatsLowered(state, battlerId))) return { shouldSwitch: true, unmodelled }

  const flagCheck1 = findMonWithFlagsAndSuperEffective()
  const flagCheck2 = findMonWithFlagsAndSuperEffective()
  unmodelled.push(...flagCheck1.unmodelled, ...flagCheck2.unmodelled)
  // Both calls always return FALSE under the lastLandedMoves gap (see this
  // module's header), so the C's own `||` never short-circuits true here --
  // ShouldSwitch's final fallthrough is always FALSE.
  return { shouldSwitch: false, unmodelled }
}

/**
 * ShouldUseItem, battle_ai_switch_items.c:1082-1235.
 *
 * Trainer item lists are always empty (`CLAUDE.md`: the codegen emits no
 * `.items`), so `MAX_TRAINER_ITEMS`' own loop always reads `ITEM_NONE` and
 * `continue`s every iteration without ever reaching a `switch` case -- no
 * RNG, no state write, no early return from inside that loop is ever taken.
 * The function's answer is therefore always FALSE.
 *
 * `AiExpectsToFaintPlayer` (:1065-1080) is called UNCONDITIONALLY before that
 * loop whenever `ShouldSwitch()` was FALSE (this function's only caller),
 * regardless of item contents. Its own early return reads
 * `gBattleStruct->aiMoveOrAction[gActiveBattler]` -- a value the real game
 * populates via `ComputeBattleAiScores`, called at `STATE_TURN_START_RECORD`
 * (battle_main.c:3636-3638, "Do AI score computations here so we can use them
 * in AI_TrySwitchOrUseItem") BEFORE `AI_TrySwitchOrUseItem` ever runs
 * (`STATE_BEFORE_ACTION_CHOSEN`). Cycle15's fix pass reordered
 * `chooseAiAction` to match this: move scoring (`chooseMoveOrActionSingles`)
 * now runs BEFORE `AI_TrySwitchOrUseItem`, so its result (`choice`, the same
 * value as `aiMoveOrAction`) IS available here, and `AiExpectsToFaintPlayer`
 * is REACHABLE -- ported below as `aiExpectsToFaintPlayer` and called
 * unconditionally, exactly like the C.
 *
 * Despite being reachable, `ShouldUseItem`'s own answer is STILL always
 * FALSE: `AiExpectsToFaintPlayer` returning TRUE only makes the C return
 * FALSE one line earlier (:1085-1086, before the item loop), and returning
 * FALSE just falls into the item loop, which is a guaranteed no-op (trainer
 * item lists are always empty -- `CLAUDE.md`, the codegen emits no `.items`).
 * Both of `AiExpectsToFaintPlayer`'s outcomes therefore lead to the same
 * final answer -- `aiExpectsToFaintPlayer` is still evaluated for its RNG/
 * state effects (matching the C calling it unconditionally), but its result
 * does not gate anything further here.
 */
function aiExpectsToFaintPlayer(state: BattleState, battlerId: number, target: number, choice: AiChoice, moveView: TurnOrderMoveView | null, deps: AiDamageDeps): { expects: boolean; unmodelled: string[] } {
  // :1069 -- `if (aiMoveOrAction > 3) return FALSE;`. AI_CHOICE_SWITCH/WATCH/
  // FLEE and the mega-evolution marker (case 6, OpponentHandleChooseMove)
  // are all > 3 as MoveEnum-shaped constants; only a real move slot (0-3)
  // continues.
  if (choice.kind !== 'move') return { expects: false, unmodelled: [] }

  const battler = state.battlers[battlerId]
  const moveId = battler?.mon.moves[choice.moveIndex]
  if (!battler || !moveId) return { expects: false, unmodelled: [] }

  // :1071 -- `GetBattlerSide(target) != GetBattlerSide(gActiveBattler)`. In
  // this sim's singles battles the AI's own chosen target (setRandomTargetSingles)
  // is always the opponent, so this is always TRUE here -- reproduced anyway
  // rather than assumed, matching aiSwitching.ts's own precedent for
  // structurally-always-true C conditions.
  if ((target & 1) === (battlerId & 1)) return { expects: false, unmodelled: [] }

  // :1073 -- CanIndexMoveFaintTarget(gActiveBattler, target, aiMoveOrAction, 0).
  const faintCheck = canIndexMoveFaintTarget(state, battlerId, target, moveId, 0, deps)
  if (!faintCheck.faints) return { expects: false, unmodelled: faintCheck.unmodelled }

  // :1074 -- GetWhoStrikesFirst(gActiveBattler, target, FALSE). Unlike every
  // other GetWhoStrikesFirst call in this file (aiScorers.ts's aiTryToFaint/
  // isAiFaster, both ignoreChosenMoves=TRUE), this one uses FALSE -- the AI's
  // REAL chosen move (Mycelium Might / drenched goesLast adjustments apply).
  // Still draws state.rng on a speed tie, same mechanism as every other call.
  const actions: (ChosenAction | null)[] = [null, null, null, null]
  if (moveView) actions[battlerId] = { action: 'USE_MOVE', moveToBeUsed: moveView, chosenMove: moveView, target }
  const strikesFirst = getWhoStrikesFirst(state, battlerId, target, actions, false, deps.turnOrder, deps.statStageRatios)
  return { expects: strikesFirst === 0, unmodelled: faintCheck.unmodelled }
}

export function shouldUseItem(state: BattleState, battlerId: number, target: number, choice: AiChoice, moveView: TurnOrderMoveView | null, deps: AiDamageDeps): { usedItem: false; unmodelled: string[] } {
  const expects = aiExpectsToFaintPlayer(state, battlerId, target, choice, moveView, deps)
  return {
    usedItem: false,
    unmodelled: [
      ...expects.unmodelled,
      'ShouldUseItem (battle_ai_switch_items.c:1082) always returns FALSE -- trainer item lists are always empty, so its MAX_TRAINER_ITEMS loop is a guaranteed no-op regardless of AiExpectsToFaintPlayer\'s own answer',
    ],
  }
}

/**
 * AI_TrySwitchOrUseItem, battle_ai_switch_items.c:699-766 -- the trainer-battle
 * branch only (this sim's battles are always `BATTLE_TYPE_TRAINER`).
 *
 * When `ShouldSwitch` decides TRUE, `AI_monToSwitchIntoId[battlerId]` has
 * already been written by whichever helper decided it (see `shouldSwitch`'s
 * own `decide` closure) -- if that value is still `PARTY_SIZE` (every helper
 * that does not pick a SPECIFIC mon writes this sentinel), `GetMostSuitableMonToSwitchInto`
 * runs; if THAT also returns `PARTY_SIZE`, this function's own local fallback
 * loop (:715-745) picks the first live, non-excluded reserve slot -- NOT the
 * same fallback `switchIn.ts`'s `createAiOpponentReplacement` uses
 * (`fallbackFirstLiveSlot`, `OpponentHandleChoosePokemon`'s OWN separate
 * fallback for end-of-turn replacement) -- this one additionally excludes the
 * slot already queued in `monToSwitchIntoId`, which the end-of-turn fallback
 * does not need to.
 *
 * `target`/`choice`/`moveView` are step 1's own results (`chooseMoveOrActionSingles`'s
 * chosen target/action and, when it chose a move, the built `TurnOrderMoveView`)
 * -- threaded through only so `ShouldUseItem`'s `AiExpectsToFaintPlayer` can
 * read them, matching `gBattleStruct->aiMoveOrAction`/`aiChosenTarget` being
 * populated before `AI_TrySwitchOrUseItem` runs (see `shouldUseItem`'s own doc).
 */
export function aiTrySwitchOrUseItem(
  state: BattleState,
  battlerId: number,
  deps: AiDamageDeps,
  getMostSuitableMonToSwitchInto: (state: BattleState, battlerId: number, deps: AiDamageDeps) => { partyIndex: number; unmodelled: string[] },
  target: number,
  choice: AiChoice,
  moveView: TurnOrderMoveView | null,
): { switched: boolean; unmodelled: string[] } {
  const battler = state.battlers[battlerId]
  if (!battler) return { switched: false, unmodelled: [] }

  const switchResult = shouldSwitch(state, battlerId, deps)
  const unmodelled = [...switchResult.unmodelled]
  if (switchResult.shouldSwitch) {
    let monToSwitchId = battler.aiMonToSwitchIntoId
    if (monToSwitchId === PARTY_SIZE) {
      const suitable = getMostSuitableMonToSwitchInto(state, battlerId, deps)
      unmodelled.push(...suitable.unmodelled)
      monToSwitchId = suitable.partyIndex
      if (monToSwitchId === PARTY_SIZE) {
        const party = state.sides[battlerId & 1].party
        monToSwitchId = PARTY_SIZE
        for (let i = 0; i < 6; i++) {
          const mon = party[i]
          if (!mon || mon.hp === 0) continue
          if (i === battler.partyIndex) continue
          if (i === battler.monToSwitchIntoId) continue
          monToSwitchId = i
          break
        }
      }
      battler.aiMonToSwitchIntoId = monToSwitchId
    }
    battler.monToSwitchIntoId = battler.aiMonToSwitchIntoId
    return { switched: true, unmodelled }
  }

  const itemResult = shouldUseItem(state, battlerId, target, choice, moveView, deps)
  unmodelled.push(...itemResult.unmodelled)
  return { switched: false, unmodelled }
}
