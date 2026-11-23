// Expectimax player policy.
//
// The opponent's AI decides from the state at the START of a turn, before it sees the
// player's choice, so its action distribution does not depend on what the player does.
// That lets one set of sampled opponent actions be shared by every candidate player action
// (common random numbers: the same sampled action AND the same generator seed per sample),
// which both cuts the cost and removes most of the noise between candidates.
//
//   value(state, depth) = max over player choices of  mean over samples of  value(next, depth - 1)
//
// Leaves are scored by `evaluateState`. A player choice is a move (mega-evolving whenever the
// game allows it) or a voluntary switch to a live party member.

import { battlerHasAbility } from '../../abilities/dispatch'
import { chooseAiAction } from '../ai/chooseAiAction'
import { getMostSuitableMonToSwitchInto } from '../ai/aiSwitching'
import {
  CHOICE_HOLD_EFFECTS,
  PARTY_SIZE,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_TOXIC_SPIKES,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_HAIL_ANY,
  WEATHER_PERMANENT,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  getCounter,
  hasFlag,
} from '../constants'
import { isMagicGuardProtected } from '../endTurn'
import {
  HAIL_IMMUNE_ABILITY_IDS,
  SAND_IMMUNE_ABILITY_IDS,
  TOXIC_TERRAIN_IMMUNE_ABILITY_IDS,
  hasAnyAbility,
  isAbilityOnField,
} from '../fieldEndTurn'
import { createRandomSource } from '../rng'
import { applyStatStage } from '../../stats'
import { battlerHasSimAbility } from '../statBuffs'
import type { BattleState, BattlerState, SimBattleMon, SimPartyMon } from '../state'
import type { ChosenAction } from '../turnOrder'
import { partySlotsFor } from '../partySlots'
import { hasLiveReserve } from '../switchIn'
import type { BattleFormat } from './battleFormat'
import { defaultPlayerPolicy } from './runBattle'
import { aiDamageDepsFor, buildMoveAction, cloneParty, cloneSession, beginTurn, createSession, firstLiveReplacement, holdEffectOfBattler, stepTurn, type BattleSession } from './session'
import type { BattleSummary } from './lossAnatomy'
import type { SimDataBundle } from './loadSimData'

/** The only move metadata the cycle-142 field-condition terms need: whether a
 * move slot damages and which type it is. `SimDataContext.move` satisfies this
 * shape; the leaf scorer takes it as a parameter because `evaluateState(state,
 * options)` has no `SimDataBundle`. */
export interface MoveLookupEntry {
  type?: string | null
  power?: number
  split?: string | null
}
export type MoveLookup = (moveId: string) => MoveLookupEntry | undefined

export interface ExpectimaxOptions {
  /** Plies of lookahead. 1 = score the position after one turn. */
  depth: number
  /** Sampled (opponent action, generator seed) pairs at the root. */
  samples: number
  /** Samples used at plies below the root. */
  innerSamples: number
  /** A switch must beat the best move by at least this much to be chosen. */
  switchMargin: number
  /** Add the status1 residual/tempo, volatile and per-side field terms
   * (hazards/screens/Tailwind plus weather, terrain and Trick Room) to the leaf
   * score (see `statusScore`). On by default; set to false to score
   * positionScore alone. */
  statusTerms?: boolean
  /** Move-type lookup for the cycle-142 field move-type boosts. The driver
   * supplies the session's data context automatically; when omitted those boost
   * terms are 0 (all the data-free field terms still score). */
  moveData?: MoveLookup
}

export const DEFAULT_EXPECTIMAX: ExpectimaxOptions = { depth: 1, samples: 6, innerSamples: 2, switchMargin: 0.05, statusTerms: true }

export interface PlayerChoice {
  action: ChosenAction
  /** Party slot for a voluntary switch. */
  switchTo?: number
}

function hpFraction(hp: number, maxHp: number): number {
  return maxHp > 0 ? hp / maxHp : 0
}

function sideScore(state: BattleState, side: 0 | 1): { hp: number; alive: number; stages: number } {
  const active1 = state.battlers[side]
  const active2 = state.battlersCount === 4 ? state.battlers[side + 2] : null
  const party = state.sides[side].party
  let hp = 0
  let alive = 0
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const activeBattler =
      active1 !== null && active1 !== undefined && active1.partyIndex === i
        ? active1
        : active2 !== null && active2 !== undefined && active2.partyIndex === i
          ? active2
          : null
    const isActive = activeBattler !== null
    const curHp = isActive ? activeBattler.mon.hp : mon.hp
    const maxHp = isActive ? activeBattler.mon.maxHp : mon.maxHp
    hp += hpFraction(curHp, maxHp)
    if (curHp > 0) alive++
  }
  let stages = 0
  if (active1 && active1.mon.hp > 0) {
    // atk, def, spatk, spdef, speed (indices 1..5 of the 8 stat stages) relative to the neutral 6
    for (let s = 1; s <= 5; s++) stages += Math.max(-6, Math.min(6, (active1.mon.statStages[s] ?? 6) - 6))
  }
  if (active2 && active2.mon.hp > 0) {
    for (let s = 1; s <= 5; s++) stages += Math.max(-6, Math.min(6, (active2.mon.statStages[s] ?? 6) - 6))
  }
  return { hp, alive, stages }
}

/** Static score of a position from the player's side: higher is better for the player.
 * By default adds the status1 residual/tempo, volatile and per-side field terms
 * (`statusScore`); set `options.statusTerms: false` to score `positionScore` alone
 * (or the terminal +-100). */
export function evaluateState(state: BattleState, options?: Partial<ExpectimaxOptions>): number {
  if (state.battleOutcome === 'WON') return 100
  if (state.battleOutcome === 'LOST') return -100
  return positionScore(state) + ((options?.statusTerms ?? true) ? statusScore(state, options?.moveData) : 0)
}

// ---------------------------------------------------------------------------
// status term (status1 + active volatiles + per-side field)
//
// `positionScore` only knows HP, alive count and stat stages, so Spore,
// Will-O-Wisp and Thunder Wave score as free actions. `statusScore` values the
// residual damage and the actions/tempo a status costs, in the same
// HP-fraction units as `positionScore`, so the two add. Alongside the status1
// terms it values the active battler's volatile statuses: confusion, nightmare,
// wrap, Leech Seed and a standing Substitute.
//
// The weights are expected HP-fraction-equivalents lost over a short horizon.
// STATUS_HORIZON_TURNS, ACTION_VALUE, PARALYSIS_SPEED_VALUE and
// SUBSTITUTE_BUFFER_WEIGHT are MODEL CHOICES, not constants in the C; each
// individual damage fraction and the conditions below are transcribed from the
// cited C lines.
// ---------------------------------------------------------------------------

/** Model horizon: how many end-of-turn ticks / actions the term looks ahead. MODEL CHOICE. */
const STATUS_HORIZON_TURNS = 3
/** HP-fraction-equivalent value of one lost action. MODEL CHOICE. */
const ACTION_VALUE = 0.25
/** The `statBase /= 2` that burn applies to Attack (battle_util.c:7135) and
 * frostbite applies to Special Attack (:7146) is worth half of one action's
 * damage output. Only the active mon pays it: the halving applies to a mon's
 * own move, so charging a reserve mon would value damage it is not dealing; it
 * also vanishes when the mon switches out. MODEL CHOICE flat weight. */
const BURN_ATTACK_HALF_VALUE = ACTION_VALUE / 2
/** Paralysis halves Speed (battle_main.c:4185-4186, `speed /= 2` when
 * `B_PARALYSIS_SPEED >= GEN_7` and not Quick Feet). Value of that lost speed is
 * a MODEL CHOICE flat weight; the /2 itself is the C's. */
const PARALYSIS_SPEED_VALUE = 0.25
/** CANCELLER_FROZEN (battle_util.c:3249-3260): `if (Random() % 5)` keeps the mon
 * frozen, the else branch thaws it, so one attempt thaws with probability 1/5. */
const FREEZE_THAW_CHANCE = 1 / 5
/** CANCELLER_CONFUSED (battle_util.c:3377): `Random() % 3 == 0` makes the mon hit
 * itself and lose the action. The 1/3 is the C's, not a model choice. */
const CONFUSION_SELF_HIT_CHANCE = 1 / 3
/** A standing Substitute is worth k times the HP it paid for (its HP fraction),
 * because it absorbs hits AND blocks status for as long as it stands. 2 is a
 * MODEL CHOICE: 1 would cancel the HP cost `positionScore` already charges and
 * the sub would never be picked. */
const SUBSTITUTE_BUFFER_WEIGHT = 2
/** HP-fraction-equivalent value of one turn of one damage-halving screen
 * (Reflect or Light Screen), per point of the attacker's move mix it covers.
 * MODEL CHOICE flat weight; the `UQ_4_12(0.5)` halving in a singles battle is
 * battle_util.c:7627-7628 (the 0.66 branch is the doubles value and is not
 * used). Aurora Veil halves both categories, so it is worth this weight times
 * the sum of the two shares (see `sideFieldScore`) -- Reflect plus Light
 * Screen against any foe with a damaging move. */
const SCREEN_VALUE = 0.1
/** HP-fraction-equivalent value of one turn of Tailwind's doubled Speed.
 * MODEL CHOICE flat weight; `speed *= 2` is battle_main.c:4203-4204. */
const TAILWIND_SPEED_VALUE = 0.1
/** HP-fraction-equivalent value of one benched mon entering at -1 Speed from
 * Sticky Web. MODEL CHOICE flat weight; the `SetStatChanger(STAT_SPEED, -1)`
 * itself is battle_script_commands.c:8796 (HAZARD_MODE_WEBS). */
const STICKY_WEB_SPEED_VALUE = 0.05

/** HasGrappler, battle_util.c:9359-9362: `RETURN_ABILITY_IF_FLAG(battler, FALSE,
 * grappler)` (include/battle_util.h:277), i.e. any of the battler's slots holding
 * a `grappler`-flagged ability. Those are Grappler, Tangled Tails and Tentalock
 * (abilityHooks.json), the same trio endTurn.ts:600 names for its own
 * ENDTURN_WRAP port. */
const GRAPPLER_ABILITIES = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK']
/** The suppression predicate endTurn.ts:382 passes to `battlerHasAbility` for its
 * HasGrappler port, mirrored here so this term reads the wrapper identically. */
const NO_SUPPRESSION = () => false

/** One end-of-turn fractional drain as an HP fraction, keeping the C's
 * `if (gBattleMoveDamage == 0) gBattleMoveDamage = 1` floor. */
