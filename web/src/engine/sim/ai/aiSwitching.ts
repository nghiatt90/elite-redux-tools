// GetMostSuitableMonToSwitchInto, src/battle_ai_switch_items.c:969-1043, plus
// its four sub-steps (GetBestMonBatonPass :768-797, GetBestMonDefensive
// :799-874, GetBestMonOffensive :876-936, GetBestMonDmg :938-966) and its
// caller's own PARTY_SIZE fallback (OpponentHandleChoosePokemon,
// battle_controller_opponent.c:1643-1693). Singles and BATTLE_TYPE_DOUBLE
// (:986-999, the battlerIn1/battlerIn2 pair and the opposing battler's
// absent-bit flip). The multi-battler formats -- TWO_OPPONENTS / INGAME_PARTNER
// / TOWER_LINK_MULTI -- add no code of their own here: BATTLE_TYPE_DOUBLE is
// always set alongside them (driver/battleFormat.ts:68-80), so the
// doubles pair logic above applies unchanged; only the party range changes,
// through GetAIPartyIndexes below.
//
// GetAIPartyIndexes (:30-47) is ported as its own function. Its `else` branch
// (firstId=0, lastId=6) covers singles and plain doubles; the
// TWO_OPPONENTS/INGAME_PARTNER/TOWER_LINK_MULTI branch splits BOTH sides by
// flank -- `battlerId & BIT_FLANK` -- into [0,3) / [3,6), which is NOT what
// partySlots.ts's `partySlotsFor` does (that one is HasNoMonsToSwitch and only
// splits the opponent side). Its first branch, BATTLE_TWO_VS_ONE_OPPONENT,
// cannot fire in this sim: see the function's own comment.
//
// WIRING NOTE: `chooseReplacement` (switchIn.ts's `ReplacementDeps`) takes an
// `unmodelled: string[]` output parameter -- the SAME array
// `applyEndOfTurnReplacements` already threads for the switch's own
// ability/item gaps. `createAiOpponentReplacement` below pushes every gap
// this module's own functions collect while REACHING the decision (a Truant
// `WhoStrikesFirst` approximation, a bridge gap from an
// `AI_GetTypeEffectiveness` call, ...) into that same array, so a caller
// inspecting `executeTurn`'s `replacementUnmodelled` sees the whole decision,
// not just the switch that followed it.
//
// `createAiOpponentReplacement` does NOT read `aiMonToSwitchIntoId`
// (`BattlerState.aiMonToSwitchIntoId`, `gBattleStruct->AI_monToSwitchIntoId`).
// `OpponentHandleChoosePokemon` (battle_controller_opponent.c:1652) consumes
// that field FIRST, before ever calling `GetMostSuitableMonToSwitchInto`, when
// it isn't `PARTY_SIZE` (a switch already decided by an earlier AI step, e.g.
// a mid-turn `ShouldSwitch`/`ShouldPivot` choice, carried into the
// end-of-turn replacement). Nothing in this sim writes that field yet --
// `create.ts` only ever sets it to the `PARTY_SIZE` sentinel -- so skipping
// it here is currently a no-op, not a missing branch. It stops being a no-op,
// and this port must start reading it, the moment a future `ShouldPivot`-style
// batch gives it a real writer.

import type { BattleState, SimPartyMon } from '../state'
import { hasFlag, BIT_FLANK, BIT_SIDE, B_SIDE_OPPONENT, PARTY_SIZE, STATUS3_MIRACLE_EYED, STATUS_FIELD_INVERSE_ROOM } from '../constants'
import { getTypeModifier, type TypeModifierInputs } from '../../typeEffectiveness'
import { UQ_ONE } from '../../fixed'
import { getWhoStrikesFirst } from '../turnOrder'
import type { ReplacementDeps } from '../switchIn'
import { aiCalcPartyMonDamage, aiGetTypeEffectiveness, type AiDamageDeps } from './aiCalcDamage'
import { isDoubleBattle } from './aiCheckBadMove'

export type AiSwitchingDeps = AiDamageDeps

/** include/constants/battle.h:64, 71, 72 -- the multi-battler formats whose
 * GetAIPartyIndexes branch (:36-42) splits each side's party by flank. DOUBLE
 * alone is not in this mask. */
const BATTLE_TYPE_TWO_OPPONENTS = 1 << 15
const BATTLE_TYPE_INGAME_PARTNER = 1 << 22
const BATTLE_TYPE_TOWER_LINK_MULTI = 1 << 23
/** include/constants/battle.h:67. Never actually set by anything this tool
 * builds (Battle Arena is not one of the 40 fights), ported anyway per the
 * brief's explicit instruction to include this early return. */
