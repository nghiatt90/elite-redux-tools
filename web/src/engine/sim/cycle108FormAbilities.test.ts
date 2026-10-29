/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 108: the nine form-change ability hooks the simulator still skipped.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - DisguiseReformHandler (src/abilities.cc:2846-2866), Impl<ABILITY_DISGUISE>.onEntry (:2868),
//   .onWeather (:2881)
// - IceFaceReformHandler (src/abilities.cc:3350-3361), .onEntry (:3363), .onWeather (:3366)
// - Impl<ABILITY_PATCHWORK>.onEntry = Impl<ABILITY_DISGUISE>.onEntry (src/abilities.cc:8637; its
//   onDefender curse half :8644-8656 stays unported)
// - ApeShiftHandler (src/abilities.cc:9047-9059), .onEntry (:9061), .onEndTurn (:9062),
//   .onDefender (:9063); BattleScript_ApeShift (data/battle_scripts_1.s:8472-8482),
//   BattleScript_DoRudeAwakening (:8464-8470), BattleScript_AllStatsUp (:7891-7925)
// - Impl<ABILITY_POWER_CONSTRUCT>.onEndTurn (src/abilities.cc:2924-2945)
// - Impl<ABILITY_HUNGER_SWITCH>.onEndTurn (src/abilities.cc:3546-3573) and Dual Shadow's alias
//   (src/abilities.cc:9567)
// - Impl<ABILITY_ZERO_TO_HERO>.onEntry (:7125-7135) / .onExit (:7136-7139)
// - DrakelpHeadReformHandler (src/abilities.cc:12044-12053), .onEntry (:12056), .onTerrain (:12057)
// - BattleScript_AttackerFormChange (data/battle_scripts_1.s:8454-8462), whose trailing
//   `switchinabilities BS_ATTACKER` is the applySwitchInAbilities recursion; End3 :8508-8510;
//   StackBattlerFormChange :8501-8506
//
// Every species id asserted below is read from data/v2.65beta/species.json at module load; the
// battle mons are built from that same data, including which slot each ability sits in (the
// form-change abilities live in innates[0] for Mimikyu/Eiscue/Morpeko/Palafin/Slaking here).
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { dispatchSwitchOutAbilities, type TurnLoopDeps } from './turn'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_PARALYSIS,
  STATUS1_SLEEP,
  STATUS2_TRANSFORMED,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import {
  apeShiftHandler,
  disguiseReformHandler,
  drakelpHeadReformHandler,
  iceFaceReformHandler,
} from './formChange'
import { dispatchOnTerrainChange, dispatchOnWeatherChange } from './onWeather'
import { runEndTurnEffects } from './endTurn'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import {
  applySwitchInAbilities,
  getSingleUseAbilityCounter,
  setSingleUseAbilityCounter,
} from './switchInAbility'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

interface RawSpecies {
  types: string[]
  abilities: (string | null)[]
  innates: (string | null)[]
}

function species(id: string): RawSpecies {
  const s = simData.speciesById.get(id) as RawSpecies | undefined
  if (!s) throw new Error(`species.json has no ${id}`)
  return s
}

// Verified at module load: the form pairs the C handlers switch between all exist in the pinned
// data (a missing pair would make every assertion below meaningless).
for (const id of [
  'SPECIES_MIMIKYU_BUSTED',
  'SPECIES_MIMIKYU',
  'SPECIES_MIMIKYU_RAYQUAZA_BUSTED',
  'SPECIES_MIMIKYU_RAYQUAZA',
  'SPECIES_EISCUE_NOICE_FACE',
  'SPECIES_EISCUE',
  'SPECIES_ZYGARDE',
  'SPECIES_ZYGARDE_10_POWER_CONSTRUCT',
  'SPECIES_ZYGARDE_COMPLETE',
  'SPECIES_MORPEKO',
  'SPECIES_MORPEKO_HANGRY',
  'SPECIES_MORPEKYLL',
  'SPECIES_MORPEKYLL_HANGRY',
  'SPECIES_PALAFIN',
  'SPECIES_PALAFIN_HERO',
  'SPECIES_SLAKING_MEGA',
  'SPECIES_SLAKING_MEGA_APE_SHIFT',
  'SPECIES_DRAGALGE_MEGA',
  'SPECIES_MUDKIP',
]) {
  species(id)
}

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = species(speciesId)
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

