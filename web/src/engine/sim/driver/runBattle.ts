// Battle driver for running simulated battles.
// Assembles singles BattleState from data, executes turns between AI and player policy,
// processes switch-in effects and replacements, and tallies unmodelled mechanics.

import { canMegaEvolve } from '../formChange'
import { PARTY_SIZE } from '../constants'
import type { BattleOutcome, BattleState, RandomSource, SimPartyMon } from '../state'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import { naturalGiftPriority } from '../turnOrder'
import type { DamageResolver } from '../turn'
import { isKeenEdgeMove, type StatusDeps } from '../statusEffects'
import { getPlayerSelectedMoveTarget } from '../moveTargetFlags'
import { partySlotsFor } from '../partySlots'
import { hasLiveReserve } from '../switchIn'
import { createSession, cloneParty, groundingFor, stepTurn } from './session'
import type { BattleFormat } from './battleFormat'
import type { SimDataBundle, TrainerData } from './loadSimData'

export interface RunBattleOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: TrainerData
  tier?: 'ace' | 'elite' | 'hell'
  rng?: RandomSource
  maxTurns?: number
  leadIndex?: number
  /** FlagGet(B_FLAG_INVERSE_BATTLE) for the whole battle (battle_util.c:8028); derive it
   * from `isInverseBattleTrainer` in encounters.json's inverseBattles list. */
  inverseBattle?: boolean
  /** Battle format; defaults to a single-trainer fight for `opponentTrainer`. */
  format?: BattleFormat
  /** Custom player action policy; called for each active player battler (`battlerId` is 0
   * in singles; 0 and 2 in doubles). */
  playerPolicy?: (state: BattleState, unmodelled: string[], battlerId: number) => ChosenAction | null
  /** Battle events to register at battle start (e.g. BATTLE_EVENT_TENSE_BATTLE). */
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
  /** Scripted field effects to apply at battle start (TryToSetFieldEffect, battle_util.c:4240-4252). */
  startFieldEffects?: Array<{ effectType: string; fieldId: string }>
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
  /** The player's party at the end of the battle, deep-copied. Absent on the error return.
   * The mon still on the field keeps its live `status1`/`pp`/`itemId` on the battler
   * (`state.battlers[0].mon`): `pp`/`itemId` reach the party slot only on switch-out
   * (`turn.ts switchBattlerOut`), `status1` only there and on Rest. */
  finalParty?: SimPartyMon[]
}

/**
 * Default player policy: choose the first move with the highest base power that has PP;
 * switch to the next live mon only when forced.
 */
export function defaultPlayerPolicy(
  state: BattleState,
  data: SimDataBundle,
  damage?: DamageResolver,
  battlerId = 0,
): ChosenAction | null {
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) {
    const party = state.sides[0].party
    const [first, last] = partySlotsFor(state, battlerId)
    const active = new Set<number>()
    for (let id = 0; id < state.battlers.length; id++) {
      if ((id & 1) !== 0) continue
      const other = state.battlers[id]
      if (other) active.add(other.partyIndex)
    }
    let nextSlot = PARTY_SIZE
    for (let i = first; i < Math.min(last, party.length); i++) {
      const m = party[i]
      if (m && m.speciesId !== null && m.hp > 0 && !active.has(i)) {
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
  const statusDeps: StatusDeps = { dataContext: data.dataContext, grounding: groundingFor(data, state) }
  const declaredType = mData?.type ?? 'NORMAL'
  // GetTypeBeforeUsingMove's answer (see buildMoveAction in session.ts): the RESOLVED
  // type, which getMovePriority forwards as the onPriority `moveType`. Without a
  // resolver the declared type stands in -- runBattle passes `session.turnDeps.damage`,
  // so its own policy resolves retypes; a caller-constructed one may not.
  const resolvedType =
    damage?.moveType && state.battlers[battlerId]
      ? (damage.moveType(state, battlerId, 1, moveIdToUse).moveType ?? declaredType)
      : declaredType
  const moveView: TurnOrderMoveView = {
    id: moveIdToUse,
    priority: mData?.priority ?? 0,
    effect: mData?.effect ?? null,
    isStatus: mData?.split === 'STATUS',
    resolvedType,
    declaredType,
    power: mData?.power ?? 0,
    flags: mData?.flags ?? {},
    split: mData?.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    // IsKeenEdge(battler, move, GetTypeBeforeUsingMove(move, battler)), battle_main.c:4278.
    isKeenEdge: isKeenEdgeMove(state, battlerId, moveIdToUse, statusDeps),
    naturalGiftPriority: mData?.effect === 'EFFECT_NATURAL_GIFT'
      ? naturalGiftPriority(state.battlers[battlerId]?.mon.itemId ?? null)
      : 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }

  // The player controller's selection target (battle_controller_player.c:2385-2398), stored in
  // gBattleStruct->moveTarget[] and read back by HandleAction_UseMove (battle_util.c:242).
  const target = getPlayerSelectedMoveTarget(state, battlerId, moveIdToUse, mData, statusDeps, statusDeps)
  const mega = canMegaEvolve(state, battlerId, data.dataContext)
  return {
    action: 'USE_MOVE',
    moveToBeUsed: moveView,
    chosenMove: moveView,
    target,
    ...(mega ? { mega: true } : {}),
  }
}

/**
 * Runs a simulated battle to completion or until maxTurns.
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
      leadIndex: options.leadIndex,
      inverseBattle: options.inverseBattle,
      format: options.format,
      battleEvents: options.battleEvents,
      startFieldEffects: options.startFieldEffects,
    })
    const { state } = session
    recordUnmodelled(session.startUnmodelled)

    while (!state.battleOutcome && turnCount < maxTurns) {
      turnCount++
      const turnUnmodelled: string[] = []

      const isAbsent0 = (state.absentBattlerFlags & (1 << 0)) !== 0 || !state.battlers[0]
      const isFaintedNoReserve0 = state.battlers[0]?.mon.hp === 0 && !hasLiveReserve(state, 0)
      const playerAction =
        state.battlersCount === 4 && (isAbsent0 || isFaintedNoReserve0)
          ? null
          : options.playerPolicy
            ? options.playerPolicy(state, turnUnmodelled, 0)
            : defaultPlayerPolicy(state, data, session.turnDeps.damage, 0)

      let action2: ChosenAction | null = null
      if (state.battlersCount === 4) {
        const isAbsent2 = (state.absentBattlerFlags & (1 << 2)) !== 0 || !state.battlers[2]
        const isFaintedNoReserve2 = state.battlers[2]?.mon.hp === 0 && !hasLiveReserve(state, 2)
        if (!isAbsent2 && !isFaintedNoReserve2) {
          action2 = options.playerPolicy
            ? options.playerPolicy(state, turnUnmodelled, 2)
            : defaultPlayerPolicy(state, data, session.turnDeps.damage, 2)
        }
      }

      const step =
        state.battlersCount === 4
          ? stepTurn(session, playerAction, undefined, { 2: action2 })
          : stepTurn(session, playerAction)

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
      finalParty: cloneParty(state.sides[0].party),
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
