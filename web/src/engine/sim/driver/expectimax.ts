// Expectimax player policy.
//
// The opponent's AI decides from the state at the START of a turn, before it sees the
// player's choice, so its action distribution does not depend on what the player does.
// That lets one set of sampled opponent actions be shared by every candidate player action
// (common random numbers: the same sampled action AND the same generator seed per sample),
// which both cuts the cost and removes most of the noise between candidates.
//
//   value(state, depth) = max over player choices of  mean over samples of  value(next, depth - 1)
//
// Leaves are scored by `evaluateState`. A player choice is a move (mega-evolving whenever the
// game allows it) or a voluntary switch to a live party member.

import { chooseAiAction } from '../ai/chooseAiAction'
import { getMostSuitableMonToSwitchInto } from '../ai/aiSwitching'
import { PARTY_SIZE } from '../constants'
import { createRandomSource } from '../rng'
import type { BattleState } from '../state'
import type { ChosenAction } from '../turnOrder'
import { aiDamageDepsFor, buildMoveAction, cloneSession, beginTurn, createSession, firstLiveReplacement, stepTurn, type BattleSession } from './session'
import type { SimDataBundle } from './loadSimData'

export interface ExpectimaxOptions {
  /** Plies of lookahead. 1 = score the position after one turn. */
  depth: number
  /** Sampled (opponent action, generator seed) pairs at the root. */
  samples: number
  /** Samples used at plies below the root. */
  innerSamples: number
  /** A switch must beat the best move by at least this much to be chosen. */
  switchMargin: number
}

export const DEFAULT_EXPECTIMAX: ExpectimaxOptions = { depth: 1, samples: 6, innerSamples: 2, switchMargin: 0.05 }

export interface PlayerChoice {
  action: ChosenAction
  /** Party slot for a voluntary switch. */
  switchTo?: number
}

function hpFraction(hp: number, maxHp: number): number {
  return maxHp > 0 ? hp / maxHp : 0
}

function sideScore(state: BattleState, side: 0 | 1): { hp: number; alive: number; stages: number } {
  const active = state.battlers[side]
  const party = state.sides[side].party
  let hp = 0
  let alive = 0
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const isActive = active !== null && active !== undefined && active.partyIndex === i
    const curHp = isActive ? active.mon.hp : mon.hp
    const maxHp = isActive ? active.mon.maxHp : mon.maxHp
    hp += hpFraction(curHp, maxHp)
    if (curHp > 0) alive++
  }
  let stages = 0
  if (active && active.mon.hp > 0) {
    // atk, def, spatk, spdef, speed (indices 1..5 of the 8 stat stages) relative to the neutral 6
    for (let s = 1; s <= 5; s++) stages += Math.max(-6, Math.min(6, (active.mon.statStages[s] ?? 6) - 6))
  }
  return { hp, alive, stages }
}

/** Static score of a position from the player's side: higher is better for the player. */
export function evaluateState(state: BattleState): number {
  if (state.battleOutcome === 'WON') return 100
  if (state.battleOutcome === 'LOST') return -100
  return positionScore(state)
}

/** The material and boost balance, ignoring whether the battle is already decided. */
export function positionScore(state: BattleState): number {
  const me = sideScore(state, 0)
  const them = sideScore(state, 1)
  return me.hp - them.hp + 0.3 * (me.alive - them.alive) + 0.04 * (me.stages - them.stages)
}

export function legalChoices(session: BattleSession): PlayerChoice[] {
  const { state, data } = session
  const battler = state.battlers[0]
  if (!battler || battler.mon.hp === 0) return []
  const choices: PlayerChoice[] = []
  for (let i = 0; i < battler.mon.moves.length; i++) {
    const moveId = battler.mon.moves[i]
    if (moveId && battler.mon.pp[i] > 0) {
      const action = buildMoveAction(state, data, 0, moveId)
      choices.push({ action })
    }
  }
  if (choices.length === 0) choices.push({ action: buildMoveAction(state, data, 0, 'MOVE_STRUGGLE') })

  const party = state.sides[0].party
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0 && i !== battler.partyIndex) {
      choices.push({ action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, switchTo: i })
    }
  }
  return choices
}

function applyChoice(session: BattleSession, choice: PlayerChoice): void {
  const battler = session.state.battlers[0]
  if (battler) battler.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
}

interface OpponentSample {
  action: ChosenAction | null
  seed: number
}

function sampleOpponent(session: BattleSession, count: number, seedBase: number): OpponentSample[] {
  const samples: OpponentSample[] = []
  for (let k = 0; k < count; k++) {
    const seed = (seedBase + k * 0x9e3779b1) >>> 0
    const probe = cloneSession(session, seed)
    const opp = probe.state.battlers[1]
    const action = opp && opp.mon.hp > 0 ? chooseAiAction(probe.state, 1, probe.chooseAiDeps).action : null
    samples.push({ action, seed })
  }
  return samples
}

