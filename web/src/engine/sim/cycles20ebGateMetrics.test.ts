/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20eb - gate metrics: "boosted" counts only the mon's own boosting, the
// report clamps a negative Wilson lower bound, and it lists the informative
// fights where the role policy wins less often. Decision 14,
// docs/battle-sim/solver-v2-plan.md Step 2.0b.
import { describe, expect, it } from 'vitest'

import type { CancelReason } from './attackCanceller'
import { DEFAULT_STAT_STAGE, STAT_ATK, STAT_SPEED } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { legalChoices } from './driver/expectimax'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { playPolicyBattle } from './driver/policyBattle'
import {
  classifyWinRates,
  createPolicyObserver,
  renderGateReport,
  summarizePolicy,
  type ComparisonGameRecord,
  type FightMeasurement,
} from './driver/policyComparison'
import { createSession } from './driver/session'
import type { StepResult } from './driver/session'
import { createRandomSource } from './rng'

const data = loadSimData()

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

// ---------------------------------------------------------------------------
// Hand-driven observer
// ---------------------------------------------------------------------------

/** The action half of a `PlayerChoice`; the observer reads only the move id. */
const useMove = (moveId: string): PlayerChoice =>
  ({
    action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: moveId }, target: null },
  }) as unknown as PlayerChoice

/** The shape `onTurn` reads: the player's USE_MOVE entry and whether it ran. */
function executed(): StepResult {
  return {
    chosenActions: [null, null],
    outcome: {
      actions: [
        {
          battlerId: 0,
          action: 'USE_MOVE',
          cancelledBy: null,
          skippedBecauseFainted: false,
          battleOver: false,
        },
      ],
    },
  } as unknown as StepResult
}

function cancelledBusy(reason: CancelReason): StepResult {
  return {
    chosenActions: [null, null],
    outcome: {
      actions: [
        {
          battlerId: 0,
          action: 'USE_MOVE',
          cancelledBy: reason,
          skippedBecauseFainted: false,
          battleOver: false,
        },
      ],
    },
  } as unknown as StepResult
}

function harness() {
  const session = createSession({
    data,
    playerParty: buildPlayerParty(
      [
        {
          species: 'SPECIES_SNORLAX',
          level: 50,
          ability: 'ABILITY_GUTS',
          moves: ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE'],
        },
      ],
      50,
      data,
    ),
    opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
    rng: createRandomSource(1),
  })
  const observer = createPolicyObserver()
  const drive = (turn: number, moveId: string, step: StepResult): void => {
    const choice = observer.wrap(() => useMove(moveId))(session, turn, [])
    observer.onTurn(turn, choice, step)
  }
  const setStage = (stat: number, stage: number): void => {
    session.state.battlers[0]!.mon.statStages[stat] = stage
  }
  const setFirstTurn = (value: number): void => {
    session.state.battlers[0]!.volatiles.isFirstTurn = value
  }
  return { observer, drive, setStage, setFirstTurn }
}

/** A lead that has used Swords Dance on turn 1 and attacked at +2 on turn 2. */
function boostThenAttack(h: ReturnType<typeof harness>): void {
  h.setFirstTurn(0)
  h.drive(1, 'MOVE_SWORDS_DANCE', executed())
  h.setStage(STAT_ATK, DEFAULT_STAT_STAGE + 2)
  h.setFirstTurn(0)
  h.drive(2, 'MOVE_TACKLE', executed())
}

