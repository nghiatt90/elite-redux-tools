/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946gb: Magic Bounce is read from the `magicBounce` ability flag, not the
// literal ABILITY_MAGIC_BOUNCE id.
//
// C source:
//  - ABILITY_MAGIC_BOUNCE is `.breakable`, `.magicBounce` (src/abilities.cc:2227-2231).
//  - ABILITY_CONJOURER_OF_DECEIT is `.breakable`, `.magicGuard`, `.magicBounce`
//    (src/abilities.cc:9362-9367).
//  - Cmd_attackcanceler bounces a FLAG_MAGIC_COAT_AFFECTED move through
//    `ON_ABILITY(gBattlerTarget, TRUE, gAbilities[ability].magicBounce, ...)`
//    (src/battle_script_commands.c:1168-1172); ON_ABILITY walks every slot and
//    skips IsSuppressed(..., checkMoldBreaker=TRUE) ones (include/battle_util.h:269-275).
//  - The Prankster exception checks the NAME
//    `BATTLER_HAS_ABILITY(battler, ABILITY_MAGIC_BOUNCE)` (src/battle_util.c:8970-8971),
//    so a Prankster status move into a Dark-type Conjourer holder is blocked, not bounced.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DECLARATIVE_ABILITIES } from '../abilities/impl/00-flags'
import { PARTY_SIZE, STATUS1_PARALYSIS, STATUS3_GASTRO_ACID } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import type { TrainerData, TrainerMonData } from './driver/loadSimData'
import { loadSimData } from './driver/loadSimData'
import type { RoleMemory } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
  ...overrides,
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  overrides: Partial<TrainerData> = {},
  rng: RandomSource = createRandomSource(1),
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < values.length) return values[idx++]!
      return 0
    },
  }
  return r
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

function forceMove(s: BattleSession, id: string): void {
  beginTurn(s)
  const choice = legalChoices(s).find((c) => moveId(c) === id)
  expect(choice, `${id} must be a legal choice`).toBeDefined()
  s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
  stepTurn(s, choice!.action)
}

const playerOne = (moves: string[], ability?: string, species = 'SPECIES_SNORLAX'): PlayerMonSpec[] => [
  { species, level: 50, moves, ...(ability ? { ability } : {}) },
]

const idle = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData =>
  mon(species, moves, overrides)

const IDLE_MOVES = ['MOVE_CELEBRATE']

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/stat overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

/** Species innates would otherwise add immunities/abilities the C block does not
 * hold, so every fixture pins both battlers' four slots explicitly. */
function setSlots(
  s: BattleSession,
  side: 0 | 1,
  ability: string,
  innates: [string | null, string | null, string | null] = [null, null, null],
): void {
  s.state.battlers[side]!.mon.abilities = { ability, innates }
}

describe('cycle 946gb - the magicBounce flag, not the ability id', () => {
  it('bounces Thunder Wave when the target ability slot holds Conjourer of Deceit', () => {
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_GUTS')
    setSlots(s, 1, 'ABILITY_CONJOURER_OF_DECEIT')
    const initialPp = s.state.battlers[0]!.mon.pp[0]!

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect(s.state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
    expect(s.state.battlers[0]!.mon.pp[0]).toBe(initialPp - 1)
  })

  it('bounces Thunder Wave when Conjourer of Deceit is an innate and the ability is inert', () => {
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_GUTS')
    setSlots(s, 1, 'ABILITY_GUTS', ['ABILITY_CONJOURER_OF_DECEIT', null, null])

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect(s.state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
  })

  it('ABILITY_MAGIC_BOUNCE still bounces (control for the refactor)', () => {
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_GUTS')
    setSlots(s, 1, 'ABILITY_MAGIC_BOUNCE')
    const initialPp = s.state.battlers[0]!.mon.pp[0]!

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect(s.state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
    expect(s.state.battlers[0]!.mon.pp[0]).toBe(initialPp - 1)
  })

  it('a Mold Breaker user lands Thunder Wave through Conjourer of Deceit', () => {
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_MOLD_BREAKER')
    setSlots(s, 1, 'ABILITY_CONJOURER_OF_DECEIT')

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Gastro Acid suppresses Conjourer of Deceit, so Thunder Wave then lands', () => {
    // Gastro Acid also poisons in Elite Redux, so clear the target's status1
    // before the second move (same shape as cycle 946g case 3).
    const s = session(
      playerOne(['MOVE_GASTRO_ACID', 'MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0, 0, 0, 0]),
    )
    setSlots(s, 0, 'ABILITY_MOLD_BREAKER')
    setSlots(s, 1, 'ABILITY_CONJOURER_OF_DECEIT')

    forceMove(s, 'MOVE_GASTRO_ACID')
    expect(s.state.battlers[1]!.statuses3 & STATUS3_GASTRO_ACID).not.toBe(0)
    patchMon(s.state, 1, 0, { status1: 0 })

    // Drop Mold Breaker: the suppression must come from Gastro Acid alone.
    setSlots(s, 0, 'ABILITY_GUTS')
    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Magic Guard carries magicGuard but not magicBounce, so Thunder Wave is not bounced', () => {
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'),
      [idle('SPECIES_SNORLAX', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_GUTS')
    setSlots(s, 1, 'ABILITY_MAGIC_GUARD')

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).not.toBe(0)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Prankster Thunder Wave into a Dark-type Conjourer holder: neither side is statused', () => {
    // battle_util.c:8970-8971 tests the NAME, so MOVES_BLOCK runs before the bounce.
    const s = session(
      playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'),
      [idle('SPECIES_UMBREON', IDLE_MOVES)],
      {},
      scriptedRng([0]),
    )
    setSlots(s, 0, 'ABILITY_PRANKSTER')
    setSlots(s, 1, 'ABILITY_CONJOURER_OF_DECEIT')

    forceMove(s, 'MOVE_THUNDER_WAVE')

    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Policy: staller skips Toxic into a Conjourer target, picks it with a Mold Breaker user', () => {
    const s = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES),
    ])
    setSlots(s, 0, 'ABILITY_GUTS')
    setSlots(s, 1, 'ABILITY_CONJOURER_OF_DECEIT')
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const s2 = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES),
    ])
    setSlots(s2, 0, 'ABILITY_MOLD_BREAKER')
    setSlots(s2, 1, 'ABILITY_CONJOURER_OF_DECEIT')
    beginTurn(s2)
    expect(moveId(chooseRoleAction(s2, 'staller', {}, memory()))).toBe('MOVE_TOXIC')
  })

  it('Oracle: declarative magicBounce flags match abilityHooks.json bitfields', () => {
    const dataDir = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
    const hooks = JSON.parse(readFileSync(join(dataDir, 'abilityHooks.json'), 'utf8')) as Record<
      string,
      { bitfields?: Record<string, string> }
    >
    const fromHooks = Object.entries(hooks)
      .filter(([, v]) => v.bitfields?.magicBounce === 'TRUE')
      .map(([id]) => id)
      .sort()
    const fromDeclarative = DECLARATIVE_ABILITIES.filter((a) => a.flags?.magicBounce)
      .map((a) => a.id)
      .sort()

    expect(fromDeclarative).toEqual(['ABILITY_CONJOURER_OF_DECEIT', 'ABILITY_MAGIC_BOUNCE'])
    expect(fromHooks).toEqual(fromDeclarative)
  })
})
