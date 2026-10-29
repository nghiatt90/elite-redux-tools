// Mega Evolution and Primal Reversion in the battle simulator turn loop.
//
// Ported from eliteredux-source C sources at pinned SHA:
//
// 1. Form change primitive:
//    - VARIOUS_HANDLE_MEGA_EVO (src/battle_script_commands.c:7374-7426)
//    - VARIOUS_HANDLE_PRIMAL_REVERSION (src/battle_script_commands.c:7428-7489)
//    - RecalcBattlerStats (src/battle_script_commands.c:6618-6638)
//    - CalculateMonStatsWithoutRestoringPP / CalculateMonStatsMaster (src/pokemon.c:963-1040)
//    - RepopulateAbilities (src/battle_util.c:9281-9297)
//    - UpdateAbilityStateIndices (src/battle_util.c:8833-8862)
//    - UndoMegaEvolution (src/battle_util.c:8187-8215)
//
// 2. Trigger rules and decisions:
//    - CanMegaEvolve (src/battle_util.c:8124-8185)
//    - GetMegaEvolutionSpecies (src/battle_util.c:8092-8100)
//    - GetPrimalReversionSpecies (src/battle_util.c:8102-8110)
//    - AI decision: OpponentHandleChooseMove (src/battle_controller_opponent.c:1608-1611)
//      "if (CanMegaEvolve(gActiveBattler) && ItemId_GetHoldEffect(mon.item) != HOLD_EFFECT_PRIMAL_ORB) -> RET_MEGA_EVOLUTION"
//    - Player action selection: RET_MEGA_EVOLUTION (src/battle_main.c:3917-3918)
//
// 3. Execution timing:
//    - CheckMegaEvolutionBeforeTurn (src/battle_main.c:4513-4541)
//    - TryChangeTurnOrder / RecalculateMoveOrder(0, FALSE) (src/battle_main.c:4545-4549)
//    - BattleScript_MegaEvolution (data/battle_scripts_1.s:8399-8414)
//    - TryPrimalReversion (src/battle_util.c:3908-3920) called at battle start
//      (TryDoEventsBeforeFirstTurn, battle_main.c:3370-3372) and on switch-in
//      (Cmd_switchineffects, battle_script_commands.c:5519)
//    - UndoMegaEvolution on switch-out (CleanUpBattlerBeforeSwitchOut, battle_main.c:3007)
//      and battle end (BattleTurnPassed / BattleCleanUp, battle_main.c:4830)

import type { AbilitySlots } from '../abilities/dispatch'
import { calcHp, calcStat, DEFAULT_NATURE_STAT_TABLE } from '../stats'
import type { BattleStatKey, StatKey } from '../types'
import {
  B_SIDE_PLAYER,
  STATUS2_TRANSFORMED,
  WEATHER_ANY,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  hasFlag,
} from './constants'
import type { SimDataContext } from './dataContext'
import type { TurnLoopDeps } from './turn'
import { buildTurnOrderContext, isBattlerAlive } from './turn'
import type { ChosenAction, TurnOrder } from './turnOrder'
import { recalculateMoveOrder } from './turnOrder'
import type { BattleState, BattlerState } from './state'
import { ABILITY_SLOT_COUNT, SWITCH_IN_ABILITY_DONE_COUNT } from './state'
import { applySwitchInAbilities, type SwitchInAbilityDeps } from './switchInAbility'
import { isWeatherActive } from './onWeather'
import { battlerHasSimAbility } from './statBuffs'
import { findAbilitySlot } from './statusEffects'

export interface FormChangeDeps extends SwitchInAbilityDeps {}

/**
 * GetMegaEvolutionSpecies (src/battle_util.c:8092-8100):
 * Finds the target mega evolution species for (preEvoSpecies, heldItemId).
 */
export function getMegaEvolutionSpecies(
  speciesId: string,
  itemId: string | null,
  dataContext: SimDataContext,
): string | null {
  if (!itemId) return null
  if (dataContext.megaEvolutionSpecies) {
    return dataContext.megaEvolutionSpecies(speciesId, itemId) ?? null
  }
  const spec = dataContext.species(speciesId)
  if (spec?.megas) {
    for (const m of spec.megas) {
      if (m && m.item === itemId) {
        return (m as unknown as { target?: string; to?: string }).target ??
          (m as unknown as { target?: string; to?: string }).to ??
          null
      }
    }
  }
  return null
}