const BATTLE_TYPE_ARENA = 1 << 18

/**
 * GetAIPartyIndexes, battle_ai_switch_items.c:30-47.
 *
 * `BATTLE_TWO_VS_ONE_OPPONENT` (include/constants/battle.h:87) is
 * `(gBattleTypeFlags & BATTLE_TYPE_INGAME_PARTNER) && gTrainerBattleOpponent_B
 * == 0xFFFF`. The sim has no `gTrainerBattleOpponent_B`, and
 * `battleTypeFlagsFor` (driver/battleFormat.ts:68-80) always sets
 * BATTLE_TYPE_TWO_OPPONENTS together with BATTLE_TYPE_INGAME_PARTNER for a
 * partner format, so "ingame partner without a second opponent" is not a state
 * this sim can build. The branch is ported as `INGAME_PARTNER &&
 * !TWO_OPPONENTS` and is therefore unreachable today.
 *
 * The second branch tests `battlerId & BIT_FLANK`, not the side, so it splits
 * BOTH sides: battlers 0 and 1 (B_FLANK_LEFT, the bit clear) get [0,3), 2 and
 * 3 get [3,6). B_FLANK_LEFT is 0 (include/constants/battle.h:42).
 */
export function getAiPartyIndexes(state: BattleState, battlerId: number): [number, number] {
  const flags = state.battleTypeFlags
  // :32-35 -- unreachable in this sim (see above).
  const twoVsOne = (flags & BATTLE_TYPE_INGAME_PARTNER) !== 0 && (flags & BATTLE_TYPE_TWO_OPPONENTS) === 0
  if (twoVsOne && (battlerId & BIT_SIDE) === B_SIDE_OPPONENT) return [0, PARTY_SIZE]
  // :36-42.
  if ((flags & (BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_INGAME_PARTNER | BATTLE_TYPE_TOWER_LINK_MULTI)) !== 0) {
    return (battlerId & BIT_FLANK) === 0 ? [0, 3] : [3, PARTY_SIZE]
  }
  // :43-46.
  return [0, PARTY_SIZE]
}

/** GetTypeModifier's own toggle inputs (typeEffectiveness.ts's
 * TypeModifierInputs), built exactly the way GetTypeModifier(atkType, defType,
 * battlerAtk, battlerDef) derives them from the two battler ids it's given --
 * battle_util.c:8021-8038, and bridge.ts's own IsInverseRoomActive/Clueless
 * precedent for the Inverse Room suppression. */
function typeModifierInputsFor(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiSwitchingDeps): TypeModifierInputs {
  const clueless = deps.grounding.isCluelessOnField
  return {
    isInverseRoomActive: !clueless && hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM),
    isInverseBattleFlagSet: deps.inverseBattle,
    attackerHasMiracleEye: hasFlag(state.battlers[battlerAtk]?.statuses3 ?? 0, STATUS3_MIRACLE_EYED),
    defenderHasMiracleEye: hasFlag(state.battlers[battlerDef]?.statuses3 ?? 0, STATUS3_MIRACLE_EYED),
  }
}

/** u32 typeDmg *= (u16) modifier, replicated bit-for-bit: `Math.imul` performs
 * the 32-bit multiplication and `>>> 0` re-reads the result as unsigned,
 * matching the C's own `u32` storage. Applied after EACH multiplication (the
 * C reassigns the running `u32 typeDmg` at every `*=`, not once at the end),
 * which is what makes the wraparound reachable at all -- see this module's
 * own test for a case where it changes the chosen mon. */
function wrapMul(a: number, b: number): number {
  return Math.imul(a, b) >>> 0
}

/**
 * IsTruantMonVulnerable, battle_ai_util.c:587-596. Reads the OPPOSING
 * battler's own current moves (not its party record) -- a Truant mon should
 * not switch in against a foe that can just Protect/Endure through the
 * free turn, or a foe about to strike first with a semi-invulnerable move
 * (Fly/Dig/...) that would otherwise dodge the free turn's own attack.
 */
function isTruantMonVulnerable(state: BattleState, aiBattlerId: number, opposingBattlerId: number, deps: AiSwitchingDeps): boolean {
  const opponent = state.battlers[opposingBattlerId]
  if (!opponent) return false
  for (const moveId of opponent.mon.moves) {
    if (!moveId) continue
    const move = deps.dataContext.move(moveId)
    if (!move) continue
    if (move.effect === 'EFFECT_PROTECT' && moveId !== 'MOVE_ENDURE') return true
    if (move.effect === 'EFFECT_SEMI_INVULNERABLE') {
      const strikesFirst = getWhoStrikesFirst(state, aiBattlerId, opposingBattlerId, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios)
      if (strikesFirst === 1) return true
    }
  }
  return false
}

