/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { BattlerState, SimPartyMon } from './state'
import { STATUS1_PARALYSIS } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { legalChoices, playExpectimaxBattle } from './driver/expectimax'
import type { PlayerChoice } from './driver/expectimax'
import { levelCapForTrainer } from './driver/fights'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { playPolicyBattle } from './driver/policyBattle'
import {
  buildFightSetup,
  classifyWinRates,
  createPolicyObserver,
  fightKey,
  formatBattleLog,
  gameSeed,
  gameSeeds,
  playComparisonGame,
  roleNameFor,
  runFightGames,
  type ObservedTurn,
  type PolicyComparisonFixture,
  type PolicyFightSetup,
} from './driver/policyComparison'

const data = loadSimData()

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json'),
    'utf8',
  ),
) as PolicyComparisonFixture

const setups: PolicyFightSetup[] = fixture.fights.map((fight) => buildFightSetup(data, fight))

function setupFor(key: string): PolicyFightSetup {
  const setup = setups.find((candidate) => candidate.key === key)
  if (!setup) throw new Error(`no setup for ${key}`)
  return setup
}

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
  noSwitching: true,
  parties: parties(mons),
})

function finalHp(party: SimPartyMon[], actives: (BattlerState | undefined)[]): number[] {
  return party.map((slotMon, slot) => {
    if (!slotMon || slotMon.speciesId === null) return 0
    const active = actives.find((candidate) => candidate !== undefined && candidate.partyIndex === slot)
    return active ? active.mon.hp : slotMon.hp
  })
}

const pickMove = (moveId: string) => (choices: PlayerChoice[]): PlayerChoice | null =>
  choices.find(
    (choice) =>
      choice.action.action === 'USE_MOVE' &&
      (choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id) === moveId,
  ) ?? null

function runObserverGame(
  moves: string[],
  pick: (session: Parameters<typeof legalChoices>[0], turn: number) => PlayerChoice | null,
  maxTurns: number,
) {
  const observer = createPolicyObserver()
  playPolicyBattle({
    data,
    playerParty: buildPlayerParty(
      [{ species: 'SPECIES_SNORLAX', level: 50, ability: 'ABILITY_GUTS', moves }],
      50,
      data,
    ),
    opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
    tier: 'elite',
    seed: 1,
    maxTurns,
    policy: observer.wrap((session, turn) => pick(session, turn)),
    onTurn: observer.onTurn,
  })
  return observer
}

describe('cycle 948 - fixture loader', () => {
  it('maps all six fights and keys the repeated trainer by kind', () => {
    expect(fixture.fights).toHaveLength(6)
    expect(setups.map((setup) => setup.key)).toEqual([
      'TRAINER_SIDNEY-attack',
      'TRAINER_PHOEBE-attack',
      'TRAINER_GLACIA-attack',
      'TRAINER_DRAKE-attack',
      'TRAINER_STEVEN-attack',
      'TRAINER_GLACIA-stall',
    ])
    expect(setups.map((setup) => setup.leadIndex)).toEqual([4, 0, 5, 5, 2, 0])
    expect(fightKey({ trainer: 'TRAINER_GLACIA', kind: 'stall' })).toBe('TRAINER_GLACIA-stall')
  })

  it('maps the stall fight roles and fallback roles exactly', () => {
    const stall = setupFor('TRAINER_GLACIA-stall')
    expect(stall.roles).toEqual([
      'staller',
      'leadHazard',
      'setupSweeper',
      'staller',
      'staller',
      'attacker',
    ])
    expect(stall.roleParams).toEqual([{}, { fallbackRole: 'staller' }, {}, {}, {}, {}])
  })

  it('maps an attack fight roles and fallback roles exactly', () => {
    const sidney = setupFor('TRAINER_SIDNEY-attack')
    expect(sidney.roles).toEqual([
      'support',
      'attacker',
      'attacker',
      'support',
      'attacker',
      'attacker',
    ])
    expect(sidney.roleParams).toEqual([
      { fallbackRole: 'attacker' },
      {},
      {},
      { fallbackRole: 'attacker' },
      {},
      {},
    ])
  })

  it('carries ironPill through to speedDown on the built party', () => {
    const stall = setupFor('TRAINER_GLACIA-stall')
    expect(stall.party[0]!.speedDown).toBe(true)
    expect(stall.party[1]!.speedDown).toBe(false)
    expect(stall.party[3]!.speedDown).toBe(true)
    expect(stall.party[5]!.speedDown).toBe(false)
  })

  it('uses levelCapForTrainer for every fight', () => {
    for (const setup of setups) {
      const resolved = levelCapForTrainer(setup.trainer.id)
      expect(resolved && 'cap' in resolved).toBe(true)
      expect(setup.levelCap).toBe((resolved as { cap: number }).cap)
      for (const member of setup.party) expect(member.level).toBe(setup.levelCap)
    }
  })

  it('maps every role string and throws on an unknown one', () => {
    expect(roleNameFor('sweeper')).toBe('setupSweeper')
    expect(roleNameFor('lead')).toBe('leadHazard')
    expect(roleNameFor('attacker')).toBe('attacker')
    expect(roleNameFor('pivot')).toBe('pivot')
    expect(roleNameFor('setupSweeper')).toBe('setupSweeper')
    expect(roleNameFor('staller')).toBe('staller')
    expect(roleNameFor('support')).toBe('support')
    expect(() => roleNameFor('nonsense')).toThrow(/unknown role/)
  })
})

