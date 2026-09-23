// AtkCanceller_UnableToUseMove, battle_util.c:3199-3567 -- the ladder
// Cmd_attackcanceler (battle_script_commands.c:1046-1081, the call at :1081)
// runs before every move, and which can stop the move outright. Script order
// confirmed from BattleScript_EffectHit (data/battle_scripts_1.s:216-219):
// attackcanceler -> accuracycheck -> attackstring -> ppreduce, and a cancelled
// action's own script (e.g. BattleScript_MoveUsedIsAsleep, :8594-8598) `goto`s
// straight to BattleScript_MoveEnd -- none of those three run for a cancelled
// move. Verified by reading BattleScript_MoveUsedIsAsleep/-IsFrozen/
// -IsParalyzed/-Flinched, all of which `goto BattleScript_MoveEnd` with no
// intervening ppreduce.
//
// THE LOOP-EXIT RULE, easy to miss from the C: AtkCanceller_UnableToUseMove is
// a do-while over the enum below (gBattleStruct->atkCancellerTracker), and the
// loop exits the INSTANT any case sets its local `effect` nonzero -- not only
// on a hard cancel (effect=1), but also on a "resolved, not cancelled" event
// like waking from sleep or a confusion-wore-off (effect=3) or thawing
// (effect=2). An action that wakes up this turn therefore skips every LATER
// enum entry (paralysis, confusion, ...) for that same call. This port is a
// straight-line function that returns at the first branch that produces ANY
// outcome, cancelling or not, to match that exactly.
//
// Enum order (battle_util.c:3164-3187), and what this batch does with each:
//
//   CANCELLER_FLAGS       Ported -- unconditional, no RNG, never stops the ladder.
//   CANCELLER_ASLEEP      Ported.
//   CANCELLER_FROZEN      Ported.
//   CANCELLER_TRUANT      Ported -- volatiles.abilityState is real per-battler
//                          state (state.ts's own doc names it GetAbilityState's
//                          backing store); nothing else in the sim writes it,
//                          same as sleep/paralysis/confusion being externally
//                          settable statuses a caller can construct directly.
//   CANCELLER_RECHARGE    Unreachable -- STATUS2_RECHARGE's only writer in the
//                          whole C tree is MOVE_EFFECT_RECHARGE
//                          (battle_script_commands.c:2815), a move-effect Cmd
//                          this sim does not run; grepped, no writer exists
//                          anywhere in web/src/engine/sim either.
//   CANCELLER_FLINCH      Ported.
//   CANCELLER_DISABLED    Unreachable -- volatiles.disabledMove has no writer
//                          in web/src/engine/sim (Disable's own move effect is
//                          not ported).
//   CANCELLER_GRAVITY     Unreachable -- field.statuses' GRAVITY bit has no
//                          production writer in web/src/engine/sim; grounding.ts
//                          and turn.test.ts only READ it (the latter to test
//                          grounding, not this canceller), and the Gravity move
//                          effect itself is not ported. Same "nothing in this
//                          loop ever sets it" treatment turn.ts's header already
//                          gives RoundState.protectMove.
//   CANCELLER_HEAL_BLOCKED Unreachable -- volatiles.healBlockTimer has no writer.
//   CANCELLER_TAUNTED     Unreachable -- volatiles.tauntTimer has no writer.
//   CANCELLER_IMPRISONED  Unreachable -- statuses3's IMPRISONED_OTHERS bit has
//                          no writer.
//   CANCELLER_PARALYSED   Ported. Hell mode's disableParalysisCancel clause
//                          (isHellMode() && side !== B_SIDE_PLAYER, :3402) is
//                          not modelled -- Hell mode is out of scope (CLAUDE.md,
//                          plan decision 2) -- so it is always false here and
//                          every paralysis draw applies to both sides equally.
//   CANCELLER_BIDE        Unreachable -- status2's BIDE counter has no writer.
//   CANCELLER_THAW        Ported.
//   CANCELLER_POWDER_MOVE Gapped at runtime, only when the move is powderAffected
//                          and the target differs from the attacker (the C's own
//                          entry condition, :3455-3458) -- IsPowderImmune's own
//                          chain (Mycelium Might, Grass typing, Safety Goggles,
//                          the powderImmune/pollinateImmunities ability flags,
//                          battle_util.c:3190-3196) is not evaluated, so a genuinely
//                          immune target is not detected and this port always lets
//                          the move through.
//   CANCELLER_POWDER_STATUS Gapped at runtime, only when the attacker's own
//                          status2 carries STATUS2_POWDER and the move's type is
//                          Fire (the C's own entry condition, :3469-3473) -- the
//                          self-damage (maxHP/4, Magic-Guard-gated, :3474) is not
//                          applied, and BattleScript_MoveUsedPowder's OWN ppreduce
//                          (data/battle_scripts_1.s:8771-8778 -- unlike every
//                          other cancel script here, which goes straight to
//                          BattleScript_MoveEnd, this one deducts PP itself) is
//                          not modelled either.
//   CANCELLER_THROAT_CHOP Unreachable -- volatiles.throatChopTimer has no writer.
//   CANCELLER_SKY_DROP    Unreachable -- volatiles.skyDropped has no writer.
//   CANCELLER_QUICK_GUARD Unreachable -- side.timers.quickGuardTimer has no writer.
//   CANCELLER_PSYCHIC_TERRAIN Unreachable -- field.statuses' PSYCHIC_TERRAIN bit
//                          has no writer.
//   CANCELLER_CONFUSED    Ported, except the self-hit's own damage (see below).
//                          NOTE: this case's C SOURCE TEXT appears earlier in the
//                          file than CANCELLER_PARALYSED/THAW/POWDER_*, but its
//                          ENUM value (20) places it near the very end of the
//                          ladder; ported in ENUM order, not source order.
//   CANCELLER_MULTIHIT_MOVES Ported (fix cycle 6). Never stops the ladder in
//                          the C either -- no case in GetMultihitType's own
//                          switch (:3568-3605) or the CANCELLER_MULTIHIT_MOVES
//                          switch (:3491-3541) sets `effect`, only
//                          gTurnStructs.multiHitCounter. Draws RNG from
//                          state.rng for MULTIHIT_FOUR_OR_FIVE (one draw,
//                          :3516) and MULTIHIT_TWO_TO_FIVE (two draws, :3520)
//                          -- every other MultihitType is a fixed count with
//                          no draw at all. GetMultihitType's `hitCountOverride`
//                          check (:3569-3575) is GAPPED, only when the move is
//                          one of the six moves.json/er-config's own MoveList
//                          textproto (pinned SHA) actually sets it on
//                          (MOVE_TWINEEDLE, MOVE_CROSS_POISON,
//                          MOVE_DOUBLE_IRON_BASH, MOVE_DOUBLE_SHOCK,
//                          MOVE_RAPID_RIVER: hit_count=2; MOVE_CHILLER:
//                          hit_count=3) -- the field exists in the C
//                          (pokemon.h:290) and in the source proto
//                          (MoveList.proto:135 hit_count) but nothing in the
//                          pipeline emits it into moves.json/SimMoveData, and
//                          none of these six moves' own effects
//                          (EFFECT_POISON_HIT/FLINCH_HIT/BURN_UP/DRENCH_HIT/
//                          FROSTBITE_HIT) is one GetMultihitType's effect
//                          switch recognises either, so without the override
//                          this port sees them as MULTIHIT_SINGLE. Both of the
//                          override's own values (2, 3) are fixed counts with
//                          NO Random() call, so this gap costs multiHitCounter
//                          fidelity for exactly these six moves, never an RNG
//                          draw. EFFECT_DOUBLE_HIT's own `argument == 3` check
//                          (:3589) is ported for real via SimMoveData's new
//                          `argumentInt` (moves.json already carries it; see
//                          dataContext.ts) -- also a fixed count either way,
//                          no draw. MULTIHIT_BEAT_UP (:3523-3538) is ported
//                          for real from `state.sides[...].party`: HP,
//                          species-presence and status are all real
//                          SimPartyMon fields; the C's egg check
//                          (MON_DATA_IS_EGG) is always false here, matching
//                          state.ts's SimPartyMon doc ("Eggs cannot occur in
//                          the 40 fights and are not modelled"), not a
//                          per-call gap. PREPARE_BYTE_NUMBER_BUFFER (:3540) is
//                          a UI-only display-string prep with no gameplay
//                          effect, same "nothing to be wrong about" precedent
//                          as turn.ts's deductPp transformed/mimicked-move
//                          branch -- not modelled, not a gap.
//
// Every RNG draw below is state.rng.random16(), in this exact order, matching
// the C's Random() call sites cited on each branch.

