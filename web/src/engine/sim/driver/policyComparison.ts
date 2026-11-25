// Pure, headless measurement harness for the solver-v2 policy gate
// (docs/battle-sim/solver-v2-plan.md Step 2.0b, decisions 14 and 15). It plays
// the fixture's teams on identical seeds under two player policies -- the role
// policy with the team layer, and depth-1 expectimax -- and records what it
// measured: win rate and its Wilson interval, time per game, capped games,
// boosting-move availability/use, whether the mon attacked once boosted, the
// AI's voluntary switches and what our policy did on those turns. No React, no
// node:fs, no judgement of the gate itself.

import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
} from '../constants'
import type { ChosenAction } from '../turnOrder'
import type { TurnOutcome } from '../turn'
import type { BattlerState, SimPartyMon } from '../state'
import type { StatKey } from '../../types'
import type { PlayerMonSpec } from './buildParty'
import { buildPlayerParty } from './buildParty'
import type { PlayerChoice } from './expectimax'
import { DEFAULT_EXPECTIMAX, chooseExpectimaxAction, legalChoices } from './expectimax'
import { fightSpecFor, type FightSpec } from './fightSpec'
import { levelCapForTrainer } from './fights'
import type { SimDataBundle, TrainerData } from './loadSimData'
import type { PolicyTraceEntry } from './policyBattle'
import { playPolicyBattle, type PolicyBattleResult } from './policyBattle'
import type { RoleName, RoleParams } from './rolePolicy'
import { boostStatsOf } from './rolePolicy'
import type { StepResult } from './session'
import type { BattleSession } from './session'
import { DEFAULT_TEAM_GENES, createTeamLayer } from './teamLayer'
import { wilsonInterval } from './wilson'

export const POLICY_GATE_Z = 1.96

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export interface PolicyComparisonMember {
  species: string
  ability: string | null
  item: string | null
  nature: string
  evs: Partial<Record<StatKey, number>>
  moves: (string | null)[]
  role: string
  fallbackRole?: string
  ironPill?: boolean
}

export interface PolicyComparisonFight {
  trainer: string
  kind: string
  lead: number
  team: PolicyComparisonMember[]
}

export interface PolicyComparisonFixture {
  source: string
  fights: PolicyComparisonFight[]
}

/** A fight's identity. `TRAINER_GLACIA` appears twice in the fixture (as an
 * `attack` fight and a `stall` fight), so trainer + kind is the key everywhere:
 * maps, file names and report rows. */
export function fightKey(fight: Pick<PolicyComparisonFight, 'trainer' | 'kind'>): string {
  return `${fight.trainer}-${fight.kind}`
}

const ROLE_ALIASES: Record<string, RoleName> = {
  attacker: 'attacker',
  pivot: 'pivot',
  leadHazard: 'leadHazard',
  setupSweeper: 'setupSweeper',
  staller: 'staller',
  support: 'support',
  sweeper: 'setupSweeper',
  lead: 'leadHazard',
}

/** The fixture's role labels use two shorthand names; every other label is a
 * `RoleName` verbatim. An unknown label is a fixture error, so it throws. */
export function roleNameFor(raw: string): RoleName {
  const role = ROLE_ALIASES[raw]
  if (!role) throw new Error(`roleNameFor: unknown role '${raw}'`)
  return role
}

function fallbackRoleFor(raw: string): 'attacker' | 'staller' {
  if (raw === 'attacker' || raw === 'staller') return raw
  throw new Error(`fallbackRoleFor: unknown fallback role '${raw}'`)
}

export interface PolicyFightSetup {
  data: SimDataBundle
  key: string
  trainer: TrainerData
  tier: 'elite'
  levelCap: number
  party: SimPartyMon[]
  roles: RoleName[]
  roleParams: RoleParams[]
  leadIndex: number
  fightSpec: FightSpec
}

/** Loads one fixture fight against the pinned data. Roles and fallback roles
 * stay in parallel arrays indexed by party index; every other role parameter
 * is left at its default (decision 14's middle values). */
