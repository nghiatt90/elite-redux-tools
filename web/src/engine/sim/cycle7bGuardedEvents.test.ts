/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, SimBattleMon, SimPartyMon } from './state'
import { SIDE_STATUS_STICKY_WEB, hasFlag } from './constants'
import { registerBattleEvent, runBattleEvents } from './battleEvents'

const BATTLE_EVENTS_SOURCE = readFileSync(join(import.meta.dirname, 'battleEvents.ts'), 'utf8')

function hasHandler(eventId: string): boolean {
  return new RegExp(`^\\s*case '${eventId}':`, 'm').test(BATTLE_EVENTS_SOURCE)
}

const GUARDED_EVENTS_BY_GYM: Record<string, string[]> = {
  RustboroCity_Gym: [
    'BATTLE_EVENT_LAST_STAND',
    'BATTLE_EVENT_LAST_BLEED',
    'BATTLE_EVENT_STEALTH_ROCK',
    'BATTLE_EVENT_POSTURE_DEFENSE',
    'BATTLE_EVENT_STEADY_DEFENSE',
  ],
  DewfordTown_Gym: [
    'BATTLE_EVENT_ONSTAY_FORESIGHT',
    'BATTLE_EVENT_LAST_PARALYZED',
    'BATTLE_EVENT_SPIKES',
    'BATTLE_EVENT_ONSWITCH_MAT_BLOCK',
    'BATTLE_EVENT_POSTURE_OFFENSE',
  ],
  MauvilleCity_Gym: [
    'BATTLE_EVENT_LAST_BURNED',
    'BATTLE_EVENT_STICKY_WEB',
    'BATTLE_EVENT_STEADY_SPEED',
    'BATTLE_EVENT_ONSTAY_MAGNET_RISE',
    'BATTLE_EVENT_POSTURE_SPDEF',
  ],
  LavaridgeTown_Gym_1F: [
    'BATTLE_EVENT_STEADY_SPECIAL',
    'BATTLE_EVENT_LAST_TOXIC',
    'BATTLE_EVENT_PERMA_HEAL_BLOCK',
    'BATTLE_EVENT_STEADY_ACCURACY',
    'BATTLE_EVENT_LAST_BURNED',
    'BATTLE_EVENT_POSTURE_DEFENSE',
    'BATTLE_EVENT_ONDS_COPY_STATS',
    'BATTLE_EVENT_POSTURE_SPECIAL',
  ],
  PetalburgCity_Gym: [
    'BATTLE_EVENT_POSTURE_SPEED',
    'BATTLE_EVENT_STEADY_ACCURACY',
    'BATTLE_EVENT_LAST_STAND',
    'BATTLE_EVENT_SPIKES',
    'BATTLE_EVENT_POSTURE_DEFENSE',
    'BATTLE_EVENT_ONSTAY_LEECH_SEED',
    'BATTLE_EVENT_POSTURE_OFFENSE',
    'BATTLE_EVENT_SUBSTITUTE',
  ],
  FortreeCity_Gym: [
    'BATTLE_EVENT_POSTURE_SPDEF',
    'BATTLE_EVENT_LAST_FROSTBITE',
    'BATTLE_EVENT_EMBARGO',
    'BATTLE_EVENT_POSTURE_DEFENSE',
  ],
  MossdeepCity_Gym: [
    'BATTLE_EVENT_LIGHTSCREEN',
    'BATTLE_EVENT_REFLECT',
    'BATTLE_EVENT_LUCKY_CHANT',
    'BATTLE_EVENT_PERMA_WIDE_GUARD',
    'BATTLE_EVENT_LAST_SLEEP',
    'BATTLE_EVENT_NO_PROTECT',
  ],
}

// src/battle_events.c handles only PERMA_STICKY_WEB (:325, :475); id 203 has no case.
const UNHANDLED_EVENT_IDS = new Set(['BATTLE_EVENT_STICKY_WEB'])

function mon(): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
  }
}

function partyMon(): SimPartyMon {
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
    status1: 0,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
  }
}

function freshBattle(): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(), 0), createBattlerState(1, mon(), 0)],
    rng: { random16: () => 0 },
    playerParty: [partyMon()],
    opponentParty: [partyMon()],
  })
}

describe('cycle7b gym guarded battle events', () => {
  it('every guarded event id is a switch case in battleEvents.ts except STICKY_WEB', () => {
    for (const [gym, ids] of Object.entries(GUARDED_EVENTS_BY_GYM)) {
      for (const id of ids) {
        expect(hasHandler(id), `${gym} registers ${id}`).toBe(!UNHANDLED_EVENT_IDS.has(id))
      }
    }
  })

  it('Kirk guard: STICKY_WEB has no handler while PERMA_STICKY_WEB does (battle_events.c:325,475)', () => {
    expect(hasHandler('BATTLE_EVENT_STICKY_WEB')).toBe(false)
    expect(hasHandler('BATTLE_EVENT_PERMA_STICKY_WEB')).toBe(true)
  })

  it('STICKY_WEB leaves the player side untouched while PERMA_STICKY_WEB sets it', () => {
    const noop = freshBattle()
    registerBattleEvent(noop, 'BATTLE_EVENT_STICKY_WEB')
    runBattleEvents(noop)
    expect(hasFlag(noop.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(false)

    const perma = freshBattle()
    registerBattleEvent(perma, 'BATTLE_EVENT_PERMA_STICKY_WEB')
    runBattleEvents(perma)
    expect(hasFlag(perma.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
  })
})
