// Entry hazards on switch-in and Rapid Spin's hazard removal.
//
// Switch-in: Cmd_switchineffects (battle_script_commands.c:5495-5541). Its FIRST
// pass (`!hazardDamaged`, :5512-5515) calls BattleScript_ResolveAllHazards
// (data/battle_scripts_1.s:7690) = `dohazarddamage` (VARIOUS_DO_HAZARD_DAMAGE,
// battle_script_commands.c:8711-8830). The script chain runs the hazards in this
// order, each one `BattleScriptCall`-ing the next before it does its own work:
// Spikes -> Stealth Rock (ResolveRocks :7694) -> Toxic Spikes (ResolvePoisonSpikes
// :7698) -> Sticky Web (ResolveWebs :7702) -> Hot Coals (ResolveFireTrap :7706) ->
// Caltrops (ResolveCaltrops :7710). Every case opens with `IsBattlerAlive`
// (:8713), so a hazard that faints the mon stops the rest. The SECOND pass
// (abilities, items) only runs for a mon still alive -- switchIn.ts runs it
// after this function and skips it when the mon fainted.
//
// During this whole sequence gBattlerAttacker == gActiveBattler (:5497), which is
// why Heavy-Duty Boots, Tectonize and Shield Dust are tested on the switching
// mon itself and why grounding is evaluated with no Mold Breaker attacker.
//
// NOT ported, gapped only when the real condition holds: Hot Coals and Caltrops
// (:8798-8830, no writer anywhere in this sim) and SetOnMoveEffectReactionFlags
// after Toxic Spikes poisons. Sticky Web's setter (and so Mirror Armor's reflection)
// is state.stickyWebUser.
// SIDE_STATUS_STEALTH_ROCK_DAMAGED / STICKY_WEB_DAMAGED (:8750, :8795) are not
// written: nothing in the pinned source reads them and the second pass would
// clear them again.

import type { BattleState } from './state'
import type { SimDataContext } from './dataContext'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import type { TypeChart } from '../typeEffectiveness'
import { getTypeModifier, type TypeModifierInputs } from '../typeEffectiveness'
import { mulModifier, uq } from '../fixed'
import {
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS2_WRAPPED,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  STATUS3_MIRACLE_EYED,
  STATUS_FIELD_INVERSE_ROOM,
  STAT_SPEED,
  clearFlag,
  hasFlag,
} from './constants'
import { applyDamage } from './turn'
import { isMagicGuardProtected } from './endTurn'
import {
  B_MSG_DEFENDER_STAT_FELL,
  battlerHasSimAbility,
  changeStatBuffsImplicit,
  dispatchOnStatLowered,
  MOVE_EFFECT_AFFECTS_USER,
  STAT_BUFF_ALLOW_PTR,
  STAT_BUFF_NOT_PROTECT_AFFECTED,
} from './statBuffs'
import { canBePoisoned, MOVE_EFFECT_POISON, SET_STATE_ON_EFFECT_MAP } from './statusEffects'

/** The type tables GetStealthHazardDamage's GetTypeModifier calls need. Optional
 * on the turn loop's deps: a Stealth Rock switch-in without them is gapped, not
 * guessed. `inverseBattle` is FlagGet(B_FLAG_INVERSE_BATTLE). */
export interface HazardTypeDeps {
  typeChart: TypeChart
  inverseTypeChart: TypeChart
  inverseBattle: boolean
}

export interface HazardDeps {
  dataContext: SimDataContext
  grounding: GroundingContext
  hazardTypes?: HazardTypeDeps
}

/** gSideTimers.stealthRockType is a TYPE_* number (include/constants/pokemon.h);
 * this is the reverse of moveEffects.ts's TYPE_NAME_TO_ID, indexed by that number. */
export const TYPE_NAME_BY_ID = [
  'NORMAL', 'FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL', 'MYSTERY',
  'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'PSYCHIC', 'ICE', 'DRAGON', 'DARK', 'FAIRY', 'STELLAR',
] as const
export const TYPE_ROCK_ID = 5