describe('cycle 948 - seeds', () => {
  it('derives game seeds from seedOffset + g * 1000', () => {
    expect(gameSeeds(3, 0)).toEqual([1000, 2000, 3000])
    expect(gameSeeds(3, 7)).toEqual([1007, 2007, 3007])
    expect(gameSeed(5, 2)).toBe(2005)
  })
})

describe('cycle 948 - classifier', () => {
  it('flags both-under-20% as uninformative and not otherwise', () => {
    expect(classifyWinRates(0.19, 0.19)).toBe('uninformative')
    expect(classifyWinRates(0.2, 0)).toBe('role>=expectimax')
    expect(classifyWinRates(0, 0.2)).toBe('role<expectimax')
    expect(classifyWinRates(0.5, 0.5)).toBe('role>=expectimax')
    expect(classifyWinRates(0.3, 0.5)).toBe('role<expectimax')
  })
})

describe('cycle 948 - battle log status', () => {
  function playerLine(status1: number): string {
    const view = (value: number) => ({
      speciesId: 'SPECIES_SNORLAX',
      hp: 100,
      maxHp: 100,
      status1: value,
      statStages: [],
    })
    const turn = {
      turn: 1,
      player: view(status1),
      opponent: view(0),
      playerPartySpecies: ['SPECIES_SNORLAX'],
      opponentPartySpecies: ['SPECIES_MACHAMP'],
      choice: null,
      trace: [],
      chosenActions: [null, null],
      outcome: { actions: [] },
    } as unknown as ObservedTurn
    const log = formatBattleLog([turn], { outcome: 'WON', turns: 1, capped: false })
    const line = log.split('\n').find((candidate) => candidate.startsWith('  player: '))
    if (!line) throw new Error('no player line in battle log')
    return line
  }

  it('reports any nonzero sleep counter as SLP', () => {
    expect(playerLine(1)).toContain('status SLP')
    expect(playerLine(3)).toContain('status SLP')
  })

  it('reports paralysis and no SLP', () => {
    const line = playerLine(STATUS1_PARALYSIS)
    expect(line).toContain('status PAR')
    expect(line).not.toContain('SLP')
  })

  it('reports no status for zero', () => {
    expect(playerLine(0)).toContain('status none')
  })
})