function drainTickFraction(maxHp: number, divisor: number): number {
  if (maxHp <= 0) return 0
  return Math.max(1, Math.trunc(maxHp / divisor)) / maxHp
}

/** End-of-turn chip for one status, as an HP fraction over the horizon.
 * `divisor` is the C's `maxHP / 16` (burn/frostbite/bleed) or `/ 8` (poison);
 * the C's `if (gBattleMoveDamage == 0) gBattleMoveDamage = 1` floor is kept. */
function statusChipFraction(maxHp: number, divisor: number): number {
  if (maxHp <= 0) return 0
  const perTurn = Math.max(1, Math.trunc(maxHp / divisor))
  return (perTurn / maxHp) * STATUS_HORIZON_TURNS
}

/** Toxic: `gBattleMoveDamage = maxHP / 16; ... = (status1 & STATUS1_TOXIC_COUNTER) * gBattleMoveDamage >> 8`
 * (battle_util.c:2538-2540). The C increments the counter first, capped at 15
 * (`!= STATUS1_TOXIC_TURN(15)`, :2532-2533), so the horizon's ticks are
 * current+1 .. current+3, each capped. The field itself is counter << 8, which
 * is why the multiply-then-shift leaves counter * (maxHP / 16). */
function statusToxicFraction(maxHp: number, status1: number): number {
  if (maxHp <= 0) return 0
  const current = getCounter(status1, STATUS1_TOXIC_COUNTER)
  const perTick = Math.max(1, Math.trunc(maxHp / 16))
  let damage = 0
  for (let tick = 1; tick <= STATUS_HORIZON_TURNS; tick++) {
    const counter = Math.min(15, current + tick)
    damage += ((counter << 8) * perTick) >> 8 // gBattleMoveDamage, :2540
  }
  return damage / maxHp
}

/** The HP-fraction-equivalent cost of `mon`'s status1. `isActive` gates the
 * tempo terms (sleep/paralysis/freeze) and the stat-drop terms (burn's Attack
 * halving, frostbite's Sp. Atk halving): a benched mon only
 * acts after a switch-in, so those terms are deliberately 0 for it (there is no
 * C rule charging a reserve mon for them). A fainted mon contributes 0.
 *
 * Not modelled here, because this function takes only `{status1, hp, maxHp}` and
 * so cannot see the battler's abilities:
 *   - Magic Guard (`IsMagicGuardProtected` at battle_util.c:2507, :2535 and via
 *     `MAGIC_GUARD_CHECK` at :2575, :2586, :2600) and TakesNoBurnDamage
 *     (`takesNoBurnDamage`, :2574);
 *   - Poison Heal (:2497, :2522) and Toxic Boost, whose
 *     `REQUIRE_NOT(BattlerHasAbility(..., ABILITY_TOXIC_BOOST, FALSE))` skips the
 *     poison damage at :2508 and the bad-poison damage at :2536;
 *   - Flare Boost / Guts and any other `negatesBurnAtkDrop` ability, via
 *     `IgnoresBurnAtkDrop` (:7095), which cancels burn's Attack halving at :7135,
 *     and the analogous `IgnoresFrostbiteSpatkDrop` (`negatesFrzSpatkDrop`, :7100)
 *     at :7146;
 *   - Early Bird (battle_util.c:3218-3223), which makes sleep's counter drop by 2
 *     instead of 1. */
export function statusMonValue(mon: { status1: number; hp: number; maxHp: number }, isActive: boolean): number {
  if (mon.hp <= 0 || mon.maxHp <= 0) return 0
  const { status1 } = mon
  let value = 0
  if (hasFlag(status1, STATUS1_BURN)) {
    // ENDTURN_BURN, battle_util.c:2573-2582: maxHP / 16 (B_BURN_DAMAGE >= GEN_7), min 1.
    value += statusChipFraction(mon.maxHp, 16)
    // `statBase /= 2` for a burned physical attacker, battle_util.c:7135.
    if (isActive) value += BURN_ATTACK_HALF_VALUE
  }
  if (hasFlag(status1, STATUS1_POISON)) {
    // ENDTURN_POISON, battle_util.c:2492-2511 (the non-Poison-Heal branch): maxHP / 8.
    value += statusChipFraction(mon.maxHp, 8)
  }
  if (hasFlag(status1, STATUS1_TOXIC_POISON)) {
    // ENDTURN_BAD_POISON, battle_util.c:2516-2544.
    value += statusToxicFraction(mon.maxHp, status1)
  }
  if (hasFlag(status1, STATUS1_FROSTBITE)) {
    // ENDTURN_FROSTBITE, battle_util.c:2584-2596: maxHP / 16 with B_BURN_DAMAGE >= GEN_7.
    value += statusChipFraction(mon.maxHp, 16)
    // `statBase /= 2` for a frostbitten special attacker, battle_util.c:7146,
    // mirroring the burn Attack drop above.
    if (isActive) value += BURN_ATTACK_HALF_VALUE
  }
  if (hasFlag(status1, STATUS1_BLEED)) {
    // ENDTURN_BLEED, battle_util.c:2598-2606: BLEED_DAMAGE(maxHP) = maxHP / 16
    // (include/constants/battle.h:142), min 1.
    value += statusChipFraction(mon.maxHp, 16)
  }
  if (isActive && hasFlag(status1, STATUS1_PARALYSIS)) {
    // CANCELLER_PARALYSED, battle_util.c:3404: `(Random() % 4) == 0` cancels the
    // action, so 25% of this mon's actions are lost, plus the halved Speed above.
    value += 0.25 * STATUS_HORIZON_TURNS * ACTION_VALUE + PARALYSIS_SPEED_VALUE
  }
  if (isActive && hasFlag(status1, STATUS1_SLEEP)) {
    // CANCELLER_ASLEEP, battle_util.c:3218-3242: each move attempt subtracts
    // toSub (1, or 2 with Early Bird, :3218-3222) from the counter (:3224-3227).
    // The attempt is cancelled only if the counter is still nonzero afterwards
    // (:3229-3236); otherwise the mon wakes and acts that turn (:3238-3242). So
    // with toSub 1 a counter of N loses N-1 attempts, not N, capped by the horizon.
    const counter = getCounter(status1, STATUS1_SLEEP)
    value += Math.min(Math.max(counter - 1, 0), STATUS_HORIZON_TURNS) * ACTION_VALUE
  }
  if (isActive && hasFlag(status1, STATUS1_FREEZE)) {
    // CANCELLER_FROZEN, battle_util.c:3248-3262: `Random() % 5` non-zero keeps
    // the mon frozen (:3250-3253); a zero roll clears STATUS1_FREEZE (:3255) and
    // the mon acts that turn, so after a thaw later turns are not lost. The
    // action on turn k is lost only if all k rolls kept it frozen, probability
    // (1 - 1/5)^k; sum that over the horizon (0.8 + 0.64 + 0.512 = 1.952).
    for (let k = 1; k <= STATUS_HORIZON_TURNS; k++) {
      value += ACTION_VALUE * (1 - FREEZE_THAW_CHANCE) ** k
    }
  }
  return value
}

/** The HP-fraction-equivalent burden of one ACTIVE battler's volatiles:
 * confusion, nightmare, wrap and Leech Seed cost HP or actions; a standing
 * Substitute is a buffer, i.e. a BENEFIT, and is subtracted.
 *
 * `status2`, `statuses3` and `volatiles` live on the battler and are cleared on
 * switch out (`state.ts:92-94, :326`), unlike status1 which has a party-mon
 * copy -- so this reads `state.battlers[side]`, never the party roster. A
 * fainted battler contributes 0.
 *
 * Magic Guard: the nightmare, wrap and Leech Seed C branches below are gated by
 * MAGIC_GUARD_CHECK (battle_util.c:2610, :2666, :2477). `isMagicGuardProtected`
 * is the sim's own port of that check and needs only `state` + `battler` (the
 * ability registry's `magicGuard` flag plus Magic Room), so it is used here
 * directly instead of `battlerHasSimAbility`, whose `SimDataContext`
 * `evaluateState(state, options)` does not carry. */
