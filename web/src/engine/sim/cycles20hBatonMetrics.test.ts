/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20h - observer-only Baton Pass counters: how often the role policy's
// own-boost step fires, how often the boosted mon hands off with Baton Pass, and
// how often the passed stages reach the receiver at our next decision. Decision
// 14, docs/battle-sim/solver-v2-plan.md Step 2.0b.
import { describe, expect, it } from 'vitest'

import type { CancelReason } from './attackCanceller'
import { DEFAULT_STAT_STAGE, STAT_SPATK } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { playPolicyBattle } from './driver/policyBattle'
import type { PolicyTraceEntry } from './driver/policyBattle'
import {
  classifyWinRates,
  createPolicyObserver,
  renderGateReport,
  summarizePolicy,
  type ComparisonGameRecord,
  type FightMeasurement,
  type PolicyFn,
} from './driver/policyComparison'
import { chooseRoleAction } from './driver/rolePolicy'
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
          moves: ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_TACKLE'],
        },
        {
          species: 'SPECIES_SNORLAX',
          level: 50,
          ability: 'ABILITY_GUTS',
          moves: ['MOVE_TACKLE'],
        },
      ],
      50,
      data,
    ),
    opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
    rng: createRandomSource(1),
  })
  const observer = createPolicyObserver()
  /** Run one hand-driven turn. `tags`, when given, is the trace entry the inner
   * policy pushes, which is what the observer reads for the fired counter. */
  const drive = (turn: number, moveId: string, step: StepResult, tags?: string[]): void => {
    const trace: PolicyTraceEntry[] = []
    const inner: PolicyFn = (_session, decidedTurn, innerTrace) => {
      if (tags) innerTrace.push({ turn: decidedTurn, choice: 'stub', tags })
      return useMove(moveId)
    }
    const choice = observer.wrap(inner)(session, turn, trace)
    observer.onTurn(turn, choice, step)
  }
  const setStage = (stat: number, stage: number): void => {
    session.state.battlers[0]!.mon.statStages[stat] = stage
  }
  const setFirstTurn = (value: number): void => {
    session.state.battlers[0]!.volatiles.isFirstTurn = value
  }
  const setPartyIndex = (index: number): void => {
    session.state.battlers[0]!.partyIndex = index
  }
  return { observer, drive, setStage, setFirstTurn, setPartyIndex }
}

/** Calm Mind executed on turn 1, then Baton Pass chosen on turn 2 with the
 * Sp. Atk stage carried. Returns after the pass turn. */
function boostThenPass(h: ReturnType<typeof harness>, passStep: StepResult = executed()): void {
  h.setFirstTurn(0)
  h.drive(1, 'MOVE_CALM_MIND', executed())
  h.setStage(STAT_SPATK, DEFAULT_STAT_STAGE + 2)
  h.setFirstTurn(0)
  h.drive(2, 'MOVE_BATON_PASS', passStep)
}

