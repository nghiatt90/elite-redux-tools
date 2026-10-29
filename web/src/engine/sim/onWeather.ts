// BattleScript_OnWeatherChange (data/battle_scripts_1.s:9833-9841) and
// VARIOUS_ON_WEATHER_CHANGE (src/battle_script_commands.c:8183-8190).
//
// The script walks gBattlerAttacker over 0..gBattlersCount-1 with no alive or
// absent check, and each step runs ON_ABILITY (include/battle_util.h:269-275)
// with checkMoldBreaker FALSE: slots from the last innate down to the ability,
// skipping suppressed ones, calling every onWeather hook in place. The hooks
// mutate state immediately; only their messages are queued.

import type { BattleState } from './state'
import type { SimDataContext } from './dataContext'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import { canBeBurned, canBePoisoned, isTerrainActive } from './statusEffects'
import {
  DEFAULT_STAT_STAGE_RATIOS,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_ENRAGED,
  STATUS2_TRANSFORMED,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_SUN_ANY,
  hasFlag,
  setFlag,
} from './constants'
import {
  attackerHasMoldBreakerActive,
  battlerHasSimAbility,
  consumeHeldItem,
  getHighestStatId,
  isBattlerWeatherAffected,
  isSimAbilitySuppressed,
} from './statBuffs'
import { isBattlerAlive } from './turn'
import { weatherHasEffect } from './fieldEndTurn'
import { disableSwitchInAbility } from './switchInAbility'
import { tryTransformAttacker } from './formChange'

export interface OnWeatherDeps {
  dataContext: SimDataContext
  grounding: GroundingContext
  statStageRatios?: [number, number][]
}

/** ParadoxBoostSource, include/battle_util.h:109-113. */
export const PARADOX_BOOST_NOT_ACTIVE = 0
export const PARADOX_BOOSTER_ENERGY = 1
export const PARADOX_WEATHER_ACTIVE = 2

/** IsWeatherActive, src/battle_util.c:8638-8641. Exported for formChange.ts's ShouldChangeFormHpBased (:3861). */
export function isWeatherActive(state: BattleState, weather: number, grounding: GroundingContext): boolean {
  return hasFlag(state.field.weather, weather) && weatherHasEffect(state, grounding)
}

/** ProtosynthesisHandler, src/abilities.cc:6927-6967. abilityState packs ParadoxBoost
 * (include/battle_util.h:115-118) as `source:2` then `statId:3`. */
export function protosynthesisHandler(state: BattleState, battlerId: number, slot: number, deps: OnWeatherDeps, unmodelled: string[]): void {
  const battler = state.battlers[battlerId]!
  const source = (battler.volatiles.abilityState[slot] ?? 0) & 3
  const ratios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS
  const sun = isWeatherActive(state, WEATHER_SUN_ANY, deps.grounding)
  const hasBoosterEnergy = () => deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_BOOSTER_ENERGY'
  const activate = (boostSource: number) => {
    battler.volatiles.abilityState[slot] = boostSource | (getHighestStatId(state, battlerId, ratios) << 2)
  }
  // RemoveItem (battle_script_commands.c:2231) is UpdateBattlerItem alone; usedHeldItems
  // belongs to Cmd_removeitem, so consumeHeldItem's write to it is undone.
  const removeItem = () => {
    const used = battler.usedHeldItem
    consumeHeldItem(state, battler, unmodelled)
    battler.usedHeldItem = used
  }

  if (source === PARADOX_BOOST_NOT_ACTIVE && sun) {
    activate(PARADOX_WEATHER_ACTIVE)
  } else if (source === PARADOX_WEATHER_ACTIVE && !sun) {
    if (hasBoosterEnergy()) {
      activate(PARADOX_BOOSTER_ENERGY)
      removeItem()
    } else {
      battler.volatiles.abilityState[slot] = 0
    }
  } else if (source === PARADOX_BOOST_NOT_ACTIVE && hasBoosterEnergy()) {
    activate(PARADOX_BOOSTER_ENERGY)
    removeItem()
  }
}

