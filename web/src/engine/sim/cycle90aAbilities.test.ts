/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Switch-in ability ports checked against the C: cycle 90a.
// Hospitality, Food Lovers, Soothing Aroma, Butter Up, Costar, Curious Medicine, Cheating Death, Molten Core,
// Overcast, Deep Fried, Taste the Rainbow, Rainbow Scales.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { applySwitchInAbilities, getSingleUseAbilityCounter } from './switchInAbility'
import type { GroundingContext } from './grounding'
import type { SimDataContext } from './dataContext'
import { TYPE_ROCK_ID } from './hazards'
import {
  DEFAULT_STAT_STAGE,
  PLEDGE_DURATION,
  SCREEN_DURATION,
  SIDE_STATUS_MIST,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_ENRAGED,
  STATUS2_NIGHTMARE,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_TERRAIN_PERMANENT,
  WEATHER_DURATION,
  WEATHER_FOG_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  hasFlag,
  setFlag,
} from './constants'

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: () => undefined,
  move: () => undefined,
}

const entryDeps = {
  grounding: GROUNDING,
  dataContext: DATA_CONTEXT,
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

interface Spec {
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  types?: [string, string, string]
  status1?: number
  status2?: number
  rawStats?: Partial<SimBattleMon['rawStats']>
}

function partyMon(status1 = 0): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

/** Battler i sits on side i & 1 and in party slot i >> 1 (doubles: 0/1 leads, 2/3 partners). */
function battle(specs: Spec[], rng: RandomSource, rosters?: { player: SimPartyMon[]; opponent: SimPartyMon[] }): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100, ...s.rawStats },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        i >> 1,
      ),
    ),
    ...(rosters ? { playerParty: rosters.player, opponentParty: rosters.opponent } : {}),
    rng,
  })
}

const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

const rng: RandomSource = { random16: () => 0 }

const notRun = (u: string[]) => u.filter((n) => n.includes('onEntry hook was not run'))

describe('Hospitality family (abilities.cc:8526-8537, 8540-8542, 10856-10859)', () => {
  it('heals the partner maxHP / 4, floored: 90 -> 22, 10 + 22 = 32', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 10, maxHp: 90 }, {}], rng)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[2]!.mon.hp).toBe(32)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(notRun(u)).toEqual([])
  })

  it('caps at maxHP (80 + 22 -> 90) and heals at least 1 (maxHP 3 -> 0 -> 1)', () => {
    const near = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 80, maxHp: 90 }, {}], rng)
    applySwitchInAbilities(near, 0, entryDeps, [])
    expect(near.battlers[2]!.mon.hp).toBe(90)

    const tiny = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 1, maxHp: 3 }, {}], rng)
    applySwitchInAbilities(tiny, 0, entryDeps, [])
    expect(tiny.battlers[2]!.mon.hp).toBe(2)
  })

  it('Food Lovers runs the same onEntry', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_FOOD_LOVERS') }, {}, { hp: 10, maxHp: 90 }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[2]!.mon.hp).toBe(32)
  })

  it('does nothing in singles, for a fainted partner, a full-HP partner, a heal-blocked or bleeding partner', () => {
    const singles = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}], rng)
    const u: string[] = []
    applySwitchInAbilities(singles, 0, entryDeps, u)
    expect(singles.battlers[0]!.mon.hp).toBe(100)
    expect(notRun(u)).toEqual([])

    const fainted = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 0, maxHp: 90 }, {}], rng)
    applySwitchInAbilities(fainted, 0, entryDeps, [])
    expect(fainted.battlers[2]!.mon.hp).toBe(0)

    const full = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 90, maxHp: 90 }, {}], rng)
    applySwitchInAbilities(full, 0, entryDeps, [])
    expect(full.battlers[2]!.mon.hp).toBe(90)

    const blocked = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 10, maxHp: 90 }, {}], rng)
    blocked.battlers[2]!.statuses3 = setFlag(0, STATUS3_HEAL_BLOCK)
    applySwitchInAbilities(blocked, 0, entryDeps, [])
    expect(blocked.battlers[2]!.mon.hp).toBe(10)

    const bleeding = battle(
      [{ abilities: hasAbility('ABILITY_HOSPITALITY') }, {}, { hp: 10, maxHp: 90, status1: STATUS1_BLEED }, {}],
      rng,
    )
    applySwitchInAbilities(bleeding, 0, entryDeps, [])
    expect(bleeding.battlers[2]!.mon.hp).toBe(10)
  })

  it("does not heal an opponent (BATTLE_PARTNER is battler ^ 2, not ^ 1)", () => {
    const state = battle([{ abilities: hasAbility('ABILITY_HOSPITALITY') }, { hp: 10 }, { hp: 100 }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[1]!.mon.hp).toBe(10)
  })
})