function activeVolatileBurden(state: BattleState, battler: BattlerState): number {
  const { mon } = battler
  if (mon.hp <= 0 || mon.maxHp <= 0) return 0
  const { status2 } = mon
  let value = 0

  // CANCELLER_CONFUSED, battle_util.c:3368-3399. Every move attempt runs
  // `--status2 & STATUS2_CONFUSION` (:3374); if that reaches 0 the mon snaps out
  // and still acts (:3374-3376), otherwise `Random() % 3 == 0` (:3377) makes it
  // hit itself and lose the action. So with counter c only the c-1 attempts
  // that still had a nonzero counter can be lost, each with probability 1/3.
  // The horizon cap and ACTION_VALUE are model choices. The self-hit is real HP
  // lost as well as the action: CalculateMoveDamage (:3380-3387, 40 BP, 80 with
  // Cosmic Daze at :3384) plus HITMARKER_UNABLE_TO_USE_MOVE (:3389). Its damage
  // is left out here as a MODEL CHOICE, for consistency with the sim, which
  // also gaps it (attackCanceller.ts:85, :198-205).
  const confusionCounter = getCounter(status2, STATUS2_CONFUSION)
  value += Math.min(Math.max(0, confusionCounter - 1), STATUS_HORIZON_TURNS) * CONFUSION_SELF_HIT_CHANCE * ACTION_VALUE

  // ENDTURN_NIGHTMARES, battle_util.c:2608-2623. Requires STATUS2_NIGHTMARE and
  // hp != 0 (:2609); MAGIC_GUARD_CHECK follows (:2610). With STATUS1_SLEEP it
  // takes maxHP / 4, min 1, each end of turn (:2613-2615); without sleep the
  // flag is silently cleared and nothing is charged (:2618-2619). Each move
  // attempt first spends one point of the sleep counter (CANCELLER_ASLEEP,
  // :3218-3227) and is cancelled only while the counter is still nonzero
  // (:3229-3237); the attempt that empties it wakes the mon, clears
  // STATUS2_NIGHTMARE (:3238-3243) and lets it act. So a counter of N yields
  // N - 1 end-of-turn ticks, capped by the horizon (a model choice), the same
  // counter - 1 handling `statusMonValue`'s sleep term uses; Early Bird's
  // toSub 2 is not modelled there either (see that function's header).
  if (hasFlag(status2, STATUS2_NIGHTMARE) && !isMagicGuardProtected(state, battler)) {
    if (hasFlag(mon.status1, STATUS1_SLEEP)) {
      const sleepTurns = getCounter(mon.status1, STATUS1_SLEEP)
      value += Math.min(Math.max(sleepTurns - 1, 0), STATUS_HORIZON_TURNS) * drainTickFraction(mon.maxHp, 4)
    }
  }

  // ENDTURN_WRAP, battle_util.c:2648-2707, the STATUS2_WRAPPED branch (:2663-2705;
  // the Bug monotype champion branch above it, :2649-2662, has no port here). The
  // C pre-decrements wrapTurns (:2664); a zero result is the break-free tick and
  // deals no damage (:2688-2690), so the damaging ticks are wrapTurns - 1,
  // capped by the horizon. The rate is maxHP / 8 (:2685) unless the wrapper
  // (`gBattleStruct->wrappedBy`, :2680) has a grappler-flagged ability
  // (HasGrappler, :9359-9362) or a Binding Band (:2682-2683), which make it
  // maxHP / 6. Grappler is read here exactly as endTurn.ts:630-633 does it:
  // `state.wrappedBy[battlerId]` plus that wrapper's own ability slots. Only the
  // Binding Band half needs the hold-effect read (`holdEffectOfBattler`, which
  // wants a dataContext this leaf scorer does not carry), so the /6 for a
  // Binding Band wrapper is a MODEL CHOICE to leave out. MAGIC_GUARD_CHECK is
  // :2666.
  if (hasFlag(status2, STATUS2_WRAPPED) && !isMagicGuardProtected(state, battler)) {
    const wrapper = state.battlers[state.wrappedBy[battler.id]]
    const hasGrappler = !!wrapper && GRAPPLER_ABILITIES.some((ab) => battlerHasAbility(wrapper.mon.abilities, ab, NO_SUPPRESSION))
    const divisor = hasGrappler ? 6 : 8
    const damagingTicks = Math.min(Math.max(0, battler.volatiles.wrapTurns - 1), STATUS_HORIZON_TURNS)
    value += damagingTicks * drainTickFraction(mon.maxHp, divisor)
  }

  // ENDTURN_LEECH_SEED, battle_util.c:2472-2486. Requires STATUS3_LEECHSEED on
  // the victim (:2474), the victim alive (:2475), the seeder -- the low bits
  // `statuses3 & STATUS3_LEECHSEED_BATTLER` (constants.ts:218) -- alive (:2476),
  // and the victim not Magic Guard protected (:2477). The drain is maxHP / 8,
  // min 1, each end of turn (:2480-2481). The seeder's equal heal (:2479, the
  // "HP receiver") is left out as a MODEL CHOICE: positionScore only reads
  // current HP, so it would not score that future recovery on its own.
  if (hasFlag(battler.statuses3, STATUS3_LEECHSEED) && !isMagicGuardProtected(state, battler)) {
    const seeder = state.battlers[battler.statuses3 & STATUS3_LEECHSEED_BATTLER]
    if (seeder && seeder.mon.hp > 0) {
      value += STATUS_HORIZON_TURNS * drainTickFraction(mon.maxHp, 8)
    }
  }

  // Cmd_setsubstitute, battle_script_commands.c:10535-10555. Its own HP is
  // maxHP / 4, min 1 (:10536, :10539) and the cost is maxHP / 4, min 1
  // (:10537-10538), so a fresh sub's HP fraction equals the HP its holder paid
  // -- and positionScore already charges that HP. Valuing the sub 1:1 would
  // therefore score it as free; SUBSTITUTE_BUFFER_WEIGHT (>1) values what the
  // buffer buys. The flag and the HP are separate fields, so both are required.
  // This is a benefit, so it lowers the holder's burden.
  if (hasFlag(status2, STATUS2_SUBSTITUTE) && battler.volatiles.substituteHp > 0) {
    value -= SUBSTITUTE_BUFFER_WEIGHT * (battler.volatiles.substituteHp / mon.maxHp)
  }
  return value
}

/** Grounding for a BENCHED mon in the leaf scorer. Only the party copy's
 * `types` is readable here -- a reserve mon carries no abilities or items in
 * this scorer's reach -- so a Flying type is the only thing treated as
 * airborne. Left unmodelled, as a MODEL CHOICE: Levitate, Air Balloon and
 * Iron Ball (IsBattlerGrounded, battle_util.c), and the ability/item paths of
 * IsBattlerAffectedByHazards (battle_util.c:8522-8530: Heavy-Duty Boots, Shield
 * Dust, Molten Core / Mountaineer for Stealth Rock, Tectonize for grounded
 * types) and Magic Guard's hazard immunity.
 *
 * Gravity is also unmodelled here. CheckGroundingEffects (battle_util.c:6647-6652)
 * returns grounded on `IsGravityActive()`, so in the C Gravity grounds a Flying
 * mon for Spikes / Toxic Spikes / Sticky Web. The sim's port of IsGravityActive
 * (grounding.ts, battle_util.c:8689-8696) is NOT the bare field-status test --
 * it is suppressed by Clueless anywhere on the field -- so this leaf scorer does
 * not read it. MODEL CHOICE. */
function benchedMonGrounded(types: readonly string[]): boolean {
  return !types.includes('FLYING')
}

/** One Spikes switch-in as an HP fraction: the C's
 * `maxHP / ((5 - spikesAmount) * 2)` with its `if (gBattleMoveDamage == 0)
 * gBattleMoveDamage = 1` floor (battle_script_commands.c:8737-8739, ported at
 * hazards.ts:165-171). That is /8, /6 and /4 for 1, 2 and 3 layers. */
function spikesEntryFraction(maxHp: number, layers: number): number {
  if (maxHp <= 0) return 0
  const divisor = (5 - layers) * 2
  if (divisor <= 0) return 0
  return Math.max(1, Math.trunc(maxHp / divisor)) / maxHp
}

/** End-turn ticks a side timer is still worth, capped by the model horizon.
 * The end-turn countdowns are `!started.<field> && --<timer> == 0` --
 * ENDTURN_REFLECT battle_util.c:1793-1803, Light Screen :1813-1823, Aurora Veil
 * :1834-1844, Tailwind :1924-1934 -- so `started.*` only guards the turn the
 * effect was set and a just-set screen still has its full timer. */
function timerTurns(timer: number): number {
  return Math.max(0, Math.min(timer, STATUS_HORIZON_TURNS))
}

/** The per-side field burden from entry hazards, screens and Tailwind, in the
 * same HP-fraction units as `positionScore` and `statusMonValue`.
 *
 * Sign: hazards are a burden on the side that owns them, so they return
 * positive; screens and Tailwind are a benefit, so they return negative.
 * `statusScore` then computes `foe - player`, which makes a foe hazard positive
 * for the player and a foe screen negative.
 *
 * Hazards bite only the BENCHED living mons: the active mon has already
 * entered, and over the horizon each reserve is assumed to enter at most once
 * (MODEL CHOICE: no multiplier for repeated switch-in cycles).
 *
 * Each hazard's C condition:
 *   - Spikes (HAZARD_MODE_SPIKES, battle_script_commands.c:8729-8742) needs the
 *     presence bit AND `spikesAmount`; grounded only.
 *   - Stealth Rock (HAZARD_MODE_ROCKS, :8743-8757, GetStealthHazardDamage
 *     battle_util.c:8040-8079) needs the bit. The type chart is not reachable
 *     from this leaf scorer, so every benched mon is charged the neutral /8
 *     (MODEL CHOICE); the /4, /2, /16 and /32 branches are not modelled.
 *   - Toxic Spikes (HAZARD_MODE_POISON_SPIKES, :8758-8787) needs the bit AND
 *     `toxicSpikesAmount`; a grounded mon that is not Poison/Steel (CanPoisonType,
 *     battle_script_commands.c:6465-6471) and has no status1 is poisoned --
 *     STATUS1_TOXIC_POISON at >= 2 layers, STATUS1_POISON at 1 -- and is valued
 *     with `statusMonValue`, false (benched, so no tempo terms). The Poison
 *     absorb branch is why a Poison-type is skipped. The onCanStatusType attacker
 *     abilities that let CanPoisonType poison a Steel type are unmodelled.
 *   - Sticky Web (HAZARD_MODE_WEBS, :8788-8798) needs the bit; grounded only.
 */
