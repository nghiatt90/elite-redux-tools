// Battle driver for running simulated battles.
// Assembles singles BattleState from data, executes turns between AI and player policy,
// processes switch-in effects and replacements, and tallies unmodelled mechanics.

import { canMegaEvolve } from '../formChange'
import { PARTY_SIZE } from '../constants'
import type { BattleOutcome, BattleState, RandomSource, SimPartyMon } from '../state'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import { createSession, stepTurn } from './session'
import type { SimDataBundle, TrainerData } from './loadSimData'

export interface RunBattleOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: TrainerData
  tier?: 'ace' | 'elite' | 'hell'
  rng?: RandomSource
  maxTurns?: number
  playerPolicy?: (state: BattleState, unmodelled: string[]) => ChosenAction | null
}

export interface TurnActionSummary {
  battlerId: number
  action: string
  moveId?: string
  damage?: number | null
  targetId?: number | null
  missed?: boolean
  fainted?: number[]
}

export interface TurnLogEntry {
  turn: number
  actions: TurnActionSummary[]
  outcome: BattleOutcome
  unmodelled: string[]
}

export interface BattleRunResult {
  outcome: BattleOutcome | 'MAX_TURNS' | 'ERROR'
  turns: number
  log: TurnLogEntry[]
  unmodelled: Map<string, number>
  error?: string
  megaEvolutions: number
}

/**
 * Default player policy: choose the first move with the highest base power that has PP;
 * switch to the next live mon only when forced.
 */
export function defaultPlayerPolicy(
  state: BattleState,
  data: SimDataBundle,
): ChosenAction | null {
  const battler = state.battlers[0]
  if (!battler || battler.mon.hp === 0) {
    const party = state.sides[0].party
    const activeIdx = battler?.partyIndex ?? -1
    let nextSlot = PARTY_SIZE
    for (let i = 0; i < party.length; i++) {
      const m = party[i]
      if (m && m.speciesId !== null && m.hp > 0 && i !== activeIdx) {
        nextSlot = i
        break
      }
    }
    if (battler) {
      battler.monToSwitchIntoId = nextSlot
    }
    return {
      action: 'SWITCH',
      moveToBeUsed: null,
      chosenMove: null,
      target: null,
    }
  }

  const mon = battler.mon
  let bestMoveId: string | null = null
  let maxPower = -1

  for (let i = 0; i < mon.moves.length; i++) {
    const moveId = mon.moves[i]
    const pp = mon.pp[i]
    if (moveId && pp > 0) {
      const mData = data.dataContext.move(moveId)
      const power = mData?.power ?? 0
      if (power > maxPower) {
        maxPower = power
        bestMoveId = moveId
      }
    }
  }

  const moveIdToUse = bestMoveId ?? 'MOVE_STRUGGLE'
  const mData = data.dataContext.move(moveIdToUse)
  const moveView: TurnOrderMoveView = {
    id: moveIdToUse,
    priority: mData?.priority ?? 0,
    effect: mData?.effect ?? null,
    isStatus: mData?.split === 'STATUS',
    resolvedType: mData?.type ?? 'NORMAL',
    power: mData?.power ?? 0,
    flags: mData?.flags ?? {},
    split: mData?.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }

  const target = mData?.target === 'USER' ? 0 : 1
  const mega = canMegaEvolve(state, 0, data.dataContext)
  return {
    action: 'USE_MOVE',
    moveToBeUsed: moveView,
    chosenMove: moveView,
    target,
    ...(mega ? { mega: true } : {}),
  }
}

/**
 * Runs a simulated singles battle to completion or until maxTurns.
 */
export function runBattle(options: RunBattleOptions): BattleRunResult {
  const tier = options.tier ?? 'elite'
  const maxTurns = options.maxTurns ?? 60
  const data = options.data
  const unmodelledMap = new Map<string, number>()

  function recordUnmodelled(notes: string[]): void {
    for (const n of notes) {
      unmodelledMap.set(n, (unmodelledMap.get(n) ?? 0) + 1)
    }
  }

  let turnCount = 0
  let megaEvolutions = 0
  const log: TurnLogEntry[] = []

  try {
    const session = createSession({
      data,
      playerParty: options.playerParty,
      opponentTrainer: options.opponentTrainer,
      tier,
      rng: options.rng ?? { random16: () => 0 },
    })
    const { state } = session
    recordUnmodelled(session.startUnmodelled)

    while (!state.battleOutcome && turnCount < maxTurns) {
      turnCount++
      const turnUnmodelled: string[] = []

      const playerAction = options.playerPolicy
        ? options.playerPolicy(state, turnUnmodelled)
        : defaultPlayerPolicy(state, data)

      const step = stepTurn(session, playerAction)
      const turnOutcome = step.outcome
      megaEvolutions += turnOutcome.megaEvolutions ?? 0
      turnUnmodelled.push(...step.unmodelled)
      recordUnmodelled(turnUnmodelled)

      const actionSummaries: TurnActionSummary[] = turnOutcome.actions.map((a) => ({
        battlerId: a.battlerId,
        action: a.action,
        moveId: a.chosenMoveId,
        damage: a.targetDamage,
        targetId: a.targetId,
        missed: a.missed,
        fainted: a.fainted,
      }))

      log.push({
        turn: turnCount,
        actions: actionSummaries,
        outcome: state.battleOutcome,
        unmodelled: turnUnmodelled,
      })
    }

    const finalOutcome: BattleOutcome | 'MAX_TURNS' = state.battleOutcome ?? 'MAX_TURNS'
    return {
      outcome: finalOutcome,
      turns: turnCount,
      log,
      unmodelled: unmodelledMap,
      megaEvolutions,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    return {
      outcome: 'ERROR',
      turns: turnCount,
      log,
      unmodelled: unmodelledMap,
      error: errorMsg,
      megaEvolutions,
    }
  }
}