/**
 * GetPrimalReversionSpecies (src/battle_util.c:8102-8110):
 * Finds the target primal reversion species for (preEvoSpecies, heldItemId).
 */
export function getPrimalReversionSpecies(
  speciesId: string,
  itemId: string | null,
  dataContext: SimDataContext,
): string | null {
  if (!itemId) return null
  if (dataContext.primalReversionSpecies) {
    return dataContext.primalReversionSpecies(speciesId, itemId) ?? null
  }
  const spec = dataContext.species(speciesId)
  if (spec?.primals) {
    for (const p of spec.primals) {
      if (p && p.item === itemId) {
        return (p as unknown as { target?: string; to?: string }).target ??
          (p as unknown as { target?: string; to?: string }).to ??
          null
      }
    }
  }
  return null
}

/**
 * CanMegaEvolve (src/battle_util.c:8124-8185):
 * Checks whether a battler can mega-evolve this turn.
 *
 * C QUIRK KEPT: battle_util.c:8148-8158 gates alreadyEvolved only for B_SIDE_PLAYER.
 * For the opponent side (B_SIDE_OPPONENT), the C does not gate on alreadyEvolved;
 * it relies on GetMegaEvolutionSpecies returning SPECIES_NONE once already in mega form.
 */
export function canMegaEvolve(
  state: BattleState,
  battlerId: number,
  dataContext: SimDataContext,
): boolean {
  if (!isBattlerAlive(state, battlerId)) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false

  const side = battlerId & 1
  const battlerPosition = battlerId
  const partyMon = state.sides[side].party[battler.partyIndex]
  const speciesId = partyMon?.speciesId ?? battler.mon.speciesId
  const itemId = battler.mon.itemId
  if (!itemId) return false

  // Check if trainer already mega evolved a pokemon (battle_util.c:8148-8158)
  if (side === B_SIDE_PLAYER) {
    const holdEffect = dataContext.item(itemId)?.resolvedHoldEffect ?? null
    if (state.mega.alreadyEvolved[battlerPosition] && holdEffect !== 'HOLD_EFFECT_PRIMAL_ORB') {
      return false
    }
  }

  // Check if there is an entry in the evolution table for regular Mega Evolution (battle_util.c:8161)
  const megaSpecies = getMegaEvolutionSpecies(speciesId, itemId, dataContext)
  if (megaSpecies !== null) {
    // battle_util.c:8162: if (isMagicRoomActive()) return FALSE;
    if (state.field.timers.magicRoomTimer > 0) return false
    return true
  }

  return false
}

/**
 * UpdateAbilityStateIndices (src/battle_util.c:8833-8862):
 * Remaps switchInAbilityDone, turnAbilityTriggers, and abilityState arrays when
 * a battler changes form / species. If an ability was already present in the old
 * form, its state index is preserved; newly gained abilities start fresh (0/false),
 * allowing their switch-in entry effects to fire.
 */
export function updateAbilityStateIndices(
  battler: BattlerState,
  newAbilities: AbilitySlots,
): void {
  const oldList: (string | null)[] = [
    battler.mon.abilities.ability,
    battler.mon.abilities.innates[0],
    battler.mon.abilities.innates[1],
    battler.mon.abilities.innates[2],
  ]
  const newList: (string | null)[] = [
    newAbilities.ability,
    newAbilities.innates[0],
    newAbilities.innates[1],
    newAbilities.innates[2],
  ]

  const newSwitchInAbilityDone = new Array<boolean>(SWITCH_IN_ABILITY_DONE_COUNT).fill(false)
  const newTurnAbilityTriggers = new Array<number>(ABILITY_SLOT_COUNT).fill(0)
  const newAbilityState = new Array<number>(ABILITY_SLOT_COUNT).fill(0)

  for (let i = 0; i < ABILITY_SLOT_COUNT; i++) {
    let j = 0
    for (; j < ABILITY_SLOT_COUNT; j++) {
      if (newList[i] !== null && newList[i] === oldList[j]) {
        break
      }
    }
    if (j >= ABILITY_SLOT_COUNT) continue
    newSwitchInAbilityDone[i] = battler.volatiles.switchInAbilityDone[j] ?? false
    newTurnAbilityTriggers[i] = battler.turn.turnAbilityTriggers[j] ?? 0
    newAbilityState[i] = battler.volatiles.abilityState[j] ?? 0
  }

  battler.volatiles.switchInAbilityDone = newSwitchInAbilityDone
  battler.turn.turnAbilityTriggers = newTurnAbilityTriggers
  battler.volatiles.abilityState = newAbilityState
}

