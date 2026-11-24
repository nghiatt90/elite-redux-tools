// A singles battle loop driven by a caller-supplied POLICY instead of the
// expectimax/legalChoices machinery. The solver-v2 role policies plug in here:
// `policy(session, turn, trace)` observes the position (and appends its own
// trace entries) and returns a `PlayerChoice`, or null to do nothing.
//
// Mirrors `playExpectimaxBattle` (expectimax.ts:1492-1550): same session
// options, same `beginTurn` -> choice -> `stepTurn` order. Two things are
// re-implemented rather than imported because expectimax.ts keeps them
// module-private: the two-line `applyChoice` write (expectimax.ts:1097) and the
// `maxTurns` default (200 here versus expectimax's untouched 60).

import type { BattleFormat } from './battleFormat'
import { createHeuristicPlayerReplacement } from './expectimax'
import type { PlayerChoice } from './expectimax'
import type { SimDataBundle, TrainerData } from './loadSimData'
import type { BattleSession, Tier } from './session'
import { beginTurn, createSession, stepTurn } from './session'
import { PARTY_SIZE } from '../constants'
import { createRandomSource } from '../rng'
import type { BattleState, SimPartyMon } from '../state'

/** One policy-authored trace line. The policy pushes these; the loop itself
 * pushes nothing. `choice` is free-form text the policy writes. */
export interface PolicyTraceEntry {
  turn: number
  choice: string
  tags: string[]
}

export interface PolicyBattleOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: TrainerData
  tier?: Tier
  seed: number
  leadIndex?: number
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
  format?: BattleFormat
  startFieldEffects?: Array<{ effectType: string; fieldId: string }>
  inverseBattle?: boolean
  /** Chooses the player's action for this turn. `trace` is the array returned
   * on the result; entries the policy pushes are preserved in order. */
  policy: (session: BattleSession, turn: number, trace: PolicyTraceEntry[]) => PlayerChoice | null
  /** Which party slot the player sends in after a faint; defaults to the game's
   * own "most suitable mon" heuristic (expectimax.ts:1417-1431). The team layer
   * supplies its matchup-scored replacement here. */
  playerReplacement?: (state: BattleState, battlerId: number) => number
  maxTurns?: number
}

export interface PolicyBattleResult {
  outcome: 'WON' | 'LOST' | 'DREW' | 'MAX_TURNS'
  turns: number
  /** True iff the loop ended by reaching `maxTurns` with no battle outcome. */
  capped: boolean
  trace: PolicyTraceEntry[]
  session: BattleSession
}

/** Plays one singles battle with `options.policy` controlling the player side.
 * Doubles are not supported by this loop (the solver-v2 policies are singles
 * only for now). */
export function playPolicyBattle(options: PolicyBattleOptions): PolicyBattleResult {
  const maxTurns = options.maxTurns ?? 200
  const session = createSession({
    data: options.data,
    playerParty: options.playerParty,
    opponentTrainer: options.opponentTrainer,
    tier: options.tier,
    rng: createRandomSource(options.seed),
    leadIndex: options.leadIndex,
    playerReplacement:
      options.playerReplacement ?? createHeuristicPlayerReplacement(options.data, options.inverseBattle),
    inverseBattle: options.inverseBattle,
    battleEvents: options.battleEvents,
    format: options.format,
    startFieldEffects: options.startFieldEffects,
  })
  if (session.state.battlersCount !== 2) {
    throw new Error(
      `playPolicyBattle: doubles are not supported (the session has ${session.state.battlersCount} battlers)`,
    )
  }

  const trace: PolicyTraceEntry[] = []
  let turns = 0
  while (!session.state.battleOutcome && turns < maxTurns) {
    turns++
    beginTurn(session)
    const choice = options.policy(session, turns, trace)
    // `applyChoice` (expectimax.ts:1097): the party slot a SWITCH -- or a pivot
    // move carrying `switchTo` -- switches into. performSwitchAction reads it
    // (turn.ts:1864).
    const battler = session.state.battlers[0]
    if (battler) battler.monToSwitchIntoId = choice?.switchTo ?? PARTY_SIZE
    stepTurn(session, choice ? choice.action : null)
  }

  const outcome = session.state.battleOutcome ?? 'MAX_TURNS'
  return {
    outcome,
    turns,
    capped: session.state.battleOutcome == null && turns >= maxTurns,
    trace,
    session,
  }
}
