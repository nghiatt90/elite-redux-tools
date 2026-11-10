/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 157: Transform into Cramorant-Gulping/Gorging, then Gulp Missile's onDefender revert.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - Impl<ABILITY_GULP_MISSILE>.onDefender (src/abilities.cc:3275-3285): CHECK(ShouldApplyOnHitEffect
//   (attacker)), then the holder's species must be SPECIES_CRAMORANT_GORGING or _GULPING. The hook
//   does NOT check STATUS2_TRANSFORMED. It calls UpdateAbilityStateIndicesForNewSpecies(battler,
//   SPECIES_CRAMORANT) (:3279) and writes only gBattleMons[battler].species = SPECIES_CRAMORANT
//   (:3283) after the script. Scripts: Gorging data/battle_scripts_1.s:7799-7836 (paralysis),
//   Gulping :7837-7880 (STAT_DEF -1); gBattleMoveDamage = attacker.maxHP / 4, min 1 (:3280-3281).
// - Cmd_transformdataexecution (src/battle_script_commands.c:10482-10533): sets STATUS2_TRANSFORMED
//   (:10493), calls UpdateAbilityStateIndices(attacker, target->abilities) (:10505), then copies
//   species/stats/abilityNum/types/abilities[] (:10507-10520, abilityNum at :10513).
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, STAT_DEF, STATUS1_PARALYSIS, STATUS2_TRANSFORMED, hasFlag } from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import { getAbilityStateOf, setAbilityStateOf } from './endTurn'
import { applyTransformCopy } from './moveEffects'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { BattleState, SimBattleMon } from './state'
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

const DUMMY_DAMAGE = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
}

/** Battler 1's ability takes the hit; attacker 0 is the move user. */
function defenderHit(
  state: BattleState,
  moveId: string,
  targetDamage: number,
  deps: TurnLoopDeps = LOOP_DEPS,
) {
  return dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: DATA_CONTEXT.move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps,
    unmodelled: [],
    fainted: [],
  })
}

/**
 * Three battlers: 0 is a plain attacker with 100 max HP, 1 is the Transform user that
 * applyTransformCopy turns into the real form on battler 2, and 2 is the form built by monFor.
 * This is the Cmd_transformdataexecution copy path (:10482-10533); nothing about battler 1's
 * species/status2/abilities is hand-set.
 */
function transformedCramorantBattle(form: string): BattleState {
  const state = createBattleState({
    battlers: [
      createBattlerState(0, monFor('SPECIES_MUDKIP', { abilities: noAbility, maxHp: 100, hp: 100 }), 0),
      createBattlerState(1, monFor('SPECIES_MUDKIP', { abilities: noAbility }), 0),
      createBattlerState(2, monFor(form, { abilityNum: 2 }), 0),
    ],
    rng: { random16: () => 0 },
  })
  applyTransformCopy(state, 1, 2, { dataContext: DATA_CONTEXT })
  return state
}

const SEEDED_GULP_STATE = 7

describe('Cycle 157 - Transform into Cramorant, then Gulp Missile revert', () => {
  it('a transformed Gulping holder reverts and drops the attacker Def by one', () => {
    const state = transformedCramorantBattle('SPECIES_CRAMORANT_GULPING')
    const holder = state.battlers[1]!

    // applyTransformCopy copied the real Gulping form: species, STATUS2_TRANSFORMED, the ability
    // list (GULP_MISSILE is innate[0]) and abilityNum (battle_script_commands.c:10513).
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
    expect(hasFlag(holder.mon.status2, STATUS2_TRANSFORMED)).toBe(true)
    expect(holder.mon.abilities.innates[0]).toBe('ABILITY_GULP_MISSILE')
    expect(holder.mon.abilityNum).toBe(2)

    // Identity seed for the post-revert UpdateAbilityStateIndices check below.
    setAbilityStateOf(holder, 'ABILITY_GULP_MISSILE', SEEDED_GULP_STATE)

    const result = defenderHit(state, 'MOVE_TACKLE', 10)

    // gBattleMoveDamage = attacker.maxHP / 4 = 100 / 4 = 25 (abilities.cc:3280-3281).
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(result.attackerDamage).toBe(25)
    // BattleScript_GulpMissileDoDefense (data/battle_scripts_1.s:7860-7870): STAT_DEF, -1.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)

    // The C calls the state remap (:3279) and writes only the species on revert (:3283).
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT')

    // UpdateAbilityStateIndices (battle_util.c:8833-8862) remaps by ability identity. GULP_MISSILE
    // is innate[0] on both SPECIES_CRAMORANT_GULPING and SPECIES_CRAMORANT, so its state follows.
    expect(getAbilityStateOf(holder, 'ABILITY_GULP_MISSILE')).toBe(SEEDED_GULP_STATE)

    // abilityNum is part of the Transform copy (:10513) and the revert does not write it.
    // NOTE: the sim's changeBattlerForm also rewrites abilities[] and rawStats from the new
    // species (formChange.ts:341), while the C keeps the copied Cramorant-Gulping ability list;
    // that divergence is recorded in REPORT.md and deliberately not asserted either way here.
    expect(holder.mon.abilityNum).toBe(2)
  })

  it('a transformed Gorging holder reverts and paralyses the attacker', () => {
    const state = transformedCramorantBattle('SPECIES_CRAMORANT_GORGING')
    const holder = state.battlers[1]!
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT_GORGING')
    expect(holder.mon.abilities.innates[0]).toBe('ABILITY_GULP_MISSILE')

    const result = defenderHit(state, 'MOVE_TACKLE', 10)

    // Same maxHP / 4 damage to the attacker (abilities.cc:3280-3281).
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(result.attackerDamage).toBe(25)
    // BattleScript_GulpMissileDoParalyze (data/battle_scripts_1.s:7821-7835).
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT')
    // Gorging has no Def drop.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('a transformed base Cramorant is neither Gulping nor Gorging, so Gulp Missile does nothing', () => {
    const state = transformedCramorantBattle('SPECIES_CRAMORANT')
    const holder = state.battlers[1]!
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT')
    // The Transform copied the base form's ability list, so Gulp Missile is present but the
    // species CHECK at abilities.cc:3278 rejects it.
    expect(holder.mon.abilities.innates[0]).toBe('ABILITY_GULP_MISSILE')

    const result = defenderHit(state, 'MOVE_TACKLE', 10)

    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(result.attackerDamage).toBe(0)
    expect(holder.mon.speciesId).toBe('SPECIES_CRAMORANT')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('ShouldApplyOnHitEffect (damage dealt and attacker alive) gates the whole effect', () => {
    // Zero-damage hit: targetDamage > 0 fails.
    const zero = transformedCramorantBattle('SPECIES_CRAMORANT_GULPING')
    defenderHit(zero, 'MOVE_TACKLE', 0)
    expect(zero.battlers[0]!.mon.hp).toBe(100)
    expect(zero.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')

    // Fainted attacker: the attacker.alive half of ShouldApplyOnHitEffect fails.
    const fainted = transformedCramorantBattle('SPECIES_CRAMORANT_GULPING')
    fainted.battlers[0]!.mon.hp = 0
    const result = defenderHit(fainted, 'MOVE_TACKLE', 25)
    expect(result.attackerDamage).toBe(0)
    expect(fainted.battlers[0]!.mon.hp).toBe(0)
    expect(fainted.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
  })
})