describe('Soothing Aroma (abilities.cc:6284-6307, BattleScript_HealAllPartyStatus, Cmd_healpartystatus Aromatherapy branch)', () => {
  it('cures the holder, its partner and every party slot, and clears Nightmare on the two actives', () => {
    const rosters = { player: [partyMon(STATUS1_BURN), partyMon(), partyMon(STATUS1_POISON), partyMon(STATUS1_BLEED)], opponent: [partyMon(STATUS1_BURN), partyMon()] }
    const state = battle(
      [
        { abilities: hasAbility('ABILITY_SOOTHING_AROMA'), status1: STATUS1_BURN, status2: STATUS2_NIGHTMARE },
        { status1: STATUS1_BURN },
        { status1: STATUS1_POISON, status2: STATUS2_NIGHTMARE },
        {},
      ],
      rng,
      rosters,
    )
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.status2).toBe(0)
    expect(state.battlers[2]!.mon.status1).toBe(0)
    expect(state.battlers[2]!.mon.status2).toBe(0)
    expect(state.sides[0].party.map((p) => p.status1)).toEqual([0, 0, 0, 0])
    // the other side is untouched
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[1].party[0]!.status1).toBe(STATUS1_BURN)
    expect(notRun(u)).toEqual([])
  })

  it('fires when only a reserve mon has a status (gate scans the whole party)', () => {
    const rosters = { player: [partyMon(), partyMon(STATUS1_POISON)], opponent: [partyMon(), partyMon()] }
    const state = battle([{ abilities: hasAbility('ABILITY_SOOTHING_AROMA') }, {}], rng, rosters)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.sides[0].party[1]!.status1).toBe(0)
  })

  it('fires in singles when only the holder is statused and the side carries no roster', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_SOOTHING_AROMA'), status1: STATUS1_BURN }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('does nothing when no party mon has a status: a bare Nightmare bit survives (the cure is gated on status1)', () => {
    const rosters = { player: [partyMon(), partyMon()], opponent: [partyMon(), partyMon()] }
    const state = battle([{ abilities: hasAbility('ABILITY_SOOTHING_AROMA'), status2: STATUS2_NIGHTMARE }, {}], rng, rosters)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.status2).toBe(STATUS2_NIGHTMARE)
  })

  it('an opposing mon\'s status does not satisfy the gate', () => {
    const rosters = { player: [partyMon(), partyMon()], opponent: [partyMon(STATUS1_BURN), partyMon()] }
    const state = battle([{ abilities: hasAbility('ABILITY_SOOTHING_AROMA'), status2: STATUS2_NIGHTMARE }, { status1: STATUS1_BURN }], rng, rosters)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.status2).toBe(STATUS2_NIGHTMARE)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
  })
})