/** QuarkDriveHandler, src/abilities.cc:6983-7023. abilityState packs ParadoxBoost
 * (include/battle_util.h:115-118) as `source:2` then `statId:3`. */
export function quarkDriveHandler(state: BattleState, battlerId: number, slot: number, deps: OnWeatherDeps, unmodelled: string[]): void {
  const battler = state.battlers[battlerId]!
  const source = (battler.volatiles.abilityState[slot] ?? 0) & 3
  const ratios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS
  const electric = isTerrainActive(state, STATUS_FIELD_ELECTRIC_TERRAIN, deps)
  const hasBoosterEnergy = () => deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_BOOSTER_ENERGY'
  const activate = (boostSource: number) => {
    battler.volatiles.abilityState[slot] = boostSource | (getHighestStatId(state, battlerId, ratios) << 2)
  }
  // RemoveItem (battle_script_commands.c:2231) is UpdateBattlerItem alone; usedHeldItems
  // belongs to Cmd_removeitem, so consumeHeldItem's write to it is undone.
  const removeItem = () => {
    const used = battler.usedHeldItem
    consumeHeldItem(state, battler, unmodelled)
    battler.usedHeldItem = used
  }

  if (source === PARADOX_BOOST_NOT_ACTIVE && electric) {
    activate(PARADOX_WEATHER_ACTIVE)
  } else if (source === PARADOX_WEATHER_ACTIVE && !electric) {
    if (hasBoosterEnergy()) {
      activate(PARADOX_BOOSTER_ENERGY)
      removeItem()
    } else {
      battler.volatiles.abilityState[slot] = 0
    }
  } else if (source === PARADOX_BOOST_NOT_ACTIVE && hasBoosterEnergy()) {
    activate(PARADOX_BOOSTER_ENERGY)
    removeItem()
  }
}

/** FlareBoostHandler, src/abilities.cc:2003-2013. */
export function flareBoostHandler(
  state: BattleState,
  battlerId: number,
  deps: { dataContext: SimDataContext; grounding: GroundingContext },
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (
    canBeBurned(state, battlerId, battlerId, deps) &&
    isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)
  ) {
    battler.mon.status1 = setFlag(battler.mon.status1, STATUS1_BURN)
    return true
  }
  return false
}

/** ToxicBoostHandler, src/abilities.cc:1981-1992. */
export function toxicBoostHandler(
  state: BattleState,
  battlerId: number,
  deps: { dataContext: SimDataContext; grounding: GroundingContext },
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (
    hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN) &&
    isBattlerGrounded(state, battlerId, deps.grounding) &&
    canBePoisoned(state, battlerId, battlerId, null, deps)
  ) {
    battler.mon.status1 = setFlag(battler.mon.status1, STATUS1_POISON)
    return true
  }
  return false
}