function value(session: BattleSession, depth: number, options: ExpectimaxOptions, seedBase: number): number {
  if (session.state.battleOutcome || depth === 0) return evaluateState(session.state)
  const choices = legalChoices(session)
  if (choices.length === 0) return evaluateState(session.state)
  const samples = sampleOpponent(session, options.innerSamples, seedBase)
  let best = -Infinity
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, depth, options)
    if (v > best) best = v
  }
  return best
}

function meanOver(
  session: BattleSession,
  choice: PlayerChoice,
  samples: OpponentSample[],
  depth: number,
  options: ExpectimaxOptions,
): number {
  let sum = 0
  for (const sample of samples) {
    const next = cloneSession(session, sample.seed)
    applyChoice(next, choice)
    stepTurn(next, choice.action, sample.action)
    sum += value(next, depth - 1, options, sample.seed ^ 0x85ebca6b)
  }
  return sum / samples.length
}

/** Picks the player's action for the coming turn; also sets the switch slot on the real state. */
export function chooseExpectimaxAction(
  session: BattleSession,
  options: ExpectimaxOptions,
  seed: number,
): PlayerChoice | null {
  const choices = legalChoices(session)
  if (choices.length === 0) return null
  if (choices.length === 1) return choices[0]

  const samples = sampleOpponent(session, options.samples, seed)
  let bestMove: { choice: PlayerChoice; v: number } | null = null
  let bestSwitch: { choice: PlayerChoice; v: number } | null = null
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, options.depth, options)
    const slot = choice.switchTo === undefined ? 'move' : 'switch'
    if (slot === 'move') {
      if (!bestMove || v > bestMove.v) bestMove = { choice, v }
    } else if (!bestSwitch || v > bestSwitch.v) {
      bestSwitch = { choice, v }
    }
  }
  if (bestSwitch && (!bestMove || bestSwitch.v > bestMove.v + options.switchMargin)) return bestSwitch.choice
  return bestMove ? bestMove.choice : bestSwitch ? bestSwitch.choice : null
}

/** After a faint the player's replacement comes from the game's own "most suitable mon" heuristic. */
export function createHeuristicPlayerReplacement(data: SimDataBundle): (state: BattleState) => number {
  return (state) => {
    const deps = aiDamageDepsFor(data, state)
    const battler = state.battlers[0]
    if (!battler) return PARTY_SIZE
    const saved = battler.monToSwitchIntoId
    battler.monToSwitchIntoId = PARTY_SIZE
    const result = getMostSuitableMonToSwitchInto(state, 0, deps)
    battler.monToSwitchIntoId = saved
    return result.partyIndex === PARTY_SIZE ? firstLiveReplacement(state) : result.partyIndex
  }
}

export interface ExpectimaxBattleOptions {
  data: SimDataBundle
  playerParty: import('../state').SimPartyMon[]
  opponentTrainer: import('./loadSimData').TrainerData
  tier?: 'ace' | 'elite' | 'hell'
  seed: number
  maxTurns?: number
  expectimax?: ExpectimaxOptions
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
}

export interface ExpectimaxBattleResult {
  outcome: 'WON' | 'LOST' | 'DREW' | 'MAX_TURNS'
  turns: number
  /** positionScore at the end of the battle. */
  finalScore: number
}

/** Plays one battle with the expectimax policy on the player's side. */
export function playExpectimaxBattle(options: ExpectimaxBattleOptions): ExpectimaxBattleResult {
  const maxTurns = options.maxTurns ?? 60
  const expectimax = options.expectimax ?? DEFAULT_EXPECTIMAX
  const session = createSession({
    data: options.data,
    playerParty: options.playerParty,
    opponentTrainer: options.opponentTrainer,
    tier: options.tier,
    rng: createRandomSource(options.seed),
    playerReplacement: createHeuristicPlayerReplacement(options.data),
    battleEvents: options.battleEvents,
  })
  let turns = 0
  while (!session.state.battleOutcome && turns < maxTurns) {
    turns++
    beginTurn(session)
    const choice = chooseExpectimaxAction(session, expectimax, (options.seed * 31 + turns) >>> 0)
    if (choice) applyChoice(session, choice)
    stepTurn(session, choice ? choice.action : null)
  }
  return { outcome: session.state.battleOutcome ?? 'MAX_TURNS', turns, finalScore: positionScore(session.state) }
}

/** Fraction of `games` seeded battles the player wins. */
export function expectimaxWinRate(options: Omit<ExpectimaxBattleOptions, 'seed'>, games: number, baseSeed: number): number {
  let wins = 0
  for (let g = 0; g < games; g++) {
    if (playExpectimaxBattle({ ...options, seed: baseSeed + g }).outcome === 'WON') wins++
  }
  return wins / games
}