function sideFieldScore(state: BattleState, side: 0 | 1, moveLookup?: MoveLookup): number {
  const active = state.battlers[side]
  const party = state.sides[side].party
  const timers = state.sides[side].timers
  const statuses = state.sides[side].statuses
  const benched = []
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const isActive = active !== null && active !== undefined && active.partyIndex === i
    if (isActive) continue
    if (mon.hp <= 0) continue
    benched.push(mon)
  }
  const grounded = benched.filter((mon) => benchedMonGrounded(mon.types))
  let burden = 0

  // HAZARD_MODE_SPIKES, battle_script_commands.c:8729-8742. The sim never
  // writes the bit without a layer count, so requiring both is a guard against
  // an inconsistent state rather than a second mechanic.
  if (hasFlag(statuses, SIDE_STATUS_SPIKES) && timers.spikesAmount >= 1) {
    const layers = Math.min(timers.spikesAmount, 3)
    for (const mon of grounded) burden += spikesEntryFraction(mon.maxHp, layers)
  }

  // HAZARD_MODE_ROCKS, battle_script_commands.c:8743-8757. Neutral /8 per mon
  // (MODEL CHOICE, see this function's header); the C's min-1 floor is kept by
  // `drainTickFraction`.
  if (hasFlag(statuses, SIDE_STATUS_STEALTH_ROCK)) {
    for (const mon of benched) burden += drainTickFraction(mon.maxHp, 8)
  }

  // HAZARD_MODE_POISON_SPIKES, battle_script_commands.c:8758-8787. The status
  // is written onto the switching mon, so a benched mon with any status1 takes
  // nothing (CanBePoisoned's first check, battle_util.c:5044). In the C an
  // Immunity holder ALSO absorbs the spikes and clears them
  // (`IS_BATTLER_OF_TYPE(gActiveBattler, TYPE_POISON) || BattlerHasAbility(
  // gActiveBattler, ABILITY_IMMUNITY, TRUE)`, :8763), and Heavy-Duty Boots /
  // Shield Dust suppress the poison through `IsBattlerAffectedByHazards(
  // gActiveBattler, FALSE, FALSE)` at :8770. MODEL CHOICE: neither ability nor
  // item is readable from a benched party mon in this scorer, so only the
  // Poison type and the layer count are read here; the numbers do not change.
  if (hasFlag(statuses, SIDE_STATUS_TOXIC_SPIKES) && timers.toxicSpikesAmount >= 1) {
    const status1 = timers.toxicSpikesAmount >= 2 ? STATUS1_TOXIC_POISON : STATUS1_POISON
    for (const mon of grounded) {
      if (mon.status1 !== 0) continue
      if (mon.types.includes('POISON') || mon.types.includes('STEEL')) continue
      burden += statusMonValue({ status1, hp: mon.hp, maxHp: mon.maxHp }, false)
    }
  }

  // HAZARD_MODE_WEBS, battle_script_commands.c:8788-8798.
  if (hasFlag(statuses, SIDE_STATUS_STICKY_WEB)) {
    burden += STICKY_WEB_SPEED_VALUE * grounded.length
  }

  // Screens, battle_util.c:7622-7630: Reflect halves PHYSICAL damage
  // (`SIDE_STATUS_REFLECT && IS_MOVE_PHYSICAL(move)`, :7622), Light Screen
  // SPECIAL (:7623), and Aurora Veil both with no category test (:7623). A
  // screen is therefore worth SCREEN_VALUE per remaining turn times the share
  // of the ATTACKER's damaging moves it halves (`foeSplitShares`); the attacker
  // is the other side's active battler. physShare + specShare is 1 whenever
  // the foe has a damaging move, so Aurora Veil is worth
  // `SCREEN_VALUE * timerTurns(auroraVeilTimer)` -- exactly Reflect plus Light
  // Screen against any foe. When `moveLookup` is undefined (the data-free
  // path) the flat weights are kept instead: factor 1 for each screen and 2
  // for Aurora Veil. A timer is read only when its bit is set. Crits and
  // Infiltrator (:7624) are not modelled, neither is the doubles 0.66
  // multiplier (:7627).
  const foeShares = moveLookup ? foeSplitShares(state.battlers[1 - side], moveLookup) : null
  if (hasFlag(statuses, SIDE_STATUS_REFLECT)) {
    burden -= SCREEN_VALUE * timerTurns(timers.reflectTimer) * (foeShares ? foeShares.phys : 1)
  }
  if (hasFlag(statuses, SIDE_STATUS_LIGHTSCREEN)) {
    burden -= SCREEN_VALUE * timerTurns(timers.lightscreenTimer) * (foeShares ? foeShares.spec : 1)
  }
  if (hasFlag(statuses, SIDE_STATUS_AURORA_VEIL)) {
    burden -= SCREEN_VALUE * timerTurns(timers.auroraVeilTimer) * (foeShares ? foeShares.phys + foeShares.spec : 2)
  }

  // Tailwind, battle_main.c:4203-4204: `speed *= 2` for the side that owns it.
  if (hasFlag(statuses, SIDE_STATUS_TAILWIND)) burden -= TAILWIND_SPEED_VALUE * timerTurns(timers.tailwindTimer)

  return burden
}

// ---------------------------------------------------------------------------
// cycle 142: field conditions -- weather chip, terrain heal/chip, weather and
// terrain move-type boosts, and Trick Room.
//
// Same units and sign convention as the rest of `statusScore`: the per-side
// parts below return a BURDEN (positive = bad for that side), heals and boosts
// are negative burdens; the global Trick Room term is player-oriented (positive
// = good for the player).
//
// `fieldEndTurn.ts`'s immunity predicates take a `SimDataContext` (and
// `weatherHasEffect` a `GroundingContext`), neither of which
// `evaluateState(state, options)` carries. The local equivalents below
// transcribe every data-free clause and leave the rest to named MODEL CHOICEs.
// ---------------------------------------------------------------------------

/** Flat HP-fraction-equivalent value of one turn of a terrain's 1.3 move-type
 * boost. MODEL CHOICE; the `MUL_MODIFIER(&modifier, 1.3)` itself is
 * battle_util.c:7087. */
const TERRAIN_BOOST_VALUE = 0.05
/** Flat value of one turn of a rain/sun move-type boost or drop. MODEL CHOICE;
 * the C's multipliers are battle_util.c:7562-7607 (1.5 temporary/primal, 1.2
 * permanent, 0.5 for the disfavoured type). The flat weight deliberately does
 * not scale with them. */
const WEATHER_BOOST_VALUE = 0.05
/** Flat value of one turn of Trick Room advantage (the slower active mon moves
 * first). MODEL CHOICE; the effect itself is battle_main.c:4325. */
const TRICK_ROOM_VALUE = 0.1

/** `gStatStageRatios[MAX_STAT_STAGE + 1][2]`, src/pokemon.c:171-185 (stage
 * -6..+6) -- the same table data/<version>/natures.json carries as
 * `statStageRatios`. Duplicated only because the leaf scorer has no
 * SimDataBundle. */
const STAT_STAGE_RATIOS: [number, number][] = [
  [10, 40],
  [10, 35],
  [10, 30],
  [10, 25],
  [10, 20],
  [10, 15],
  [10, 10],
  [15, 10],
  [20, 10],
  [25, 10],
  [30, 10],
  [35, 10],
  [40, 10],
]

function bareTypeName(type: string | null | undefined): string {
  return (type ?? '').replace(/^TYPE_/, '')
}

/** WEATHER_HAS_EFFECT, include/battle_util.h:45-46. `grounding.isCluelessOnField`
 * is exactly `IsAbilityOnField(ABILITY_CLUELESS)` (grounding.ts:20-24), so the
 * exported fieldEndTurn scan replaces it. */
function weatherHasEffectLocal(state: BattleState): boolean {
  if (state.field.timers.clearSkiesTimer > 0) return false
  if (isAbilityOnField(state, 'ABILITY_CLOUD_NINE')) return false
  if (isAbilityOnField(state, 'ABILITY_AIR_LOCK')) return false
  if (isAbilityOnField(state, 'ABILITY_CLUELESS')) return false
  return true
}

/** Damaging end-turn ticks left. ENDTURN_SANDSTORM, battle_util.c:1982-1996 and
 * ENDTURN_HAIL :2014-2028: a permanent weather never ticks down; a temporary
 * one does `!started.weather && --weatherDuration == 0`, and the tick that
 * reaches zero runs BattleScript_SandStormHailEnds (data/battle_scripts_1.s:
 * 7340-7344), which deals no damage. So a temporary weather damages
 * `weatherDuration - 1` times.
 *
 * `started.weather` does NOT hold back any of those FUTURE ticks: the leaf is
 * scored after `stepTurn`, and every `started` flag is zeroed at the start of
 * the next turn (battle_main.c:4589-4595 `ZERO(gFieldTimers.started)`, sim
 * turn.ts:4495 `clearStartedFlags`), so every future end-of-turn countdown runs
 * with `started` false -- which is why `timerTurns` ignores it too.
 * MODEL CHOICE: capped by STATUS_HORIZON_TURNS. */
function weatherTicks(state: BattleState): number {
  if (hasFlag(state.field.weather, WEATHER_PERMANENT)) return STATUS_HORIZON_TURNS
  return timerTurns(state.field.weatherDuration - 1)
}

/** Turns left on the rain/sun Water/Fire multiplier. The multiplier is applied
 * in damage calculation for every move while the weather bit is set
 * (battle_util.c:7562-7607) and the bit is cleared only by the end-of-turn
 * decrement that reaches 0 (ENDTURN_RAIN :1959-1981, ENDTURN_SUN :1998-2013),
 * so a temporary weather boosts on each of its `weatherDuration` remaining
 * turns -- unlike the chip, the clearing turn still counts, because the
 * decrement runs at the END of the turn and that turn's moves are already
 * boosted. For the same reason as `weatherTicks`, `started.weather` is not
 * read: it never holds back a future decrement.
 *
 * Permanent weather never ticks down (the `WEATHER_*_PERMANENT` guards plus
 * `!(WEATHER_RAIN_PRIMAL)` / `!(WEATHER_SUN_PRIMAL)` at :1963 / :2002), so it
 * keeps the full horizon. WEATHER_PERMANENT (constants.ts:359-361) already
 * includes WEATHER_PRIMAL_ANY, so the primal bits need no separate clause. */
function weatherBoostTurns(state: BattleState): number {
  if (hasFlag(state.field.weather, WEATHER_PERMANENT)) return STATUS_HORIZON_TURNS
  return timerTurns(state.field.weatherDuration)
}

/** IsSandImmune, battle_script_commands.c:10376-10386, data-free half. Left
 * out as MODEL CHOICE: Safety Goggles (held-item data) and the Desert Cloak
 * living-partner check (:10385). Everything else -- the three types, the
 * underground/underwater flags, Magic Guard and `sandImmune` abilities -- is
 * transcribed. */
function isSandImmuneLocal(state: BattleState, battler: BattlerState): boolean {
  if (battler.mon.types.includes('ROCK')) return true
  if (battler.mon.types.includes('GROUND')) return true
  if (battler.mon.types.includes('STEEL')) return true
  if (hasFlag(battler.statuses3, STATUS3_UNDERGROUND) || hasFlag(battler.statuses3, STATUS3_UNDERWATER)) return true
  if (isMagicGuardProtected(state, battler)) return true
  return hasAnyAbility(battler.mon.abilities, SAND_IMMUNE_ABILITY_IDS)
}

/** IsHailImmune, battle_script_commands.c:10388-10395, data-free half (same
 * omissions as `isSandImmuneLocal`). */
function isHailImmuneLocal(state: BattleState, battler: BattlerState): boolean {
  if (battler.mon.types.includes('ICE')) return true
  if (hasFlag(battler.statuses3, STATUS3_UNDERGROUND) || hasFlag(battler.statuses3, STATUS3_UNDERWATER)) return true
  if (isMagicGuardProtected(state, battler)) return true
  return hasAnyAbility(battler.mon.abilities, HAIL_IMMUNE_ABILITY_IDS)
}

/** IsBattlerGrounded, specialised to the one airborne marker this scorer can
 * read. MODEL CHOICE (the same one `benchedMonGrounded` makes): only the
 * Flying type; no Levitate, Air Balloon, Iron Ball, Ingrain, Gravity or Smack
 * Down. */
function activeMonGrounded(types: readonly string[]): boolean {
  return !types.includes('FLYING')
}

