// A battle session: everything runBattle needs to advance one turn at a time, and a
// clone operation so a search can try a turn without disturbing the real battle.
//
// The state is plain data except `rng`, a closure. A clone therefore deep-copies the
// state with `rng` removed and gives the copy its own generator. Every dependency
// object (damage resolver, AI deps, turn deps) reads the RNG through `session.state`
// rather than capturing it, so they are built once per session and a clone only has
// to rebuild them around its own state.

import { createBattleState, createBattlerState } from '../create'
import { createBridgeDamageResolver } from '../damageResolver'
import { executeTurn, type TurnLoopDeps, type TurnOutcome } from '../turn'
import { applyBattleStartPass } from '../switchInAbility'
import { registerBattleEvent, runBattleEvents } from '../battleEvents'
import { chooseAiAction, type ChooseAiActionDeps } from '../ai/chooseAiAction'
import { battleAiSetupFlags } from '../ai/aiFlags'
import { createAiOpponentReplacement } from '../ai/aiSwitching'
import type { AiDamageDeps } from '../ai/aiCalcDamage'
import { PARTY_SIZE } from '../constants'
import { createRandomSource } from '../rng'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon, Slot4 } from '../state'
import { canMegaEvolve } from '../formChange'
import type { GroundingContext } from '../grounding'
import { battlerHasSimAbility } from '../statBuffs'
import { hasEmbargo } from '../unpack'
import type { SimDataContext } from '../dataContext'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import type { ReplacementDeps } from '../switchIn'
import { buildOpponentParty } from './buildParty'
import type { SimDataBundle, TrainerData } from './loadSimData'

export type Tier = 'ace' | 'elite' | 'hell'

export interface SessionOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: TrainerData
  tier?: Tier
  rng: RandomSource
  /** Which party slot the player sends in after a faint; default is the first live mon that is not already out. */
  playerReplacement?: (state: BattleState) => number
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
}

export interface BattleSession {
  state: BattleState
  data: SimDataBundle
  trainer: TrainerData
  turnDeps: TurnLoopDeps
  chooseAiDeps: ChooseAiActionDeps
  playerReplacement: (state: BattleState) => number
  /** Notes from the battle-start pass. */
  startUnmodelled: string[]
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

export function firstLiveReplacement(state: BattleState): number {
  const party = state.sides[0].party
  const currentPartyIndex = state.battlers[0]?.partyIndex ?? -1
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0 && i !== currentPartyIndex) return i
  }
  return PARTY_SIZE
}

/** GetBattlerHoldEffect(battler, TRUE), battle_util.c:6526-6537: the held item's hold effect unless IsItemNegated
 * (Embargo or Klutz, battle_util.c:6520-6524). Reads the live state, so it cannot live in the shared data bundle. */
export function holdEffectOfBattler(state: BattleState, battlerId: number, dataContext: SimDataContext): string | null {
  const battler = state.battlers[battlerId]
  if (!battler || !battler.mon.itemId) return null
  if (hasEmbargo(battler.statuses3) || battlerHasSimAbility(state, battler, 'ABILITY_KLUTZ', false, battlerId, false, dataContext)) return null
  return dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null
}

/** The shared grounding context with `holdEffectOf` bound to this state. The bundle's own `holdEffectOf` always
 * returned null, which switched off every held-item effect read through it (Life Orb, Assault Vest, Choice items, ...). */
export function groundingFor(data: SimDataBundle, state: BattleState): GroundingContext {
  return { ...data.grounding, holdEffectOf: (battlerId) => holdEffectOfBattler(state, battlerId, data.dataContext) }
}