describe('Butter Up (abilities.cc:8540-8542: Hospitality | Soothing Aroma)', () => {
  it('heals the partner and cures the party', () => {
    const rosters = { player: [partyMon(STATUS1_BURN), partyMon()], opponent: [partyMon(), partyMon()] }
    const state = battle([{ abilities: hasAbility('ABILITY_BUTTER_UP'), status1: STATUS1_BURN }, {}, { hp: 10, maxHp: 90 }, {}], rng, rosters)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[2]!.mon.hp).toBe(32)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.sides[0].party[0]!.status1).toBe(0)
    expect(notRun(u)).toEqual([])
  })

  it('both halves are evaluated even when the first has nothing to do (non-short-circuit |)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_BUTTER_UP'), status1: STATUS1_BURN }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('a bleeding partner is not healed but is still cured of the status by the aroma half', () => {
    const rosters = { player: [partyMon(), partyMon(STATUS1_BLEED)], opponent: [partyMon(), partyMon()] }
    const state = battle([{ abilities: hasAbility('ABILITY_BUTTER_UP') }, {}, { hp: 10, maxHp: 90, status1: STATUS1_BLEED }, {}], rng, rosters)
    applySwitchInAbilities(state, 0, entryDeps, [])
    // Hospitality runs first: bleed blocks the heal
    expect(state.battlers[2]!.mon.hp).toBe(10)
    expect(state.battlers[2]!.mon.status1).toBe(0)
  })
})

describe('Costar (abilities.cc:7145-7160)', () => {
  it('copies every stage ATK..EVASION from the live partner', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_COSTAR') }, {}, {}, {}], rng)
    state.battlers[2]!.mon.statStages[STAT_ATK] = 8
    state.battlers[2]!.mon.statStages[STAT_SPEED] = 5
    state.battlers[2]!.mon.statStages[STAT_EVASION] = 9
    state.battlers[0]!.mon.statStages[STAT_DEF] = 3
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(9)
    // the holder's own stage is overwritten with the partner's neutral one, not kept
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    // the partner is not modified
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(notRun(u)).toEqual([])
  })

  it('does nothing in singles or with a fainted partner', () => {
    const singles = battle([{ abilities: hasAbility('ABILITY_COSTAR') }, {}], rng)
    singles.battlers[0]!.mon.statStages[STAT_ATK] = 9
    singles.battlers[1]!.mon.statStages[STAT_ATK] = 3
    applySwitchInAbilities(singles, 0, entryDeps, [])
    expect(singles.battlers[0]!.mon.statStages[STAT_ATK]).toBe(9)

    const fainted = battle([{ abilities: hasAbility('ABILITY_COSTAR') }, {}, { hp: 0 }, {}], rng)
    fainted.battlers[2]!.mon.statStages[STAT_ATK] = 9
    applySwitchInAbilities(fainted, 0, entryDeps, [])
    expect(fainted.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('does not copy from an opponent (the partner is battler ^ 2)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_COSTAR') }, {}, {}, {}], rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = 10
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('Curious Medicine (abilities.cc:3578-3589)', () => {
  it('resets all of the partner\'s stages, leaving the holder\'s own', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_CURIOUS_MEDICINE') }, {}, {}, {}], rng)
    state.battlers[2]!.mon.statStages[STAT_ATK] = 9
    state.battlers[2]!.mon.statStages[STAT_SPEED] = 2
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[2]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(notRun(u)).toEqual([])
  })

  it('does nothing in singles, with a fainted partner, and never touches an opponent', () => {
    const singles = battle([{ abilities: hasAbility('ABILITY_CURIOUS_MEDICINE') }, {}], rng)
    singles.battlers[1]!.mon.statStages[STAT_ATK] = 9
    applySwitchInAbilities(singles, 0, entryDeps, [])
    expect(singles.battlers[1]!.mon.statStages[STAT_ATK]).toBe(9)

    const fainted = battle([{ abilities: hasAbility('ABILITY_CURIOUS_MEDICINE') }, {}, { hp: 0 }, {}], rng)
    fainted.battlers[2]!.mon.statStages[STAT_ATK] = 9
    applySwitchInAbilities(fainted, 0, entryDeps, [])
    expect(fainted.battlers[2]!.mon.statStages[STAT_ATK]).toBe(9)

    const doubles = battle([{ abilities: hasAbility('ABILITY_CURIOUS_MEDICINE') }, {}, {}, {}], rng)
    doubles.battlers[1]!.mon.statStages[STAT_ATK] = 9
    applySwitchInAbilities(doubles, 0, entryDeps, [])
    expect(doubles.battlers[1]!.mon.statStages[STAT_ATK]).toBe(9)
  })
})

describe('Cheating Death (abilities.cc:5418-5433): onEntry is message-only', () => {
  it('runs without an unrun-hook line and changes no state', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_CHEATING_DEATH') }, {}], rng)
    const before = JSON.stringify(state.battlers[0]!.mon)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(notRun(u)).toEqual([])
    expect(JSON.stringify(state.battlers[0]!.mon)).toBe(before)
    expect(state.battlers[0]!.statuses3).toBe(0)
  })
})

