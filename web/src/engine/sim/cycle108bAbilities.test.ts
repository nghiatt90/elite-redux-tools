/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 108b: four switch-in abilities the simulator still reported as "onEntry hook was not run",
// plus Mimicry's onTerrain and Petal Shield's onDefender.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - Impl<ABILITY_TRACE>.onEntry (src/abilities.cc:951-974); IsRolePlayBannedAbility
//   (src/battle_util.c:8428-8436) with sRolePlayBannedAbilities (:90-95) and
//   IsPersistentOrUnsuppressableAbility (:4790); BattleScript_TraceActivatesEnd3
//   (data/battle_scripts_1.s:9514-9527), whose `switchinabilities BS_STACK_1` re-runs the
//   dispatcher so the copied ability's own onEntry fires.
// - Impl<ABILITY_IMPOSTER>.onEntry (src/abilities.cc:2161-2175); transformdataexecution
//   (src/battle_script_commands.c:10482-10533); BattleScript_ImposterActivates
//   (data/battle_scripts_1.s:10469-10477).
// - HandleMimicry (src/abilities.cc:3378-3440), Impl<ABILITY_MIMICRY>.onEntry/.onTerrain
//   (:3444-3449); SET_BATTLER_TYPE (include/battle.h:755-760); MimicryState
//   (include/battle_util.h:130-137); BattleScript_MimicryActivates/_Ends (:10200-10210).
// - Impl<ABILITY_PETAL_SHIELD>.onEntry/.onDefender (src/abilities.cc:12432-12446);
//   AbilityStatusEffectSafe (data/battle_scripts_1.s:10588-10594); SetMoveEffect's stat-drop
//   path (src/battle_script_commands.c:2765-2776).
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS2_SUBSTITUTE,
  STATUS2_TRANSFORMED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { applySwitchInAbilities } from './switchInAbility'
import { dispatchOnTerrainChange } from './onWeather'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { TurnLoopDeps } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: s.abilities[0] ?? null,
      innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

interface CountingRng extends RandomSource {
  calls: number
}

function countingRng(): CountingRng {
  const rng: CountingRng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  rngSource: RandomSource = { random16: () => 0 },
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: rngSource,
  })
}

const DUMMY_DAMAGE = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
}

const WEATHER_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING, statStageRatios: RATIOS }

function hasEntryGap(unmodelled: string[], abilityId: string): boolean {
  return unmodelled.some((m) => m.includes(`${abilityId}'s onEntry hook was not run`))
}