/** Heal/chip ticks left on a terrain. This is GRASSY TERRAIN's timing only:
 * ENDTURN_GRASSY_TERRAIN, battle_util.c:2102-2113, does `!permanent &&
 * !started.terrain && --terrainTimer == 0` and clears the bit, but the heal
 * loop that follows is BattleScript_GrassyTerrainHeals ->
 * VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS (battle_script_commands.c:6876-6886)
 * and never tests the field bit -- so Grassy still heals on the clearing tick.
 * A temporary terrain therefore heals `terrainTimer` times
 * (`clearingTickActs = true`).
 *
 * TOXIC TERRAIN differs, ENDTURN_TOXIC_TERRAIN, battle_util.c:2124-2146: the
 * countdown and the `gFieldStatuses &= ~STATUS_FIELD_TOXIC_TERRAIN` clear
 * (:2128-2133) run FIRST, and the damage loop's
 * `FILTER(IsBattlerTerrainAffected(i, STATUS_FIELD_TOXIC_TERRAIN))`
 * (:2134-2139 -> IsTerrainActive, :4886-4889) tests the field bit -- already
 * gone on the clearing tick. So Toxic chips `terrainTimer - 1` times
 * (`clearingTickActs = false`).
 *
 * `started.terrain` is not read. The leaf is scored after `stepTurn`, and every
 * `started` flag is zeroed at the start of the next turn (battle_main.c:
 * 4589-4595 `ZERO(gFieldTimers.started)`, sim turn.ts:4495
 * `clearStartedFlags`), so it never holds back any FUTURE decrement; every
 * future end-of-turn countdown runs with `started` false, exactly as
 * `timerTurns` assumes.
 *
 * `countdownBlocked` is Toxic Terrain's `!IsAbilityOnField(ABILITY_STENCH)`
 * gate (:2127), which freezes the timer so the full horizon stays.
 * MODEL CHOICE: capped by STATUS_HORIZON_TURNS. */
function terrainTicks(state: BattleState, countdownBlocked: boolean, clearingTickActs: boolean): number {
  if (hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) || countdownBlocked) return STATUS_HORIZON_TURNS
  const timer = state.field.timers.terrainTimer
  return timerTurns(clearingTickActs ? timer : timer - 1)
}

/** The bare type names of `mon`'s DAMAGING moves. MODEL CHOICE: "damaging" is
 * `split != STATUS` and `power > 0`; a fixed-damage move (power 0) is left out
 * because the 1.3/weather modifiers apply to `actualPower`. */
function damagingMoveTypes(mon: SimBattleMon, moveLookup: MoveLookup): Set<string> {
  const types = new Set<string>()
  for (const moveId of mon.moves) {
    if (!moveId) continue
    const move = moveLookup(moveId)
    if (!move) continue
    if (move.split === 'STATUS') continue
    if (!move.power || move.power <= 0) continue
    types.add(bareTypeName(move.type))
  }
  return types
}

/** What fraction of a battler's DAMAGING moves each screen halves, for the
 * screen terms in `sideFieldScore`. Reflect multiplies only `IS_MOVE_PHYSICAL`
 * hits and Light Screen only `IS_MOVE_SPECIAL` (battle_util.c:7622-7623), so a
 * screen's worth is the share of the incoming moves it actually reduces.
 * "Damaging" is the same MODEL CHOICE as `damagingMoveTypes`: `split != STATUS`
 * and `power > 0`. An empty slot is skipped (the C's MOVE_NONE); a battler with
 * no damaging move gets two zeros. */
function foeSplitShares(
  battler: BattlerState | null | undefined,
  moveLookup: MoveLookup,
): { phys: number; spec: number } {
  let damaging = 0
  let phys = 0
  let spec = 0
  if (!battler) return { phys: 0, spec: 0 }
  for (const moveId of battler.mon.moves) {
    if (!moveId) continue
    const move = moveLookup(moveId)
    if (!move) continue
    if (move.split === 'STATUS') continue
    if (!move.power || move.power <= 0) continue
    damaging++
    if (move.split === 'PHYSICAL') phys++
    else if (move.split === 'SPECIAL') spec++
  }
  if (damaging === 0) return { phys: 0, spec: 0 }
  return { phys: phys / damaging, spec: spec / damaging }
}

/** Rain/sun Water/Fire multiplier site, battle_util.c:7562-7607: under rain
 * Water is boosted and Fire halved, under sun the reverse. The multipliers are
 * the C's (1.5 temporary/primal, 1.2 permanent, 0.5 for the disfavoured type);
 * the flat WEATHER_BOOST_VALUE per turn is a MODEL CHOICE, and the turn count
 * is `weatherBoostTurns`. Left out: the `EFFECT_WEATHER_BOOST` branch (:7565),
 * Weather Double Boost (:7560), Nika and Steam Eruption's modifier floor
 * (:7584-7588), and POWER_WEATHER_ANY's DOWNPOUR-only bit (the C has no branch
 * for it).
 *
 * MODEL CHOICE: the multiplier is gated by IsBattlerWeatherAffected, which
 * rejects sun/rain when the battler holds HOLD_EFFECT_UTILITY_UMBRELLA
 * (:8644-8648: `if (gBattleWeather & (WEATHER_SUN_ANY | WEATHER_RAIN_ANY) &&
 * GetBattlerHoldEffect(battlerId, TRUE) == HOLD_EFFECT_UTILITY_UMBRELLA)
 * return FALSE;`). A held item is not readable from this leaf scorer, so an
 * Umbrella holder still gets the boost. */
function weatherMoveTypeBurden(state: BattleState, types: Set<string>): number {
  if (!weatherHasEffectLocal(state)) return 0
  const weather = state.field.weather
  const ticks = weatherBoostTurns(state)
  if (ticks === 0) return 0
  const rain = hasFlag(weather, WEATHER_RAIN_ANY)
  const sun = hasFlag(weather, WEATHER_SUN_ANY)
  let value = 0
  if (rain && !sun) {
    if (types.has('WATER')) value -= WEATHER_BOOST_VALUE * ticks
    if (types.has('FIRE')) value += WEATHER_BOOST_VALUE * ticks
  } else if (sun && !rain) {
    if (types.has('FIRE')) value -= WEATHER_BOOST_VALUE * ticks
    if (types.has('WATER')) value += WEATHER_BOOST_VALUE * ticks
  }
  return value
}

/** IsBattlerTerrainAffected's type switch, battle_util.c:7064-7090: the terrain
 * bit maps to a move type and a matching move gets `MUL_MODIFIER(1.3)`. The
 * caller has already gated the grounded clause; TERRAIN_HAS_EFFECT is the
 * Clueless check. The boost lasts `terrainTicks(..., true)` turns: it applies
 * during the moves of every turn the bit is set, and the bit clears at the
 * end-of-turn decrement that reaches 0. MODEL CHOICE: flat
 * TERRAIN_BOOST_VALUE per turn.
 *
 * MODEL CHOICE: IsBattlerTerrainAffected also rejects a semi-invulnerable
 * battler (:4903 `if (gStatuses3[battlerId] & STATUS3_SEMI_INVULNERABLE)
 * return FALSE;`). This scorer reads only the type and ignores that flag, so
 * an attacker in a semi-invulnerable turn still counts as boosted -- in the C
 * it would not be attacking that turn at all. */
function terrainMoveTypeBurden(state: BattleState, types: Set<string>): number {
  const terrain = state.field.statuses & STATUS_FIELD_TERRAIN_ANY
  if (!terrain) return 0
  if (isAbilityOnField(state, 'ABILITY_CLUELESS')) return 0
  let terrainType: string | null = null
  if (terrain === STATUS_FIELD_ELECTRIC_TERRAIN) terrainType = 'ELECTRIC'
  else if (terrain === STATUS_FIELD_PSYCHIC_TERRAIN) terrainType = 'PSYCHIC'
  else if (terrain === STATUS_FIELD_GRASSY_TERRAIN) terrainType = 'GRASS'
  else if (terrain === STATUS_FIELD_MISTY_TERRAIN) terrainType = 'FAIRY'
  else if (terrain === STATUS_FIELD_TOXIC_TERRAIN) terrainType = 'POISON'
  if (!terrainType || !types.has(terrainType)) return 0
  return -(TERRAIN_BOOST_VALUE * terrainTicks(state, false, true))
}

/** The per-side field-condition burden from weather, terrains and the weather/
 * terrain move-type boosts. Positive = bad for `side`; a Grassy Terrain heal
 * or a boost its active mon can use is a negative burden.
 *
 * Only the ACTIVE battler is on the field: reserves neither take weather chip
 * nor heal from terrain nor attack with a boosted type. */
function sideFieldConditionBurden(state: BattleState, battlerId: number, moveLookup?: MoveLookup): number {
  const battler = state.battlers[battlerId]
  if (!battler) return 0
  const mon = battler.mon
  if (mon.hp <= 0 || mon.maxHp <= 0) return 0
  const weather = state.field.weather
  let burden = 0

  // 1. Sandstorm / Hail chip. Cmd_weatherdamage, battle_script_commands.c:
  // 10397-10416: alive, WEATHER_HAS_EFFECT, not Magic Guard. The sandstorm
  // branch ASSIGNS and the hail branch OVERWRITES the same gBattleMoveDamage,
  // so with both bits set the surviving damage is hail's when the mon is not
  // hail-immune, otherwise sandstorm's. maxHP/16 with the min-1 floor.
  if (weatherHasEffectLocal(state)) {
    const ticks = weatherTicks(state)
    if (ticks > 0) {
      let chip = 0
      if (hasFlag(weather, WEATHER_SANDSTORM_ANY) && !isSandImmuneLocal(state, battler)) chip = drainTickFraction(mon.maxHp, 16)
      if (hasFlag(weather, WEATHER_HAIL_ANY) && !isHailImmuneLocal(state, battler)) chip = drainTickFraction(mon.maxHp, 16)
      burden += ticks * chip
    }
  }

  // 2. Grassy Terrain heal. ENDTURN_GRASSY_TERRAIN, battle_util.c:2102-2113 and
  // VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS, battle_script_commands.c:6876-6886:
  // skip semi-invulnerable, full HP, fainted and non-grounded; heal maxHP/16
  // (min 1). Capped by the missing HP over the horizon. NOTE: the heal script
  // itself has no Clueless/TERRAIN_HAS_EFFECT gate -- it only asks
  // IsBattlerGrounded -- so this term does not gate on Clueless either.
  if (
    hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN) &&
    !hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE) &&
    activeMonGrounded(mon.types) &&
    mon.hp < mon.maxHp
  ) {
    const perTick = Math.max(1, Math.trunc(mon.maxHp / 16))
    const missing = mon.maxHp - mon.hp
    burden -= Math.min(terrainTicks(state, false, true) * perTick, missing) / mon.maxHp
  }

  // 3. Toxic Terrain chip. ENDTURN_TOXIC_TERRAIN, battle_util.c:2124-2146 and
  // BattleScript_ToxicTerrainDamages, data/battle_scripts_1.s:10167-10175
  // (`hpfractiontodamage BS_STACK_1, 16`). FILTER chain (:2134-2139): alive,
  // not Magic Guard, IsBattlerTerrainAffected (TERRAIN_HAS_EFFECT + not
  // semi-invulnerable + grounded), not AbilityBlocksToxicTerrain, not Poison,
  // not Steel. The hit is maxHP/16 min 1, capped at the current HP
  // (Cmd_various, battle_script_commands.c:9017-9022).
  // MODEL CHOICE: IsBattlerTerrainAffected's `allowTerrainIfAirborne` ability
  // clause (:4926) is not modelled, so an airborne mon with such an ability is
  // treated as unaffected.
  if (hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)) {
    const terrainHasEffect = !isAbilityOnField(state, 'ABILITY_CLUELESS')
    if (
      terrainHasEffect &&
      !hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE) &&
      activeMonGrounded(mon.types) &&
      !isMagicGuardProtected(state, battler) &&
      !hasAnyAbility(mon.abilities, TOXIC_TERRAIN_IMMUNE_ABILITY_IDS) &&
      !mon.types.includes('POISON') &&
      !mon.types.includes('STEEL')
    ) {
      // The clearing tick does NOT chip: the bit is already cleared when the
      // damage loop's IsBattlerTerrainAffected filter runs (:2128-2133 vs
      // :2134-2139), so Toxic uses `timer - 1`, not Grassy's `timer`.
      const ticks = terrainTicks(state, isAbilityOnField(state, 'ABILITY_STENCH'), false)
      const perTick = Math.max(1, Math.trunc(mon.maxHp / 16))
      burden += Math.min(ticks * perTick, mon.hp) / mon.maxHp
    }
  }

  // 4/5. Move-type boosts for the active mon's own moves.
  if (moveLookup) {
    const types = damagingMoveTypes(mon, moveLookup)
    burden += weatherMoveTypeBurden(state, types)
    if (activeMonGrounded(mon.types)) burden += terrainMoveTypeBurden(state, types)
  }

  return burden
}