/**
 * CalculateMonStatsMaster's stat part (src/pokemon.c:969-1048) for a mon that changes form: the mon's own EVs are
 * re-read (enableEvs defaults on, src/new_game.c:96), IVs are 31 (Speed 0 under the iron-pill flag).
 */
function formStats(
  mon: { level: number; nature: string; speedDown: boolean; evs?: Record<StatKey, number> },
  baseStats: { hp: number; atk: number; def: number; spatk: number; spdef: number; spe: number },
  speciesId: string,
): { rawStats: Record<BattleStatKey, number>; maxHp: number } {
  const evs: Record<StatKey, number> = {
    hp: mon.evs?.hp ?? 0,
    atk: mon.evs?.atk ?? 0,
    def: mon.evs?.def ?? 0,
    spatk: mon.evs?.spatk ?? 0,
    spdef: mon.evs?.spdef ?? 0,
    spe: mon.evs?.spe ?? 0,
  }
  const iv = (stat: StatKey): number => (stat === 'spe' && mon.speedDown ? 0 : 31)
  const t = DEFAULT_NATURE_STAT_TABLE
  return {
    rawStats: {
      atk: calcStat(baseStats.atk, iv('atk'), evs.atk, mon.level, mon.nature, 'atk', t),
      def: calcStat(baseStats.def, iv('def'), evs.def, mon.level, mon.nature, 'def', t),
      spatk: calcStat(baseStats.spatk, iv('spatk'), evs.spatk, mon.level, mon.nature, 'spatk', t),
      spdef: calcStat(baseStats.spdef, iv('spdef'), evs.spdef, mon.level, mon.nature, 'spdef', t),
      spe: calcStat(baseStats.spe, iv('spe'), evs.spe, mon.level, mon.nature, 'spe', t),
    },
    maxHp: calcHp(baseStats.hp, iv('hp'), evs.hp, mon.level, speciesId === 'SPECIES_SHEDINJA' || speciesId === 'SPECIES_SHEDINJA_MEGA'),
  }
}

/**
 * Form change primitive:
 * Ports VARIOUS_HANDLE_FORM_CHANGE & RecalcBattlerStats (src/battle_script_commands.c:7374-7514, 6618-6638).
 *
 * What changes:
 *   - speciesId
 *   - rawStats (recomputed via calculateRawStats using new species base stats)
 *   - types (from new species)
 *   - abilities (primary ability + 3 innates)
 *   - ability state indices (via updateAbilityStateIndices)
 *   - party record (SimPartyMon for this battler)
 *
 * What does NOT change:
 *   - hp and maxHp (Mega Evolution base HP is unchanged in C)
 *   - level, nature, speedDown (IVs/EVs)
 *   - itemId
 *   - moves, pp
 *   - status1, status2, statStages, gender, hiddenPowerType
 */
export function changeBattlerForm(
  state: BattleState,
  battlerId: number,
  newSpeciesId: string,
  dataContext: SimDataContext,
): void {
  const battler = state.battlers[battlerId]
  if (!battler) return

  const speciesData = dataContext.species(newSpeciesId)
  if (!speciesData) return

  const newTypes: [string, string, string] = [
    speciesData.types[0] ?? 'MYSTERY',
    speciesData.types[1] ?? 'MYSTERY',
    speciesData.types[2] ?? 'MYSTERY',
  ]

  const newAbilities: AbilitySlots = {
    ability: speciesData.abilities[0] ?? null,
    innates: [
      speciesData.innates[0] ?? null,
      speciesData.innates[1] ?? null,
      speciesData.innates[2] ?? null,
    ],
  }

  updateAbilityStateIndices(battler, newAbilities)

  battler.mon.speciesId = newSpeciesId
  battler.mon.types = newTypes
  battler.mon.abilities = newAbilities
  // RecalcBattlerStats -> CalculateMonStatsMaster (src/battle_script_commands.c:6618, src/pokemon.c:1040-1046):
  // current HP moves by the max-HP delta.
  const stats = formStats(battler.mon, speciesData.baseStats, newSpeciesId)
  battler.mon.rawStats = stats.rawStats
  const oldMaxHp = battler.mon.maxHp
  battler.mon.maxHp = stats.maxHp
  if (battler.mon.hp !== 0) {
    battler.mon.hp += stats.maxHp - oldMaxHp
    if (battler.mon.hp <= 0) battler.mon.hp = 1
  }

  // Persist species and stats to the party record (src/battle_script_commands.c:7409-7410, REQUEST_SPECIES_BATTLE)
  const side = battlerId & 1
  const partyMon = state.sides[side].party[battler.partyIndex]
  if (partyMon) {
    partyMon.speciesId = newSpeciesId
    partyMon.types = newTypes
    partyMon.abilities = newAbilities
    partyMon.rawStats = battler.mon.rawStats
    partyMon.maxHp = battler.mon.maxHp
    partyMon.hp = battler.mon.hp
  }
}

