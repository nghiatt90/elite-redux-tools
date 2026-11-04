/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 141b: the screen terms in `sideFieldScore` now weight each screen by the
// share of the ATTACKER's damaging moves it actually halves, from
// battle_util.c:7622-7623 (Reflect only IS_MOVE_PHYSICAL, Light Screen only
// IS_MOVE_SPECIAL, Aurora Veil both with no category test). SCREEN_VALUE = 0.1
// per remaining turn is a MODEL CHOICE (expectimax.ts), and the horizon cap is
// STATUS_HORIZON_TURNS = 3, so a five-turn timer is worth three turns. Every
// expected number below is hand-derived from those two constants.
//
// Player side screens are a benefit, so `statusScore` (foe burden minus player
// burden) is positive; foe side screens are negative.
import { describe, expect, it } from 'vitest'

import {
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
} from './constants'
import type { AbilitySlots } from '../abilities/dispatch'
import { statusScore } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { createRandomSource } from './rng'
import type { BattleSession } from './driver/session'
import type { BattleState } from './state'

const data = loadSimData()

/** `SimDataContext.move`, the same lookup the driver threads into the leaf
 * scorer (`chooseExpectimaxAction` fills `moveData` when the caller omits it). */
const moveLookup = (id: string) => data.dataContext.move(id)

const mon = (species: string, moves: string[]): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[]): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  // The scenarios never want an AI switch to move the bench around.
  noSwitching: true,
  parties: parties(mons),
})

function session(playerMons: string[], foeMons: TrainerMonData[]): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(
      playerMons.map((species) => ({ species, level: 50, moves: ['MOVE_TACKLE'] })),
      50,
      data,
    ),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on BOTH copies of a party slot (active battler mon and the
 * party mon), as `sideStatusScore` reads the active copy for the active slot. */
function patchMon(
  state: BattleState,
  side: 0 | 1,
  partyIndex: number,
  patch: { hp?: number; maxHp?: number; abilities?: AbilitySlots },
): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

/** A foe (and player) at maxHp 320, so the HP fractions below are round numbers. */
function fresh(s: BattleSession): BattleState {
  patchMon(s.state, 0, 0, { hp: 320, maxHp: 320 })
  patchMon(s.state, 1, 0, { hp: 320, maxHp: 320 })
  return s.state
}

/** Writes the side status word and the screen timers the leaf scorer reads. */
function setSideField(
  state: BattleState,
  side: 0 | 1,
  patch: { statuses?: number; reflectTimer?: number; lightscreenTimer?: number; auroraVeilTimer?: number },
): void {
  const sideState = state.sides[side]
  if (patch.statuses !== undefined) sideState.statuses = patch.statuses
  if (patch.reflectTimer !== undefined) sideState.timers.reflectTimer = patch.reflectTimer
  if (patch.lightscreenTimer !== undefined) sideState.timers.lightscreenTimer = patch.lightscreenTimer
  if (patch.auroraVeilTimer !== undefined) sideState.timers.auroraVeilTimer = patch.auroraVeilTimer
}

/** Movesets, by split from data/v2.65beta/moves.json. */
const PHYSICAL_A = 'MOVE_BODY_SLAM'
const PHYSICAL_B = 'MOVE_ROCK_SLIDE'
const SPECIAL_A = 'MOVE_EMBER'
const SPECIAL_B = 'MOVE_WATER_GUN'
const STATUS_ONLY = 'MOVE_SWORDS_DANCE'

/** A one-mon foe whose moves the screen terms read. */
function foeWith(moves: string[]): TrainerMonData[] {
  return [mon('SPECIES_MACHAMP', moves)]
}

describe('cycle 141b - Reflect follows the foe physical share', () => {
  // Reflect halves only physical hits (battle_util.c:7622), so its value is
  // SCREEN_VALUE * timerTurns(5) * physShare = 0.1 * 3 * physShare.
  it('foe with two physical moves -> factor 1, +0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, PHYSICAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.3, 10)
  })

  it('foe with one physical and one special move -> factor 0.5, +0.15', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, SPECIAL_A])))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.15, 10)
  })

  it('foe with only special moves -> factor 0, +0 (negative case)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s, moveLookup)).toBe(0)
  })

  it('foe with only status moves -> no damaging move, +0 (negative case)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([STATUS_ONLY])))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s, moveLookup)).toBe(0)
  })

  it('a two-turn timer halves the value -> 0.1 * 2 * 1 = 0.2', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, PHYSICAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 2 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.2, 10)
  })
})

describe('cycle 141b - Light Screen follows the foe special share', () => {
  // Light Screen halves only special hits (battle_util.c:7623):
  // 0.1 * 3 * specShare.
  it('foe with two special moves -> factor 1, +0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_LIGHTSCREEN, lightscreenTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.3, 10)
  })

  it('foe with only physical moves -> factor 0, +0 (negative case)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, PHYSICAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_LIGHTSCREEN, lightscreenTimer: 5 })
    expect(statusScore(s, moveLookup)).toBe(0)
  })

  it('foe with one special and one physical move -> factor 0.5, +0.15', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, PHYSICAL_A])))
    setSideField(s, 0, { statuses: SIDE_STATUS_LIGHTSCREEN, lightscreenTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.15, 10)
  })
})

describe('cycle 141b - Aurora Veil covers both shares', () => {
  // Aurora Veil has no category test (battle_util.c:7623), so it is worth
  // 0.1 * 3 * (physShare + specShare) -- one screen's weight whenever the foe
  // has a damaging move, exactly Reflect + Light Screen together.
  it('foe with one physical and one special move -> 0.1 * 3 * 1 = 0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, SPECIAL_A])))
    setSideField(s, 0, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.3, 10)
  })

  it('foe with only physical moves -> also 0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([PHYSICAL_A, PHYSICAL_B])))
    setSideField(s, 0, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(0.3, 10)
  })

  it('foe with only status moves -> no damaging move, 0 (negative case)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([STATUS_ONLY])))
    setSideField(s, 0, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s, moveLookup)).toBe(0)
  })
})

describe('cycle 141b - sign and the data-free path', () => {
  // A foe screen protects the FOE side against the PLAYER's moves. The player
  // mon carries MOVE_TACKLE (physical), so the foe's Reflect is a benefit for
  // the foe and statusScore is negative: -0.1 * 3 * 1 = -0.3.
  it('foe Reflect against the player physical Tackle -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(-0.3, 10)
  })

  it('foe Aurora Veil against the player physical Tackle -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 1, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s, moveLookup)).toBeCloseTo(-0.3, 10)
  })

  // Without a lookup the old flat weights are kept: factor 1 per screen and 2
  // for Aurora Veil, whatever the foe's mix. This is the data-free path the
  // cycle-141 unit tests call.
  it('no lookup: Reflect keeps the flat weight, -0.3 even against a special-only foe', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('no lookup: Aurora Veil keeps the old two-screen weight, -0.6', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([SPECIAL_A, SPECIAL_B])))
    setSideField(s, 1, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.6, 10)
  })

  it('no lookup: Aurora Veil is still -0.6 against a status-only foe', () => {
    const s = fresh(session(['SPECIES_GOLEM'], foeWith([STATUS_ONLY])))
    setSideField(s, 1, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.6, 10)
  })
})