function rng(): RandomSource {
  return { random16: () => 0 }
}

function battle(a: SimBattleMon, b: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility })): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: rng(),
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
const END_TURN_DEPS = { grounding: GROUNDING, statStageRatios: RATIOS }
const FORM_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

function hasEntryGap(unmodelled: string[], abilityId: string): boolean {
  return unmodelled.some((m) => m.includes(`${abilityId}'s onEntry hook was not run`))
}
function hasEndTurnGap(unmodelled: string[], abilityId: string): boolean {
  return unmodelled.some((m) => m.includes(`${abilityId}'s onEndTurn hook was not run`))
}

describe('Cycle 108 - Disguise (abilities.cc:2846-2866, :2868, :2881)', () => {
  it('reforms MIMIKYU_BUSTED -> MIMIKYU in fog and runs switchinabilities', () => {
    const state = battle(monFor('SPECIES_MIMIKYU_BUSTED'))
    state.field.weather = WEATHER_FOG_ANY
    const unmodelled: string[] = []
    const changed = disguiseReformHandler(state, 0, FORM_DEPS, unmodelled)
    expect(changed).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MIMIKYU')
    // The reform's BattleScript_AttackerFormChange ends in `switchinabilities BS_ATTACKER`
    // (:8454-8462), so the new form's DISGUISE onEntry runs and immediately no-ops (its species
    // pair default returns FALSE); nothing is reported as unmodelled.
    expect(unmodelled).toEqual([])
  })

  it('does nothing without fog (CHECK(IsBattlerWeatherAffected(battler, WEATHER_FOG_ANY)))', () => {
    const state = battle(monFor('SPECIES_MIMIKYU_BUSTED'))
    const unmodelled: string[] = []
    expect(disguiseReformHandler(state, 0, FORM_DEPS, unmodelled)).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MIMIKYU_BUSTED')
    expect(unmodelled).toEqual([])
  })

  it('does nothing when STATUS2_TRANSFORMED is set', () => {
    const state = battle(monFor('SPECIES_MIMIKYU_BUSTED', { status2: STATUS2_TRANSFORMED }))
    state.field.weather = WEATHER_FOG_ANY
    expect(disguiseReformHandler(state, 0, FORM_DEPS, [])).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MIMIKYU_BUSTED')
  })

  it('the onWeather dispatcher reaches the reform and drops the old "species changes are not modelled" note', () => {
    const state = battle(monFor('SPECIES_MIMIKYU_BUSTED'))
    state.field.weather = WEATHER_FOG_ANY
    const unmodelled: string[] = []
    dispatchOnWeatherChange(state, WEATHER_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MIMIKYU')
    expect(unmodelled.some((m) => m.includes('species changes are not modelled'))).toBe(false)
  })
})

describe('Cycle 108 - Ice Face (abilities.cc:3350-3361, :3363, :3366)', () => {
  it('reforms EISCUE_NOICE_FACE -> EISCUE in hail', () => {
    const state = battle(monFor('SPECIES_EISCUE_NOICE_FACE'))
    state.field.weather = WEATHER_HAIL_ANY
    expect(iceFaceReformHandler(state, 0, FORM_DEPS, [])).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_EISCUE')
  })

  it('does nothing without hail', () => {
    const state = battle(monFor('SPECIES_EISCUE_NOICE_FACE'))
    expect(iceFaceReformHandler(state, 0, FORM_DEPS, [])).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_EISCUE_NOICE_FACE')
  })

  it('the onWeather dispatcher reaches the hail reform', () => {
    const state = battle(monFor('SPECIES_EISCUE_NOICE_FACE'))
    state.field.weather = WEATHER_HAIL_ANY
    const unmodelled: string[] = []
    dispatchOnWeatherChange(state, WEATHER_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_EISCUE')
    expect(unmodelled.some((m) => m.includes('species changes are not modelled'))).toBe(false)
  })
})

describe('Cycle 108 - Patchwork onEntry (abilities.cc:8637)', () => {
  it('runs the Disguise onEntry alias for the Rayquaza pair and reports no unrun hook', () => {
    // Data check: PATCHWORK is MIMIKYU_RAYQUAZA(_BUSTED)'s innates[0], DISGUISE's pair ids.
    expect(species('SPECIES_MIMIKYU_RAYQUAZA_BUSTED').innates[0]).toBe('ABILITY_PATCHWORK')
    const state = battle(monFor('SPECIES_MIMIKYU_RAYQUAZA_BUSTED', { abilities: { ability: 'ABILITY_PATCHWORK', innates: [null, null, null] } }))
    state.field.weather = WEATHER_FOG_ANY
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MIMIKYU_RAYQUAZA')
    expect(hasEntryGap(unmodelled, 'ABILITY_PATCHWORK')).toBe(false)
  })
})

describe('Cycle 108 - Power Construct end turn (abilities.cc:2924-2945)', () => {
  // ZYGARDE_10_POWER_CONSTRUCT data abilities are [AURA_BREAK, OVERWHELM, POWER_CONSTRUCT]; a real
  // mon chose POWER_CONSTRUCT as its ability. Its three innates come from the same species row.
  function zygarde(hp: number): BattleState {
    const s = species('SPECIES_ZYGARDE_10_POWER_CONSTRUCT')
    return battle(
      monFor('SPECIES_ZYGARDE_10_POWER_CONSTRUCT', {
        hp,
        maxHp: 200,
        abilities: { ability: 'ABILITY_POWER_CONSTRUCT', innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null] },
      }),
    )
  }

  it('changes to ZYGARDE_COMPLETE at exactly half HP (hp <= maxHP / 2)', () => {
    const state = zygarde(100)
    const { unmodelled } = runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ZYGARDE_COMPLETE')
    expect(hasEndTurnGap(unmodelled, 'ABILITY_POWER_CONSTRUCT')).toBe(false)
  })

  it('stays put one HP above the boundary (101 > 200 / 2)', () => {
    const state = zygarde(101)
    const { unmodelled } = runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ZYGARDE_10_POWER_CONSTRUCT')
    expect(hasEndTurnGap(unmodelled, 'ABILITY_POWER_CONSTRUCT')).toBe(false)
  })

  it('is inert on a non-Zygarde holder', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { hp: 10, maxHp: 200, abilities: { ability: 'ABILITY_POWER_CONSTRUCT', innates: [null, null, null] } }))
    const { unmodelled } = runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(hasEndTurnGap(unmodelled, 'ABILITY_POWER_CONSTRUCT')).toBe(false)
  })
})

