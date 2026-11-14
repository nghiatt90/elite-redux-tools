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
// `AI_THINKING_STRUCT->switchMon` (`ShouldSwitchIfAllBadMoves`,
// battle_ai_switch_items.c:49-62) is set by ChooseMoveOrAction_Singles' own
// second switch check once every move score is at or below the cap and a
// suitable reserve exists (battle_ai_main.c:313-315). `state.aiSwitchMon` holds
// it; `setupAiScores` clears it at the start of every scoring pass, matching
// BattleAI_SetupAIData's memset (:164), and `shouldSwitchIfAllBadMoves` clears
// it as it consumes it, so a second evaluation in the same selection returns
// NOT_DECIDED.

import type { BattleState, SimPartyMon } from '../state'
import {
  BATTLER_NONE,
  DEFAULT_STAT_STAGE,
  MOVE_UNSET,
  NUM_BATTLE_STATS,
  PARTY_SIZE,
  STAT_ATK,
  STAT_SPATK,
  STATUS1_SLEEP,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_WRAPPED,
  STATUS3_EMBARGO,
  STATUS3_MIRACLE_EYED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  STATUS4_FORESIGHT,
  STATUS_FIELD_INVERSE_ROOM,
  WEATHER_STRONG_WINDS,
  hasFlag,
} from '../constants'
import { selfAbility } from './aiAbilityHelpers'
import { UQ_ONE, idiv, mulModifier, uq } from '../../fixed'
import { getTypeModifier, type TypeModifierInputs } from '../../typeEffectiveness'
import { forEachAbility } from '../../abilities/dispatch'
import { isBattlerGrounded } from '../grounding'
import { battlerHasSimAbility, isSimAbilitySuppressed } from '../statBuffs'
import { weatherHasEffect } from '../fieldEndTurn'
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

/** ShouldSwitchIfAllBadMoves, battle_ai_switch_items.c:49-62. Reads and CLEARS
 * `state.aiSwitchMon` (the C's `gBattleResources->ai->switchMon = 0`), queues
 * the `PARTY_SIZE` sentinel into `AI_monToSwitchIntoId` (the caller's `AI_monToSwitchIntoId[battlerId]`
 * write, which `decide` performs from `chosenPartyIndex`), and reports the
 * switch. NOT_DECIDED otherwise. */
function shouldSwitchIfAllBadMoves(state: BattleState, battlerId: number): SwitchHelperResult {
  if (!state.aiSwitchMon) return NOT_DECIDED
  // :51-53.
  state.aiSwitchMon = false
  const battler = state.battlers[battlerId]
  if (battler) battler.aiMonToSwitchIntoId = PARTY_SIZE
  return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled: [] }
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

/** FindMonThatAbsorbsOpponentsMove's per-move-type absorber list, :178-207.
 * Order matters: the C scans j = 0..numAbsorbingAbilities-1, and every
 * matching (party slot, ability) pair with a truthy `Random() & 1` wins. */
const ABSORBING_ABILITIES_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  FIRE: ['ABILITY_FLASH_FIRE'],
  WATER: ['ABILITY_WATER_ABSORB', 'ABILITY_STORM_DRAIN', 'ABILITY_DRY_SKIN'],
  ELECTRIC: ['ABILITY_VOLT_ABSORB', 'ABILITY_MOTOR_DRIVE', 'ABILITY_LIGHTNING_ROD'],
  GRASS: ['ABILITY_SAP_SIPPER'],
  GROUND: ['ABILITY_EARTH_EATER'],
}

/** FindMonThatAbsorbsOpponentsMove, :147-263. The `HasSuperEffectiveMoveAgainstOpponents(TRUE)`
 * guard draws ONE `Random() % 3` roll whenever the AI currently holds a
 * super-effective move. Then the last move that landed ON the AI's active
 * battler picks an absorber list; a reserve mon whose own primary ability is
 * on it is brought in on a `Random() & 1` per matching (slot, ability) pair. */