describe('cycle s20h - Baton Pass counters, hand-driven', () => {
  it('does not count a passive stage raise passed with Baton Pass', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.setStage(STAT_SPATK, DEFAULT_STAT_STAGE + 2)
    h.drive(1, 'MOVE_BATON_PASS', executed())

    expect(h.observer.batonCounters.batonBoostPasses).toBe(0)
  })

  it('counts the pass but not a cancelled one as received', () => {
    const h = harness()
    boostThenPass(h, cancelledBusy('FLINCH'))
    expect(h.observer.batonCounters.batonBoostPasses).toBe(1)

    h.setPartyIndex(1)
    h.setStage(STAT_SPATK, DEFAULT_STAT_STAGE + 2)
    h.setFirstTurn(0)
    h.drive(3, 'MOVE_TACKLE', executed())

    expect(h.observer.batonCounters.batonBoostReceived).toBe(0)
  })

  it('does not count a receiver that is still the passer slot', () => {
    const h = harness()
    boostThenPass(h)
    h.setFirstTurn(0)
    h.drive(3, 'MOVE_TACKLE', executed())

    expect(h.observer.batonCounters.batonBoostPasses).toBe(1)
    expect(h.observer.batonCounters.batonBoostReceived).toBe(0)
  })

  it('does not count a receiver whose passed stat is back at neutral', () => {
    const h = harness()
    boostThenPass(h)
    h.setPartyIndex(1)
    h.setStage(STAT_SPATK, DEFAULT_STAT_STAGE)
    h.setFirstTurn(0)
    h.drive(3, 'MOVE_TACKLE', executed())

    expect(h.observer.batonCounters.batonBoostReceived).toBe(0)
  })

  it('does not count a pass with no further decision', () => {
    const h = harness()
    boostThenPass(h)

    expect(h.observer.batonCounters.batonBoostPasses).toBe(1)
    expect(h.observer.batonCounters.batonBoostReceived).toBe(0)
  })

  it('counts a receiver with the passed stat once, never twice', () => {
    const h = harness()
    boostThenPass(h)

    h.setPartyIndex(1)
    h.setStage(STAT_SPATK, DEFAULT_STAT_STAGE + 2)
    h.setFirstTurn(0)
    h.drive(3, 'MOVE_TACKLE', executed())
    expect(h.observer.batonCounters.batonBoostReceived).toBe(1)

    h.setFirstTurn(0)
    h.drive(4, 'MOVE_TACKLE', executed())
    expect(h.observer.batonCounters.batonBoostReceived).toBe(1)
  })

  it('counts fired only for a support setup decision in the trace', () => {
    const h = harness()
    h.setFirstTurn(0)
    h.drive(1, 'MOVE_TACKLE', executed(), ['support', 'pivot'])
    h.setFirstTurn(0)
    h.drive(2, 'MOVE_TACKLE', executed(), ['setupSweeper', 'setup'])
    h.setFirstTurn(0)
    h.drive(3, 'MOVE_TACKLE', executed(), ['team', 'support'])

    expect(h.observer.batonCounters.batonBoostFired).toBe(0)

    h.setFirstTurn(0)
    h.drive(4, 'MOVE_CALM_MIND', executed(), ['support', 'setup'])
    expect(h.observer.batonCounters.batonBoostFired).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Real play
// ---------------------------------------------------------------------------

describe('cycle s20h - Baton Pass counters, real play', () => {
  it('fires twice, passes once and reaches the receiver through the rule', () => {
    const observer = createPolicyObserver()
    const memory = { turn: 0, lastMove: null as string | null }
    const result = playPolicyBattle({
      data,
      playerParty: buildPlayerParty(
        [
          {
            species: 'SPECIES_SNORLAX',
            level: 50,
            ability: 'ABILITY_GUTS',
            moves: ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM'],
          },
          {
            species: 'SPECIES_SNORLAX',
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
      maxTurns: 4,
      policy: observer.wrap((session, turn, trace) =>
        chooseRoleAction(session, turn <= 3 ? 'support' : 'attacker', {}, memory, trace),
      ),
      onTurn: observer.onTurn,
    })

    // The pass really switched and the receiver carries the Sp. Atk stages.
    expect(result.session.state.battlers[0]!.partyIndex).toBe(1)
    expect(result.session.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(
      DEFAULT_STAT_STAGE + 2,
    )

    expect(observer.batonCounters.batonBoostFired).toBe(2)
    expect(observer.batonCounters.batonBoostPasses).toBe(1)
    expect(observer.batonCounters.batonBoostReceived).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function record(
  won: boolean,
  baton: { fired: number; passes: number; received: number } = {
    fired: 0,
    passes: 0,
    received: 0,
  },
): ComparisonGameRecord {
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
    batonBoostFired: baton.fired,
    batonBoostPasses: baton.passes,
    batonBoostReceived: baton.received,
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

function batonSection(report: string): string {
  const start = report.indexOf('## Baton Pass own boosts')
  const end = report.indexOf('## Classification', start)
  return report.slice(start, end)
}

describe('cycle s20h - report metrics', () => {
  it('sums the counters per fight and dashes the expectimax fired cell', () => {
    const records = [
      record(true, { fired: 2, passes: 1, received: 1 }),
      record(false, { fired: 3, passes: 2, received: 0 }),
    ]
    const section = batonSection(render([measurement('TRAINER_X-attack', records, records)]))
    expect(section).toContain('| TRAINER_X-attack | role | 5 | 3 | 1 |')
    expect(section).toContain('| TRAINER_X-attack | expectimax | - | 3 | 1 |')
  })

  it('renders - for a summary whose three Baton Pass fields were deleted', () => {
    const fight = measurement('TRAINER_X-attack', winsOf(80, 10), winsOf(80, 20))
    delete fight.role.batonBoostFired
    delete fight.role.batonBoostPasses
    delete fight.role.batonBoostReceived
    const section = batonSection(render([fight]))
    expect(section).toContain('| TRAINER_X-attack | role | - | - | - |')
  })

  it('states the three definitions in the Definitions section', () => {
    const report = render([measurement('TRAINER_X-attack', winsOf(80, 10), winsOf(80, 20))])
    const definitions = report.slice(
      report.indexOf('## Definitions'),
      report.indexOf('## Results'),
    )
    expect(definitions).toContain('`baton boost step fired`')
    expect(definitions).toContain('`boost passes`')
    expect(definitions).toContain('`boost received`')
  })
})