import type { BattleState, BattlerState } from './state'
import type { SimMoveData } from './dataContext'
import type { AbilitySlots } from '../abilities/dispatch'
import { battlerHasAbility } from '../abilities/dispatch'
import {
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_DESTINY_BOND,
  STATUS2_FLINCHED,
  STATUS2_NIGHTMARE,
  STATUS2_POWDER,
  STATUS3_GRUDGE,
  clearFlag,
  getCounter,
  hasFlag,
  setCounter,
} from './constants'

export const CANCEL_REASONS = ['SLEEP', 'FREEZE', 'PARALYSIS', 'FLINCH', 'TRUANT', 'CONFUSION'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

export interface AttackCancellerResult {
  cancelledBy: CancelReason | null
  /** HP removed from the ATTACKER by the confusion self-hit -- always null in
   * this batch (see CANCELLER_CONFUSED below): the damage engine call it needs
   * (CalculateMoveDamage, battle_util.c:3376-3378) is the same
   * `engine/` <-> sim bridge turn.ts's own DamageResolver seam defers, so this
   * is gapped by name rather than computed. Kept as its own field, distinct
   * from `targetDamage`, so a caller can tell a confusion self-hit apart from
   * ordinary target damage once that seam exists. */
  confusionSelfHitDamage: number | null
}

const bareType = (type: string | null | undefined): string => (type ?? '').replace(/^TYPE_/, '')

/** The six moves whose C hitCountOverride (pokemon.h:290) is nonzero, read
 * directly off er-config's MoveList.textproto at the pinned SHA (sources.lock.json)
 * because the pipeline does not emit this field into moves.json/SimMoveData --
 * see this module's header. Used ONLY to know when to emit the gap line, never
 * to apply a value: applying the value without a real data field would be
 * exactly the kind of guess CLAUDE.md's "verify game-mechanic claims" note
 * warns against, so the override itself stays unported. */
const HIT_COUNT_OVERRIDE_MOVES = new Set([
  'MOVE_TWINEEDLE',
  'MOVE_CROSS_POISON',
  'MOVE_DOUBLE_IRON_BASH',
  'MOVE_DOUBLE_SHOCK',
  'MOVE_RAPID_RIVER',
  'MOVE_CHILLER',
])

/** GetMultihitType's own return enum (battle_util.c:3568-3605), minus
 * MULTIHIT_SINGLE which this port represents as `null` (see resolveMultihitType). */
type MultihitType = 'TWO' | 'THREE' | 'FIVE' | 'TEN' | 'TEN_CAN_MISS' | 'FOUR_OR_FIVE' | 'TWO_TO_FIVE' | 'TRIPLE_KICK' | 'BEAT_UP'

/**
 * GetMultihitType, battle_util.c:3568-3605. Returns null for MULTIHIT_SINGLE
 * (every move this function does not recognise as multi-hit).
 */
function resolveMultihitType(attacker: BattlerState, moveId: string, move: SimMoveData | undefined, attackerHoldEffect: string | null, unmodelled: string[]): MultihitType | null {
  // :3569-3575 -- gapped, see this module's header.
  if (HIT_COUNT_OVERRIDE_MOVES.has(moveId)) {
    unmodelled.push(
      `${moveId}'s C hitCountOverride (pokemon.h:290, from er-config's MoveList.textproto hit_count) is not in moves.json/SimMoveData; multiHitCounter was not set for it here`,
    )
  }

  switch (move?.effect) {
    case 'EFFECT_MULTI_HIT': {
      // :3579 -- Giant Shuriken cancels Water Shuriken's own multi-hit entirely.
      if (moveId === 'MOVE_WATER_SHURIKEN' && battlerHasAbility(attacker.mon.abilities, 'ABILITY_GIANT_SHURIKEN', () => false)) return null
      // :3581.
      if (battlerHasAbility(attacker.mon.abilities, 'ABILITY_SKILL_LINK', () => false)) return 'FIVE'
      // :3583-3584.
      if (moveId === 'MOVE_WATER_SHURIKEN' && battlerHasAbility(attacker.mon.abilities, 'ABILITY_BATTLE_BOND', () => false) && attacker.mon.speciesId === 'SPECIES_GRENINJA_ASH') return 'THREE'
      // :3586.
      return attackerHoldEffect === 'HOLD_EFFECT_LOADED_DICE' ? 'FOUR_OR_FIVE' : 'TWO_TO_FIVE'
    }
    case 'EFFECT_DOUBLE_HIT':
      // :3589 -- argumentInt is a real SimMoveData field (dataContext.ts), not gapped.
      return move.argumentInt === 3 ? 'THREE' : 'TWO'
    case 'EFFECT_TRIPLE_KICK':
      // :3593.
      return battlerHasAbility(attacker.mon.abilities, 'ABILITY_SKILL_LINK', () => false) ? 'THREE' : 'TRIPLE_KICK'
    case 'EFFECT_TEN_HITS':
      // :3597.
      return battlerHasAbility(attacker.mon.abilities, 'ABILITY_SKILL_LINK', () => false) ? 'TEN' : 'TEN_CAN_MISS'
    case 'EFFECT_BEAT_UP':
      return 'BEAT_UP'
    default:
      return null
  }
}

/** GetAbilityIndex's own linear scan (battle_util.c:9299-9313), minus its
 * suppression check (GetAbilityState's caller passes checkMoldBreaker=FALSE at
 * every call site relevant to CANCELLER_TRUANT) -- just "which of the four
 * slots holds this ability id", same slot order as
 * abilities/dispatch.ts's forEachAbility (0=ability, 1-3=innates). -1 when
 * absent, matching Array.indexOf rather than the C's abilityCount sentinel. */
function findAbilitySlot(slots: AbilitySlots, abilityId: string): number {
  return [slots.ability, ...slots.innates].indexOf(abilityId)
}

const NO_CANCEL: AttackCancellerResult = { cancelledBy: null, confusionSelfHitDamage: null }

/**
 * Runs the canceller ladder for one USE_MOVE action, in enum order, stopping
 * at the first branch that produces an outcome (see this module's header).
 * Mutates `state` for every branch that reaches a real effect (status1/status2
 * clears, the sleep/confusion counters, RoundState's flinchImmobility/
 * prlzImmobility/confusionSelfDmg/attackCancelled -- the same fields the C
 * itself writes at these exact sites). Push gap notes onto `unmodelled`;
 * does not return them, since a caller may need to keep accumulating gaps
 * whether or not this call cancels the move.
 */
export function runAttackCanceller(
  state: BattleState,
  attackerId: number,
  targetId: number | null,
  moveId: string,
  move: SimMoveData | undefined,
  unmodelled: string[],
  attackerHoldEffect: string | null = null,
): AttackCancellerResult {
  const attacker = state.battlers[attackerId]
  if (!attacker) return NO_CANCEL

  // CANCELLER_FLAGS, :3204-3208 -- unconditional every action, never stops the
  // ladder.
  attacker.mon.status2 = clearFlag(attacker.mon.status2, STATUS2_DESTINY_BOND)
  attacker.statuses3 = clearFlag(attacker.statuses3, STATUS3_GRUDGE)

  // CANCELLER_ASLEEP, :3209-3247. UproarWakeUpCheck (:3211) is not modelled:
  // STATUS2_UPROAR has no writer anywhere in this sim (Uproar's own move effect
  // is not ported), so it is unreachable rather than gapped -- the branch it
  // guards can never fire. gProcessingExtraAttacks/sleepTalk (:3210) is also
  // always false, same precedent as turn.ts's other "not modelled" notes.
  if (hasFlag(attacker.mon.status1, STATUS1_SLEEP)) {
    const earlyBird = battlerHasAbility(attacker.mon.abilities, 'ABILITY_EARLY_BIRD', () => false)
    const toSub = earlyBird ? 2 : 1
    const sleepCounter = getCounter(attacker.mon.status1, STATUS1_SLEEP)
    const newCounter = sleepCounter < toSub ? 0 : sleepCounter - toSub
    attacker.mon.status1 = setCounter(attacker.mon.status1, STATUS1_SLEEP, newCounter)
    if (newCounter > 0) {
      // :3224-3232 -- Snore/Sleep Talk are the only moves usable while still
      // asleep; the C sets effect=1 ONLY in the else branch below, so a
      // Snore/Sleep-Talk user with turns remaining sets neither -- falls
      // through to CANCELLER_FROZEN with no cancellation and no ladder stop.
      if (moveId !== 'MOVE_SNORE' && moveId !== 'MOVE_SLEEP_TALK') {
        attacker.round.attackCancelled = true
        return { cancelledBy: 'SLEEP', confusionSelfHitDamage: null }
      }
    } else {
      // :3239-3243 -- woke up naturally. Not a cancellation (effect=3): the
      // move still proceeds to the accuracy check, but the ladder stops here.
      attacker.mon.status2 = clearFlag(attacker.mon.status2, STATUS2_NIGHTMARE)
      return NO_CANCEL
    }
  }

  // CANCELLER_FROZEN, :3248-3263.
  if (hasFlag(attacker.mon.status1, STATUS1_FREEZE) && !move?.flags.thawUser) {
    if (state.rng.random16() % 5 !== 0) {
      attacker.round.attackCancelled = true
      return { cancelledBy: 'FREEZE', confusionSelfHitDamage: null }
    }
    // :3256-3260 -- 1-in-5, unfroze. Not a cancellation; the ladder stops here.
    attacker.mon.status1 = clearFlag(attacker.mon.status1, STATUS1_FREEZE)
    return NO_CANCEL
  }

  // CANCELLER_TRUANT, :3281-3293.
  const truantSlot = findAbilitySlot(attacker.mon.abilities, 'ABILITY_TRUANT')
  if (truantSlot !== -1 && attacker.volatiles.abilityState[truantSlot] !== 0 && move?.split !== 'STATUS') {
    attacker.round.attackCancelled = true
    return { cancelledBy: 'TRUANT', confusionSelfHitDamage: null }
  }

  // CANCELLER_RECHARGE (:3294-3304), CANCELLER_DISABLED (:3315-3325),
  // CANCELLER_GRAVITY (:3337-3347), CANCELLER_HEAL_BLOCKED (:3326-3336),
  // CANCELLER_TAUNTED (:3348-3357), CANCELLER_IMPRISONED (:3358-3367) --
  // unreachable, see this module's header.

  // CANCELLER_FLINCH, :3305-3314.
  if (hasFlag(attacker.mon.status2, STATUS2_FLINCHED)) {
    attacker.round.flinchImmobility = true
    attacker.round.attackCancelled = true
    return { cancelledBy: 'FLINCH', confusionSelfHitDamage: null }
  }

  // CANCELLER_PARALYSED, :3400-3413.
  if (hasFlag(attacker.mon.status1, STATUS1_PARALYSIS)) {
    if (state.rng.random16() % 4 === 0) {
      attacker.round.prlzImmobility = true
      attacker.round.attackCancelled = true
      return { cancelledBy: 'PARALYSIS', confusionSelfHitDamage: null }
    }
  }

  // CANCELLER_BIDE (:3414-3435) -- unreachable, see header.

  // CANCELLER_THAW, :3436-3454. Reached with STATUS1_FREEZE still set only
  // when the move has FLAG_THAW_USER (otherwise CANCELLER_FROZEN above already
  // resolved -- cancelled or thawed -- and stopped the ladder), so no separate
  // flag check is needed here; that is exactly the C's own control flow, not
  // an assumption.
  if (hasFlag(attacker.mon.status1, STATUS1_FREEZE)) {
    const attackerIsFire = attacker.mon.types.includes('FIRE')
    if (!(move?.effect === 'EFFECT_BURN_UP' && !attackerIsFire)) {
      attacker.mon.status1 = clearFlag(attacker.mon.status1, STATUS1_FREEZE)
    }
    return NO_CANCEL
  }
  if (hasFlag(attacker.mon.status1, STATUS1_FROSTBITE) && move?.flags.thawUser) {
    const attackerIsFire = attacker.mon.types.includes('FIRE')
    if (!(move?.effect === 'EFFECT_BURN_UP' && !attackerIsFire)) {
      attacker.mon.status1 = clearFlag(attacker.mon.status1, STATUS1_FROSTBITE)
    }
    return NO_CANCEL
  }

  // CANCELLER_POWDER_MOVE, :3455-3466 -- gapped, see header. Never stops the
  // ladder here (the true C may cancel when genuinely immune; this port does
  // not compute immunity, so it always lets the move through).
  if (move?.flags.powderAffected && targetId !== null && targetId !== attackerId) {
    unmodelled.push(
      "CANCELLER_POWDER_MOVE (battle_util.c:3455-3466): IsPowderImmune's own chain (Mycelium Might, Grass typing, Safety Goggles, the powderImmune/pollinateImmunities ability flags, :3190-3196) is not evaluated; a target that would actually be immune is not detected here",
    )
  }

  // CANCELLER_POWDER_STATUS, :3468-3480 -- gapped, see header.
  if (hasFlag(attacker.mon.status2, STATUS2_POWDER) && bareType(move?.type) === 'FIRE') {
    unmodelled.push(
      "CANCELLER_POWDER_STATUS (battle_util.c:3468-3480): the self-damage (maxHP/4, Magic-Guard-gated) and BattleScript_MoveUsedPowder's own ppreduce (data/battle_scripts_1.s:8771-8778, unlike every other cancel script here) are not modelled",
    )
  }

  // CANCELLER_THROAT_CHOP (:3481-3490), CANCELLER_SKY_DROP (:3264-3271),
  // CANCELLER_QUICK_GUARD (:3272-3280), CANCELLER_PSYCHIC_TERRAIN
  // (:3542-3551) -- unreachable, see header.

  // CANCELLER_CONFUSED, :3368-3399 (source order; enum value 20 -- see header).
  const confusionCounter = getCounter(attacker.mon.status2, STATUS2_CONFUSION)
  if (confusionCounter !== 0) {
    const newConfusion = confusionCounter - 1
    attacker.mon.status2 = setCounter(attacker.mon.status2, STATUS2_CONFUSION, newConfusion)
    if (newConfusion === 0) {
      // :3372-3374 -- wore off. Not a cancellation; the ladder stops here.
      return NO_CANCEL
    }
    if (state.rng.random16() % 3 === 0) {
      // :3375-3388 -- self-hit. CalculateMoveDamage's own call (:3376-3378) is
      // gapped by name: computing it needs the full damage engine bridge
      // turn.ts's DamageResolver seam defers (see this module's header and
      // AttackCancellerResult.confusionSelfHitDamage's own doc).
      attacker.round.confusionSelfDmg = true
      attacker.round.attackCancelled = true
      unmodelled.push(
        "CANCELLER_CONFUSED's self-hit damage (CalculateMoveDamage MOVE_NONE, battle_util.c:3376-3378, power 40 or 80 with an opposing Cosmic Daze) is not modelled; no HP was removed from the attacker",
      )
      return { cancelledBy: 'CONFUSION', confusionSelfHitDamage: null }
    }
    // :3395-3398 -- confused but acted through it. Not a cancellation; the
    // ladder stops here.
    return NO_CANCEL
  }

  // CANCELLER_MULTIHIT_MOVES, :3491-3541 -- never stops the ladder in the C
  // either (see header); ported for real here (fix cycle 6). Runs even after
  // CANCELLER_CONFUSED resolves without cancelling, matching the C's own enum
  // order (21 comes after 20).
  const multihitType = resolveMultihitType(attacker, moveId, move, attackerHoldEffect, unmodelled)
  if (multihitType) {
    switch (multihitType) {
      case 'TWO':
        attacker.turn.multiHitCounter = 2
        break
      case 'THREE':
      case 'TRIPLE_KICK':
        attacker.turn.multiHitCounter = 3
        break
      case 'FIVE':
        attacker.turn.multiHitCounter = 5
        break
      case 'TEN':
      case 'TEN_CAN_MISS':
        attacker.turn.multiHitCounter = 10
        break
      case 'FOUR_OR_FIVE':
        // :3516 -- one Random() draw.
        attacker.turn.multiHitCounter = 4 + (state.rng.random16() % 2)
        break
      case 'TWO_TO_FIVE': {
        // :3520 -- `2 + (Random() % 2) + 2 * (Random() % 3 == 0)` is one C
        // expression with two Random() calls; their evaluation order is
        // unspecified by the C standard. ASSUMPTION: drawn left to right, the
        // same order the expression is written in.
        const first = state.rng.random16() % 2
        const second = state.rng.random16() % 3 === 0 ? 2 : 0
        attacker.turn.multiHitCounter = 2 + first + second
        break
      }
      case 'BEAT_UP': {
        // :3523-3538 -- a live count of the attacker's own party: HP nonzero,
        // a real species (SPECIES_NONE excluded), not an egg (never true here,
        // see header) and no non-volatile status. No Random() draw.
        const party = state.sides[attackerId & 1].party
        let count = 0
        for (const mon of party) {
          if (mon.hp !== 0 && mon.speciesId !== null && mon.status1 === 0) count++
        }
        attacker.turn.multiHitCounter = count
        break
      }
    }
  }

  return NO_CANCEL
}