/** Battle main's effective Speed for the Trick Room comparison, from the raw
 * Speed stat and its stat stage only. MODEL CHOICE: `getBattlerTotalSpeedStat`
 * needs a `TurnOrderContext` and `statStageRatios` that a state alone cannot
 * supply, so Tailwind, paralysis, Swamp, item and ability speed modifiers are
 * omitted and the stage table is the transcribed `gStatStageRatios`. */
function activeSpeed(mon: SimBattleMon): number {
  const stage = Math.max(0, Math.min(12, mon.statStages[STAT_SPEED] ?? 6))
  return applyStatStage(mon.rawStats.spe, stage, STAT_STAGE_RATIOS)
}

/** Player-oriented Trick Room value (positive = good for the player). The
 * effect is battle_main.c:4325 `speedValue.effectiveSpeed = ~...`, i.e. the
 * slower active mon moves first; IsTrickRoomActive (battle_util.c:8671-8680) is
 * false with Clueless on the field. The monotype-champion branches (:8672
 * FLYING, :8675 NORMAL) are not modelled -- the leaf scorer has no champion
 * type. ENDTURN_TRICK_ROOM (:2051-2056) is `!started.trickRoom &&
 * --trickRoomTimer == 0`, so a just-set room keeps its full 5 turns.
 * NOTE: For doubles, uses the mean activeSpeed of each side's living active
 * battlers. This is a leaf heuristic, not a C port. */
function trickRoomValue(state: BattleState): number {
  if (!hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)) return 0
  if (isAbilityOnField(state, 'ABILITY_CLUELESS')) return 0
  const playerActives = [state.battlers[0], state.battlersCount === 4 ? state.battlers[2] : null].filter(
    (b): b is BattlerState => !!b && b.mon.hp > 0,
  )
  const foeActives = [state.battlers[1], state.battlersCount === 4 ? state.battlers[3] : null].filter(
    (b): b is BattlerState => !!b && b.mon.hp > 0,
  )
  if (playerActives.length === 0 || foeActives.length === 0) return 0
  const playerSpeed = playerActives.reduce((sum, b) => sum + activeSpeed(b.mon), 0) / playerActives.length
  const foeSpeed = foeActives.reduce((sum, b) => sum + activeSpeed(b.mon), 0) / foeActives.length
  if (playerSpeed === foeSpeed) return 0
  const magnitude = TRICK_ROOM_VALUE * timerTurns(state.field.timers.trickRoomTimer)
  return playerSpeed < foeSpeed ? magnitude : -magnitude
}

/** Sum of `statusMonValue` over one side's living mons, reading the active
 * battler's copy for the active slot and the party copy for the rest -- the
 * same split `sideScore` uses, because status1 persists across switches -- plus
 * the active battlers' volatile burden, which does not persist across switches,
 * plus the side's hazards/screens/Tailwind burden (`sideFieldScore`) and its
 * active mons' field-condition burden (`sideFieldConditionBurden`). */
function sideStatusScore(state: BattleState, side: 0 | 1, moveLookup?: MoveLookup): number {
  const active1 = state.battlers[side]
  const active2 = state.battlersCount === 4 ? state.battlers[side + 2] : null
  const party = state.sides[side].party
  let total = 0
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const activeBattler =
      active1 !== null && active1 !== undefined && active1.partyIndex === i
        ? active1
        : active2 !== null && active2 !== undefined && active2.partyIndex === i
          ? active2
          : null
    const isActive = activeBattler !== null
    const cur = activeBattler ? activeBattler.mon : mon
    if (cur.hp <= 0) continue
    total += statusMonValue({ status1: cur.status1, hp: cur.hp, maxHp: cur.maxHp }, isActive)
  }
  if (active1) total += activeVolatileBurden(state, active1)
  if (active2 && active2.mon.hp > 0) total += activeVolatileBurden(state, active2)
  total += sideFieldScore(state, side, moveLookup)
  total += sideFieldConditionBurden(state, side, moveLookup)
  if (active2 && active2.mon.hp > 0) total += sideFieldConditionBurden(state, side + 2, moveLookup)
  return total
}

/** Status and field burden from the player's side: higher is better for the
 * player (the foe's burden minus the player's), the same orientation as
 * `positionScore`. Covers status1 (per party mon), the active battler's
 * volatiles, the per-side entry hazards, screens and Tailwind
 * (`sideFieldScore`), the active mons' weather/terrain terms
 * (`sideFieldConditionBurden`) and the global Trick Room value.
 *
 * `moveLookup` is only needed by the weather/terrain move-type boosts; without
 * it those terms are 0 and every other term still scores. */
export function statusScore(state: BattleState, moveLookup?: MoveLookup): number {
  return sideStatusScore(state, 1, moveLookup) - sideStatusScore(state, 0, moveLookup) + trickRoomValue(state)
}

/** The material and boost balance, ignoring whether the battle is already decided. */
export function positionScore(state: BattleState): number {
  const me = sideScore(state, 0)
  const them = sideScore(state, 1)
  return me.hp - them.hp + 0.3 * (me.alive - them.alive) + 0.04 * (me.stages - them.stages)
}

export function legalChoices(session: BattleSession, battlerId = 0): PlayerChoice[] {
  const { state, data } = session
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0 || (state.absentBattlerFlags & (1 << battlerId)) !== 0) return []
  const choices: PlayerChoice[] = []
  // An Assault/Tactical Vest holder cannot select a status move (battle_util.c:1571-1578, the player-selection
  // check, and battle_util.c:1651-1653 for the shared filter); MOVE_ME_FIRST is exempt. Both read the hold effect
  // with GetBattlerHoldEffect(battler, TRUE) (battle_util.c:1418), so Klutz/Embargo leave the menu untouched.
  const vestHoldEffect = holdEffectOfBattler(state, battlerId, data.dataContext)
  const vestBlocksStatus = vestHoldEffect === 'HOLD_EFFECT_ASSAULT_VEST' || vestHoldEffect === 'HOLD_EFFECT_TACTICAL_VEST'
  // TrySetCantSelectMoveBattleScript's choice branch (battle_util.c:1565-1571): a Choice Band/Scarf/Specs
  // holder whose choicedMove is set may only select that move. Both the hold effect and the lock are read
  // exactly as the C reads them: GetBattlerHoldEffect(battler, TRUE) (Klutz/Embargo negate) and
  // gBattleStruct->choicedMove (0/0xFFFF == null). This is a selection-time filter only -- the turn loop,
  // like the C, does not re-validate a move that was already chosen.
  const holdsChoiceItem = vestHoldEffect !== null && CHOICE_HOLD_EFFECTS.includes(vestHoldEffect)
  // TrySetCantSelectMoveBattleScript's "Sage Power and Gorilla Tactics" block (battle_util.c:1585-1596):
  // Discipline, Gorilla Tactics and Sage Power all lock the holder to the recorded choicedMove. All three
  // use BATTLER_HAS_ABILITY (checkMoldBreaker=TRUE); the battler's own ability cannot be mold-broken by
  // itself, so attackerHasMoldBreaker is false. Selection-time filter only, like the Choice branch above.
  const abilityLocksMove =
    battlerHasSimAbility(state, battler, 'ABILITY_DISCIPLINE', true, battlerId, false, data.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_GORILLA_TACTICS', true, battlerId, false, data.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_SAGE_POWER', true, battlerId, false, data.dataContext)
  for (let i = 0; i < battler.mon.moves.length; i++) {
    const moveId = battler.mon.moves[i]
    if (moveId && battler.mon.pp[i] > 0) {
      if (vestBlocksStatus && moveId !== 'MOVE_ME_FIRST' && data.dataContext.move(moveId)?.split === 'STATUS') continue
      if (holdsChoiceItem && battler.choicedMove !== null && battler.choicedMove !== moveId) continue
      if (abilityLocksMove && battler.choicedMove !== null && battler.choicedMove !== moveId) continue
      const action = buildMoveAction(state, data, battlerId, moveId, session.turnDeps.damage)
      choices.push({ action })
    }
  }
  if (choices.length === 0) choices.push({ action: buildMoveAction(state, data, battlerId, 'MOVE_STRUGGLE', session.turnDeps.damage) })

  const party = state.sides[0].party
  const [firstSlot, lastSlot] = partySlotsFor(state, battlerId)
  const active = new Set<number>()
  for (let id = 0; id < state.battlers.length; id++) {
    if ((id & 1) !== 0) continue
    const other = state.battlers[id]
    if (other) active.add(other.partyIndex)
  }
  for (let i = firstSlot; i < Math.min(lastSlot, party.length); i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0 && !active.has(i)) {
      choices.push({ action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, switchTo: i })
    }
  }
  return choices
}