describe('cycle 948 - smoke run', () => {
  it(
    'plays two games per policy and keeps its records consistent',
    { timeout: 300_000 },
    () => {
      const setup = setupFor('TRAINER_GLACIA-stall')
      const maxTurns = 8
      const { role, expectimax } = runFightGames(setup, { games: 2, seedOffset: 0, maxTurns })

      for (const records of [role, expectimax]) {
        expect(records).toHaveLength(2)
        expect(records.filter((record) => record.won).length + records.filter((record) => !record.won).length).toBe(2)
        for (const record of records) {
          if (record.capped) expect(record.won).toBe(false)
          expect(record.attackedWhileBoosted).toBeLessThanOrEqual(record.boosted)
          expect(record.used).toBeLessThanOrEqual(record.available)
        }
      }

      expect(role.map((record) => record.seed)).toEqual([1000, 2000])
      expect(expectimax.map((record) => record.seed)).toEqual([1000, 2000])

      expect(role[0]!.log).toBeDefined()
      expect(role[1]!.log).toBeDefined()
      for (const record of expectimax) expect(record.log).toBeUndefined()

      const short = runFightGames(setup, { games: 2, seedOffset: 7, maxTurns: 1 })
      expect(short.role.map((record) => record.seed)).toEqual([1007, 2007])
      expect(short.expectimax.map((record) => record.seed)).toEqual([1007, 2007])

      const log = role[0]!.log
      expect(log!.split('\n').filter((line) => line.startsWith('Turn '))).toHaveLength(role[0]!.turns)
    },
  )
})

describe('cycle 948 - expectimax equivalence', () => {
  it(
    'matches playExpectimaxBattle on outcome, turns and both parties\' final HP',
    { timeout: 300_000 },
    () => {
      const setup = setupFor('TRAINER_SIDNEY-attack')
      const maxTurns = 10
      for (const game of [1, 2]) {
        const seed = gameSeed(0, game)
        const harness = playComparisonGame(setup, 'expectimax', seed, { maxTurns })
        const direct = playExpectimaxBattle({
          data: setup.data,
          playerParty: setup.party,
          opponentTrainer: setup.trainer,
          tier: setup.tier,
          seed,
          maxTurns,
          leadIndex: setup.leadIndex,
          inverseBattle: setup.fightSpec.inverseBattle,
          battleEvents: setup.fightSpec.battleEvents,
          format: setup.fightSpec.format,
          startFieldEffects: setup.fightSpec.startFieldEffects,
        })
        expect(harness.outcome).toBe(direct.outcome)
        expect(harness.turns).toBe(direct.turns)
        expect(harness.playerPartyHp).toEqual(finalHp(direct.finalParty, [direct.finalActive]))
        expect(harness.opponentPartyHp).toEqual(
          finalHp(direct.finalOpponentParty!, [direct.finalOpponentActive]),
        )
      }
    },
  )
})

describe('cycle 948 - observer counting', () => {
  it('counts one available boosting turn and the move it uses', () => {
    const withBoost = runObserverGame(
      ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE'],
      (session) => pickMove('MOVE_SWORDS_DANCE')(legalChoices(session)),
      1,
    )
    expect(withBoost.counters.available).toBe(1)
    expect(withBoost.counters.used).toBe(1)

    const withAttack = runObserverGame(
      ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE'],
      (session) => pickMove('MOVE_TACKLE')(legalChoices(session)),
      1,
    )
    expect(withAttack.counters.available).toBe(1)
    expect(withAttack.counters.used).toBe(0)
  })

  it('counts an Iron Defense turn as boosting even though the role table omits it', () => {
    const observer = runObserverGame(
      ['MOVE_IRON_DEFENSE', 'MOVE_TACKLE'],
      (session) => pickMove('MOVE_IRON_DEFENSE')(legalChoices(session)),
      1,
    )
    expect(observer.counters.available).toBe(1)
    expect(observer.counters.used).toBe(1)
  })

  it('counts a boosted attack on the turn after a boost', () => {
    const observer = runObserverGame(
      ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE'],
      (session, turn) => pickMove(turn === 1 ? 'MOVE_SWORDS_DANCE' : 'MOVE_TACKLE')(legalChoices(session)),
      2,
    )
    expect(observer.counters.available).toBe(2)
    expect(observer.counters.used).toBe(1)
    expect(observer.counters.boosted).toBe(1)
    expect(observer.counters.attackedWhileBoosted).toBe(1)
  })
})