/**
 * GetBestMonBatonPass, battle_ai_switch_items.c:768-797. Two RNG draws in the
 * C's own order: `Random() % 3` (only when `aliveCount > 2`; the
 * `aliveCount === 2` path skips straight to the rejection loop), then the
 * rejection loop's own `Random() % (lastId - firstId)` draws, one per
 * rejected candidate plus the one that lands on a Baton Pass slot.
 */
function getBestMonBatonPass(party: SimPartyMon[], firstId: number, lastId: number, invalidMons: number, aliveCount: number, state: BattleState): number {
  let bits = 0
  for (let i = firstId; i < lastId; i++) {
    if (invalidMons & (1 << i)) continue
    if (party[i]?.moves.includes('MOVE_BATON_PASS')) bits |= 1 << i
  }

  const rollsIt = aliveCount === 2 || (aliveCount > 2 && state.rng.random16() % 3 === 0)
  if (rollsIt && bits) {
    let i: number
    do {
      i = (state.rng.random16() % (lastId - firstId)) + firstId
    } while (!(bits & (1 << i)))
    return i
  }
  return PARTY_SIZE
}

/** GetBestMonDefensive, battle_ai_switch_items.c:799-874 -- entirely commented
 * out in the C ("This was changed at some point and does nothing"). Ported as
 * exactly that: a permanent no-op returning PARTY_SIZE. */
function getBestMonDefensive(): number {
  return PARTY_SIZE
}

/**
 * GetBestMonOffensive, battle_ai_switch_items.c:876-936. The type-damage
 * product is UQ_4_12 arithmetic left UNNORMALIZED (no `>> 10` after each
 * multiply, unlike `mulModifier`) in a `u32` -- see `wrapMul`'s own doc. The
 * super-effective move check calls AI_GetTypeEffectiveness with `aiBattlerId`
 * (the FAINTED active battler) as the attacker, not the candidate party mon
 * -- `AI_GetTypeEffectiveness(move, gActiveBattler, opposingBattler)` in the
 * C, :920 -- a real quirk, kept rather than "corrected".
 */
function getBestMonOffensive(
  state: BattleState,
  party: SimPartyMon[],
  firstId: number,
  lastId: number,
  invalidMons: number,
  aiBattlerId: number,
  opposingBattlerId: number,
  deps: AiSwitchingDeps,
): { bestMonId: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const opposingMon = state.battlers[opposingBattlerId]?.mon
  if (!opposingMon) return { bestMonId: PARTY_SIZE, unmodelled }
  const defType1 = opposingMon.types[0]
  const defType2 = opposingMon.types[1]
  const inputs = typeModifierInputsFor(state, aiBattlerId, opposingBattlerId, deps)

  let bits = 0
  while (bits !== 0x3f) {
    let bestDmg = 0
    let bestMonId = PARTY_SIZE
    for (let i = firstId; i < lastId; i++) {
      if (invalidMons & (1 << i)) continue
      if (bits & (1 << i)) continue
      const mon = party[i]
      if (!mon || mon.speciesId === null) continue

      const atkType1 = mon.types[0]
      const atkType2 = mon.types[1]
      let typeDmg = UQ_ONE
      typeDmg = wrapMul(typeDmg, getTypeModifier(atkType1, defType1, deps.typeChart, deps.inverseTypeChart, inputs))
      if (atkType2 !== atkType1) typeDmg = wrapMul(typeDmg, getTypeModifier(atkType2, defType1, deps.typeChart, deps.inverseTypeChart, inputs))
      if (defType2 !== defType1) {
        typeDmg = wrapMul(typeDmg, getTypeModifier(atkType1, defType2, deps.typeChart, deps.inverseTypeChart, inputs))
        if (atkType2 !== atkType1) typeDmg = wrapMul(typeDmg, getTypeModifier(atkType2, defType2, deps.typeChart, deps.inverseTypeChart, inputs))
      }

      if (bestDmg < typeDmg) {
        bestDmg = typeDmg
        bestMonId = i
      }
    }

    if (bestMonId !== PARTY_SIZE) {
      let hasSuperEffectiveMove = false
      for (const moveId of party[bestMonId]!.moves) {
        if (!moveId) continue
        const { effectiveness, unmodelled: u } = aiGetTypeEffectiveness(state, moveId, aiBattlerId, opposingBattlerId, deps)
        unmodelled.push(...u)
        if (effectiveness >= UQ_ONE * 2) {
          hasSuperEffectiveMove = true
          break
        }
      }
      if (hasSuperEffectiveMove) return { bestMonId, unmodelled }
      bits |= 1 << bestMonId
    } else {
      bits = 0x3f
    }
  }

  return { bestMonId: PARTY_SIZE, unmodelled }
}