describe('Molten Core (abilities.cc:10637-10653)', () => {
  function rockSr(state: BattleState, side: number, type = TYPE_ROCK_ID) {
    state.sides[side].statuses = setFlag(0, SIDE_STATUS_STEALTH_ROCK)
    state.sides[side].timers.stealthRockType = type
  }

  it('Furnace half: +2 Speed (6 -> 8) with own-side Rock Stealth Rock, then the hazard is removed', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_MOLTEN_CORE') }, {}], rng)
    rockSr(state, 0)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
    expect(notRun(u)).toEqual([])
  })

  it('a non-Rock Stealth Rock is still removed but gives no Speed', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_MOLTEN_CORE') }, {}], rng)
    rockSr(state, 0, TYPE_ROCK_ID + 1)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })

  it('no Stealth Rock on the own side: no boost; the opposing side\'s hazard is left alone', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_MOLTEN_CORE') }, {}], rng)
    rockSr(state, 1)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
  })
})

describe('Overcast (abilities.cc:11727-11742)', () => {
  it('sets Mist (5 turns, setter recorded) on its side and Fog (8 turns)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_OVERCAST') }, {}], rng)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_MIST)).toBe(true)
    expect(state.sides[0].timers.mistTimer).toBe(SCREEN_DURATION)
    expect(state.sides[0].timers.mistBattlerId).toBe(0)
    expect(state.sides[0].timers.started.mist).toBe(true)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_MIST)).toBe(false)
    expect(hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(notRun(u)).toEqual([])
  })

  it('an enemy holder (battler 1) sets Mist on side 1', () => {
    const state = battle([{}, { abilities: hasAbility('ABILITY_OVERCAST') }], rng)
    applySwitchInAbilities(state, 1, entryDeps, [])
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_MIST)).toBe(true)
    expect(state.sides[1].timers.mistBattlerId).toBe(1)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_MIST)).toBe(false)
  })

  it('Mist already up: the timer is not restarted, Fog still comes', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_OVERCAST') }, {}], rng)
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_MIST)
    state.sides[0].timers.mistTimer = 2
    state.sides[0].timers.mistBattlerId = 7
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.sides[0].timers.mistTimer).toBe(2)
    expect(state.sides[0].timers.mistBattlerId).toBe(7)
    expect(hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY)).toBe(true)
  })

  it('primal weather blocks the Fog but not the Mist', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_OVERCAST') }, {}], rng)
    state.field.weather = WEATHER_SUN_PRIMAL
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_MIST)).toBe(true)
  })
})

describe('Deep Fried (abilities.cc:10845-10853)', () => {
  it('starts a Sea of Fire (3 turns) on the opposing side only', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_DEEP_FRIED') }, {}], rng)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.sides[1].timers.fireSeaTimer).toBe(PLEDGE_DURATION)
    expect(state.sides[1].timers.started.fireSea).toBe(true)
    expect(state.sides[0].timers.fireSeaTimer).toBe(0)
    expect(notRun(u)).toEqual([])
  })

  it('an enemy holder burns the player side, in doubles too', () => {
    const state = battle([{}, { abilities: hasAbility('ABILITY_DEEP_FRIED') }, {}, {}], rng)
    applySwitchInAbilities(state, 1, entryDeps, [])
    expect(state.sides[0].timers.fireSeaTimer).toBe(PLEDGE_DURATION)
    expect(state.sides[1].timers.fireSeaTimer).toBe(0)
  })

  it('an existing Sea of Fire is not restarted', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_DEEP_FRIED') }, {}], rng)
    state.sides[1].timers.fireSeaTimer = 1
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.sides[1].timers.fireSeaTimer).toBe(1)
    expect(state.sides[1].timers.started.fireSea).toBe(false)
  })
})