/**
 * All 2 abilities with `bitfields.stealthRockImmune` in data/v2.65beta/abilityHooks.json
 * (IsBattlerAffectedByHazards, battle_util.c:8526).
 * Derived using:
 * grep -oP '"stealthRockImmune":"TRUE".*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const STEALTH_ROCK_IMMUNE_ABILITIES = ['ABILITY_MOLTEN_CORE', 'ABILITY_MOUNTAINEER'] as const

/**
 * The 1 ability with `bitfields.tectonizeImmunities` in data/v2.65beta/abilityHooks.json
 * (IsBattlerAffectedByHazards, battle_util.c:8527-8528).
 */
export const TECTONIZE_IMMUNITIES_ABILITIES = ['ABILITY_TECTONIZE'] as const

/**
 * All 2 abilities with `bitfields.mirrorArmor` in data/v2.65beta/abilityHooks.json
 * (BattleScript_StickyWebOnSwitchIn's `jumpifabilityflag BS_TARGET, ABILITY_MIRROR_ARMOR`,
 * data/battle_scripts_1.s:7759, matches by flag).
 */
export const MIRROR_ARMOR_ABILITIES = ['ABILITY_CRYSTALLINE_ARMOR', 'ABILITY_MIRROR_ARMOR'] as const

/** IsBattlerAffectedByHazards, battle_util.c:8522-8530. */
function isBattlerAffectedByHazards(state: BattleState, battlerId: number, stealthRock: boolean, spikes: boolean, deps: HazardDeps): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_HEAVY_DUTY_BOOTS') return false
  const has = (id: string) => battlerHasSimAbility(state, battler, id, false, battlerId, false, deps.dataContext)
  if (has('ABILITY_SHIELD_DUST')) return false
  if (stealthRock && STEALTH_ROCK_IMMUNE_ABILITIES.some(has)) return false
  if ((stealthRock || spikes) && battler.mon.types.includes('GROUND') && TECTONIZE_IMMUNITIES_ABILITIES.some(has)) return false
  return true
}

/** GetStealthHazardDamage, battle_util.c:8040-8079. Folds the hazard type against
 * the mon's (up to) three types with MulModifier; any product that is not exactly
 * 0.25/0.5/1/2/4 (e.g. 0.125) falls through the C's switch and deals no damage. */
function getStealthHazardDamage(state: BattleState, hazardTypeId: number, battlerId: number, types: HazardTypeDeps, grounding: GroundingContext): number {
  const battler = state.battlers[battlerId]
  if (!battler) return 0
  const hazardType = TYPE_NAME_BY_ID[hazardTypeId] ?? 'ROCK'
  const type1 = battler.mon.types[0] ?? 'MYSTERY'
  const type2 = battler.mon.types[1] ?? type1
  const type3 = battler.mon.types[2] ?? 'MYSTERY'
  // GetTypeModifier (battle_util.c:8021-8038): battlerAtk is MAX_BATTLERS_COUNT, so only the defender's Miracle Eye counts.
  const inputs: TypeModifierInputs = {
    isInverseRoomActive: !grounding.isCluelessOnField && hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM),
    isInverseBattleFlagSet: types.inverseBattle,
    attackerHasMiracleEye: false,
    defenderHasMiracleEye: hasFlag(battler.statuses3, STATUS3_MIRACLE_EYED),
  }
  const modifierFor = (defType: string) => getTypeModifier(hazardType, defType, types.typeChart, types.inverseTypeChart, inputs)

  let modifier = mulModifier(uq(1.0), modifierFor(type1))
  if (type2 !== type1) modifier = mulModifier(modifier, modifierFor(type2))
  if (type3 !== 'MYSTERY' && type3 !== type1 && type3 !== type2) modifier = mulModifier(modifier, modifierFor(type3))

  const divisor = { [uq(0.25)]: 32, [uq(0.5)]: 16, [uq(1.0)]: 8, [uq(2.0)]: 4, [uq(4.0)]: 2 }[modifier]
  if (divisor === undefined) return 0
  return Math.max(1, Math.trunc(battler.mon.maxHp / divisor))
}

