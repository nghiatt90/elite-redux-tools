/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20j - observer-only team-layer columns for the policy gate: team
// voluntary switches per purpose, team turns without a switch, probed stay-test
// turns and the role policy's turn-1 action. Decision 14/Step 2.0b,
// docs/battle-sim/solver-v2-plan.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { playPolicyBattle } from './driver/policyBattle'
import type { PolicyTraceEntry } from './driver/policyBattle'
import {
  buildFightSetup,
  classifyWinRates,
  createPolicyObserver,
  gameSeed,
  partyHp,
  playComparisonGame,
  renderGateReport,
  summarizePolicy,
  type ComparisonGameRecord,
  type FightMeasurement,
  type PolicyComparisonFixture,
  type PolicyFn,
} from './driver/policyComparison'
import { beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession, StepResult } from './driver/session'
import { DEFAULT_TEAM_GENES, createTeamLayer } from './driver/teamLayer'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

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

const useMove = (moveId: string, switchTo?: number): PlayerChoice =>
  ({
    action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: moveId }, target: null },
    ...(switchTo !== undefined ? { switchTo } : {}),
  }) as unknown as PlayerChoice

const hardSwitch = (slot: number): PlayerChoice =>
  ({
    action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null },
    switchTo: slot,
  }) as unknown as PlayerChoice

/** The `onTurn` shape the observer reads: one executed player move. */
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

/** A hand-driven one-turn decision through the observer's wrapper. */
function drive(
  observer: ReturnType<typeof createPolicyObserver>,
  session: BattleSession,
  turn: number,
  choice: PlayerChoice | null,
  tags?: string[],
): PlayerChoice | null {
  const trace: PolicyTraceEntry[] = []
  const inner: PolicyFn = (_session, decidedTurn, innerTrace) => {
    if (tags) innerTrace.push({ turn: decidedTurn, choice: 'stub', tags })
    return choice
  }
  beginTurn(session)
  const wrapped = observer.wrap(inner)
  const decided = wrapped(session, turn, trace)
  observer.onTurn(turn, decided, executed())
  return decided
}

function patchMon(
  state: BattleState,
  side: 0 | 1,
  partyIndex: number,
  patch: Record<string, unknown>,
): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

function roleBattle(
  playerMons: PlayerMonSpec[],
  roles: ('attacker' | 'support')[],
  foeMons: TrainerMonData[],
  observer: ReturnType<typeof createPolicyObserver>,
  maxTurns: number,
  seed = 1,
  genes?: Partial<TeamGenes>,
) {
  const layer = createTeamLayer({ roles, genes })
  return playPolicyBattle({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons),
    tier: 'elite',
    seed,
    maxTurns,
    policy: observer.wrap(layer.policy),
    playerReplacement: layer.replacement,
    onTurn: observer.onTurn,
  })
}