function findMonThatAbsorbsOpponentsMove(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const seResult = hasSuperEffectiveMoveAgainstOpponents(state, battlerId, true, deps)
  const unmodelled = [...seResult.unmodelled]
  if (seResult.result && state.rng.random16() % 3 !== 0) {
    return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  const battler = state.battlers[battlerId]
  if (!battler) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  // :154-158 -- no move has landed yet (null is the C's 0), the move id is
  // the 0xFFFF sentinel, or the landed move is status/damage-less.
  const moveId = battler.lastLandedMove
  if (moveId === null || moveId === MOVE_UNSET) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  const lastMove = deps.moveData(moveId)
  if (!lastMove || lastMove.power === 0) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  const absorbing = lastMove.type ? ABSORBING_ABILITIES_BY_TYPE[lastMove.type] : undefined
  if (!absorbing) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  // :211-215 -- GetBattlerAbility is gBattleMons[b].abilities[0] only
  // (battle_util.c:9327): no suppression check, no innates.
  const ownAbility = battler.mon.abilities.ability
  if (ownAbility !== null && absorbing.includes(ownAbility)) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  const party = state.sides[battlerId & 1].party
  for (let i = 0; i < 6; i++) {
    if (isInvalidReserveSlot(state, battlerId, i)) continue
    const reserve = party[i]
    if (!reserve) continue
    for (const ability of absorbing) {
      // `Random()` is drawn only when the ability matches (short-circuit `&&`):
      // one draw per matching (slot, ability) pair, a failed bit continues to
      // the next ability then the next slot (:248-260).
      if (reserve.abilities.ability === ability && (state.rng.random16() & 1)) {
        return { decided: true, chosenPartyIndex: i, unmodelled }
      }
    }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** TypeModifierInputs for GetTypeModifier, copied locally from aiSwitching.ts:66
 * (module-private there). The two battler ids are the C's own arguments to
 * GetTypeModifier, so the Miracle Eye bits come from whichever battlers it
 * actually reads -- for CalcPartyMonTypeEffectivenessMultiplier that is
 * battler 0 on both sides (:8003), NOT the AI battler or the candidate mon. */
function typeModifierInputsFor(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiDamageDeps): TypeModifierInputs {
  const clueless = deps.grounding.isCluelessOnField
  return {
    isInverseRoomActive: !clueless && hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM),
    isInverseBattleFlagSet: deps.inverseBattle,
    attackerHasMiracleEye: hasFlag(state.battlers[battlerAtk]?.statuses3 ?? 0, STATUS3_MIRACLE_EYED),
    defenderHasMiracleEye: hasFlag(state.battlers[battlerDef]?.statuses3 ?? 0, STATUS3_MIRACLE_EYED),
  }
}

/** UpdateTypeModifier, generated by MoveTypeModifierGenerator.kt from
 * moveBehaviors.json's `attack.superEffectiveVs` (a matching defType forces
 * exactly UQ_4_12(2.0)), plus EFFECT_IGNORE_TYPE_IMMUNITY's neutral restore. */
function updateTypeModifier(defType: string, effect: string | null, modifier: number, deps: AiDamageDeps): number {
  const superEffectiveVs = effect ? deps.moveBehaviors[effect]?.attack?.superEffectiveVs : undefined
  if (superEffectiveVs && superEffectiveVs !== 'TYPE_NONE') {
    return defType === superEffectiveVs.replace(/^TYPE_/, '') ? uq(2.0) : modifier
  }
  if (effect === 'EFFECT_IGNORE_TYPE_IMMUNITY') return modifier === 0 ? uq(1.0) : modifier
  return modifier
}

/** GetBattlerHoldEffect(battler, TRUE), battle_util.c:6526-6536 with
 * IsItemNegated (:6520-6524): STATUS3_EMBARGO or an unsuppressed Klutz makes the
 * item read as HOLD_EFFECT_NONE. */
function negationAwareHoldEffect(state: BattleState, battlerId: number, deps: AiDamageDeps): string | null {
  const battler = state.battlers[battlerId]
  if (!battler?.mon.itemId) return null
  if (hasFlag(battler.statuses3, STATUS3_EMBARGO)) return null
  if (battlerHasSimAbility(state, battler, 'ABILITY_KLUTZ', false, battlerId, false, deps.dataContext)) return null
  return deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null
}

/** MulByTypeEffectiveness, battle_util.c:7843-7884, for one defending type.
 *
 * CalcPartyMonTypeEffectivenessMultiplier passes 0 for BOTH battler arguments
 * (:8003), so every `battlerAtk`/`battlerDef` read here is the player's active
 * battler (state.battlers[0]) -- never the AI and never the reserve mon. */
function mulByTypeEffectiveness(state: BattleState, moveId: string, moveType: string, defType: string, deps: AiDamageDeps): number {
  // GetTypeModifier(moveType, defType, battlerAtk=0, battlerDef=0) -- :7844.
  let modifier = getTypeModifier(moveType, defType, deps.typeChart, deps.inverseTypeChart, typeModifierInputsFor(state, 0, 0, deps))
  const battler = state.battlers[0]
  const champ = deps.grounding.monotypeChampType

  // ON_ABILITY(battlerAtk, FALSE, onTypeEffectiveness) -- :7847-7851. The
  // macro FILTER_NOTs IsSuppressed (battle_util.h:269-275, battle_util.c:9254-9261),
  // so a Gastro Acid'd / Neutralizing Gas'd ability must not fire. A ported hook
  // signals "changed" by writing ctx.modifier (see dispatchCalc.ts's
  // resolveTypeEffectivenessComponent for the same inference).
  let abilityModified = false
  if (battler) {
    forEachAbility(battler.mon.abilities, (id) => isSimAbilitySuppressed(state, battler, id, false, 0, false, deps.dataContext), (impl) => {
      if (!impl.onTypeEffectiveness) return
      // attackerId/defenderId are the damage path's own labels, not sim battler
      // indices; no ported onTypeEffectiveness body reads them.
      const ctx = { attackerId: 'attacker', defenderId: 'defender', moveId, moveType, modifier, defType }
      impl.onTypeEffectiveness(ctx)
      if (ctx.modifier !== modifier) {
        modifier = ctx.modifier
        abilityModified = true
        return 'break'
      }
    })
  }

  if (!abilityModified) {
    // :7854 -- GetBattlerHoldEffect(battlerDef, TRUE), so Embargo/Klutz negate it.
    if (modifier === 0 && negationAwareHoldEffect(state, 0, deps) === 'HOLD_EFFECT_RING_TARGET') modifier = uq(1.0)
    // :7857-7858.
    else if ((moveType === 'FIGHTING' || moveType === 'NORMAL') && defType === 'GHOST' && hasFlag(battler?.statuses4 ?? 0, STATUS4_FORESIGHT) && modifier === 0)
      modifier = uq(1.0)
    // :7860-7862 -- GetBattlerSide(0) is always B_SIDE_PLAYER here (:8003).
    else if (moveType === 'FAIRY' && (defType === 'POISON' || defType === 'STEEL') && champ === 'FAIRY') modifier = uq(2.0)
    // :7863-7864.
    else if (modifier === 0 && champ === 'DRAGON') modifier = uq(1.0)
    // :7865-7869. The `side != B_SIDE_PLAYER` arm (a Rock move vs an opponent's
    // Rock mon) is unreachable from this caller because battlerDef is 0 (:8003).
    // This arm still swallows the iceStatue arm below when the champion is ROCK.
    else if (champ === 'ROCK') {
      if (defType === 'ROCK' && moveType === 'ROCK') modifier = uq(2.0)
    }
    // :7870-7871.
    else if (battler?.volatiles.iceStatue && moveType === 'ICE' && defType === 'ICE' && modifier < uq(1.0)) modifier *= 2
  }

  // :7874 -- IsBattlerGrounded(battlerDef=0), the type-inclusive check.
  if (moveType === 'GROUND' && defType === 'FLYING' && isBattlerGrounded(state, 0, deps.grounding) && modifier === 0) modifier = uq(1.0)

  // :7876.
  modifier = updateTypeModifier(defType, deps.moveData(moveId)?.effect ?? null, modifier, deps)

  // :7878.
  if (moveType === 'FIRE' && battler?.volatiles.tarShot) modifier = uq(2.0)

  // :7881-7883 -- WEATHER_STRONG_WINDS weakens super-effective Flying hits.
  if (hasFlag(state.field.weather, WEATHER_STRONG_WINDS) && weatherHasEffect(state, deps.grounding) && defType === 'FLYING' && modifier >= uq(2.0))
    modifier = uq(1.0)

  return modifier
}

/** CalcPartyMonTypeEffectivenessMultiplier, battle_util.c:7998-8019. The two
 * MulByTypeEffectiveness calls are passed battlerDef = 0 and battlerAtk = 0 (the
 * player's active battler in singles), and the party mon's own `level` is passed
 * as the FOURTH argument -- the parameter the function uses as `battlerDef` for
 * its Levitate/Mountaineer/Gifted Mind checks. Those three checks therefore read
 * gBattleMons[level] out of bounds and are NOT applied here (one note per call
 * that reaches them, per the brief). */
export function calcPartyMonTypeEffectivenessMultiplier(state: BattleState, reserve: SimPartyMon, moveId: string, deps: AiDamageDeps, unmodelled: string[]): number {
  const move = deps.moveData(moveId)
  const moveType = move?.type ?? null
  let modifier = UQ_ONE
  if (moveId !== 'MOVE_STRUGGLE' && moveType && moveType !== 'MYSTERY') {
    const type1 = reserve.types[0]
    const type2 = reserve.types[1]
    modifier = mulModifier(modifier, mulByTypeEffectiveness(state, moveId, moveType, type1, deps))
    if (type2 !== type1) modifier = mulModifier(modifier, mulByTypeEffectiveness(state, moveId, moveType, type2, deps))
    unmodelled.push(
      "CalcPartyMonTypeEffectivenessMultiplier (battle_util.c:7998) passes the mon's level as battlerDef, so its Levitate/Mountaineer/Gifted Mind checks read out-of-bounds gBattleMons[level]",
    )
    const monAbility = reserve.abilities.ability
    if (monAbility === 'ABILITY_WONDER_GUARD' && modifier <= UQ_ONE && move && move.power) modifier = 0
  }
  // UpdateMoveResultFlags(modifier) (:8018) classifies this final value. It
  // clears the other classes on every call, so a plain classification of the
  // final modifier is exactly what `gMoveResultFlags & flags` reads.
  return modifier
}

/** UpdateMoveResultFlags, battle_util.c:7899-7913, reduced to the class the
 * caller's own `flags` argument tests for. */
function moveResultFlagClass(modifier: number): 'DOESNT_AFFECT_FOE' | 'NOT_VERY_EFFECTIVE' | null {
  if (modifier === 0) return 'DOESNT_AFFECT_FOE'
  if (modifier > UQ_ONE) return null // MOVE_RESULT_SUPER_EFFECTIVE
  if (modifier < UQ_ONE) return 'NOT_VERY_EFFECTIVE'
  return null // exactly UQ_ONE clears all three classes
}

/** FindMonWithFlagsAndSuperEffective, :414-500. Finds a reserve mon whose own
 * type matchup against the last landed move has exactly the requested
 * MOVE_RESULT class, then offers each of that mon's moves via
 * AI_GetTypeEffectiveness cast by the AI's ACTIVE battler (:484) and draws
 * `Random() % moduloPercent` only when the move is super-effective. */
function findMonWithFlagsAndSuperEffective(
  state: BattleState,
  battlerId: number,
  flagKind: 'DOESNT_AFFECT_FOE' | 'NOT_VERY_EFFECTIVE',
  moduloPercent: number,
  deps: AiDamageDeps,
): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  const unmodelled: string[] = []
  if (!battler) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  // :423-430
  const moveId = battler.lastLandedMove
  if (moveId === null || moveId === MOVE_UNSET) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  if (battler.lastHitBy === BATTLER_NONE) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
  const lastMove = deps.moveData(moveId)
  if (!lastMove || lastMove.power === 0) return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }

  const party = state.sides[battlerId & 1].party
  for (let i = 0; i < 6; i++) {
    if (isInvalidReserveSlot(state, battlerId, i)) continue
    const reserve = party[i]
    if (!reserve) continue
    const modifier = calcPartyMonTypeEffectivenessMultiplier(state, reserve, moveId, deps, unmodelled)
    if (moveResultFlagClass(modifier) !== flagKind) continue

    for (const candidateMove of reserve.moves) {
      if (!candidateMove) continue
      // :484 -- AI_GetTypeEffectiveness(move, gActiveBattler, battlerIn1), where
      // battlerIn1 = gLastHitBy[gActiveBattler]: the FOE is the defender, the
      // AI's active battler the attacker, even though the move belongs to the
      // reserve mon.
      const effectiveness = aiGetTypeEffectiveness(state, candidateMove, battlerId, battler.lastHitBy, deps)
      unmodelled.push(...effectiveness.unmodelled)
      // The `% moduloPercent` draw happens only after the super-effective test
      // passes, and even moduloPercent === 1 draws it (`% 1` is always 0).
      if (effectiveness.effectiveness >= UQ_ONE * 2 && state.rng.random16() % moduloPercent === 0) {
        return { decided: true, chosenPartyIndex: i, unmodelled }
      }
    }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** ShouldSwitchIfNaturalCure, :265-299. Reached only when asleep and holding
 * one of the three Natural-Cure-family abilities. Every branch below draws
 * from `state.rng` in the C's own order. */
function shouldSwitchIfNaturalCure(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  if (!hasFlag(battler.mon.status1, STATUS1_SLEEP)) return NOT_DECIDED
  const hasNaturalCure = selfAbility(state, deps, battler, 'ABILITY_NATURAL_CURE')
  const hasSelfRepair = selfAbility(state, deps, battler, 'ABILITY_SELF_REPAIR')
  const hasNaturalRecovery = selfAbility(state, deps, battler, 'ABILITY_NATURAL_RECOVERY')
  if (!hasNaturalCure && !hasSelfRepair && !hasNaturalRecovery) return NOT_DECIDED

  const unmodelled: string[] = []
  const lastMoveId = battler.lastLandedMove

  // :275 -- `(gLastLandedMoves == 0 || == 0xFFFF) && Random() & 1`. The draw
  // is short-circuited away when a real move has landed.
  if ((lastMoveId === null || lastMoveId === MOVE_UNSET) && (state.rng.random16() & 1)) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }

  // :280 -- `else if (gBattleMoves[gLastLandedMoves].power == 0 && Random() & 1)`.
  // `null` is the C's 0, i.e. gBattleMoves[MOVE_NONE] (power 0). MOVE_UNSET
  // indexes gBattleMoves[0xFFFF], an out-of-bounds read: treated as power 0
  // with the draw taken, the conservative reading (it is what MOVE_NONE does,
  // and the C does evaluate the second operand when the first draw fails).
  let lastMovePower: number
  if (lastMoveId === null) {
    lastMovePower = 0
  } else if (lastMoveId === MOVE_UNSET) {
    lastMovePower = 0
    unmodelled.push(
      'ShouldSwitchIfNaturalCure (battle_ai_switch_items.c:280): gBattleMoves[0xFFFF] (MOVE_UNSET) is an out-of-bounds read in the C; treated as power 0 and the Random() & 1 draw is taken, the conservative reading',
    )
  } else {
    lastMovePower = deps.moveData(lastMoveId)?.power ?? 0
  }
  if (lastMovePower === 0 && (state.rng.random16() & 1)) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }

  const flagCheck1 = findMonWithFlagsAndSuperEffective(state, battlerId, 'DOESNT_AFFECT_FOE', 1, deps)
  unmodelled.push(...flagCheck1.unmodelled)
  if (flagCheck1.decided) return { decided: true, chosenPartyIndex: flagCheck1.chosenPartyIndex, unmodelled }
  const flagCheck2 = findMonWithFlagsAndSuperEffective(state, battlerId, 'NOT_VERY_EFFECTIVE', 1, deps)
  unmodelled.push(...flagCheck2.unmodelled)
  if (flagCheck2.decided) return { decided: true, chosenPartyIndex: flagCheck2.chosenPartyIndex, unmodelled }

  // :293 -- the final unconditional `Random() & 1`.
  if (state.rng.random16() & 1) {
    return { decided: true, chosenPartyIndex: PARTY_SIZE, unmodelled }
  }
  return { decided: false, chosenPartyIndex: PARTY_SIZE, unmodelled }
}

