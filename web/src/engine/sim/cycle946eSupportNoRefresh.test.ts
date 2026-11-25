/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946e: drop the support role's `refresh` gene (decision 14).
// An effect is re-set only once it has completely expired, never on its last turn,
// even when the handler would accept a re-cast (Screen Cleaner).
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE, SIDE_STATUS_REFLECT } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'

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
  seed = 1,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(seed),
  })
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

const reflectUp = (s: BattleSession, timer: number): void => {
  s.state.sides[0].statuses |= SIDE_STATUS_REFLECT
  s.state.sides[0].timers.reflectTimer = timer
}

describe('cycle 946e - support: no refresh gene', () => {
  it('leaves last-turn Reflect to expire even with Screen Cleaner, then re-casts on the next turn', () => {
    // Player: level-50 Snorlax with ABILITY_SCREEN_CLEANER and moves Reflect, Body Slam.
    // Screen Cleaner matters: the handler would accept a re-cast, so only the policy declines it.
    const s = session(
      [
        {
          species: 'SPECIES_SNORLAX',
          level: 50,
          ability: 'ABILITY_SCREEN_CLEANER',
          moves: ['MOVE_REFLECT', 'MOVE_BODY_SLAM'],
        },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])],
    )
    reflectUp(s, 1)
    const mem = memory()

    // Turn 1: picks MOVE_BODY_SLAM; afterwards reflectTimer === 0 and the Reflect bit is clear.
    const turn1 = playTurn(s, 'support', {}, mem)
    expect(moveId(turn1)).toBe('MOVE_BODY_SLAM')
    expect(s.state.sides[0].timers.reflectTimer).toBe(0)
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(0)

    // Turn 2: picks MOVE_REFLECT; tags are ['support', 'screen'];
    // afterwards the bit is set and reflectTimer === 5.
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = chooseRoleAction(s, 'support', {}, mem, trace)
    expect(moveId(choice)).toBe('MOVE_REFLECT')
    expect(trace[0]!.tags).toEqual(['support', 'screen'])
    s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
    stepTurn(s, choice.action)
    expect(s.state.sides[0].timers.reflectTimer).toBe(5)
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)
  })
})