export function buildFightSetup(data: SimDataBundle, fight: PolicyComparisonFight): PolicyFightSetup {
  const trainer = data.trainersById.get(fight.trainer)
  if (!trainer) throw new Error(`buildFightSetup: unknown trainer ${fight.trainer}`)

  const resolved = levelCapForTrainer(fight.trainer)
  if (!resolved || !('cap' in resolved)) {
    throw new Error(`buildFightSetup: no level cap for ${fight.trainer}`)
  }
  const levelCap = resolved.cap

  const specs: PlayerMonSpec[] = fight.team.map((member) => ({
    species: member.species,
    ability: member.ability,
    item: member.item,
    nature: member.nature,
    evs: member.evs,
    moves: member.moves,
    ironPill: member.ironPill,
  }))

  return {
    data,
    key: fightKey(fight),
    trainer,
    tier: 'elite',
    levelCap,
    party: buildPlayerParty(specs, levelCap, data, { levelCap }),
    roles: fight.team.map((member) => roleNameFor(member.role)),
    roleParams: fight.team.map((member) =>
      member.fallbackRole ? { fallbackRole: fallbackRoleFor(member.fallbackRole) } : {},
    ),
    leadIndex: fight.lead,
    fightSpec: fightSpecFor(data, fight.trainer),
  }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** Game `g` (1-based) plays on this seed, exactly like `scoreTeam`
 * (solver.ts:459). One function so both policies cannot disagree. */
export function gameSeed(seedOffset: number, game: number): number {
  return seedOffset + game * 1000
}

export function gameSeeds(games: number, seedOffset = 0): number[] {
  return Array.from({ length: games }, (_, index) => gameSeed(seedOffset, index + 1))
}

// ---------------------------------------------------------------------------
// Boosting moves
// ---------------------------------------------------------------------------

const DEFENSE_BOOST_EFFECT = /^EFFECT_(DEFENSE|SPECIAL_DEFENSE)_UP(_2|_3)?$/

/** A move counts as boosting when the role table recognises it as a self-boost
 * (`boostStatsOf`), or when it is a self-targeted status move whose effect is a
 * plain Def / Sp. Def raise. The second clause is what catches Iron Defense
 * (`EFFECT_DEFENSE_UP_2`), which the role table deliberately omits because it
 * raises a stat the sweeper does not count. */
export function isBoostingMove(session: BattleSession, moveId: string): boolean {
  if (boostStatsOf(session, moveId) !== null) return true
  const move = session.data.dataContext.move(moveId)
  return (
    !!move &&
    move.split === 'STATUS' &&
    move.target === 'USER' &&
    DEFENSE_BOOST_EFFECT.test(move.effect ?? '')
  )
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

export interface BoostingCounters {
  /** Turns where our active mon is alive and a legal USE_MOVE choice is a boosting move. */
  available: number
  /** Turns where the chosen move is a boosting move. */
  used: number
  /** Turns where our active mon at decision time has any of stat stages 1..5 above
   * neutral AND has itself used a boosting move since its current switch-in. */
  boosted: number
  /** Boosted turns where the chosen move's split is not STATUS. */
  attackedWhileBoosted: number
  /** Turns where the active mon at decision time has any of stat stages 1..5 above
   * neutral, whatever raised them (passive raises and Baton-Passed stages included). */
  positiveStage: number
}

export interface ActiveView {
  speciesId: string | null
  hp: number
  maxHp: number
  status1: number
  statStages: number[]
}

export interface ObservedTurn {
  turn: number
  player: ActiveView
  opponent: ActiveView
  playerPartySpecies: (string | null)[]
  opponentPartySpecies: (string | null)[]
  choice: PlayerChoice | null
  trace: PolicyTraceEntry[]
  chosenActions: (ChosenAction | null)[]
  outcome: TurnOutcome
}

export type PolicyFn = (
  session: BattleSession,
  turn: number,
  trace: PolicyTraceEntry[],
) => PlayerChoice | null

export interface PolicyObserver {
  /** Wraps a policy so the pre-turn position and the policy's own trace slice
   * are captured before the inner policy's choice is applied. */
  wrap: (policy: PolicyFn) => PolicyFn
  onTurn: (turn: number, choice: PlayerChoice | null, step: StepResult) => void
  counters: BoostingCounters
  aiSwitchSummary: { total: number; byThing: Record<string, number> }
  /** Per-turn captures, populated only when `collectLog` is on. */
  turns: ObservedTurn[]
}

interface PendingCapture {
  turn: number
  data: SimDataBundle
  activeAlive: boolean
  player: ActiveView
  opponent: ActiveView
  playerPartySpecies: (string | null)[]
  opponentPartySpecies: (string | null)[]
  boosted: boolean
  /** True when the active mon came in since the previous decision: a freshly
   * switched-in or replaced battler gets `isFirstTurn = 2` (switchIn.ts via
   * createBattlerState), the battle-start and end-of-turn TurnValuesCleanUp
   * decrement it once, so it is nonzero at a decision exactly on the first
   * decision after the mon entered (turn 1, a voluntary switch, Baton Pass, a
   * forced switch or a faint replacement). */
  switchedIn: boolean
  hasBoostingChoice: boolean
  boostingIds: Set<string>
  trace: PolicyTraceEntry[]
}

const COUNTING_STAGES = [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]

function activeView(battler: BattlerState | null | undefined): ActiveView {
  if (!battler) return { speciesId: null, hp: 0, maxHp: 0, status1: 0, statStages: [] }
  return {
    speciesId: battler.mon.speciesId ?? null,
    hp: battler.mon.hp,
    maxHp: battler.mon.maxHp,
    status1: battler.mon.status1,
    statStages: [...battler.mon.statStages],
  }
}

function isBoosted(battler: BattlerState | null | undefined): boolean {
  if (!battler || battler.mon.hp <= 0) return false
  return COUNTING_STAGES.some(
    (stat) => (battler.mon.statStages[stat] ?? DEFAULT_STAT_STAGE) > DEFAULT_STAT_STAGE,
  )
}

function captureTurn(session: BattleSession, turn: number): PendingCapture {
  const { state } = session
  const active = state.battlers[0]
  const opponent = state.battlers[1]
  const boostingIds = new Set<string>()
  let hasBoostingChoice = false
  for (const choice of legalChoices(session)) {
    if (choice.action.action !== 'USE_MOVE') continue
    const moveId = choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id
    if (moveId && isBoostingMove(session, moveId)) {
      hasBoostingChoice = true
      boostingIds.add(moveId)
    }
  }
  return {
    turn,
    data: session.data,
    activeAlive: !!active && active.mon.hp > 0,
    player: activeView(active),
    opponent: activeView(opponent),
    playerPartySpecies: state.sides[0].party.map((mon) => mon?.speciesId ?? null),
    opponentPartySpecies: state.sides[1].party.map((mon) => mon?.speciesId ?? null),
    boosted: isBoosted(active),
    switchedIn: (active?.volatiles.isFirstTurn ?? 0) !== 0,
    hasBoostingChoice,
    boostingIds,
    trace: [],
  }
}

/** One observer per game. `wrap` is passed as `playPolicyBattle`'s `policy`;
 * `onTurn` as its `onTurn` hook. The wrapper only reads the session (legal
 * choices are pure), so it consumes no RNG and mutates nothing. */
export function createPolicyObserver(options: { collectLog?: boolean } = {}): PolicyObserver {
  const counters: BoostingCounters = {
    available: 0,
    used: 0,
    boosted: 0,
    attackedWhileBoosted: 0,
    positiveStage: 0,
  }
  const aiSwitchSummary = { total: 0, byThing: {} as Record<string, number> }
  const turns: ObservedTurn[] = []
  let pending: PendingCapture | null = null
  let ownBoostSinceSwitchIn = false

  const wrap = (policy: PolicyFn): PolicyFn => (session, turn, trace) => {
    const before = trace.length
    pending = captureTurn(session, turn)
    const choice = policy(session, turn, trace)
    pending.trace = trace.slice(before)
    return choice
  }

  const onTurn = (turn: number, choice: PlayerChoice | null, step: StepResult): void => {
    const captured = pending
    if (!captured || captured.turn !== turn) {
      throw new Error(`policy observer: no capture for turn ${turn}`)
    }
    const chosenMoveId =
      choice && choice.action.action === 'USE_MOVE'
        ? (choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null)
        : null

    if (captured.switchedIn) ownBoostSinceSwitchIn = false

    if (captured.activeAlive && captured.hasBoostingChoice) counters.available++
    if (chosenMoveId && captured.boostingIds.has(chosenMoveId)) counters.used++
    if (captured.boosted) {
      counters.positiveStage++
      if (ownBoostSinceSwitchIn) {
        counters.boosted++
        const split = chosenMoveId ? captured.data.dataContext.move(chosenMoveId)?.split : null
        if (chosenMoveId && split !== 'STATUS') counters.attackedWhileBoosted++
      }
    }

    // Set the flag from what actually executed, not from what was chosen: a
    // flinched or otherwise cancelled boost must not make later turns "boosted".
    const playerAction = step.outcome.actions.find(
      (action) => action.battlerId === 0 && action.action === 'USE_MOVE',
    )
    if (
      chosenMoveId &&
      captured.boostingIds.has(chosenMoveId) &&
      playerAction &&
      playerAction.cancelledBy === null &&
      !playerAction.skippedBecauseFainted &&
      !playerAction.battleOver
    ) {
      ownBoostSinceSwitchIn = true
    }

    if (step.chosenActions[1]?.action === 'SWITCH') {
      aiSwitchSummary.total++
      const thing =
        choice === null
          ? 'NONE'
          : choice.action.action === 'SWITCH'
            ? 'SWITCH'
            : (choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? choice.action.action)
      aiSwitchSummary.byThing[thing] = (aiSwitchSummary.byThing[thing] ?? 0) + 1
    }

    if (options.collectLog) {
      turns.push({
        turn,
        player: captured.player,
        opponent: captured.opponent,
        playerPartySpecies: captured.playerPartySpecies,
        opponentPartySpecies: captured.opponentPartySpecies,
        choice,
        trace: captured.trace,
        chosenActions: step.chosenActions,
        outcome: step.outcome,
      })
    }
  }

  return { wrap, onTurn, counters, aiSwitchSummary, turns }
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

export type PolicyKind = 'role' | 'expectimax'

export interface ComparisonGameOptions {
  maxTurns?: number
  collectLog?: boolean
}

export interface ComparisonGameRecord {
  seed: number
  outcome: PolicyBattleResult['outcome']
  turns: number
  capped: boolean
  won: boolean
  ms: number
  available: number
  used: number
  boosted: number
  attackedWhileBoosted: number
  positiveStage: number
  aiSwitches: number
  aiSwitchByThing: Record<string, number>
  playerPartyHp: number[]
  opponentPartyHp: number[]
  log?: string
}

/** Every non-empty party slot's live HP. The active mon keeps its live HP on
 * the battler, not on its stale party slot (session.ts's `switchBattlerOut`
 * note), so the battler wins when it is the one on the field. */
export function partyHp(session: BattleSession, side: 0 | 1): number[] {
  const { state } = session
  return state.sides[side].party.map((mon, slot) => {
    if (!mon || mon.speciesId === null) return 0
    const active = state.battlers.find(
      (battler): battler is BattlerState =>
        battler !== null && (battler.id & 1) === side && battler.partyIndex === slot,
    )
    return active ? active.mon.hp : mon.hp
  })
}

export function playComparisonGame(
  setup: PolicyFightSetup,
  policyKind: PolicyKind,
  seed: number,
  options: ComparisonGameOptions = {},
): ComparisonGameRecord {
  const maxTurns = options.maxTurns ?? 200
  const observer = createPolicyObserver({ collectLog: options.collectLog })
  const common = {
    data: setup.data,
    playerParty: setup.party,
    opponentTrainer: setup.trainer,
    tier: setup.tier,
    seed,
    leadIndex: setup.leadIndex,
    format: setup.fightSpec.format,
    inverseBattle: setup.fightSpec.inverseBattle,
    battleEvents: setup.fightSpec.battleEvents,
    startFieldEffects: setup.fightSpec.startFieldEffects,
    onTurn: observer.onTurn,
    maxTurns,
  }

  const started = performance.now()
  let result: PolicyBattleResult
  if (policyKind === 'role') {
    const layer = createTeamLayer({
      roles: setup.roles,
      roleParams: setup.roleParams,
      genes: DEFAULT_TEAM_GENES,
    })
    result = playPolicyBattle({
      ...common,
      policy: observer.wrap(layer.policy),
      playerReplacement: layer.replacement,
    })
  } else {
    const policy: PolicyFn = (session, turn) =>
      chooseExpectimaxAction(session, DEFAULT_EXPECTIMAX, (seed * 31 + turn) >>> 0)
    result = playPolicyBattle({ ...common, policy: observer.wrap(policy) })
  }
  const ms = performance.now() - started

  const record: ComparisonGameRecord = {
    seed,
    outcome: result.outcome,
    turns: result.turns,
    capped: result.capped,
    won: result.outcome === 'WON',
    ms,
    available: observer.counters.available,
    used: observer.counters.used,
    boosted: observer.counters.boosted,
    attackedWhileBoosted: observer.counters.attackedWhileBoosted,
    positiveStage: observer.counters.positiveStage,
    aiSwitches: observer.aiSwitchSummary.total,
    aiSwitchByThing: { ...observer.aiSwitchSummary.byThing },
    playerPartyHp: partyHp(result.session, 0),
    opponentPartyHp: partyHp(result.session, 1),
  }
  if (observer.turns.length > 0) record.log = formatBattleLog(observer.turns, result)
  return record
}

export interface RunFightGamesOptions {
  games: number
  seedOffset?: number
  maxTurns?: number
  onGame?: (policy: PolicyKind, game: number, record: ComparisonGameRecord) => void
}

/** The per-fight loop: `role` then `expectimax`, games 1..`games`, each game on
 * `gameSeed(seedOffset, game)`, logs collected only for role games 1 and 2. */
export function runFightGames(
  setup: PolicyFightSetup,
  options: RunFightGamesOptions,
): Record<PolicyKind, ComparisonGameRecord[]> {
  const { games, seedOffset = 0, maxTurns, onGame } = options
  const records: Record<PolicyKind, ComparisonGameRecord[]> = { role: [], expectimax: [] }
  for (const policy of ['role', 'expectimax'] as const) {
    for (let game = 1; game <= games; game++) {
      const seed = gameSeed(seedOffset, game)
      const collectLog = policy === 'role' && game <= 2
      const record = playComparisonGame(setup, policy, seed, { maxTurns, collectLog })
      records[policy].push(record)
      onGame?.(policy, game, record)
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// Battle log
// ---------------------------------------------------------------------------

const STATUS_NAMES: [number, string][] = [
  [STATUS1_SLEEP, 'SLP'],
  [STATUS1_POISON, 'PSN'],
  [STATUS1_BURN, 'BRN'],
  [STATUS1_FREEZE, 'FRZ'],
  [STATUS1_PARALYSIS, 'PAR'],
  [STATUS1_TOXIC_POISON, 'TOX'],
  [STATUS1_FROSTBITE, 'FRB'],
  [STATUS1_BLEED, 'BLD'],
]

function statusText(status1: number): string {
  const names = STATUS_NAMES.filter(([bit]) => (status1 & bit) !== 0).map(([, name]) => name)
  return names.length > 0 ? names.join('+') : 'none'
}

const STAGE_NAMES: [number, string][] = [
  [STAT_ATK, 'atk'],
  [STAT_DEF, 'def'],
  [STAT_SPEED, 'spe'],
  [STAT_SPATK, 'spa'],
  [STAT_SPDEF, 'spd'],
]

function statStageText(stages: number[]): string {
  const parts: string[] = []
  for (const [stat, name] of STAGE_NAMES) {
    const delta = (stages[stat] ?? DEFAULT_STAT_STAGE) - DEFAULT_STAT_STAGE
    if (delta !== 0) parts.push(`${name}${delta > 0 ? '+' : ''}${delta}`)
  }
  return parts.join(',')
}

function activeText(view: ActiveView): string {
  if (view.speciesId === null) return 'none'
  const stages = statStageText(view.statStages)
  return `${view.speciesId} HP ${view.hp}/${view.maxHp} status ${statusText(view.status1)}${stages ? ` stages ${stages}` : ''}`
}

function choiceText(choice: PlayerChoice | null, partySpecies: (string | null)[]): string {
  if (!choice) return 'NONE'
  if (choice.action.action === 'SWITCH') {
    const target =
      choice.switchTo !== undefined
        ? (partySpecies[choice.switchTo] ?? `slot ${choice.switchTo}`)
        : '(no slot)'
    return `SWITCH -> ${target}`
  }
  const moveId = choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? '(none)'
  if (choice.switchTo !== undefined) {
    return `${moveId} (switchTo ${choice.switchTo}: ${partySpecies[choice.switchTo] ?? '?'})`
  }
  return moveId
}

function actionText(action: ChosenAction | null): string {
  if (!action) return 'NONE'
  if (action.action === 'SWITCH') return 'SWITCH'
  const moveId = action.chosenMove?.id ?? action.moveToBeUsed?.id ?? '(none)'
  return `${action.action} ${moveId}`
}

function actionOutcomeText(action: TurnOutcome['actions'][number]): string {
  const statusApplied = action.statusApplied
    ? `${action.statusApplied.status}->${action.statusApplied.battlerId}`
    : 'none'
  return [
    `battler=${action.battlerId}`,
    `action=${action.action}`,
    `missed=${action.missed}`,
    `cancelledBy=${action.cancelledBy ?? 'none'}`,
    `targetDamage=${action.targetDamage ?? '-'}`,
    `attackerDamage=${action.attackerDamage ?? '-'}`,
    `fainted=[${action.fainted.join(',')}]`,
    `statusApplied=${statusApplied}`,
  ].join(' ')
}

export function formatBattleLog(
  turns: ObservedTurn[],
  result: Pick<PolicyBattleResult, 'outcome' | 'turns' | 'capped'>,
): string {
  const lines: string[] = []
  for (const turn of turns) {
    lines.push(`Turn ${turn.turn}`)
    lines.push(`  player: ${activeText(turn.player)}`)
    lines.push(`  opponent: ${activeText(turn.opponent)}`)
    lines.push(`  our choice: ${choiceText(turn.choice, turn.playerPartySpecies)}`)
    for (const entry of turn.trace) lines.push(`  trace: ${entry.choice}`)
    lines.push(`  AI action: ${actionText(turn.chosenActions[1] ?? null)}`)
    for (const action of turn.outcome.actions) lines.push(`  action: ${actionOutcomeText(action)}`)
  }
  lines.push(`Outcome: ${result.outcome} in ${result.turns} turns${result.capped ? ' (capped)' : ''}`)
  return lines.join('\n')
}

export function battleLogFileName(key: string): string {
  return `role-${key}.log`
}

// ---------------------------------------------------------------------------
// Aggregation and the report
// ---------------------------------------------------------------------------

export type FightClassification = 'uninformative' | 'role>=expectimax' | 'role<expectimax'

/** A fight is uninformative only when BOTH policies win strictly under 20% of
 * games; otherwise the raw rates decide. */
export function classifyWinRates(roleRate: number, expectimaxRate: number): FightClassification {
  if (roleRate < 0.2 && expectimaxRate < 0.2) return 'uninformative'
  return roleRate >= expectimaxRate ? 'role>=expectimax' : 'role<expectimax'
}

export interface PolicySummary {
  policy: PolicyKind
  wins: number
  games: number
  rate: number
  lower: number
  upper: number
  msPerGame: number
  capped: number
  available: number
  used: number
  boosted: number
  attackedWhileBoosted: number
  /** Optional because the committed per-fight JSON files of the first run predate it. */
  positiveStage?: number
  aiSwitches: number
  aiSwitchByThing: Record<string, number>
}

export function summarizePolicy(
  policy: PolicyKind,
  records: ComparisonGameRecord[],
): PolicySummary {
  const games = records.length
  const wins = records.filter((record) => record.won).length
  const interval = games > 0 ? wilsonInterval(wins, games, POLICY_GATE_Z) : { lower: 0, upper: 0 }
  const totalMs = records.reduce((sum, record) => sum + record.ms, 0)
  const aiSwitchByThing: Record<string, number> = {}
  for (const record of records) {
    for (const [thing, count] of Object.entries(record.aiSwitchByThing)) {
      aiSwitchByThing[thing] = (aiSwitchByThing[thing] ?? 0) + count
    }
  }
  const total = (pick: (record: ComparisonGameRecord) => number): number =>
    records.reduce((sum, record) => sum + pick(record), 0)
  return {
    policy,
    wins,
    games,
    rate: games > 0 ? wins / games : 0,
    lower: interval.lower,
    upper: interval.upper,
    msPerGame: games > 0 ? totalMs / games : 0,
    capped: records.filter((record) => record.capped).length,
    available: total((record) => record.available),
    used: total((record) => record.used),
    boosted: total((record) => record.boosted),
    attackedWhileBoosted: total((record) => record.attackedWhileBoosted),
    positiveStage: total((record) => record.positiveStage),
    aiSwitches: total((record) => record.aiSwitches),
    aiSwitchByThing,
  }
}

export interface FightMeasurement {
  key: string
  trainer: string
  kind: string
  role: PolicySummary
  expectimax: PolicySummary
  classification: FightClassification
  logFiles: string[]
}

export interface GateReportInput {
  games: number
  maxTurns: number
  seedOffset: number
  /** Directory the log files were written to, as it should appear in the report. */
  logDir: string
  /** Fights measured so far, in fixture order. */
  fights: FightMeasurement[]
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function switchBreakdown(summary: PolicySummary): string {
  const entries = Object.entries(summary.aiSwitchByThing).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return 'none'
  return entries.map(([thing, count]) => `${thing}=${count}`).join(', ')
}

/** Renders the gate report from measured results only. There is deliberately no
 * overall pass/fail line: a pass needs a human reading of the logs too. */
export function renderGateReport(input: GateReportInput): string {
  const lines: string[] = []
  if (input.games < 80) {
    lines.push(`SMOKE RUN: ${input.games} games per policy; this is not the gate measurement.`, '')
  }
  lines.push('# Role policy gate report', '')
  lines.push(
    'Written by `web/src/engine/sim/driver/policyComparison.test.ts` from the measured results. Nothing here is typed by hand.',
    '',
  )
  lines.push(`- Games per policy: ${input.games}`)
  lines.push(`- Turn cap: ${input.maxTurns}`)
  lines.push(
    `- Seeds: \`seedOffset + g * 1000\` for game g, seedOffset ${input.seedOffset} (game 1 = ${gameSeed(input.seedOffset, 1)}); both policies use the same seed per game.`,
  )
  lines.push(`- Wilson z: ${POLICY_GATE_Z}`)
  lines.push('- Fixture: `docs/battle-sim/role-policy-test-fights.json`')
  lines.push('')

  const hasLegacySummary = input.fights.some(
    (fight) =>
      fight.role.positiveStage === undefined || fight.expectimax.positiveStage === undefined,
  )

  lines.push('## Definitions', '')
  lines.push(
    '- A game counts as won only on `WON`; a capped game (`MAX_TURNS`) counts as not won.',
  )
  lines.push(
    '- Boosting move: a move `boostStatsOf` recognises as a self-boost, or a STATUS move targeting the user whose effect matches `^EFFECT_(DEFENSE|SPECIAL_DEFENSE)_UP(_2|_3)?$` (Iron Defense is `EFFECT_DEFENSE_UP_2`).',
  )
  lines.push(
    '- `available`: turns where our active mon is alive and a legal USE_MOVE choice is a boosting move.',
  )
  lines.push('- `used`: turns where the chosen move is a boosting move.')
  lines.push(
    '- `boosted`: turns where our active mon at decision time has any of stat stages 1..5 above neutral and has itself used a boosting move since its current switch-in.',
  )
  lines.push(
    '- `attacked while boosted`: boosted turns where the chosen move\'s split is not STATUS.',
  )
  lines.push(
    '- `any positive stage`: turns where our active mon at decision time has any of stat stages 1..5 above neutral, whatever raised them (passive raises and Baton-Passed stages included).',
  )
  if (hasLegacySummary) {
    lines.push(
      '- Measurements without an `Any positive stage` value predate the own-boost definition: their `Boosted` and `Attacked boosted` count any positive stage in stats 1..5, passive and Baton-Passed raises included.',
    )
  }
  lines.push(
    '- AI voluntary switches: turns where the AI\'s selection-time action is `SWITCH`, broken down by what our policy did that turn (a move id, `SWITCH`, or `NONE`). Replacements after a faint and pivot moves are not counted.',
  )
  lines.push(
    '- Classification: `uninformative` when both win rates are strictly under 20%; otherwise `role>=expectimax` or `role<expectimax` from the raw win rates.',
  )
  lines.push('')

  lines.push('## Results', '')
  lines.push(
    tableRow([
      'Fight',
      'Policy',
      'Wins',
      'Games',
      'Rate',
      'Wilson low',
      'Wilson high',
      'ms/game',
      'Capped',
      'Available',
      'Used',
      'Boosted',
      'Attacked boosted',
      'Any positive stage',
    ]),
  )
  lines.push(tableRow(Array(14).fill('---')))
  for (const fight of input.fights) {
    for (const summary of [fight.role, fight.expectimax]) {
      lines.push(
        tableRow([
          fight.key,
          summary.policy,
          String(summary.wins),
          String(summary.games),
          pct(summary.rate),
          Math.max(0, summary.lower).toFixed(3),
          summary.upper.toFixed(3),
          summary.msPerGame.toFixed(1),
          String(summary.capped),
          String(summary.available),
          String(summary.used),
          String(summary.boosted),
          String(summary.attackedWhileBoosted),
          summary.positiveStage === undefined ? '-' : String(summary.positiveStage),
        ]),
      )
    }
  }
  lines.push('')

  lines.push('## AI voluntary switches', '')
  lines.push(tableRow(['Fight', 'Policy', 'AI switches', 'Our action on those turns']))
  lines.push(tableRow(Array(4).fill('---')))
  for (const fight of input.fights) {
    for (const summary of [fight.role, fight.expectimax]) {
      lines.push(
        tableRow([
          fight.key,
          summary.policy,
          String(summary.aiSwitches),
          switchBreakdown(summary),
        ]),
      )
    }
  }
  lines.push('')

  lines.push('## Classification', '')
  lines.push(tableRow(['Fight', 'Role rate', 'Expectimax rate', 'Classification']))
  lines.push(tableRow(Array(4).fill('---')))
  for (const fight of input.fights) {
    lines.push(
      tableRow([fight.key, pct(fight.role.rate), pct(fight.expectimax.rate), fight.classification]),
    )
  }
  lines.push('')

  const wilsonText = (summary: PolicySummary): string =>
    `[${Math.max(0, summary.lower).toFixed(3)}, ${summary.upper.toFixed(3)}]`
  const informative = input.fights.filter((fight) => fight.classification !== 'uninformative')
  const roleBehind = input.fights.filter((fight) => fight.classification === 'role<expectimax')
  lines.push('## Informative fights where the role policy wins less often', '')
  lines.push(`Informative fights (classification other than \`uninformative\`): ${informative.length}.`, '')
  if (roleBehind.length === 0) {
    lines.push('No informative fight has the role policy winning less often than expectimax.')
  } else {
    for (const fight of roleBehind) {
      const disjoint =
        fight.role.upper < fight.expectimax.lower || fight.expectimax.upper < fight.role.lower
      lines.push(
        `- ${fight.key}: role ${fight.role.wins}/${fight.role.games}, Wilson ${wilsonText(fight.role)}; expectimax ${fight.expectimax.wins}/${fight.expectimax.games}, Wilson ${wilsonText(fight.expectimax)}; intervals ${disjoint ? 'do not overlap' : 'overlap'}.`,
      )
    }
  }
  lines.push('')
  lines.push(
    'This checks only the "at least as often as expectimax on every informative fight" part of Step 2.0b. "Clearly more" on the stall fight and where Mr. Mime\'s boosts decide, and the reading of the battle logs, are not evaluated here; no overall verdict is given.',
  )
  lines.push('')

  lines.push('## Battle logs', '')
  if (input.fights.length === 0) {
    lines.push('- (none yet)')
  } else {
    for (const fight of input.fights) {
      for (const file of fight.logFiles) lines.push(`- ${fight.key}: \`${input.logDir}/${file}\``)
    }
  }
  lines.push('')
  return lines.join('\n')
}