function applyChoice(session: BattleSession, choice: PlayerChoice, battlerId = 0): void {
  const battler = session.state.battlers[battlerId]
  if (battler) battler.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
}

interface OpponentSample {
  action: ChosenAction | null
  action3: ChosenAction | null
  seed: number
}

function sampleOpponent(session: BattleSession, count: number, seedBase: number): OpponentSample[] {
  const samples: OpponentSample[] = []
  for (let k = 0; k < count; k++) {
    const seed = (seedBase + k * 0x9e3779b1) >>> 0
    const probe = cloneSession(session, seed)
    const opp = probe.state.battlers[1]
    const action = opp && opp.mon.hp > 0 ? chooseAiAction(probe.state, 1, probe.chooseAiDeps).action : null
    let action3: ChosenAction | null = null
    // battle_main.c:3629: action selection loops gActiveBattler = 0..gBattlersCount-1
    if (probe.state.battlersCount === 4) {
      const opp3 = probe.state.battlers[3]
      action3 = opp3 && opp3.mon.hp > 0 ? chooseAiAction(probe.state, 3, probe.chooseAiDeps).action : null
    }
    samples.push({ action, action3, seed })
  }
  return samples
}

/** Ranks candidate choices by one-turn expectimax value and retains the top K moves
 * plus the single best switch choice (mirrors the move/switch split in chooseExpectimaxAction).
 * In doubles, ranking fixes the other player battler to defaultPlayerPolicy.
 * Ranking rule: one-turn evaluation (depth 0 leaf score) averaged across the opponent samples.
 */
export function pruneChoices(
  choices: PlayerChoice[] | Array<{ choice: PlayerChoice; score: number }>,
  scoreFnOrTopK?: ((choice: PlayerChoice) => number) | number,
  topK = 4,
): PlayerChoice[] {
  let ranked: Array<{ choice: PlayerChoice; score: number }>
  let k = topK

  if (typeof scoreFnOrTopK === 'number') {
    k = scoreFnOrTopK
    ranked = choices as Array<{ choice: PlayerChoice; score: number }>
  } else if (typeof scoreFnOrTopK === 'function') {
    const list = choices as PlayerChoice[]
    ranked = list.map((c) => ({ choice: c, score: scoreFnOrTopK(c) }))
  } else {
    ranked = choices as Array<{ choice: PlayerChoice; score: number }>
  }

  const moves: Array<{ choice: PlayerChoice; score: number }> = []
  const switches: Array<{ choice: PlayerChoice; score: number }> = []

  for (const item of ranked) {
    if (item.choice.switchTo === undefined) {
      moves.push(item)
    } else {
      switches.push(item)
    }
  }

  moves.sort((a, b) => b.score - a.score)
  switches.sort((a, b) => b.score - a.score)

  const prunedMoves = moves.slice(0, k).map((item) => item.choice)
  const bestSwitch = switches[0]?.choice
  return bestSwitch ? [...prunedMoves, bestSwitch] : prunedMoves
}

function getOtherBattlerPolicyAction(
  session: BattleSession,
  otherId: number,
): { action: ChosenAction | null; switchTo?: number } {
  const battler = session.state.battlers[otherId]
  if (!battler) return { action: null }
  const isAbsent = (session.state.absentBattlerFlags & (1 << otherId)) !== 0
  const isFaintedNoReserve = battler.mon.hp === 0 && !hasLiveReserve(session.state, otherId)
  if (isAbsent || isFaintedNoReserve) return { action: null }

  const savedSwitch = battler.monToSwitchIntoId
  const action = defaultPlayerPolicy(session.state, session.data, session.turnDeps.damage, otherId)
  const switchTo = battler.monToSwitchIntoId !== PARTY_SIZE ? battler.monToSwitchIntoId : undefined
  battler.monToSwitchIntoId = savedSwitch
  return { action, switchTo }
}

function rankCandidateChoice(
  session: BattleSession,
  battlerId: number,
  choice: PlayerChoice,
  samples: OpponentSample[],
  options: ExpectimaxOptions,
  otherAction: ChosenAction | null,
  otherSwitchTo?: number,
): number {
  const leafOptions = options.moveData ? options : { ...options, moveData: (moveId: string) => session.data.dataContext.move(moveId) }
  let sum = 0
  for (const sample of samples) {
    const next = cloneSession(session, sample.seed)
    applyChoice(next, choice, battlerId)
    const otherId = battlerId === 0 ? 2 : 0
    if (otherSwitchTo !== undefined && next.state.battlers[otherId]) {
      next.state.battlers[otherId].monToSwitchIntoId = otherSwitchTo
    }
    const action0 = battlerId === 0 ? choice.action : otherAction
    const action2 = battlerId === 2 ? choice.action : otherAction
    stepTurn(next, action0, sample.action, { 2: action2, 3: sample.action3 })
    sum += evaluateState(next.state, leafOptions)
  }
  return sum / samples.length
}

function pruneBattlerChoices(
  session: BattleSession,
  battlerId: number,
  choices: PlayerChoice[],
  samples: OpponentSample[],
  options: ExpectimaxOptions,
  topK = 4,
): PlayerChoice[] {
  if (choices.length <= 1) return choices
  const otherId = battlerId === 0 ? 2 : 0
  const { action: otherAction, switchTo: otherSwitchTo } = getOtherBattlerPolicyAction(session, otherId)
  return pruneChoices(
    choices,
    (choice) => rankCandidateChoice(session, battlerId, choice, samples, options, otherAction, otherSwitchTo),
    topK,
  )
}

function meanOverJoint(
  session: BattleSession,
  c0: PlayerChoice | null,
  c2: PlayerChoice | null,
  samples: OpponentSample[],
  depth: number,
  options: ExpectimaxOptions,
): number {
  let sum = 0
  for (const sample of samples) {
    const next = cloneSession(session, sample.seed)
    if (c0) applyChoice(next, c0, 0)
    if (c2) applyChoice(next, c2, 2)
    stepTurn(next, c0?.action ?? null, sample.action, { 2: c2?.action ?? null, 3: sample.action3 })
    sum += value(next, depth - 1, options, sample.seed ^ 0x85ebca6b)
  }
  return sum / samples.length
}

/** Chooses the joint player action for battlers 0 and 2 in a double format.
 * Prunes each battler's legal choices to topK moves plus the best switch, forms
 * the cross product skipping pairs switching to the same slot (battle_main.c:3757-3762),
 * and selects the best pair applying the switchMargin heuristic.
 */
export function chooseExpectimaxJointAction(
  session: BattleSession,
  options: ExpectimaxOptions,
  seed: number,
  topK = 4,
): { 0: PlayerChoice | null; 2: PlayerChoice | null } {
  const isAbsent0 = (session.state.absentBattlerFlags & (1 << 0)) !== 0 || !session.state.battlers[0]
  const isFaintedNoReserve0 = session.state.battlers[0]?.mon.hp === 0 && !hasLiveReserve(session.state, 0)
  const choices0 = isAbsent0 || isFaintedNoReserve0 ? [] : legalChoices(session, 0)

  const isAbsent2 = (session.state.absentBattlerFlags & (1 << 2)) !== 0 || !session.state.battlers[2]
  const isFaintedNoReserve2 = session.state.battlers[2]?.mon.hp === 0 && !hasLiveReserve(session.state, 2)
  const choices2 = isAbsent2 || isFaintedNoReserve2 ? [] : legalChoices(session, 2)

  if (choices0.length === 0 && choices2.length === 0) {
    return { 0: null, 2: null }
  }

  const samples = sampleOpponent(session, options.samples, seed)
  const pruned0 = choices0.length > 0 ? pruneBattlerChoices(session, 0, choices0, samples, options, topK) : []
  const pruned2 = choices2.length > 0 ? pruneBattlerChoices(session, 2, choices2, samples, options, topK) : []

  const pairs: Array<{ 0: PlayerChoice | null; 2: PlayerChoice | null }> = []
  if (pruned0.length > 0 && pruned2.length > 0) {
    for (const c0 of pruned0) {
      for (const c2 of pruned2) {
        // C forbids partner from choosing the same switch slot (battle_main.c:3757-3762)
        if (c0.switchTo !== undefined && c2.switchTo !== undefined && c0.switchTo === c2.switchTo) continue
        pairs.push({ 0: c0, 2: c2 })
      }
    }
  } else if (pruned0.length > 0) {
    for (const c0 of pruned0) pairs.push({ 0: c0, 2: null })
  } else if (pruned2.length > 0) {
    for (const c2 of pruned2) pairs.push({ 0: null, 2: c2 })
  }

  if (pairs.length === 0) return { 0: null, 2: null }
  if (pairs.length === 1) return pairs[0]

  let bestMove: { pair: { 0: PlayerChoice | null; 2: PlayerChoice | null }; v: number } | null = null
  let bestSwitch: { pair: { 0: PlayerChoice | null; 2: PlayerChoice | null }; v: number } | null = null

  for (const pair of pairs) {
    const v = meanOverJoint(session, pair[0], pair[2], samples, options.depth, options)
    const isSwitch = pair[0]?.switchTo !== undefined || pair[2]?.switchTo !== undefined
    if (isSwitch) {
      if (!bestSwitch || v > bestSwitch.v) bestSwitch = { pair, v }
    } else {
      if (!bestMove || v > bestMove.v) bestMove = { pair, v }
    }
  }

  if (bestSwitch && (!bestMove || bestSwitch.v > bestMove.v + options.switchMargin)) {
    return bestSwitch.pair
  }
  return bestMove ? bestMove.pair : bestSwitch ? bestSwitch.pair : { 0: null, 2: null }
}