describe('Taste the Rainbow / Rainbow Scales (abilities.cc:11908-11923)', () => {
  it('start a Rainbow (3 turns) on the holder\'s own side', () => {
    for (const ability of ['ABILITY_TASTE_THE_RAINBOW', 'ABILITY_RAINBOW_SCALES']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], rng)
      const u: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, u)
      expect(state.sides[0].timers.rainbowTimer).toBe(PLEDGE_DURATION)
      expect(state.sides[0].timers.started.rainbow).toBe(true)
      expect(state.sides[1].timers.rainbowTimer).toBe(0)
      expect(notRun(u)).toEqual([])
    }
  })

  it('an existing Rainbow is not restarted', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_TASTE_THE_RAINBOW') }, {}], rng)
    state.sides[0].timers.rainbowTimer = 2
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.sides[0].timers.rainbowTimer).toBe(2)
    expect(state.sides[0].timers.started.rainbow).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Verify-and-classify batch: the ones whose hook (with its battle script) changes state
// ---------------------------------------------------------------------------

describe('Cloud Nine / Clueless (abilities.cc:654-659, :5412-5415; BattleScript_AnnounceAirLockCloudNine)', () => {
  it('removeweather: clears temporary rain and its duration', () => {
    for (const ability of ['ABILITY_CLOUD_NINE', 'ABILITY_CLUELESS']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], rng)
      state.field.weather = WEATHER_RAIN_TEMPORARY
      state.field.weatherDuration = 5
      const u: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, u)
      expect(state.field.weather).toBe(0)
      expect(state.field.weatherDuration).toBe(0)
      expect(notRun(u)).toEqual([])
    }
  })

  it('clears fog too (gBattleWeather = 0), but primal weather cannot be ended', () => {
    const fog = battle([{ abilities: hasAbility('ABILITY_CLOUD_NINE') }, {}], rng)
    fog.field.weather = WEATHER_FOG_TEMPORARY
    applySwitchInAbilities(fog, 0, entryDeps, [])
    expect(fog.field.weather).toBe(0)

    const primal = battle([{ abilities: hasAbility('ABILITY_CLOUD_NINE') }, {}], rng)
    primal.field.weather = WEATHER_SUN_PRIMAL
    applySwitchInAbilities(primal, 0, entryDeps, [])
    expect(primal.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('no weather: nothing to change', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_CLOUD_NINE') }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.field.weather).toBe(0)
  })

  it('reruns the weather-change hooks after removing: Madness Enhancement\'s enrage is not reapplied once the fog is gone', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_CLOUD_NINE') }, {}], rng)
    state.field.weather = WEATHER_FOG_TEMPORARY
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_ENRAGED)).toBe(false)
  })
})