/** GetBestMonDmg, battle_ai_switch_items.c:938-966. */
function getBestMonDmg(
  state: BattleState,
  party: SimPartyMon[],
  firstId: number,
  lastId: number,
  invalidMons: number,
  aiBattlerId: number,
  opposingBattlerId: number,
  deps: AiSwitchingDeps,
): { bestMonId: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  let bestDmg = 0
  let bestMonId = PARTY_SIZE
  for (let i = firstId; i < lastId; i++) {
    if (invalidMons & (1 << i)) continue
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    for (const moveId of mon.moves) {
      if (!moveId) continue
      const move = deps.moveData(moveId)
      if (!move || !move.power) continue
      const { dmg, unmodelled: u } = aiCalcPartyMonDamage(state, moveId, aiBattlerId, opposingBattlerId, mon, deps)
      unmodelled.push(...u)
      if (bestDmg < dmg) {
        bestDmg = dmg
        bestMonId = i
      }
    }
  }
  return { bestMonId, unmodelled }
}

/**
 * GetMostSuitableMonToSwitchInto, battle_ai_switch_items.c:969-1043.
 * Precedence: the pre-set `monToSwitchIntoId` short-circuit, then Battle
 * Arena's own `+1` rule, then Baton Pass, then (a permanent no-op) Defensive,
 * then Offensive, then Dmg, then PARTY_SIZE.
 *
 * Singles and plain doubles use the battlerIn1/battlerIn2 pair below (:986-999).
 * The multi-battler formats (TWO_OPPONENTS / INGAME_PARTNER / TOWER_LINK_MULTI)
 * have BATTLE_TYPE_DOUBLE set too, so that pair logic applies unchanged; the
 * only difference is the party range from GetAIPartyIndexes (:1004).
 */
export function getMostSuitableMonToSwitchInto(state: BattleState, aiBattlerId: number, deps: AiSwitchingDeps): { partyIndex: number; unmodelled: string[] } {
  const battler = state.battlers[aiBattlerId]
  if (!battler) throw new Error(`getMostSuitableMonToSwitchInto: no battler at id ${aiBattlerId}`)

  const unmodelled: string[] = []
  if (battler.monToSwitchIntoId !== PARTY_SIZE) return { partyIndex: battler.monToSwitchIntoId, unmodelled }
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) return { partyIndex: battler.partyIndex + 1, unmodelled }

  // :986-999. In doubles battlerIn1 is the AI itself and battlerIn2 is the
  // flank partner, UNLESS that partner's bit is set in gAbsentBattlerFlags (or
  // there is no partner battler slot to read), in which case battlerIn2
  // collapses back onto the AI. The opposing battler is BATTLE_OPPOSITE then,
  // if ITS absent bit is set, flipped onto the other player-side battler.
  const double = isDoubleBattle(state)
  const partnerId = double ? aiBattlerId ^ BIT_FLANK : aiBattlerId
  const partnerBattler = state.battlers[partnerId]
  const partner = double && (hasFlag(state.absentBattlerFlags, 1 << partnerId) || !partnerBattler) ? battler : (partnerBattler ?? battler)
  let opposingBattlerId = aiBattlerId ^ 1
  if (double && hasFlag(state.absentBattlerFlags, 1 << opposingBattlerId)) opposingBattlerId ^= BIT_FLANK

  const side = aiBattlerId & 1
  const party = state.sides[side].party
  // :1004 -- GetAIPartyIndexes(gActiveBattler, &firstId, &lastId). Multi
  // formats narrow this to the battler's own flank half ([0,3) or [3,6)).
  const [firstId, lastId] = getAiPartyIndexes(state, aiBattlerId)

  let invalidMons = 0
  let aliveCount = 0
  for (let i = firstId; i < lastId; i++) {
    const mon = party[i]
    const isTruant = mon?.abilities.ability === 'ABILITY_TRUANT' // GetMonAbility (pokemon.c:2159) reads the CHOSEN ability slot only, :1020; a party mon, so no IsSuppressed.
    const invalid =
      !mon ||
      mon.speciesId === null ||
      mon.hp === 0 ||
      i === battler.partyIndex ||
      i === partner.partyIndex ||
      i === battler.monToSwitchIntoId ||
      i === partner.monToSwitchIntoId ||
      (isTruant && isTruantMonVulnerable(state, aiBattlerId, opposingBattlerId, deps))
    if (invalid) invalidMons |= 1 << i
    else aliveCount++
  }

  const batonPass = getBestMonBatonPass(party, firstId, lastId, invalidMons, aliveCount, state)
  if (batonPass !== PARTY_SIZE) return { partyIndex: batonPass, unmodelled }

  const defensive = getBestMonDefensive()
  if (defensive !== PARTY_SIZE) return { partyIndex: defensive, unmodelled }

  const offensive = getBestMonOffensive(state, party, firstId, lastId, invalidMons, aiBattlerId, opposingBattlerId, deps)
  unmodelled.push(...offensive.unmodelled)
  if (offensive.bestMonId !== PARTY_SIZE) return { partyIndex: offensive.bestMonId, unmodelled }

  const dmgResult = getBestMonDmg(state, party, firstId, lastId, invalidMons, aiBattlerId, opposingBattlerId, deps)
  unmodelled.push(...dmgResult.unmodelled)
  if (dmgResult.bestMonId !== PARTY_SIZE) return { partyIndex: dmgResult.bestMonId, unmodelled }

  return { partyIndex: PARTY_SIZE, unmodelled }
}