/** ShouldSwitchIfEncored, :300-317. Reached only while Encored. */
function shouldSwitchIfEncored(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  if (battler.volatiles.encoredMove === null) return NOT_DECIDED

  const unmodelled: string[] = []
  const flagCheck1 = findMonWithFlagsAndSuperEffective(state, battlerId, 'DOESNT_AFFECT_FOE', 1, deps)
  unmodelled.push(...flagCheck1.unmodelled)
  if (flagCheck1.decided) return { decided: true, chosenPartyIndex: flagCheck1.chosenPartyIndex, unmodelled }
  const flagCheck2 = findMonWithFlagsAndSuperEffective(state, battlerId, 'NOT_VERY_EFFECTIVE', 1, deps)
  unmodelled.push(...flagCheck2.unmodelled)
  if (flagCheck2.decided) return { decided: true, chosenPartyIndex: flagCheck2.chosenPartyIndex, unmodelled }

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
  if (!selfAbility(state, deps, opposing, 'ABILITY_WONDER_GUARD')) return NOT_DECIDED

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
function areAttackingStatsLowered(state: BattleState, battlerId: number, deps: AiDamageDeps): SwitchHelperResult {
  const battler = state.battlers[battlerId]
  if (!battler) return NOT_DECIDED
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spatkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const atk = battler.mon.rawStats.atk
  const spatk = battler.mon.rawStats.spatk

  if (atkStage > DEFAULT_STAT_STAGE - 2 && atk >= spatk) return NOT_DECIDED
  if (spatkStage > DEFAULT_STAT_STAGE - 2 && spatk >= atk) return NOT_DECIDED

  const unmodelled: string[] = []
  const flagCheck1 = findMonWithFlagsAndSuperEffective(state, battlerId, 'DOESNT_AFFECT_FOE', 1, deps)
  unmodelled.push(...flagCheck1.unmodelled)
  if (flagCheck1.decided) return { decided: true, chosenPartyIndex: flagCheck1.chosenPartyIndex, unmodelled }
  const flagCheck2 = findMonWithFlagsAndSuperEffective(state, battlerId, 'NOT_VERY_EFFECTIVE', 1, deps)
  unmodelled.push(...flagCheck2.unmodelled)
  if (flagCheck2.decided) return { decided: true, chosenPartyIndex: flagCheck2.chosenPartyIndex, unmodelled }
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
  // battle_ai_switch_items.c:507 reads GetBattlerAbility (abilities[0] only, no IsSuppressed): innates don't count.
  if (battler.mon.abilities.ability === 'ABILITY_REGENERATOR') {
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
  const escapeCheck = isAbilityPreventingEscape(state, battlerId, deps)
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

  if (decide(shouldSwitchIfAllBadMoves(state, battlerId))) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfPerishSong(state, battlerId))) return { shouldSwitch: true, unmodelled }
  if (decide(findMonThatAbsorbsOpponentsMove(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }
  if (!isMonHealthyEnoughToSwitch(state, battlerId)) return { shouldSwitch: false, unmodelled }
  if (decide(shouldSwitchIfEncored(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfWonderGuard(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }
  if (decide(shouldSwitchIfNaturalCure(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }

  const seResult = hasSuperEffectiveMoveAgainstOpponents(state, battlerId, false, deps)
  unmodelled.push(...seResult.unmodelled)
  if (seResult.result) return { shouldSwitch: false, unmodelled }

  if (areStatsRaised(state, battlerId)) return { shouldSwitch: false, unmodelled }
  if (decide(areAttackingStatsLowered(state, battlerId, deps))) return { shouldSwitch: true, unmodelled }

  // :692-693 -- `if (FindMonWithFlagsAndSuperEffective(DOESNT_AFFECT_FOE, 2)
  // || FindMonWithFlagsAndSuperEffective(NOT_VERY_EFFECTIVE, 3)) return TRUE;`
  // `decide` carries the chosen party slot through and short-circuits the
  // second call exactly like the C's `||`.
  if (decide(findMonWithFlagsAndSuperEffective(state, battlerId, 'DOESNT_AFFECT_FOE', 2, deps))) return { shouldSwitch: true, unmodelled }
  if (decide(findMonWithFlagsAndSuperEffective(state, battlerId, 'NOT_VERY_EFFECTIVE', 3, deps))) return { shouldSwitch: true, unmodelled }
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
  // :1089 (BATTLE_TYPE_INGAME_PARTNER at PLAYER_RIGHT) is doubles-only, never an
  // opponent in singles. :1092 returns before AiExpectsToFaintPlayer, so an
  // Embargoed AI draws none of its speed-tie RNG.
  if (hasFlag(state.battlers[battlerId]?.statuses3 ?? 0, STATUS3_EMBARGO)) return { usedItem: false, unmodelled: [] }
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