describe('Cycle 108 - Hunger Switch / Dual Shadow end turn (abilities.cc:3546-3573, :9567)', () => {
  it('toggles MORPEKO -> MORPEKO_HANGRY, then back', () => {
    const state = battle(monFor('SPECIES_MORPEKO'))
    expect(state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_HUNGER_SWITCH')
    const first = runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MORPEKO_HANGRY')
    expect(hasEndTurnGap(first.unmodelled, 'ABILITY_HUNGER_SWITCH')).toBe(false)
    runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MORPEKO')
  })

  it('Dual Shadow delegates to the same toggle for MORPEKYLL', () => {
    const state = battle(monFor('SPECIES_MORPEKYLL'))
    expect(state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_DUAL_SHADOW')
    const { unmodelled } = runEndTurnEffects(state, [0], DATA_CONTEXT, END_TURN_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MORPEKYLL_HANGRY')
    expect(hasEndTurnGap(unmodelled, 'ABILITY_DUAL_SHADOW')).toBe(false)
  })
})

describe('Cycle 108 - Zero to Hero counter flow (abilities.cc:7125-7139)', () => {
  it('stays PALAFIN on the first switch-in, arms the counter on exit, then reforms on re-entry', () => {
    const state = battle(monFor('SPECIES_PALAFIN'))
    const entryNotes: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, entryNotes)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_PALAFIN') // CHECK(GetSingleUseAbilityCounter) fails
    expect(hasEntryGap(entryNotes, 'ABILITY_ZERO_TO_HERO')).toBe(false)
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ZERO_TO_HERO', DATA_CONTEXT)).toBe(0)

    const exitNotes: string[] = []
    dispatchSwitchOutAbilities(state, 0, undefined, LOOP_DEPS, exitNotes)
    // SetSingleUseAbilityCounter(battler, ability, TRUE): stored at
    // singleUseAbility[partyIndex=0][ability slot index=1 (innates[0])][side=0].
    expect(state.singleUseAbility[0]![1]![0]).toBe(1)
    expect(exitNotes.some((m) => m.includes('switch-out Zero to Hero'))).toBe(false)

    // A real switch-in rebuilds the battler (fresh volatiles); the counter store is per party
    // slot, so the armed value survives.
    state.battlers[0] = createBattlerState(0, monFor('SPECIES_PALAFIN'), 0)
    const reentryNotes: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, reentryNotes)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_PALAFIN_HERO')
    expect(hasEntryGap(reentryNotes, 'ABILITY_ZERO_TO_HERO')).toBe(false)
  })
})

describe('Cycle 108 - Drakelp Head reform (abilities.cc:12044-12053, :12056, :12057)', () => {
  function drakelp(): BattleState {
    // DRAGALGE_MEGA carries DRAKELP_HEAD in innates[2]; the counter is keyed to that slot.
    const state = battle(monFor('SPECIES_DRAGALGE_MEGA'))
    expect(state.battlers[0]!.mon.abilities.innates[2]).toBe('ABILITY_DRAKELP_HEAD')
    return state
  }

  it('a toxic terrain clears the single-use counter', () => {
    const state = drakelp()
    setSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', 1, DATA_CONTEXT)
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(0)
  })

  it('keeps the counter without the toxic terrain', () => {
    const state = drakelp()
    setSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', 1, DATA_CONTEXT)
    dispatchOnTerrainChange(state, WEATHER_DEPS, [])
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(1)
  })

  it('the onEntry pass also clears an armed counter under toxic terrain', () => {
    const state = drakelp()
    setSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', 1, DATA_CONTEXT)
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, LOOP_DEPS, unmodelled)
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(0)
    expect(hasEntryGap(unmodelled, 'ABILITY_DRAKELP_HEAD')).toBe(false)
  })

  it('the handler itself requires the counter (CHECK(GetSingleUseAbilityCounter))', () => {
    const state = drakelp()
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    expect(drakelpHeadReformHandler(state, 0, FORM_DEPS, [])).toBe(false)
  })
})