// ---------------------------------------------------------------------------
// Trace (src/abilities.cc:951-974)
// ---------------------------------------------------------------------------
describe('Cycle 108b - Trace (abilities.cc:951-974)', () => {
  function traceMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
    return monFor('SPECIES_MUDKIP', {
      abilities: { ability: 'ABILITY_TRACE', innates: [null, null, null] },
      ...overrides,
    })
  }
  function foeMon(ability: string | null): SimBattleMon {
    return monFor('SPECIES_TREECKO', { abilities: { ability, innates: [null, null, null] } })
  }

  it('copies the foe ability and the copied onEntry runs (Intimidate lowers the foe Atk)', () => {
    const state = battle(traceMon(), foeMon('ABILITY_INTIMIDATE'))
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

    // gBattleMons[battler].abilities[index] = newAbility (:967)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    // switchinabilities BS_STACK_1 (:9514-9527) -> the copied Intimidate's own onEntry
    // (UseIntimidateClone, battle_util.c:4064-4072) lowers the foe's Attack one stage.
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(hasEntryGap(unmodelled, 'ABILITY_TRACE')).toBe(false)
  })

  it.each<[string, string]>([
    ['ABILITY_WONDER_GUARD', 'sRolePlayBannedAbilities (battle_util.c:90-95)'],
    ['ABILITY_RECEIVER', 'sRolePlayBannedAbilities (battle_util.c:90-95)'],
    ['ABILITY_PRISMATIC_FUR', 'sRolePlayBannedAbilities (battle_util.c:90-95)'],
    ['ABILITY_TRACE', 'sRolePlayBannedAbilities (battle_util.c:90-95)'],
    ['ABILITY_MULTITYPE', 'IsPersistentOrUnsuppressableAbility (battle_util.c:4790)'],
  ])('does not copy %s (%s)', (foeAbility) => {
    const state = battle(traceMon(), foeMon(foeAbility))
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

    // The opposite battler is alive, so the partner fallback does not run; the copy is simply
    // skipped (CHECK_NOT(IsRolePlayBannedAbility)).
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_TRACE')
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(hasEntryGap(unmodelled, 'ABILITY_TRACE')).toBe(false)
  })

  it('does nothing when the foe is fainted and singles has no partner', () => {
    const state = battle(traceMon(), foeMon('ABILITY_INTIMIDATE'))
    state.battlers[1]!.mon.hp = 0
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

    // BATTLE_PARTNER(1) = 3, which is absent in singles -> CHECK(IsBattlerAlive(target)) fails.
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_TRACE')
    expect(hasEntryGap(unmodelled, 'ABILITY_TRACE')).toBe(false)
  })

  it('does not copy an ability the tracer already holds in another slot (HasAbilityIgnoringSuppression)', () => {
    const state = battle(
      traceMon({ abilities: { ability: 'ABILITY_INTIMIDATE', innates: ['ABILITY_TRACE', null, null] } }),
      foeMon('ABILITY_INTIMIDATE'),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

    expect(state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_TRACE')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    expect(hasEntryGap(unmodelled, 'ABILITY_TRACE')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Imposter (src/abilities.cc:2161-2175)
// ---------------------------------------------------------------------------
describe('Cycle 108b - Imposter (abilities.cc:2161-2175)', () => {
  const TARGET_STATS = { atk: 11, def: 12, spatk: 13, spdef: 14, spe: 15 }

  function imposterBattle(source: Partial<SimBattleMon> = {}, target: Partial<SimBattleMon> = {}): BattleState {
    const src = monFor('SPECIES_MUDKIP', {
      hp: 100,
      maxHp: 100,
      abilities: { ability: 'ABILITY_IMPOSTER', innates: [null, null, null] },
      ...source,
    })
    const foe = monFor('SPECIES_TREECKO', {
      hp: 70,
      maxHp: 150,
      rawStats: TARGET_STATS,
      moves: ['MOVE_GROWL', 'MOVE_ABSORB', null, null],
      pp: [40, 25, 0, 0],
      types: ['GRASS', 'MYSTERY', 'MYSTERY'],
      abilities: noAbility,
      ...target,
    })
    const state = battle(src, foe)
    state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    return state
  }

  it('becomes the foe (species, stats, types, moves, stages) but keeps its HP', () => {
    const state = imposterBattle()
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

    const me = state.battlers[0]!.mon
    expect(me.speciesId).toBe('SPECIES_TREECKO')
    // battle_script_commands.c:10502-10518 copies every battle stat except HP/maxHP.
    expect(me.rawStats).toEqual(TARGET_STATS)
    expect(me.types).toEqual(['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(me.moves).toEqual(['MOVE_GROWL', 'MOVE_ABSORB', null, null])
    expect(me.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(me.hp).toBe(100)
    expect(me.maxHp).toBe(100)
    // STATUS2_TRANSFORMED is set on the copier (:10493).
    expect(me.status2 & STATUS2_TRANSFORMED).not.toBe(0)
    expect(hasEntryGap(unmodelled, 'ABILITY_IMPOSTER')).toBe(false)
  })

  it('fails against an already Transformed foe (STATUS2_TRANSFORMED)', () => {
    const state = imposterBattle({}, { status2: STATUS2_TRANSFORMED })
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_IMPOSTER')
  })

  it('fails against a foe behind a Substitute (STATUS2_SUBSTITUTE)', () => {
    const state = imposterBattle({}, { status2: STATUS2_SUBSTITUTE })
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })

  it('fails against a semi-invulnerable foe (STATUS3_SEMI_INVULNERABLE)', () => {
    const state = imposterBattle()
    state.battlers[1]!.statuses3 |= STATUS3_SEMI_INVULNERABLE
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })

  it('fails when the holder is already Transformed', () => {
    const state = imposterBattle({ status2: STATUS2_TRANSFORMED })
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_IMPOSTER')
  })
})

// ---------------------------------------------------------------------------
// Mimicry (src/abilities.cc:3378-3449)
// ---------------------------------------------------------------------------
describe('Cycle 108b - Mimicry (abilities.cc:3378-3449)', () => {
  function mimicryMon(types: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']): SimBattleMon {
    return monFor('SPECIES_MUDKIP', {
      types,
      abilities: { ability: 'ABILITY_MIMICRY', innates: [null, null, null] },
    })
  }

  it('maps each terrain to its type on entry and saves the original type pair', () => {
    const cases: Array<[string, number]> = [
      ['ELECTRIC', STATUS_FIELD_ELECTRIC_TERRAIN],
      ['FAIRY', STATUS_FIELD_MISTY_TERRAIN],
      ['GRASS', STATUS_FIELD_GRASSY_TERRAIN],
      ['PSYCHIC', STATUS_FIELD_PSYCHIC_TERRAIN],
    ]
    for (const [type, terrainFlag] of cases) {
      const state = battle(mimicryMon())
      state.field.statuses = terrainFlag
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)

      // SET_BATTLER_TYPE (include/battle.h:755-760): type1 = type2 = terrain type, type3 = MYSTERY.
      expect(state.battlers[0]!.mon.types).toEqual([type, type, 'MYSTERY'])
      // MimicryState saved before the first SET_BATTLER_TYPE (:3414-3427).
      expect(state.battlers[0]!.volatiles.mimicryState).toEqual({ type1: 'WATER', type2: 'MYSTERY' })
      expect(hasEntryGap(unmodelled, 'ABILITY_MIMICRY')).toBe(false)
    }
  })

  it('changes type on a later terrain change, then restores the saved types when it ends', () => {
    const state = battle(mimicryMon())
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    // No terrain -> TYPE_NORMAL is falsy and the state is inactive: nothing happens.
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.volatiles.mimicryState).toBeNull()

    state.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.mon.types).toEqual(['ELECTRIC', 'ELECTRIC', 'MYSTERY'])

    state.field.statuses = 0
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    // Restore writes the saved type1/type2 and leaves type3 alone (:3403-3405).
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.volatiles.mimicryState).toBeNull()
  })

  it('restores the original types on Toxic Terrain (the TYPE_NORMAL default)', () => {
    const state = battle(mimicryMon())
    state.field.statuses = STATUS_FIELD_GRASSY_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.mon.types).toEqual(['GRASS', 'GRASS', 'MYSTERY'])

    // STATUS_FIELD_TOXIC_TERRAIN is not one of the four switch cases -> TYPE_NORMAL -> restore.
    state.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
  })

  it('does nothing and saves nothing when already that type', () => {
    const state = battle(mimicryMon(['ELECTRIC', 'MYSTERY', 'MYSTERY']))
    state.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    // IS_BATTLER_OF_TYPE is true -> FALSE, and the save happens only inside the not-of-type branch.
    expect(state.battlers[0]!.mon.types).toEqual(['ELECTRIC', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.volatiles.mimicryState).toBeNull()
  })

  it('keeps the ORIGINAL saved types across a second terrain change', () => {
    const state = battle(mimicryMon())
    state.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.volatiles.mimicryState).toEqual({ type1: 'WATER', type2: 'MYSTERY' })

    // Already active: :3414-3415 only saves when !state.active.
    state.field.statuses = STATUS_FIELD_PSYCHIC_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.mon.types).toEqual(['PSYCHIC', 'PSYCHIC', 'MYSTERY'])
    expect(state.battlers[0]!.volatiles.mimicryState).toEqual({ type1: 'WATER', type2: 'MYSTERY' })

    state.field.statuses = 0
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// Petal Shield (src/abilities.cc:12432-12446)
// ---------------------------------------------------------------------------
describe('Cycle 108b - Petal Shield (abilities.cc:12432-12446)', () => {
  function petalBattle(): BattleState {
    return battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PETAL_SHIELD', innates: [null, null, null] } }),
    )
  }

  function hit(state: BattleState, targetDamage: number, unmodelled: string[] = []) {
    return dispatchMoveEndDefenderAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: DATA_CONTEXT.move('MOVE_TACKLE'),
      targetDamage,
      hpDealt: targetDamage,
      deps: LOOP_DEPS,
      unmodelled,
      fainted: [],
    })
  }

  it('sets Def to MAX_STAT_STAGE (+6) on entry when below max', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PETAL_SHIELD', innates: [null, null, null] } }),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(hasEntryGap(unmodelled, 'ABILITY_PETAL_SHIELD')).toBe(false)
  })

  it('leaves Def alone when it is already at max (CHECK fails)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PETAL_SHIELD', innates: [null, null, null] } }),
    )
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    applySwitchInAbilities(state, 0, LOOP_DEPS, [])
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
  })

  it('drops the holder own Def by one on a damaging hit and disables Eject Pack', () => {
    const state = petalBattle()
    const res = hit(state, 20)
    // AbilityStatusEffectSafe(DEF_MINUS_1 | AFFECTS_USER, battler, attacker) makes the holder
    // gBattlerAttacker, so SetMoveEffect lowers the HOLDER's Def (battle_script_commands.c:2765-2776).
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[1]!.round.disableEjectPack).toBe(true)
    expect(res.statChanges).toContainEqual({ battlerId: 1, stat: STAT_DEF, change: -1 })
  })

  it('does not drop or disable Eject Pack when CanLowerStat fails (Def already -6)', () => {
    const state = petalBattle()
    state.battlers[1]!.mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    const res = hit(state, 20)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[1]!.round.disableEjectPack).toBe(false)
    expect(res.statChanges).toEqual([])
  })

  it('sets the Eject Pack flag but the shared stat-drop block leaves Def untouched (Clear Body)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_MUDKIP', {
        abilities: { ability: 'ABILITY_CLEAR_BODY', innates: ['ABILITY_PETAL_SHIELD', null, null] },
      }),
    )
    const res = hit(state, 20)
    // CanLowerStat only reads the stage/Contrary (:9363 -> CompareStat :8545-8561), so the CHECK
    // passes and disableEjectPack is set before ChangeStatBuffs' own block rejects the drop.
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.round.disableEjectPack).toBe(true)
    expect(res.statChanges).toEqual([])
  })

  it('does nothing on a zero-damage hit (ShouldApplyOnHitEffect)', () => {
    const state = petalBattle()
    const res = hit(state, 0)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.round.disableEjectPack).toBe(false)
    expect(res.statChanges).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RNG: none of these hooks draws a random number
// ---------------------------------------------------------------------------
describe('Cycle 108b - no RNG draws', () => {
  it('Trace, Imposter, Mimicry and Petal Shield draw no random numbers', () => {
    const traceRng = countingRng()
    applySwitchInAbilities(
      battle(
        monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_TRACE', innates: [null, null, null] } }),
        monFor('SPECIES_TREECKO', { abilities: { ability: 'ABILITY_INTIMIDATE', innates: [null, null, null] } }),
        traceRng,
      ),
      0,
      LOOP_DEPS,
      [],
    )
    expect(traceRng.calls).toBe(0)

    const imposterRng = countingRng()
    const imposterState = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_IMPOSTER', innates: [null, null, null] } }),
      monFor('SPECIES_TREECKO', { abilities: noAbility }),
      imposterRng,
    )
    applySwitchInAbilities(imposterState, 0, LOOP_DEPS, [])
    expect(imposterRng.calls).toBe(0)

    const mimicryRng = countingRng()
    const mimicryState = battle(
      monFor('SPECIES_MUDKIP', {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: 'ABILITY_MIMICRY', innates: [null, null, null] },
      }),
      undefined,
      mimicryRng,
    )
    mimicryState.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    applySwitchInAbilities(mimicryState, 0, LOOP_DEPS, [])
    expect(mimicryRng.calls).toBe(0)

    const petalRng = countingRng()
    const petalState = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PETAL_SHIELD', innates: [null, null, null] } }),
      petalRng,
    )
    applySwitchInAbilities(petalState, 1, LOOP_DEPS, [])
    expect(petalRng.calls).toBe(0)
    dispatchMoveEndDefenderAbilities({
      state: petalState,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: DATA_CONTEXT.move('MOVE_TACKLE'),
      targetDamage: 20,
      hpDealt: 20,
      deps: LOOP_DEPS,
      unmodelled: [],
      fainted: [],
    })
    expect(petalRng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Negative: unrelated battlers are untouched and the old gap lines are gone
// ---------------------------------------------------------------------------
describe('Cycle 108b - negative', () => {
  it('a battler without the ability is untouched and produces no gap line', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_TREECKO', { abilities: noAbility }),
    )
    const before = [...state.battlers[0]!.mon.types]
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.types).toEqual(before)
    expect(state.battlers[0]!.volatiles.mimicryState).toBeNull()
    expect(unmodelled).toEqual([])
  })

  it('the four old onEntry gap lines no longer appear', () => {
    const unmodelled: string[] = []

    applySwitchInAbilities(
      battle(
        monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_TRACE', innates: [null, null, null] } }),
        monFor('SPECIES_TREECKO', { abilities: { ability: 'ABILITY_INTIMIDATE', innates: [null, null, null] } }),
      ),
      0,
      LOOP_DEPS,
      unmodelled,
    )
    applySwitchInAbilities(
      battle(
        monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_IMPOSTER', innates: [null, null, null] } }),
        monFor('SPECIES_TREECKO', { abilities: noAbility }),
      ),
      0,
      LOOP_DEPS,
      unmodelled,
    )
    const mimicryState = battle(
      monFor('SPECIES_MUDKIP', {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: 'ABILITY_MIMICRY', innates: [null, null, null] },
      }),
    )
    mimicryState.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    applySwitchInAbilities(mimicryState, 0, LOOP_DEPS, unmodelled)
    applySwitchInAbilities(
      battle(
        monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PETAL_SHIELD', innates: [null, null, null] } }),
      ),
      0,
      LOOP_DEPS,
      unmodelled,
    )

    for (const abilityId of ['ABILITY_TRACE', 'ABILITY_IMPOSTER', 'ABILITY_MIMICRY', 'ABILITY_PETAL_SHIELD']) {
      expect(hasEntryGap(unmodelled, abilityId)).toBe(false)
    }
  })
})