function isAlive(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  return !!battler && battler.mon.hp > 0
}

/**
 * VARIOUS_DO_HAZARD_DAMAGE for every mode in script order (see this module's
 * header). `battlerId` is the freshly switched-in battler. Appends to
 * `unmodelled` only for the gaps the header lists.
 */
export function applySwitchInHazards(state: BattleState, battlerId: number, deps: HazardDeps, unmodelled: string[]): void {
  const side = state.sides[battlerId & 1]
  const opposite = battlerId ^ 1
  // gBattlerAttacker == gActiveBattler here (:5497), so Levitate is never mold-broken.
  const grounding: GroundingContext = { ...deps.grounding, attackerHasMoldBreaker: false }
  const grounded = () => isBattlerGrounded(state, battlerId, grounding)
  const fainted: number[] = []

  // HAZARD_MODE_SPIKES, :8730-8742.
  if (isAlive(state, battlerId) && hasFlag(side.statuses, SIDE_STATUS_SPIKES) && !isMagicGuardProtected(state, state.battlers[battlerId]!) && grounded() && isBattlerAffectedByHazards(state, battlerId, false, true, deps)) {
    const spikesDmg = (5 - side.timers.spikesAmount) * 2
    const dmg = Math.max(1, Math.trunc(state.battlers[battlerId]!.mon.maxHp / spikesDmg))
    applyDamage(state, battlerId, dmg, fainted, deps)
  }

  // HAZARD_MODE_ROCKS, :8744-8758.
  if (isAlive(state, battlerId) && hasFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)) {
    const hazardTypeId = side.timers.stealthRockType
    if (isBattlerAffectedByHazards(state, battlerId, hazardTypeId === TYPE_ROCK_ID, false, deps) && !isMagicGuardProtected(state, state.battlers[battlerId]!)) {
      if (!deps.hazardTypes) {
        unmodelled.push(`battler ${battlerId}: Stealth Rock damage (battle_script_commands.c:8751) is not applied -- no hazardTypes (type chart) was supplied in the deps`)
      } else {
        const dmg = getStealthHazardDamage(state, hazardTypeId, battlerId, deps.hazardTypes, grounding)
        if (dmg) applyDamage(state, battlerId, dmg, fainted, deps)
      }
    }
  }

  // HAZARD_MODE_POISON_SPIKES, :8760-8787.
  if (isAlive(state, battlerId) && hasFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES) && grounded()) {
    const battler = state.battlers[battlerId]!
    if (battler.mon.types.includes('POISON') || battlerHasSimAbility(state, battler, 'ABILITY_IMMUNITY', true, battlerId, false, deps.dataContext)) {
      side.statuses = clearFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)
      side.timers.toxicSpikesAmount = 0
    } else if (isBattlerAffectedByHazards(state, battlerId, false, false, deps) && canBePoisoned(state, opposite, battlerId, null, { dataContext: deps.dataContext, grounding })) {
      battler.mon.status1 |= side.timers.toxicSpikesAmount >= 2 ? STATUS1_TOXIC_POISON : STATUS1_POISON
      const foe = state.battlers[opposite]
      if (foe && (SET_STATE_ON_EFFECT_MAP[MOVE_EFFECT_POISON] ?? []).some((id) => battlerHasSimAbility(state, foe, id, false, opposite, false, deps.dataContext))) {
        unmodelled.push(`battler ${battlerId}: SetOnMoveEffectReactionFlags (battle_script_commands.c:8776-8782) is not applied after Toxic Spikes poisoned it`)
      }
    }
  }

  // HAZARD_MODE_WEBS, :8789-8798 + BattleScript_StickyWebOnSwitchIn (data/battle_scripts_1.s:7753-7771).
  if (isAlive(state, battlerId) && hasFlag(side.statuses, SIDE_STATUS_STICKY_WEB) && isBattlerAffectedByHazards(state, battlerId, false, false, deps) && grounded()) {
    const battler = state.battlers[battlerId]!
    // setattackertostickywebuser (VARIOUS_SET_ATTACKER_STICKY_WEB_USER, :8082-8088): gBattlerAttacker starts as the switching mon (the
    // "fail" condition) and becomes the web's setter when there is one. FaintClearSetData (battle_main.c:2990) unsets a user that has
    // fainted, so a slot whose mon is down counts as none.
    const webUser = state.stickyWebUser !== 0xff && isAlive(state, state.stickyWebUser) ? state.stickyWebUser : battlerId
    const statDeps = { dataContext: deps.dataContext, grounding }
    if (MIRROR_ARMOR_ABILITIES.some((id) => battlerHasSimAbility(state, battler, id, true, battlerId, false, deps.dataContext))) {
      // BattleScript_MirrorArmorReflectStickyWeb (data/battle_scripts_1.s:3711-3715): no user on the field -> no stat loss; otherwise
      // the user's Speed falls (MirrorArmorReflectStatLoss, :3693-3704, statbuffchange with MOVE_EFFECT_AFFECTS_USER).
      if (webUser !== battlerId) {
        changeStatBuffsImplicit(state, webUser, battlerId, -1, STAT_SPEED, MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | STAT_BUFF_ALLOW_PTR, true, statDeps, unmodelled)
      }
    } else {
      const res = changeStatBuffsImplicit(state, webUser, battlerId, -1, STAT_SPEED, STAT_BUFF_ALLOW_PTR, true, statDeps, unmodelled)
      if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (webUser & 1) !== (battlerId & 1)) {
        dispatchOnStatLowered(state, battlerId, webUser, statDeps, unmodelled)
      }
    }
  }

  // HAZARD_MODE_FIRE_TRAP (Hot Coals) and HAZARD_MODE_CALTROPS, :8800-8830.
  for (const [flag, name] of [[side.timers.hotCoals, 'Hot Coals'], [side.timers.caltrops, 'Caltrops']] as const) {
    if (flag && isAlive(state, battlerId) && isBattlerAffectedByHazards(state, battlerId, false, false, deps) && grounded()) {
      unmodelled.push(`battler ${battlerId}: ${name} entry hazard (battle_script_commands.c:8800-8830) is not applied`)
    }
  }
}