describe('Cycle 108 - Ape Shift (abilities.cc:9047-9059, :9061-9063)', () => {
  // SLAKING_MEGA's data row: ability UNSEEN_FIST, innates [APE_SHIFT, TRUANT, CRYSTALLIZE].
  // HP thresholds are ShouldChangeFormHpBased's (battle_util.c:3812-3906): the form swaps when
  // a SLAKING_MEGA holder is at or below maxHP / 2, and reverts when an APE_SHIFT holder is above.
  function slaking(overrides: Partial<SimBattleMon>): BattleState {
    return battle(monFor('SPECIES_SLAKING_MEGA', { maxHp: 200, ...overrides }))
  }

  it('onEntry at half HP: species swap + the holder status is cured (onEntry BS_ATTACKER == holder)', () => {
    const state = slaking({ hp: 200, status1: STATUS1_SLEEP })
    applySwitchInAbilities(state, 0, LOOP_DEPS, []) // full HP: no swap, just sets switchInAbilityDone
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA')

    state.battlers[0]!.mon.hp = 100 // exactly maxHP / 2
    const unmodelled: string[] = []
    expect(apeShiftHandler(state, 0, FORM_DEPS, unmodelled)).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')
    expect(state.battlers[0]!.mon.status1).toBe(0) // BattleScript_ApeShift -> curestatus BS_ATTACKER
    expect(hasEntryGap(unmodelled, 'ABILITY_APE_SHIFT')).toBe(false)
  })

  it('reverting above half HP does not run the status half', () => {
    const state = battle(monFor('SPECIES_SLAKING_MEGA_APE_SHIFT', { hp: 100, maxHp: 200, status1: STATUS1_SLEEP }))
    applySwitchInAbilities(state, 0, LOOP_DEPS, []) // low form at half HP: stays
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')

    state.battlers[0]!.mon.hp = 150 // above maxHP / 2 -> ShouldChangeFormHpBased reverts
    expect(apeShiftHandler(state, 0, FORM_DEPS, [])).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA')
    // BattleScript_ApeShift is only called when the species is now APE_SHIFT (:9053-9055).
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_SLEEP)
  })

  it('onDefender targets the move attacker for the status half (gBattlerAttacker is not the holder)', () => {
    const attackerMon = monFor('SPECIES_MUDKIP', { status1: STATUS1_SLEEP, abilities: noAbility })
    const defenderMon = monFor('SPECIES_SLAKING_MEGA', { hp: 200, maxHp: 200, status1: STATUS1_PARALYSIS })
    const state = battle(attackerMon, defenderMon)
    applySwitchInAbilities(state, 1, LOOP_DEPS, []) // full HP: sets the defender's switch-in flags
    state.battlers[1]!.mon.hp = 100

    const unmodelled: string[] = []
    const res = dispatchMoveEndDefenderAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: DATA_CONTEXT.move('MOVE_TACKLE'),
      targetDamage: 20,
      hpDealt: 20,
      deps: LOOP_DEPS,
      unmodelled,
      fainted: [],
    })
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')
    expect(state.battlers[0]!.mon.status1).toBe(0) // the ATTACKER was cured ...
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS) // ... not the holder
    expect(res.attackerDamage).toBe(0)
    expect(unmodelled.some((m) => m.includes('ABILITY_APE_SHIFT is not modelled yet'))).toBe(false)
  })

  it('a sleeping attacker holding Rude Awakening gets the five AllStatsUp bumps', () => {
    const attackerMon = monFor('SPECIES_MUDKIP', {
      status1: STATUS1_SLEEP,
      abilities: { ability: 'ABILITY_RUDE_AWAKENING', innates: [null, null, null] },
    })
    const defenderMon = monFor('SPECIES_SLAKING_MEGA', { hp: 200, maxHp: 200 })
    const state = battle(attackerMon, defenderMon)
    applySwitchInAbilities(state, 1, LOOP_DEPS, [])
    state.battlers[1]!.mon.hp = 100

    dispatchMoveEndDefenderAbilities({
      state,
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

    // VARIOUS_RUDE_AWAKENING (battle_script_commands.c:8895-8904): SetAbilityState(TRUE) ...
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    // ... then BattleScript_AllStatsUp (:7891-7925): ATK, DEF, SPEED, SPATK, SPDEF each +1.
    // The sim stores neutral as DEFAULT_STAT_STAGE (6, the C's stage + 6 encoding).
    const up = DEFAULT_STAT_STAGE + 1
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(up)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(up)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(up)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(up)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(up)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })
})