function value(session: BattleSession, depth: number, options: ExpectimaxOptions, seedBase: number): number {
  // The leaf scorer has no data bundle of its own; supply the move metadata the
  // weather/terrain move-type boosts need from this session's data context
  // (unless the caller already provided a lookup, e.g. in a unit test).
  const leafOptions = options.moveData ? options : { ...options, moveData: (moveId: string) => session.data.dataContext.move(moveId) }
  if (session.state.battleOutcome || depth === 0) return evaluateState(session.state, leafOptions)

  if (session.state.battlersCount === 4) {
    const isAbsent0 = (session.state.absentBattlerFlags & (1 << 0)) !== 0 || !session.state.battlers[0]
    const isFaintedNoReserve0 = session.state.battlers[0]?.mon.hp === 0 && !hasLiveReserve(session.state, 0)
    const choices0 = isAbsent0 || isFaintedNoReserve0 ? [] : legalChoices(session, 0)

    const isAbsent2 = (session.state.absentBattlerFlags & (1 << 2)) !== 0 || !session.state.battlers[2]
    const isFaintedNoReserve2 = session.state.battlers[2]?.mon.hp === 0 && !hasLiveReserve(session.state, 2)
    const choices2 = isAbsent2 || isFaintedNoReserve2 ? [] : legalChoices(session, 2)

    if (choices0.length === 0 && choices2.length === 0) return evaluateState(session.state, leafOptions)

    const samples = sampleOpponent(session, options.innerSamples, seedBase)
    const pruned0 = choices0.length > 0 ? pruneBattlerChoices(session, 0, choices0, samples, options, 4) : []
    const pruned2 = choices2.length > 0 ? pruneBattlerChoices(session, 2, choices2, samples, options, 4) : []

    const pairs: Array<{ 0: PlayerChoice | null; 2: PlayerChoice | null }> = []
    if (pruned0.length > 0 && pruned2.length > 0) {
      for (const c0 of pruned0) {
        for (const c2 of pruned2) {
          if (c0.switchTo !== undefined && c2.switchTo !== undefined && c0.switchTo === c2.switchTo) continue
          pairs.push({ 0: c0, 2: c2 })
        }
      }
    } else if (pruned0.length > 0) {
      for (const c0 of pruned0) pairs.push({ 0: c0, 2: null })
    } else if (pruned2.length > 0) {
      for (const c2 of pruned2) pairs.push({ 0: null, 2: c2 })
    }

    if (pairs.length === 0) return evaluateState(session.state, leafOptions)

    let best = -Infinity
    for (const pair of pairs) {
      const v = meanOverJoint(session, pair[0], pair[2], samples, depth, options)
      if (v > best) best = v
    }
    return best
  }

  const choices = legalChoices(session)
  if (choices.length === 0) return evaluateState(session.state, leafOptions)
  const samples = sampleOpponent(session, options.innerSamples, seedBase)
  let best = -Infinity
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, depth, options)
    if (v > best) best = v
  }
  return best
}

function meanOver(
  session: BattleSession,
  choice: PlayerChoice,
  samples: OpponentSample[],
  depth: number,
  options: ExpectimaxOptions,
): number {
  let sum = 0
  for (const sample of samples) {
    const next = cloneSession(session, sample.seed)
    applyChoice(next, choice)
    stepTurn(next, choice.action, sample.action)
    sum += value(next, depth - 1, options, sample.seed ^ 0x85ebca6b)
  }
  return sum / samples.length
}

/** Picks the player's action for the coming turn; also sets the switch slot on the real state. */
export function chooseExpectimaxAction(
  session: BattleSession,
  options: ExpectimaxOptions,
  seed: number,
): PlayerChoice | null {
  const choices = legalChoices(session)
  if (choices.length === 0) return null
  if (choices.length === 1) return choices[0]

  const samples = sampleOpponent(session, options.samples, seed)
  let bestMove: { choice: PlayerChoice; v: number } | null = null
  let bestSwitch: { choice: PlayerChoice; v: number } | null = null
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, options.depth, options)
    const slot = choice.switchTo === undefined ? 'move' : 'switch'
    if (slot === 'move') {
      if (!bestMove || v > bestMove.v) bestMove = { choice, v }
    } else if (!bestSwitch || v > bestSwitch.v) {
      bestSwitch = { choice, v }
    }
  }
  if (bestSwitch && (!bestMove || bestSwitch.v > bestMove.v + options.switchMargin)) return bestSwitch.choice
  return bestMove ? bestMove.choice : bestSwitch ? bestSwitch.choice : null
}

/** After a faint the player's replacement comes from the game's own "most suitable mon" heuristic.
 * `inverseBattle` is FlagGet(B_FLAG_INVERSE_BATTLE) (battle_util.c:8028), forwarded to the AI deps
 * that score the candidate switch-ins.
 * In doubles, battlerId specifies which active battler is fainting (0 or 2); getMostSuitableMonToSwitchInto
 * automatically excludes the partner's current slot and planned switch-in. */
export function createHeuristicPlayerReplacement(
  data: SimDataBundle,
  inverseBattle = false,
): (state: BattleState, battlerId?: number) => number {
  return (state, battlerId = 0) => {
    const deps = aiDamageDepsFor(data, state, inverseBattle)
    const battler = state.battlers[battlerId]
    if (!battler) return PARTY_SIZE
    const saved = battler.monToSwitchIntoId
    battler.monToSwitchIntoId = PARTY_SIZE
    const result = getMostSuitableMonToSwitchInto(state, battlerId, deps)
    battler.monToSwitchIntoId = saved
    return result.partyIndex === PARTY_SIZE ? firstLiveReplacement(state, battlerId) : result.partyIndex
  }
}

export interface ExpectimaxBattleOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: import('./loadSimData').TrainerData
  tier?: 'ace' | 'elite' | 'hell'
  seed: number
  maxTurns?: number
  expectimax?: ExpectimaxOptions
  leadIndex?: number
  /** FlagGet(B_FLAG_INVERSE_BATTLE) (battle_util.c:8028); derived from encounters.json. */
  inverseBattle?: boolean
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
  format?: BattleFormat
  startFieldEffects?: Array<{ effectType: string; fieldId: string }>
}

/** Party slots of `side` that are down. A slot's live HP lives on the battler for
 * the slot currently on the field -- the party slot is stale until switch-out (see
 * the `finalParty` note below) -- so an active battler's `mon.hp` is authoritative
 * and `party[i].hp` is read for the rest. Empty slots (`speciesId === null`) are
 * not party members and never count. In doubles both of a side's battlers are
 * active and `(id & 1) === side` picks them (ids 0,2 for the player; 1,3 for the
 * opponent). */
function downSlots(state: BattleState, side: 0 | 1): number[] {
  const party = state.sides[side].party
  const down: number[] = []
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const active = state.battlers.find(
      (b): b is BattlerState => b !== null && (b.id & 1) === side && b.partyIndex === i,
    )
    const hp = active ? active.mon.hp : mon.hp
    if (hp <= 0) down.push(i)
  }
  return down
}

export interface ExpectimaxBattleResult {
  outcome: 'WON' | 'LOST' | 'DREW' | 'MAX_TURNS'
  turns: number
  /** positionScore at the end of the battle. */
  finalScore: number
  /** The player's party at the end of the battle (`state.sides[0].party`), deep-copied.
   * The mon still on the field keeps its live `status1`/`pp`/`itemId` on the battler
   * (`state.battlers[0].mon`): the sim writes `pp`/`itemId` to the party slot only on
   * switch-out (`turn.ts switchBattlerOut`), and `status1` only there and on Rest. */
  finalParty: SimPartyMon[]
  /** The player's active battler at the end (`state.battlers[0]`): `carryParty` reads
   * its live HP and `status1`, which the party slot above may not have. */
  finalActive: BattlerState
  /** The player's live battlers at the end: `battlers[0]` and, when `battlersCount === 4`, `battlers[2]`. */
  finalActives?: BattlerState[]
  /** What happened to the player's side this game. Aggregated across games by
   * `lossAnatomy` (docs/battle-sim/solver-v2-plan.md Step 2.2, decision 9c). */
  summary: BattleSummary
}

/** Plays one battle with the expectimax policy on the player's side. */
export function playExpectimaxBattle(options: ExpectimaxBattleOptions): ExpectimaxBattleResult {
  const maxTurns = options.maxTurns ?? 60
  const expectimax = options.expectimax ?? DEFAULT_EXPECTIMAX
  const session = createSession({
    data: options.data,
    playerParty: options.playerParty,
    opponentTrainer: options.opponentTrainer,
    tier: options.tier,
    rng: createRandomSource(options.seed),
    leadIndex: options.leadIndex,
    playerReplacement: createHeuristicPlayerReplacement(options.data, options.inverseBattle),
    inverseBattle: options.inverseBattle,
    battleEvents: options.battleEvents,
    format: options.format,
    startFieldEffects: options.startFieldEffects,
  })
  let turns = 0
  let firstFaintTurn: number | null = null
  while (!session.state.battleOutcome && turns < maxTurns) {
    turns++
    beginTurn(session)
    if (session.state.battlersCount === 4) {
      const joint = chooseExpectimaxJointAction(session, expectimax, (options.seed * 31 + turns) >>> 0)
      const c0 = joint[0]
      const c2 = joint[2]
      if (c0) applyChoice(session, c0, 0)
      if (c2) applyChoice(session, c2, 2)
      stepTurn(session, c0?.action ?? null, undefined, { 2: c2?.action ?? null })
    } else {
      const choice = chooseExpectimaxAction(session, expectimax, (options.seed * 31 + turns) >>> 0)
      if (choice) applyChoice(session, choice)
      stepTurn(session, choice ? choice.action : null)
    }
    // Both branches above ran one step; a player mon down now means this turn is
    // the first faint turn (the party slot of an active battler is stale, so
    // `downSlots` reads the live battler HP).
    if (firstFaintTurn === null && downSlots(session.state, 0).length > 0) firstFaintTurn = turns
  }
  const finalActives: BattlerState[] = [session.state.battlers[0]!]
  if (session.state.battlersCount === 4 && session.state.battlers[2]) {
    finalActives.push(session.state.battlers[2])
  }
  const faintedSlots = downSlots(session.state, 0)
  const opponentSlots = session.state.sides[1].party.filter((mon) => mon.speciesId !== null).length
  return {
    outcome: session.state.battleOutcome ?? 'MAX_TURNS',
    turns,
    finalScore: positionScore(session.state),
    finalParty: cloneParty(session.state.sides[0].party),
    finalActive: session.state.battlers[0]!,
    finalActives,
    summary: {
      firstFaintTurn,
      faintedSlots,
      endSlot: session.state.battlers[0]!.partyIndex,
      opponentRemaining: opponentSlots - downSlots(session.state, 1).length,
    },
  }
}

/** Fraction of `games` seeded battles the player wins. */
export function expectimaxWinRate(options: Omit<ExpectimaxBattleOptions, 'seed'>, games: number, baseSeed: number): number {
  let wins = 0
  for (let g = 0; g < games; g++) {
    if (playExpectimaxBattle({ ...options, seed: baseSeed + g }).outcome === 'WON') wins++
  }
  return wins / games
}