/**
 * Cmd_rapidspinfree, battle_script_commands.c:11367-11425, reached from
 * SetMoveEffect's MOVE_EFFECT_RAPIDSPIN case (:2837-2839). Acts on the ATTACKER
 * and the attacker's own side, in the C's order: wrap, Leech Seed, Caltrops,
 * Hot Coals, Sticky Web (unless Foamy Web), Toxic Spikes, Spikes, Stealth Rock.
 */
export function rapidSpinFree(state: BattleState, attackerId: number): void {
  const attacker = state.battlers[attackerId]
  const side = state.sides[attackerId & 1]
  if (attacker) {
    attacker.mon.status2 = clearFlag(attacker.mon.status2, STATUS2_WRAPPED)
    attacker.statuses3 = clearFlag(clearFlag(attacker.statuses3, STATUS3_LEECHSEED), STATUS3_LEECHSEED_BATTLER)
  }
  side.timers.caltrops = false
  side.timers.hotCoals = false
  if (hasFlag(side.statuses, SIDE_STATUS_STICKY_WEB) && !side.timers.foamyWeb) {
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
    side.timers.stickyWebTimer = 0
  }
  if (hasFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)) {
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)
    side.timers.toxicSpikesAmount = 0
  }
  if (hasFlag(side.statuses, SIDE_STATUS_SPIKES)) {
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_SPIKES)
    side.timers.spikesAmount = 0
  }
  if (hasFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)) {
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)
    side.timers.stealthRockType = 0
  }
}