describe('Frisk (abilities.cc:1826-1840; BattleScript_FriskActivates -> VARIOUS_TRY_FRISK, battle_script_commands.c:6817-6832)', () => {
  function withItem(state: BattleState, id: number, itemId: string | null) {
    state.battlers[id]!.mon.itemId = itemId
  }

  it('Embargoes every live opposing item holder for 2 turns', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_FRISK') }, {}, {}, {}], rng)
    withItem(state, 1, 'ITEM_LEFTOVERS')
    withItem(state, 3, 'ITEM_ORAN_BERRY')
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    for (const id of [1, 3]) {
      expect(hasFlag(state.battlers[id]!.statuses3, STATUS3_EMBARGO)).toBe(true)
      expect(state.battlers[id]!.volatiles.embargoTimer).toBe(2)
    }
    expect(notRun(u)).toEqual([])
  })

  it('skips item-less, fainted and same-side battlers; an existing Embargo keeps its timer', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_FRISK') }, {}, {}, { hp: 0 }], rng)
    withItem(state, 2, 'ITEM_LEFTOVERS') // partner
    withItem(state, 3, 'ITEM_LEFTOVERS') // fainted opponent
    withItem(state, 0, 'ITEM_LEFTOVERS') // the holder itself
    applySwitchInAbilities(state, 0, entryDeps, [])
    for (const id of [0, 1, 2, 3]) expect(hasFlag(state.battlers[id]!.statuses3, STATUS3_EMBARGO)).toBe(false)

    const already = battle([{ abilities: hasAbility('ABILITY_FRISK') }, {}], rng)
    withItem(already, 1, 'ITEM_LEFTOVERS')
    already.battlers[1]!.statuses3 = setFlag(0, STATUS3_EMBARGO)
    already.battlers[1]!.volatiles.embargoTimer = 4
    applySwitchInAbilities(already, 0, entryDeps, [])
    expect(already.battlers[1]!.volatiles.embargoTimer).toBe(4)
  })
})

describe('Comatose / Dreamscape / Anticipation / Supreme Overlord: onEntry is message-only', () => {
  it('runs with no unrun-hook line and no state change', () => {
    for (const ability of ['ABILITY_COMATOSE', 'ABILITY_DREAMSCAPE', 'ABILITY_ANTICIPATION', 'ABILITY_SUPREME_OVERLORD']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], rng)
      const before = JSON.stringify([state.battlers[0]!.mon, state.battlers[1]!.mon, state.field, state.sides])
      const u: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, u)
      expect(notRun(u)).toEqual([])
      expect(JSON.stringify([state.battlers[0]!.mon, state.battlers[1]!.mon, state.field, state.sides])).toBe(before)
    }
  })
})

describe('Madness Enhancement (abilities.cc:9934-9955)', () => {
  it('becomes enraged on entry in fog, not otherwise', () => {
    const fog = battle([{ abilities: hasAbility('ABILITY_MADNESS_ENHANCEMENT') }, {}], rng)
    fog.field.weather = WEATHER_FOG_TEMPORARY
    const u: string[] = []
    applySwitchInAbilities(fog, 0, entryDeps, u)
    expect(hasFlag(fog.battlers[0]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
    expect(notRun(u)).toEqual([])

    const clear = battle([{ abilities: hasAbility('ABILITY_MADNESS_ENHANCEMENT') }, {}], rng)
    applySwitchInAbilities(clear, 0, entryDeps, [])
    expect(hasFlag(clear.battlers[0]!.mon.status2, STATUS2_ENRAGED)).toBe(false)

    const rain = battle([{ abilities: hasAbility('ABILITY_MADNESS_ENHANCEMENT') }, {}], rng)
    rain.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(rain, 0, entryDeps, [])
    expect(hasFlag(rain.battlers[0]!.mon.status2, STATUS2_ENRAGED)).toBe(false)
  })
})

describe('Spyware (abilities.cc:10872-10904)', () => {
  const cases: Array<[string, Partial<SimBattleMon['rawStats']>, number]> = [
    ['Attack', { atk: 300 }, STAT_DEF],
    ['Defense', { def: 300 }, STAT_ATK],
    ['Sp. Atk', { spatk: 300 }, STAT_SPDEF],
    ['Sp. Def', { spdef: 300 }, STAT_SPATK],
    ['Speed', { spe: 300 }, STAT_SPEED],
  ]
  for (const [label, raw, raised] of cases) {
    it(`target's highest is ${label}: stat ${raised} +2 (6 -> 8)`, () => {
      const state = battle([{ abilities: hasAbility('ABILITY_SPYWARE') }, { rawStats: raw }], rng)
      const u: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, u)
      for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        expect(state.battlers[0]!.mon.statStages[stat]).toBe(stat === raised ? DEFAULT_STAT_STAGE + 2 : DEFAULT_STAT_STAGE)
      }
      expect(notRun(u)).toEqual([])
    })
  }

  it('is capped by the stage limit: already +6 stays +6', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_SPYWARE') }, { rawStats: { spe: 300 } }], rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = 12
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(12)
  })
})