describe('cycle s20j - team-layer columns, real play', () => {
  it('counts the support switch on turn 1 and the turn-1 SWITCH action', () => {
    // cycles20i case 1/2: Jolteon vs full-HP Machamp; Thunderbolt is not a KO,
    // the active mon is not threatened, and the support (Kingdra) is on slot 1.
    const observer = createPolicyObserver({ stayProbe: true })
    roleBattle(
      [
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_THUNDERBOLT'] },
        { species: 'SPECIES_KINGDRA', level: 50, moves: ['MOVE_RAIN_DANCE', 'MOVE_WATER_PULSE'] },
      ],
      ['attacker', 'support'],
      [mon('SPECIES_MACHAMP', ['MOVE_WATER_PULSE'])],
      observer,
      1,
      1,
      { purposeFlags: { ...DEFAULT_TEAM_GENES.purposeFlags, doubleSwitch: false } },
    )

    expect(observer.teamCounters.switches.support).toBe(1)
    expect(observer.teamCounters.switches.preserve).toBe(0)
    expect(observer.teamCounters.switches.sacrifice).toBe(0)
    expect(observer.teamCounters.switches.counter).toBe(0)
    expect(observer.teamCounters.switches.doubleSwitch).toBe(0)
    expect(observer.teamCounters.switches.entryAbility).toBe(0)
    expect(observer.teamCounters.switches.ppLoop).toBe(0)
    expect(observer.turn1Action).toBe('SWITCH')
    expect(observer.teamCounters.stayTurns).toBe(0)
  })

  it('counts an outspeeding KO stay and reports a move id on turn 1', () => {
    // Jolteon outspeeds and KOs a Magikarp; Kingdra support is on the bench.
    const observer = createPolicyObserver({ stayProbe: true })
    roleBattle(
      [
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_THUNDERBOLT'] },
        { species: 'SPECIES_KINGDRA', level: 50, moves: ['MOVE_RAIN_DANCE', 'MOVE_WATER_PULSE'] },
      ],
      ['attacker', 'support'],
      [mon('SPECIES_MAGIKARP', ['MOVE_SPLASH'])],
      observer,
      1,
    )

    expect(observer.teamCounters.stayTurns).toBe(1)
    expect(observer.teamCounters.stayOutspeedTurns).toBe(1)
    for (const purpose of ['preserve', 'sacrifice', 'counter', 'doubleSwitch', 'entryAbility', 'support', 'ppLoop'] as const) {
      expect(observer.teamCounters.switches[purpose]).toBe(0)
      expect(observer.teamCounters.turnsWithoutSwitch[purpose]).toBe(0)
    }
    expect(observer.turn1Action).toBe('MOVE_THUNDERBOLT')
  })

  it('counts a preserve switch on a stay turn that does not outspeed', () => {
    // cycles20i case 4 position A, driven by hand because the fixture patches HP.
    const session = createSession({
      data,
      playerParty: buildPlayerParty(
        [
          { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] },
          { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_IRON_HEAD'] },
        ],
        50,
        data,
      ),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])]),
      rng: createRandomSource(1),
    })
    patchMon(session.state, 1, 0, { hp: 30 })
    patchMon(session.state, 0, 0, { hp: 80 })

    const observer = createPolicyObserver({ stayProbe: true })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'], genes: { preserve: 0 } })
    const trace: PolicyTraceEntry[] = []
    beginTurn(session)
    const choice = observer.wrap(layer.policy)(session, 1, trace)
    expect(choice?.switchTo).toBe(1)
    session.state.battlers[0]!.monToSwitchIntoId = choice!.switchTo ?? PARTY_SIZE
    observer.onTurn(1, choice, stepTurn(session, choice!.action))

    expect(observer.teamCounters.stayTurns).toBe(1)
    expect(observer.teamCounters.stayOutspeedTurns).toBe(0)
    expect(observer.teamCounters.stayPreserveFired).toBe(1)
    expect(observer.teamCounters.switches.preserve).toBe(1)
    expect(observer.turn1Action).toBe('SWITCH')
  })
})

describe('cycle s20j - hand-driven negatives', () => {
  const seedSession = (): BattleSession =>
    createSession({
      data,
      playerParty: buildPlayerParty(
        [
          { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
          { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
        ],
        50,
        data,
      ),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
      rng: createRandomSource(1),
    })

  it('keeps a sacrifice non-switch out of the switch column, ignores a role pivot, and keeps turn 1 fixed', () => {
    const observer = createPolicyObserver({ stayProbe: false })
    const session = seedSession()

    drive(observer, session, 1, useMove('MOVE_TACKLE'), ['team', 'sacrifice'])
    expect(observer.teamCounters.switches.sacrifice).toBe(0)
    expect(observer.teamCounters.turnsWithoutSwitch.sacrifice).toBe(1)
    expect(observer.turn1Action).toBe('MOVE_TACKLE')

    // A role-layer pivot (switchTo, no `team` tag) counts in neither column.
    drive(observer, session, 2, useMove('MOVE_U_TURN', 1), ['support', 'pivot'])
    expect(observer.teamCounters.switches.support).toBe(0)
    expect(observer.teamCounters.turnsWithoutSwitch.support).toBe(0)

    // A turn-2 team switch does not rewrite the turn-1 record.
    drive(observer, session, 3, hardSwitch(1), ['team', 'support'])
    expect(observer.teamCounters.switches.support).toBe(1)
    expect(observer.turn1Action).toBe('MOVE_TACKLE')

    // Probe off: no stay counters.
    expect(observer.teamCounters.stayTurns).toBe(0)
    expect(observer.teamCounters.stayOutspeedTurns).toBe(0)
    expect(observer.teamCounters.probeMs).toBe(0)
  })

  it('gives an expectimax record no team values', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json'),
        'utf8',
      ),
    ) as PolicyComparisonFixture
    const setup = buildFightSetup(data, fixture.fights[0]!)
    const record = playComparisonGame(setup, 'expectimax', gameSeed(0, 1), { maxTurns: 1 })

    expect(record.teamSwitches).toBeUndefined()
    expect(record.teamTurnsWithoutSwitch).toBeUndefined()
    expect(record.teamStayTurns).toBeUndefined()
    expect(record.turn1Action).toBeUndefined()
  })
})