/** GetAbilityState, src/battle_util.c:3974-3980: `gVolatileStructs[battler].abilityState[GetAbilityIndex(battler, ability)]`
 * (0 when the battler does not have the ability). */
function getAbilityStateOf(battler: BattlerState, abilityId: string): number {
  const slot = findAbilitySlot(battler.mon.abilities, abilityId)
  return slot === -1 ? 0 : (battler.volatiles.abilityState[slot] ?? 0)
}

/** `const HpTransformation gHpTransformations[]`, src/battle_util.c:3791-3805 (struct at include/battle_util.h:160-165).
 * `lowHpSpecies` is the form the mon takes while its HP is at or below `maxHP / hpFraction`;
 * `highHpSpecies` the form above it. */
const HP_TRANSFORMATIONS: readonly {
  ability: string
  lowHpSpecies: string
  highHpSpecies: string
  hpFraction: number
}[] = [
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_RED', highHpSpecies: 'SPECIES_MINIOR', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_BLUE', highHpSpecies: 'SPECIES_MINIOR_METEOR_BLUE', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_GREEN', highHpSpecies: 'SPECIES_MINIOR_METEOR_GREEN', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_INDIGO', highHpSpecies: 'SPECIES_MINIOR_METEOR_INDIGO', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_ORANGE', highHpSpecies: 'SPECIES_MINIOR_METEOR_ORANGE', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_VIOLET', highHpSpecies: 'SPECIES_MINIOR_METEOR_VIOLET', hpFraction: 2 },
  { ability: 'ABILITY_SHIELDS_DOWN', lowHpSpecies: 'SPECIES_MINIOR_CORE_YELLOW', highHpSpecies: 'SPECIES_MINIOR_METEOR_YELLOW', hpFraction: 2 },
  { ability: 'ABILITY_SCHOOLING', lowHpSpecies: 'SPECIES_WISHIWASHI', highHpSpecies: 'SPECIES_WISHIWASHI_SCHOOL', hpFraction: 4 },
  { ability: 'ABILITY_APE_SHIFT', lowHpSpecies: 'SPECIES_SLAKING_MEGA_APE_SHIFT', highHpSpecies: 'SPECIES_SLAKING_MEGA', hpFraction: 2 },
  { ability: 'ABILITY_REVELATION', lowHpSpecies: 'SPECIES_UNOWN', highHpSpecies: 'SPECIES_UNOWN_REVELATION', hpFraction: 4 },
  { ability: 'ABILITY_LOCUST_SWARM', lowHpSpecies: 'SPECIES_WISPYWASPY', highHpSpecies: 'SPECIES_WISPYWASPY_HIVEMIND', hpFraction: 4 },
]

/**
 * ShouldChangeFormHpBased, src/battle_util.c:3812-3906. Changes `battler`'s species in place when an
 * HP-threshold form ability says it should; returns TRUE when a change happened.
 *
 * The C writes `gBattleMons[battler].species` and calls UpdateAbilityStateIndicesForNewSpecies
 * (:8822-8831); `changeBattlerForm` performs both here (plus the stat recalc the following
 * `handleformchange` script command does). A species missing from the data is a no-op, like
 * changeBattlerForm's other callers.
 */