export function dispatchOnWeatherChange(state: BattleState, deps: OnWeatherDeps, unmodelled: string[]): void {
  for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
    const battler = state.battlers[battlerId]
    if (!battler) continue
    const { ability, innates } = battler.mon.abilities
    const slots = [ability, ...innates]

    for (let slot = slots.length - 1; slot >= 0; slot--) {
      const abilityId = slots[slot]
      if (!abilityId) continue
      if (isSimAbilitySuppressed(state, battler, abilityId, false, battlerId, false, deps.dataContext)) continue

      switch (abilityId) {
        case 'ABILITY_PROTOSYNTHESIS':
          protosynthesisHandler(state, battlerId, slot, deps, unmodelled)
          break
        case 'ABILITY_FLARE_BOOST':
          // FlareBoostHandler, src/abilities.cc:2003-2013.
          flareBoostHandler(state, battlerId, deps)
          break
        case 'ABILITY_MADNESS_ENHANCEMENT':
          // MadnessEnhancementHandler, src/abilities.cc:9934-9943.
          if (isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps) && !hasFlag(battler.mon.status2, STATUS2_ENRAGED)) {
            battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_ENRAGED)
          }
          break
        case 'ABILITY_CHRISTMAS_NIGHTMARE': {
          // abilities.cc onWeather: IsAbilityOnSide(GetBattlerSide(battler), ..) passes the
          // SIDE as a battler id, so it scans battlers `side` and `side ^ 2` (battle_util.c:
          // 4792-4799, alive + mold breaker vs gBattlerAttacker, the script's loop battler).
          if (!isWeatherActive(state, WEATHER_HAIL_ANY, deps.grounding)) break
          const side = battlerId & 1
          const attackerHasMB = attackerHasMoldBreakerActive(battler, deps)
          const holds = (id: number) => {
            const b = state.battlers[id]
            return !!b && isBattlerAlive(state, id) && battlerHasSimAbility(state, b, abilityId, true, battlerId, attackerHasMB, deps.dataContext)
          }
          const first = holds(side) ? side : holds(side ^ 2) ? side ^ 2 : -1
          if (first !== battlerId) break
          disableSwitchInAbility(state, battlerId, abilityId, deps.dataContext)
          disableSwitchInAbility(state, battlerId ^ 2, abilityId, deps.dataContext)
          break
        }
        case 'ABILITY_FORECAST':
        case 'ABILITY_FLOWER_GIFT':
          // Impl<ABILITY_FORECAST>.onWeather (abilities.cc:1249) and Flower Gift's alias (:1859):
          // TryTransformAttacker (:245-252) -> ShouldChangeFormHpBased (battle_util.c:3812-3906),
          // whose own guards reject a transformed or fainted battler.
          tryTransformAttacker(state, battlerId, deps, unmodelled)
          break
        case 'ABILITY_DISGUISE':
          // DisguiseReformHandler, src/abilities.cc:2846-2866.
          if (
            (battler.mon.speciesId === 'SPECIES_MIMIKYU_BUSTED' || battler.mon.speciesId === 'SPECIES_MIMIKYU_RAYQUAZA_BUSTED') &&
            isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps) &&
            !hasFlag(battler.mon.status2, STATUS2_TRANSFORMED)
          ) {
            unmodelled.push(`battler ${battlerId}: ABILITY_DISGUISE's fog reform (abilities.cc:2846-2866) is not applied -- species changes are not modelled`)
          }
          break
        case 'ABILITY_ICE_FACE':
          // IceFaceReformHandler, src/abilities.cc:3350-3360.
          if (
            battler.mon.speciesId === 'SPECIES_EISCUE_NOICE_FACE' &&
            isBattlerWeatherAffected(state, battlerId, WEATHER_HAIL_ANY, deps) &&
            !hasFlag(battler.mon.status2, STATUS2_TRANSFORMED)
          ) {
            unmodelled.push(`battler ${battlerId}: ABILITY_ICE_FACE's hail reform (abilities.cc:3350-3360) is not applied -- species changes are not modelled`)
          }
          break
      }
    }
  }
}

/**
 * BattleScript_OnTerrainChanged (data/battle_scripts_1.s:9947-9955) and
 * VARIOUS_ON_TERRAIN_CHANGE (src/battle_script_commands.c:8191-8198).
 *
 * Walks gBattlerAttacker over 0..gBattlersCount-1 with no alive or absent check,
 * and each step runs ON_ABILITY (include/battle_util.h:269-275) with checkMoldBreaker
 * FALSE: slots from the last innate down to the ability, skipping suppressed ones,
 * calling every onTerrain hook in place.
 */
export function dispatchOnTerrainChange(state: BattleState, deps: OnWeatherDeps, unmodelled: string[]): void {
  for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
    const battler = state.battlers[battlerId]
    if (!battler) continue
    const { ability, innates } = battler.mon.abilities
    const slots = [ability, ...innates]

    for (let slot = slots.length - 1; slot >= 0; slot--) {
      const abilityId = slots[slot]
      if (!abilityId) continue
      if (isSimAbilitySuppressed(state, battler, abilityId, false, battlerId, false, deps.dataContext)) continue

      switch (abilityId) {
        case 'ABILITY_QUARK_DRIVE':
          quarkDriveHandler(state, battlerId, slot, deps, unmodelled)
          break
        case 'ABILITY_TOXIC_BOOST':
          // ToxicBoostHandler, src/abilities.cc:1981-1992.
          toxicBoostHandler(state, battlerId, deps)
          break
      }
    }
  }
}