describe('cycle s20eb - own-boost definition', () => {
  it('counts a passive raise as a positive stage but not as boosted', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.setStage(STAT_SPEED, DEFAULT_STAT_STAGE + 1)
    h.drive(1, 'MOVE_TACKLE', executed())

    expect(h.observer.counters.positiveStage).toBe(1)
    expect(h.observer.counters.boosted).toBe(0)
    expect(h.observer.counters.attackedWhileBoosted).toBe(0)
  })

  it('counts an executed Swords Dance as own boosting from the following turn', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.drive(1, 'MOVE_SWORDS_DANCE', executed())
    expect(h.observer.counters.boosted).toBe(0)
    expect(h.observer.counters.positiveStage).toBe(0)

    h.setStage(STAT_ATK, DEFAULT_STAT_STAGE + 2)
    h.setFirstTurn(0)
    h.drive(2, 'MOVE_TACKLE', executed())

    expect(h.observer.counters.boosted).toBe(1)
    expect(h.observer.counters.attackedWhileBoosted).toBe(1)
    expect(h.observer.counters.positiveStage).toBe(1)
    expect(h.observer.counters.used).toBe(1)
  })

  it('resets on switch-in and stays off while the mon has not boosted again', () => {
    const h = harness()
    boostThenAttack(h)

    h.setFirstTurn(1)
    h.drive(3, 'MOVE_TACKLE', executed())
    expect(h.observer.counters.boosted).toBe(1)

    h.setFirstTurn(0)
    h.drive(4, 'MOVE_TACKLE', executed())
    expect(h.observer.counters.boosted).toBe(1)
    expect(h.observer.counters.attackedWhileBoosted).toBe(1)
    expect(h.observer.counters.positiveStage).toBe(3)
  })

  it('does not count a cancelled boost, even after a later passive raise', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.drive(1, 'MOVE_SWORDS_DANCE', cancelledBusy('FLINCH'))
    h.setStage(STAT_ATK, DEFAULT_STAT_STAGE + 2)
    h.setFirstTurn(0)
    h.drive(2, 'MOVE_TACKLE', executed())

    expect(h.observer.counters.boosted).toBe(0)
    expect(h.observer.counters.attackedWhileBoosted).toBe(0)
    expect(h.observer.counters.positiveStage).toBe(1)
  })

  it('does not count an own boost whose stage is back at neutral', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.drive(1, 'MOVE_SWORDS_DANCE', executed())
    h.setStage(STAT_ATK, DEFAULT_STAT_STAGE)
    h.setFirstTurn(0)
    h.drive(2, 'MOVE_TACKLE', executed())

    expect(h.observer.counters.boosted).toBe(0)
    expect(h.observer.counters.attackedWhileBoosted).toBe(0)
    expect(h.observer.counters.positiveStage).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Real play
// ---------------------------------------------------------------------------

const pickMove = (moveId: string) => (choices: PlayerChoice[]): PlayerChoice | null =>
  choices.find(
    (choice) =>
      choice.action.action === 'USE_MOVE' &&
      (choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id) === moveId,
  ) ?? null

describe('cycle s20eb - real play', () => {
  it('counts the lead boost, not the Baton Pass receiver on its switch-in turn', () => {
    const observer = createPolicyObserver()
    const result = playPolicyBattle({
      data,
      playerParty: buildPlayerParty(
        [
          {
            species: 'SPECIES_SNORLAX',
            level: 50,
            ability: 'ABILITY_GUTS',
            moves: ['MOVE_SWORDS_DANCE', 'MOVE_BATON_PASS'],
          },
          {
            species: 'SPECIES_MACHAMP',
            level: 50,
            ability: 'ABILITY_GUTS',
            moves: ['MOVE_TACKLE'],
          },
        ],
        50,
        data,
      ),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
      tier: 'elite',
      seed: 1,
      maxTurns: 3,
      policy: observer.wrap((session, turn) =>
        pickMove(turn === 1 ? 'MOVE_SWORDS_DANCE' : turn === 2 ? 'MOVE_BATON_PASS' : 'MOVE_TACKLE')(
          legalChoices(session),
        ),
      ),
      onTurn: observer.onTurn,
    })

    // The pass really switched, and the receiver really carries the stages.
    expect(result.session.state.battlers[0]!.partyIndex).toBe(1)
    expect(result.session.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)

    expect(observer.counters.boosted).toBe(1)
    expect(observer.counters.attackedWhileBoosted).toBe(0)
    expect(observer.counters.positiveStage).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function record(won: boolean): ComparisonGameRecord {
  return {
    seed: 1,
    outcome: won ? 'WON' : 'LOST',
    turns: 1,
    capped: false,
    won,
    ms: 1,
    available: 0,
    used: 0,
    boosted: 0,
    attackedWhileBoosted: 0,
    positiveStage: 0,
    aiSwitches: 0,
    aiSwitchByThing: {},
    playerPartyHp: [1],
    opponentPartyHp: [1],
  }
}

const winsOf = (games: number, wins: number): ComparisonGameRecord[] =>
  Array.from({ length: games }, (_, index) => record(index < wins))

function measurement(
  key: string,
  roleRecords: ComparisonGameRecord[],
  expectimaxRecords: ComparisonGameRecord[],
): FightMeasurement {
  const role = summarizePolicy('role', roleRecords)
  const expectimax = summarizePolicy('expectimax', expectimaxRecords)
  return {
    key,
    trainer: key,
    kind: 'attack',
    role,
    expectimax,
    classification: classifyWinRates(role.rate, expectimax.rate),
    logFiles: [],
  }
}

function render(fights: FightMeasurement[], games = 80): string {
  return renderGateReport({ games, maxTurns: 200, seedOffset: 0, logDir: 'logs', fights })
}

function informativeSection(report: string): string {
  const start = report.indexOf('## Informative fights where the role policy wins less often')
  const end = report.indexOf('## Battle logs', start)
  return report.slice(start, end)
}

describe('cycle s20eb - report metrics', () => {
  it('prints a zero Wilson lower bound and never -0.000', () => {
    const report = render([measurement('TRAINER_X-attack', winsOf(80, 0), winsOf(80, 40))])
    const results = report.slice(report.indexOf('## Results'), report.indexOf('## AI voluntary switches'))
    expect(results).toContain('| 0 | 80 | 0.0% | 0.000 |')
    expect(report).not.toContain('-0.000')
  })

  it('lists a violating fight with disjoint intervals', () => {
    const fight = measurement(
      'TRAINER_SIDNEY-attack',
      winsOf(80, 1),
      winsOf(80, 71),
    )
    const section = informativeSection(render([fight]))
    expect(fight.classification).toBe('role<expectimax')
    expect(section).toContain('Informative fights (classification other than `uninformative`): 1.')
    expect(section).toContain(
      '- TRAINER_SIDNEY-attack: role 1/80, Wilson [0.002, 0.067]; expectimax 71/80, Wilson [0.800, 0.940]; intervals do not overlap.',
    )
  })

  it('lists a violating fight with overlapping intervals', () => {
    const fight = measurement('TRAINER_Y-attack', winsOf(20, 4), winsOf(20, 5))
    expect(fight.classification).toBe('role<expectimax')
    const section = informativeSection(render([fight], 20))
    expect(section).toContain(
      '- TRAINER_Y-attack: role 4/20, Wilson [0.081, 0.416]; expectimax 5/20, Wilson [0.112, 0.469]; intervals overlap.',
    )
  })

  it('does not list role>=expectimax or uninformative fights with a lower raw role rate', () => {
    const fights = [
      measurement('TRAINER_PHOEBE-attack', winsOf(80, 60), winsOf(80, 15)),
      measurement('TRAINER_GLACIA-attack', winsOf(80, 1), winsOf(80, 10)),
    ]
    const section = informativeSection(render(fights))
    expect(section).toContain('No informative fight has the role policy winning less often than expectimax.')
    expect(section).not.toContain('TRAINER_PHOEBE-attack')
    expect(section).not.toContain('TRAINER_GLACIA-attack')
  })

  it('adds the legacy definition line and a - column only when a summary predates it', () => {
    const legacy = measurement('TRAINER_X-attack', winsOf(80, 10), winsOf(80, 20))
    legacy.role.positiveStage = undefined
    const legacyReport = render([legacy])
    expect(legacyReport).toContain(
      '- Measurements without an `Any positive stage` value predate the own-boost definition:',
    )
    expect(
      legacyReport.split('\n').some((line) => line.startsWith('| TRAINER_X-attack | role |') && line.endsWith('| - |')),
    ).toBe(true)

    const current = render([measurement('TRAINER_X-attack', winsOf(80, 10), winsOf(80, 20))])
    expect(current).not.toContain('Measurements without an `Any positive stage` value')
    expect(
      current.split('\n').some((line) => line.startsWith('| TRAINER_X-attack | role |') && line.endsWith('| - |')),
    ).toBe(false)
  })
})