describe('cycle s20j - probe purity', () => {
  it('a probed game and an unobserved game agree on outcome, turns and party HP', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json'),
        'utf8',
      ),
    ) as PolicyComparisonFixture
    const setup = buildFightSetup(data, fixture.fights[0]!)

    const play = (observe: boolean) => {
      const layer = createTeamLayer({
        roles: setup.roles,
        roleParams: setup.roleParams,
        genes: DEFAULT_TEAM_GENES,
      })
      const observer = observe ? createPolicyObserver({ stayProbe: true }) : null
      const result = playPolicyBattle({
        data: setup.data,
        playerParty: setup.party,
        opponentTrainer: setup.trainer,
        tier: setup.tier,
        seed: gameSeed(0, 1),
        leadIndex: setup.leadIndex,
        format: setup.fightSpec.format,
        inverseBattle: setup.fightSpec.inverseBattle,
        battleEvents: setup.fightSpec.battleEvents,
        startFieldEffects: setup.fightSpec.startFieldEffects,
        policy: observer ? observer.wrap(layer.policy) : layer.policy,
        playerReplacement: layer.replacement,
        onTurn: observer?.onTurn,
        maxTurns: 20,
      })
      return { result, observer }
    }

    const probed = play(true)
    const plain = play(false)
    expect(probed.result.outcome).toBe(plain.result.outcome)
    expect(probed.result.turns).toBe(plain.result.turns)
    expect(partyHp(probed.result.session, 0)).toEqual(partyHp(plain.result.session, 0))
    expect(partyHp(probed.result.session, 1)).toEqual(partyHp(plain.result.session, 1))
    expect(probed.observer!.teamCounters.probeMs).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function record(won: boolean, duplicate = false): ComparisonGameRecord {
  const base: ComparisonGameRecord = {
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
    teamSwitches: {
      preserve: 1,
      sacrifice: 0,
      counter: 0,
      doubleSwitch: 0,
      entryAbility: 0,
      support: 0,
      ppLoop: 0,
    },
    teamTurnsWithoutSwitch: {
      preserve: 0,
      sacrifice: 2,
      counter: 0,
      doubleSwitch: 0,
      entryAbility: 0,
      support: 0,
      ppLoop: 0,
    },
    teamStayTurns: 3,
    teamStayOutspeedTurns: 1,
    teamStayPreserveFired: 1,
    turn1Action: duplicate ? 'MOVE_TACKLE' : 'SWITCH',
  }
  return base
}

function measurement(
  roleRecords: ComparisonGameRecord[],
  expectimaxRecords: ComparisonGameRecord[],
): FightMeasurement {
  const role = summarizePolicy('role', roleRecords)
  const expectimax = summarizePolicy('expectimax', expectimaxRecords)
  return {
    key: 'TRAINER_X-attack',
    trainer: 'TRAINER_X',
    kind: 'attack',
    role,
    expectimax,
    classification: classifyWinRates(role.rate, expectimax.rate),
    logFiles: [],
  }
}

function render(fights: FightMeasurement[]): string {
  return renderGateReport({ games: 80, maxTurns: 200, seedOffset: 0, logDir: 'logs', fights })
}

describe('cycle s20j - report columns', () => {
  it('sums team values into both new sections', () => {
    const fight = measurement(
      [record(false), record(true, true)],
      [record(true), record(false)],
    )
    const report = render([fight])
    const team = report.slice(
      report.indexOf('## Team layer (role policy)'),
      report.indexOf('## Turn 1 actions (role policy)'),
    )
    expect(team).toContain('| TRAINER_X-attack | 2 | 0 | 0 | 0 | 0 | 0 | 0 | sacrifice=4 | 6 | 2 | 2 |')
    const turn1 = report.slice(
      report.indexOf('## Turn 1 actions (role policy)'),
      report.indexOf('## Classification'),
    )
    expect(turn1).toContain('| TRAINER_X-attack | SWITCH=1, MOVE_TACKLE=1 |')
  })

  it('renders - for a summary whose team fields were deleted', () => {
    const fight = measurement([record(false), record(true)], [record(true), record(false)])
    delete fight.role.teamSwitches
    delete fight.role.teamTurnsWithoutSwitch
    delete fight.role.teamStayTurns
    delete fight.role.teamStayOutspeedTurns
    delete fight.role.teamStayPreserveFired
    delete fight.role.turn1Actions
    const report = render([fight])
    expect(report).toContain('| TRAINER_X-attack | - | - | - | - | - | - | - | - | - | - |')
    expect(report).toContain('| TRAINER_X-attack | - |')
  })
})