describe('Power of Alchemy (abilities.cc:3077-3091)', () => {
  const alchemyDeps = {
    grounding: GROUNDING,
    dataContext: {
      ...DATA_CONTEXT,
      item: (id: string) => ({
        id,
        resolvedHoldEffect: null,
        holdEffectStrength: null,
        holdEffectType: null,
        naturalGift: null,
        grouping: id.endsWith('_BERRY') ? 'POCKET_BERRIES' : 'POCKET_MEDICINE',
      }),
    } as SimDataContext,
  }

  it('turns each live opposing berry into Black Sludge and leaves other items and its own side alone', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_POWER_OF_ALCHEMY') }, {}, {}, {}], rng)
    state.battlers[0]!.mon.itemId = 'ITEM_ORAN_BERRY'
    state.battlers[1]!.mon.itemId = 'ITEM_SITRUS_BERRY'
    state.battlers[2]!.mon.itemId = 'ITEM_LUM_BERRY'
    state.battlers[3]!.mon.itemId = 'ITEM_LEFTOVERS'
    const u: string[] = []
    applySwitchInAbilities(state, 0, alchemyDeps, u)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_BLACK_SLUDGE')
    expect(state.battlers[3]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(state.battlers[2]!.mon.itemId).toBe('ITEM_LUM_BERRY')
    expect(notRun(u)).toEqual([])
  })

  it('a fainted opposing berry holder is skipped', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_POWER_OF_ALCHEMY') }, { hp: 0 }], rng)
    state.battlers[1]!.mon.itemId = 'ITEM_ORAN_BERRY'
    applySwitchInAbilities(state, 0, alchemyDeps, [])
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
  })
})

describe('Teraform Zero (abilities.cc:9128-9139; BattleScript_TeraformZero)', () => {
  it('clears the weather and the terrain, once per battle', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_TERAFORM_ZERO') }, {}], rng)
    state.field.weather = WEATHER_RAIN_TEMPORARY
    state.field.weatherDuration = 4
    state.field.statuses = setFlag(0, STATUS_FIELD_ELECTRIC_TERRAIN)
    const u: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, u)
    expect(state.field.weather).toBe(0)
    expect(state.field.weatherDuration).toBe(0)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(false)
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_TERAFORM_ZERO', DATA_CONTEXT)).toBe(1)
    expect(notRun(u)).toEqual([])

    // a second entry (flag cleared) is stopped by the spent counter
    state.field.weather = WEATHER_RAIN_TEMPORARY
    state.field.statuses = setFlag(0, STATUS_FIELD_ELECTRIC_TERRAIN)
    state.battlers[0]!.volatiles.switchInAbilityDone[0] = false
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
  })

  it('the counter is spent even when the field is empty', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_TERAFORM_ZERO') }, {}], rng)
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_TERAFORM_ZERO', DATA_CONTEXT)).toBe(1)
  })

  it('primal weather survives, the terrain does not; permanent terrain survives', () => {
    const primal = battle([{ abilities: hasAbility('ABILITY_TERAFORM_ZERO') }, {}], rng)
    primal.field.weather = WEATHER_SUN_PRIMAL
    primal.field.statuses = setFlag(0, STATUS_FIELD_ELECTRIC_TERRAIN)
    applySwitchInAbilities(primal, 0, entryDeps, [])
    expect(primal.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(hasFlag(primal.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(false)

    const perm = battle([{ abilities: hasAbility('ABILITY_TERAFORM_ZERO') }, {}], rng)
    perm.field.statuses = setFlag(setFlag(0, STATUS_FIELD_ELECTRIC_TERRAIN), STATUS_FIELD_TERRAIN_PERMANENT)
    applySwitchInAbilities(perm, 0, entryDeps, [])
    expect(hasFlag(perm.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
  })
})