export function aiDamageDepsFor(data: SimDataBundle, state: BattleState): AiDamageDeps {
  return {
    grounding: groundingFor(data, state),
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
}

/** A MOVE action for `moveId` aimed at the other side (or the user for self-targeting moves). */
export function buildMoveAction(state: BattleState, data: SimDataBundle, battlerId: number, moveId: string): ChosenAction {
  const mData = data.dataContext.move(moveId)
  const view: TurnOrderMoveView = {
    id: moveId,
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
  const target = mData?.target === 'USER' ? battlerId : battlerId ^ 1
  const mega = canMegaEvolve(state, battlerId, data.dataContext)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target, ...(mega ? { mega: true } : {}) }
}

/** Builds the dependency objects around `state`. Nothing here captures `state.rng` itself. */
function buildDeps(
  state: BattleState,
  data: SimDataBundle,
  trainer: TrainerData,
  playerReplacement: (state: BattleState) => number,
): { turnDeps: TurnLoopDeps; chooseAiDeps: ChooseAiActionDeps } {
  const random: RandomSource = { random16: () => state.rng.random16() }
  const grounding = groundingFor(data, state)
  const damageResolver = createBridgeDamageResolver({
    dataContext: data.dataContext,
    grounding,
    turnOrder: data.turnOrder,
    statStageRatios: data.statStageRatios,
    inverseBattle: false,
    moveData: data.moveData,
    typeChart: data.typeChart,
    inverseTypeChart: data.inverseTypeChart,
    moveBehaviors: data.moveBehaviors,
    battleConstants: data.battleConstants,
    random,
  })

  const aiDamageDeps = aiDamageDepsFor(data, state)
  const chooseAiDeps: ChooseAiActionDeps = { ...aiDamageDeps, trainer }

  const aiOpponentReplacement = createAiOpponentReplacement(aiDamageDeps)
  const replacementDeps: ReplacementDeps = {
    chooseReplacement(battleState: BattleState, battlerId: number, unmodelled: string[]): number {
      if ((battlerId & 1) === 1) return aiOpponentReplacement.chooseReplacement(battleState, battlerId, unmodelled)
      return playerReplacement(battleState)
    },
  }

  const turnDeps: TurnLoopDeps = {
    turnOrder: data.turnOrder,
    grounding,
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
  return { turnDeps, chooseAiDeps }
}

export function createSession(options: SessionOptions): BattleSession {
  const tier = options.tier ?? 'elite'
  const data = options.data
  const playerParty = cloneParty(options.playerParty)
  if (playerParty.length === 0) throw new Error('createSession: playerParty must not be empty')

  const playerMaxLevel = Math.max(...playerParty.map((m) => m.level))
  const opponentParty = buildOpponentParty(options.opponentTrainer, tier, playerMaxLevel, data)
  if (opponentParty.length === 0) {
    throw new Error(`createSession: opponentParty for ${options.opponentTrainer.id} (${tier}) must not be empty`)
  }

  const state = createBattleState({
    battlers: [
      createBattlerState(0, toBattleMon(playerParty[0]), 0),
      createBattlerState(1, toBattleMon(opponentParty[0]), 0),
    ],
    playerParty,
    opponentParty,
    battleTypeFlags: 0,
    aiFlags: battleAiSetupFlags(options.opponentTrainer, 0),
    rng: options.rng,
  })

  if (options.battleEvents) {
    for (const ev of options.battleEvents) {
      registerBattleEvent(state, ev.event, ev.data0 ?? 0, ev.data1 ?? 0)
    }
  }

  const playerReplacement = options.playerReplacement ?? firstLiveReplacement
  const { turnDeps, chooseAiDeps } = buildDeps(state, data, options.opponentTrainer, playerReplacement)

  const startUnmodelled: string[] = []
  applyBattleStartPass(
    state,
    {
      grounding: groundingFor(data, state),
      dataContext: data.dataContext,
      turnOrder: data.turnOrder,
      statStageRatios: data.statStageRatios,
    },
    startUnmodelled,
  )
  runBattleEvents(
    state,
    {
      dataContext: data.dataContext,
      grounding: groundingFor(data, state),
    },
    startUnmodelled,
  )

  return { state, data, trainer: options.opponentTrainer, turnDeps, chooseAiDeps, playerReplacement, startUnmodelled }
}

/**
 * An independent copy of the session with its own generator seeded from `seed`. The copy
 * shares only the immutable data bundle with the original.
 */
export function cloneSession(session: BattleSession, seed: number): BattleSession {
  const { rng, ...rest } = session.state
  const copy = structuredClone(rest) as Omit<BattleState, 'rng'>
  const state = { ...copy, rng: createRandomSource(seed) } as BattleState
  const { turnDeps, chooseAiDeps } = buildDeps(state, session.data, session.trainer, session.playerReplacement)
  void rng
  return { ...session, state, turnDeps, chooseAiDeps }
}

export interface StepResult {
  outcome: TurnOutcome
  /** Every unmodelled note raised by the AI and by the turn. */
  unmodelled: string[]
}

/** Chooses the opponent's action with the ported AI (or uses `fixedOpponentAction`, `null` meaning no action), then runs one turn with `playerAction`. */
export function stepTurn(
  session: BattleSession,
  playerAction: ChosenAction | null,
  fixedOpponentAction?: ChosenAction | null,
): StepResult {
  const { state } = session
  const unmodelled: string[] = []

  runBattleEvents(
    state,
    {
      dataContext: session.data.dataContext,
      grounding: session.turnDeps.grounding,
    },
    unmodelled,
  )

  let opponentAction: ChosenAction | null = fixedOpponentAction ?? null
  if (fixedOpponentAction === undefined && state.battlers[1] && state.battlers[1].mon.hp > 0) {
    const aiResult = chooseAiAction(state, 1, session.chooseAiDeps)
    opponentAction = aiResult.action
    unmodelled.push(...aiResult.unmodelled)
  }

  const outcome = executeTurn(state, [playerAction, opponentAction, null, null], session.turnDeps)
  for (const a of outcome.actions) unmodelled.push(...a.unmodelled)
  unmodelled.push(
    ...outcome.endTurnUnmodelled,
    ...outcome.switchUnmodelled,
    ...outcome.fieldEndTurnUnmodelled,
    ...outcome.replacementUnmodelled,
    ...(outcome.battleEventsUnmodelled ?? []),
  )
  return { outcome, unmodelled }
}

/**
 * Runs the turn-start battle events (HandleBattleEvents, src/battle_main.c:5888). A policy that looks ahead must
 * call this before it decides, so it sees the same position the AI and the turn loop will; it is idempotent
 * within a turn, so stepTurn's own call does nothing a second time.
 */
export function beginTurn(session: BattleSession): string[] {
  const unmodelled: string[] = []
  runBattleEvents(session.state, { dataContext: session.data.dataContext, grounding: session.turnDeps.grounding }, unmodelled)
  return unmodelled
}
