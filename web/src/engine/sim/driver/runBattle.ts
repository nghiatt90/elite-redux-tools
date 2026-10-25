// Battle driver for running simulated battles.
// Assembles singles BattleState from data, executes turns between AI and player policy,
// processes switch-in effects and replacements, and tallies unmodelled mechanics.

import { createBattleState, createBattlerState } from '../create'
import { createBridgeDamageResolver } from '../damageResolver'
import { executeTurn, type TurnLoopDeps } from '../turn'
import { applyBattleStartPass } from '../switchInAbility'
import { chooseAiAction, type ChooseAiActionDeps } from '../ai/chooseAiAction'
import { battleAiSetupFlags } from '../ai/aiFlags'
import { createAiOpponentReplacement } from '../ai/aiSwitching'
import type { AiDamageDeps } from '../ai/aiCalcDamage'
import { canMegaEvolve } from '../formChange'
import { PARTY_SIZE } from '../constants'
import type { BattleOutcome, BattleState, RandomSource, SimBattleMon, SimPartyMon, Slot4 } from '../state'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import type { ReplacementDeps } from '../switchIn'
import { buildOpponentParty } from './buildParty'
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

function cloneParty(party: SimPartyMon[]): SimPartyMon[] {
  return party.map((p) => ({
    ...p,
    moves: [...p.moves] as Slot4<string | null>,
    pp: [...p.pp] as Slot4<number>,
    rawStats: { ...p.rawStats },
    evs: p.evs ? { ...p.evs } : undefined,
    abilities: {
      ability: p.abilities.ability,
      innates: [...p.abilities.innates] as [string | null, string | null, string | null],
    },
    types: [...p.types] as [string, string, string],
  }))
}

function toBattleMon(incoming: SimPartyMon): SimBattleMon {
  return {
    speciesId: incoming.speciesId as string,
    rawStats: incoming.rawStats,
    moves: incoming.moves,
    pp: incoming.pp,
    hp: incoming.hp,
    maxHp: incoming.maxHp,
    itemId: incoming.itemId,
    statStages: [],
    types: incoming.types,
    level: incoming.level,
    nature: incoming.nature,
    hiddenPowerType: incoming.hiddenPowerType,
    speedDown: incoming.speedDown,
    abilities: incoming.abilities,
    gender: incoming.gender,
    status1: incoming.status1,
    status2: 0,
    evs: incoming.evs,
  }
}

/**
 * Default player policy: choose the first move with the highest base power that has PP;
 * switch to the next live mon only when forced.
 */
function defaultPlayerPolicy(
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
    const playerParty = cloneParty(options.playerParty)
    if (playerParty.length === 0) {
      throw new Error('runBattle: playerParty must not be empty')
    }

    const playerMaxLevel = Math.max(...playerParty.map((m) => m.level))
    const opponentParty = buildOpponentParty(options.opponentTrainer, tier, playerMaxLevel, data)
    if (opponentParty.length === 0) {
      throw new Error(`runBattle: opponentParty for ${options.opponentTrainer.id} (${tier}) must not be empty`)
    }

    const battler0 = createBattlerState(0, toBattleMon(playerParty[0]), 0)
    const battler1 = createBattlerState(1, toBattleMon(opponentParty[0]), 0)

    const aiFlags = battleAiSetupFlags(options.opponentTrainer, 0)
    const rng = options.rng ?? { random16: () => 0 }

    const state = createBattleState({
      battlers: [battler0, battler1],
      playerParty,
      opponentParty,
      battleTypeFlags: 0,
      aiFlags,
      rng,
    })

    const startUnmodelled: string[] = []
    applyBattleStartPass(
      state,
      {
        grounding: data.grounding,
        dataContext: data.dataContext,
        turnOrder: data.turnOrder,
        statStageRatios: data.statStageRatios,
      },
      startUnmodelled,
    )
    recordUnmodelled(startUnmodelled)

    const damageResolver = createBridgeDamageResolver({
      dataContext: data.dataContext,
      grounding: data.grounding,
      turnOrder: data.turnOrder,
      statStageRatios: data.statStageRatios,
      inverseBattle: false,
      moveData: data.moveData,
      typeChart: data.typeChart,
      inverseTypeChart: data.inverseTypeChart,
      moveBehaviors: data.moveBehaviors,
      battleConstants: data.battleConstants,
      random: state.rng,
    })

    const aiDamageDeps: AiDamageDeps = {
      grounding: data.grounding,
      turnOrder: data.turnOrder,
      statStageRatios: data.statStageRatios,
      dataContext: data.dataContext,
      inverseBattle: false,
      moveData: data.moveData,
      typeChart: data.typeChart,
      inverseTypeChart: data.inverseTypeChart,
      moveBehaviors: data.moveBehaviors,
      battleConstants: data.battleConstants,
      holdEffectIds: data.holdEffectIds,
    }

    const chooseAiDeps: ChooseAiActionDeps = {
      ...aiDamageDeps,
      trainer: options.opponentTrainer,
    }

    const aiOpponentReplacement = createAiOpponentReplacement(aiDamageDeps)
    const replacementDeps: ReplacementDeps = {
      chooseReplacement(battleState: BattleState, battlerId: number, unmodelled: string[]): number {
        if ((battlerId & 1) === 1) {
          return aiOpponentReplacement.chooseReplacement(battleState, battlerId, unmodelled)
        }
        const party = battleState.sides[0].party
        const currentPartyIndex = battleState.battlers[0]?.partyIndex ?? -1
        for (let i = 0; i < party.length; i++) {
          const mon = party[i]
          if (mon && mon.speciesId !== null && mon.hp > 0 && i !== currentPartyIndex) {
            return i
          }
        }
        return PARTY_SIZE
      },
    }

    const turnDeps: TurnLoopDeps = {
      turnOrder: data.turnOrder,
      grounding: data.grounding,
      damage: damageResolver,
      statStageRatios: data.statStageRatios,
      dataContext: data.dataContext,
      replacement: replacementDeps,
      moveBehaviors: data.moveBehaviors,
      hazardTypes: {
        typeChart: data.typeChart,
        inverseTypeChart: data.inverseTypeChart,
        inverseBattle: false,
      },
    }

    while (!state.battleOutcome && turnCount < maxTurns) {
      turnCount++
      const turnUnmodelled: string[] = []

      // Opponent action from chooseAiAction
      let opponentAction: ChosenAction | null = null
      if (state.battlers[1] && state.battlers[1].mon.hp > 0) {
        const aiResult = chooseAiAction(state, 1, chooseAiDeps)
        opponentAction = aiResult.action
        turnUnmodelled.push(...aiResult.unmodelled)
      }

      // Player action from playerPolicy or defaultPlayerPolicy
      let playerAction: ChosenAction | null = null
      if (options.playerPolicy) {
        playerAction = options.playerPolicy(state, turnUnmodelled)
      } else {
        playerAction = defaultPlayerPolicy(state, data)
      }

      const actions: (ChosenAction | null)[] = [playerAction, opponentAction, null, null]
      const turnOutcome = executeTurn(state, actions, turnDeps)
      megaEvolutions += turnOutcome.megaEvolutions ?? 0

      for (const actionOutcome of turnOutcome.actions) {
        turnUnmodelled.push(...actionOutcome.unmodelled)
      }
      turnUnmodelled.push(...turnOutcome.endTurnUnmodelled)
      turnUnmodelled.push(...turnOutcome.fieldEndTurnUnmodelled)
      turnUnmodelled.push(...turnOutcome.replacementUnmodelled)
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