/**
 * OpponentHandleChoosePokemon, battle_controller_opponent.c:1652-1680 -- the
 * caller's own PARTY_SIZE fallback: the first party slot in GetAIPartyIndexes'
 * range (:1670) whose HP is non-zero and that is neither battler 1's nor
 * battler 3's active slot (:1672-1674). In singles both `battler1` and
 * `battler2` are B_POSITION_OPPONENT_LEFT = 1 (:1655-1659), so the second test
 * is the first. The C does NOT test for an empty species or for
 * Truant/monToSwitchIntoId (that filtering belongs to
 * GetMostSuitableMonToSwitchInto's own invalid-slot pass, already tried and
 * exhausted by the time this runs).
 *
 * When nothing qualifies the C's loop falls out at `lastId`, NOT PARTY_SIZE
 * (:1670-1678), and that value is what it writes into `monToSwitchIntoId`
 * (:1683). Mirrored exactly: `lastId` is 6 (= PARTY_SIZE) in singles, but 3 or
 * 6 in the multi formats, so this can return a value that is not a live slot.
 * See REPORT.md for what the sim's caller does with it.
 */
function fallbackFirstLiveSlot(state: BattleState, battlerId: number): number {
  const party = state.sides[battlerId & 1].party
  const battler1 = state.battlers[1]?.partyIndex ?? -1
  const battler2 = isDoubleBattle(state) ? (state.battlers[3]?.partyIndex ?? -1) : battler1
  const [firstId, lastId] = getAiPartyIndexes(state, battlerId)
  let chosenMonId = firstId
  for (; chosenMonId < lastId; chosenMonId++) {
    const mon = party[chosenMonId]
    if (mon && mon.hp !== 0 && chosenMonId !== battler1 && chosenMonId !== battler2) break
  }
  return chosenMonId
}

/**
 * Builds a `ReplacementDeps.chooseReplacement` for the OPPONENT side only,
 * running this module's port end to end (GetMostSuitableMonToSwitchInto, then
 * OpponentHandleChoosePokemon's own fallback). The PLAYER side is intentionally
 * left uncovered -- switching.ts's own brief: player choice is solver input,
 * not something this batch decides. Throws if asked to choose for a player
 * battler (even id), so a caller cannot silently get an opponent-shaped
 * decision on the wrong side.
 *
 * See this module's header for the one thing this wiring cannot carry: the
 * decision's own unmodelled notes (ReplacementDeps has no gap channel).
 */
export function createAiOpponentReplacement(deps: AiSwitchingDeps): ReplacementDeps {
  return {
    chooseReplacement(state: BattleState, battlerId: number, unmodelled: string[]): number {
      if ((battlerId & 1) !== 1) {
        throw new Error(`createAiOpponentReplacement: battler ${battlerId} is not on the opponent side`)
      }
      const battler = state.battlers[battlerId]
      if (!battler) throw new Error(`createAiOpponentReplacement: no battler at id ${battlerId}`)
      const result = getMostSuitableMonToSwitchInto(state, battlerId, deps)
      unmodelled.push(...result.unmodelled)
      if (result.partyIndex !== PARTY_SIZE) return result.partyIndex
      return fallbackFirstLiveSlot(state, battlerId)
    },
  }
}