export function shouldChangeFormHpBased(state: BattleState, battlerId: number, deps: FormChangeDeps): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const species = battler.mon.speciesId

  if (hasFlag(battler.mon.status2, STATUS2_TRANSFORMED)) return false
  if (!isBattlerAlive(state, battlerId)) return false

  for (const transformation of HP_TRANSFORMATIONS) {
    if (!battlerHasSimAbility(state, battler, transformation.ability, false, battlerId, false, deps.dataContext)) continue
    // abilities.cc:2836-2842: Schooling's onEntry/onEndTurn only fire at level 20+, and
    // ShouldChangeFormHpBased skips its table row below that.
    if (transformation.ability === 'ABILITY_SCHOOLING' && battler.mon.level < 20) continue
    if (
      species === transformation.lowHpSpecies &&
      battler.mon.hp > Math.trunc(battler.mon.maxHp / transformation.hpFraction)
    ) {
      // Shields Down reverts from core to Meteor only while its ability state is clear (:3824-3825).
      if (transformation.ability === 'ABILITY_SHIELDS_DOWN' && getAbilityStateOf(battler, 'ABILITY_SHIELDS_DOWN')) return false
      changeBattlerForm(state, battlerId, transformation.highHpSpecies, deps.dataContext)
      return true
    }
    if (
      species === transformation.highHpSpecies &&
      battler.mon.hp <= Math.trunc(battler.mon.maxHp / transformation.hpFraction)
    ) {
      changeBattlerForm(state, battlerId, transformation.lowHpSpecies, deps.dataContext)
      return true
    }
  }

  // Darmanitan (:3840-3847)
  if (species === 'SPECIES_DARMANITAN' && battlerHasSimAbility(state, battler, 'ABILITY_ZEN_MODE', false, battlerId, false, deps.dataContext) && battler.mon.hp !== 0) {
    changeBattlerForm(state, battlerId, 'SPECIES_DARMANITAN_ZEN_MODE', deps.dataContext)
    return true
  }

  // Darmanitan Galarian (:3849-3856)
  if (species === 'SPECIES_DARMANITAN_GALARIAN' && battlerHasSimAbility(state, battler, 'ABILITY_ZEN_MODE', false, battlerId, false, deps.dataContext) && battler.mon.hp !== 0) {
    changeBattlerForm(state, battlerId, 'SPECIES_DARMANITAN_ZEN_MODE_GALARIAN', deps.dataContext)
    return true
  }

  // Castform (:3858-3883): only the IsWeatherActive(WEATHER_ANY) probe is weather-immunity aware;
  // the per-weather selections below read the raw gBattleWeather bits, as the C does.
  const baseSpecies = deps.dataContext.species(species)?.formOf ?? species
  if (battlerHasSimAbility(state, battler, 'ABILITY_FORECAST', false, battlerId, false, deps.dataContext) && baseSpecies === 'SPECIES_CASTFORM') {
    let newSpecies = 'SPECIES_CASTFORM'
    if (isWeatherActive(state, WEATHER_ANY, deps.grounding)) {
      if (hasFlag(state.field.weather, WEATHER_RAIN_ANY)) newSpecies = 'SPECIES_CASTFORM_RAINY'
      else if (hasFlag(state.field.weather, WEATHER_SUN_ANY)) newSpecies = 'SPECIES_CASTFORM_SUNNY'
      else if (hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY)) newSpecies = 'SPECIES_CASTFORM_SANDY'
      else if (hasFlag(state.field.weather, WEATHER_FOG_ANY)) newSpecies = 'SPECIES_CASTFORM_FOGGY'
      else if (hasFlag(state.field.weather, WEATHER_HAIL_ANY)) newSpecies = 'SPECIES_CASTFORM_SNOWY'
    }
    if (newSpecies !== species) {
      changeBattlerForm(state, battlerId, newSpecies, deps.dataContext)
      return true
    }
  }

  // Cherrim (:3885-3903)
  if (species === 'SPECIES_CHERRIM' && battlerHasSimAbility(state, battler, 'ABILITY_FLOWER_GIFT', false, battlerId, false, deps.dataContext) && battler.mon.hp !== 0) {
    if (hasFlag(state.field.weather, WEATHER_SUN_ANY)) {
      changeBattlerForm(state, battlerId, 'SPECIES_CHERRIM_SUNSHINE', deps.dataContext)
      return true
    }
  } else if (
    species === 'SPECIES_CHERRIM_SUNSHINE' &&
    battlerHasSimAbility(state, battler, 'ABILITY_FLOWER_GIFT', false, battlerId, false, deps.dataContext) &&
    battler.mon.hp !== 0
  ) {
    if (!hasFlag(state.field.weather, WEATHER_SUN_ANY)) {
      changeBattlerForm(state, battlerId, 'SPECIES_CHERRIM', deps.dataContext)
      return true
    }
  }

  return false
}

/**
 * TryTransformAttacker, src/abilities.cc:245-252. The form change's BattleScript_AttackerFormChange
 * (data/battle_scripts_1.s:8454-8462) ends in `switchinabilities BS_ATTACKER`, reproduced by
 * applySwitchInAbilities. The second, now redundant TRANSFORMED guard is kept as written.
 */
export function tryTransformAttacker(
  state: BattleState,
  battlerId: number,
  deps: FormChangeDeps,
  unmodelled: string[],
): boolean {
  if (!shouldChangeFormHpBased(state, battlerId, deps)) return false
  const battler = state.battlers[battlerId]
  if (!battler || hasFlag(battler.mon.status2, STATUS2_TRANSFORMED)) return false
  applySwitchInAbilities(state, battlerId, deps, unmodelled)
  return true
}

/**
 * BattleScript_MegaEvolution (data/battle_scripts_1.s:8399-8414) &
 * VARIOUS_HANDLE_MEGA_EVO (src/battle_script_commands.c:7374-7426).
 */
export function megaEvolveBattler(
  state: BattleState,
  battlerId: number,
  deps: FormChangeDeps,
  unmodelled: string[],
): string | null {
  if (!isBattlerAlive(state, battlerId)) return null
  const battler = state.battlers[battlerId]
  if (!battler) return null

  // battle_scripts_1.s:8400: jumpifroom STATUS_FIELD_MAGIC_ROOM, BattleScript_End2
  if (state.field.timers.magicRoomTimer > 0) return null

  const side = battlerId & 1
  const partyIndex = battler.partyIndex
  const oldSpecies = battler.mon.speciesId
  const megaSpecies = getMegaEvolutionSpecies(oldSpecies, battler.mon.itemId, deps.dataContext)
  if (!megaSpecies) return null

  // VARIOUS_HANDLE_MEGA_EVO case 0 (:7384-7392)
  state.mega.evolvedSpecies[battlerId] = oldSpecies
  if (side === B_SIDE_PLAYER) {
    state.mega.playerBaseSpecies[partyIndex] = oldSpecies
    state.mega.playerEvolvedSpecies = oldSpecies
  }

  // Change form and recalc stats (:7404-7415)
  changeBattlerForm(state, battlerId, megaSpecies, deps.dataContext)

  // VARIOUS_HANDLE_MEGA_EVO case 1 (:7416-7419)
  const holdEffect = battler.mon.itemId
    ? deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null
    : null
  if (holdEffect !== 'HOLD_EFFECT_PRIMAL_ORB') {
    state.mega.alreadyEvolved[battlerId] = true
    state.mega.evolvedPartyIds[side] |= 1 << partyIndex
  }

  // BattleScript_MegaEvolution:8412: switchinabilities BS_ATTACKER
  applySwitchInAbilities(state, battlerId, deps, unmodelled)

  return megaSpecies
}

/**
 * TryPrimalReversion (src/battle_util.c:3908-3920) &
 * VARIOUS_HANDLE_PRIMAL_REVERSION (src/battle_script_commands.c:7428-7489).
 */
export function tryPrimalReversion(
  state: BattleState,
  battlerId: number,
  deps: FormChangeDeps,
  _unmodelled: string[],
): boolean {
  if (!isBattlerAlive(state, battlerId)) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false

  const itemId = battler.mon.itemId
  if (!itemId) return false

  const holdEffect = deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null
  if (holdEffect !== 'HOLD_EFFECT_PRIMAL_ORB') return false

  const oldSpecies = battler.mon.speciesId
  const primalSpecies = getPrimalReversionSpecies(oldSpecies, itemId, deps.dataContext)
  if (!primalSpecies) return false

  const side = battlerId & 1
  const partyIndex = battler.partyIndex

  // VARIOUS_HANDLE_PRIMAL_REVERSION case 0 (:7438-7447)
  state.mega.primalRevertedSpecies[battlerId] = oldSpecies
  if (side === B_SIDE_PLAYER) {
    state.mega.playerBaseSpecies[partyIndex] = oldSpecies
    state.mega.playerPrimalRevertedSpecies = oldSpecies
  }

  // Change form and recalc stats (:7452-7482)
  changeBattlerForm(state, battlerId, primalSpecies, deps.dataContext)
  state.mega.primalRevertedPartyIds[side] |= 1 << partyIndex

  return true
}

/**
 * UndoMegaEvolution (src/battle_util.c:8187-8215):
 * Reverts player party mons from Mega / Primal form back to base species.
 * Called on player switch-out (battle_main.c:3007) and at battle end (battle_main.c:4830).
 */
export function undoMegaEvolution(
  state: BattleState,
  side: number,
  partyIndex: number,
  dataContext: SimDataContext,
): void {
  const partyMon = state.sides[side]?.party?.[partyIndex]
  if (!partyMon || !partyMon.speciesId) return

  // battle_util.c:8189: u16 baseSpecies = gBattleStruct->mega.playerBaseSpecies[monId];
  if (side === B_SIDE_PLAYER) {
    const baseSpecies = state.mega.playerBaseSpecies[partyIndex]
    if (baseSpecies && partyMon.speciesId !== baseSpecies) {
      partyMon.speciesId = baseSpecies
      const baseData = dataContext.species(baseSpecies)
      if (baseData) {
        partyMon.types = [
          baseData.types[0] ?? 'MYSTERY',
          baseData.types[1] ?? 'MYSTERY',
          baseData.types[2] ?? 'MYSTERY',
        ]
        partyMon.abilities = {
          ability: baseData.abilities[0] ?? null,
          innates: [
            baseData.innates[0] ?? null,
            baseData.innates[1] ?? null,
            baseData.innates[2] ?? null,
          ],
        }
        const stats = formStats(partyMon, baseData.baseStats, baseSpecies)
        partyMon.rawStats = stats.rawStats
        if (partyMon.hp !== 0) partyMon.hp = Math.max(1, partyMon.hp + stats.maxHp - partyMon.maxHp)
        partyMon.maxHp = stats.maxHp
      }
    }
    state.mega.evolvedPartyIds[side] &= ~(1 << partyIndex)
    state.mega.primalRevertedPartyIds[side] &= ~(1 << partyIndex)
  }
}

/**
 * CheckMegaEvolutionBeforeTurn (src/battle_main.c:4513-4541) &
 * TryChangeTurnOrder (src/battle_main.c:4545-4549).
 *
 * Runs before the turn's actions:
 *   1. Iterates battlers 0..battlersCount-1.
 *   2. For each battler flagged in toEvolve (and not noValidMoves), executes mega evolution.
 *   3. If any mon mega-evolved, recalculates turn order from index 0 using the updated speeds/priorities.
 */
export interface MegaEvolutionRecord {
  battlerId: number
  speciesId: string
  unmodelled: string[]
}

export function checkMegaEvolutionBeforeTurn(
  state: BattleState,
  actions: (ChosenAction | null)[],
  order: TurnOrder,
  deps: TurnLoopDeps,
): MegaEvolutionRecord[] {
  for (let i = 0; i < state.battlersCount; i++) {
    if (actions[i]?.action === 'USE_MOVE' && actions[i]?.mega) {
      state.mega.toEvolve |= 1 << i
    }
  }

  const evolved: MegaEvolutionRecord[] = []
  for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
    if (state.mega.toEvolve & (1 << battlerId)) {
      state.mega.toEvolve &= ~(1 << battlerId)
      const battler = state.battlers[battlerId]
      if (battler && !battler.round.noValidMoves) {
        const unmodelled: string[] = []
        const megaSpecies = megaEvolveBattler(state, battlerId, deps as FormChangeDeps, unmodelled)
        if (megaSpecies) evolved.push({ battlerId, speciesId: megaSpecies, unmodelled })
      }
    }
  }

  if (evolved.length > 0) {
    // TryChangeTurnOrder, battle_main.c:4545-4549: RecalculateMoveOrder(0, FALSE)
    // "In gen7, priority and speed are recalculated during the turn in which a pokemon mega evolves"
    const ctx = buildTurnOrderContext(state, deps)
    recalculateMoveOrder(order, state, actions, 0, false, ctx, deps.statStageRatios)
  }

  return evolved
}
