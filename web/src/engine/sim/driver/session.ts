// A battle session: everything runBattle needs to advance one turn at a time, and a
// clone operation so a search can try a turn without disturbing the real battle.
//
// The state is plain data except `rng`, a closure. A clone therefore deep-copies the
// state with `rng` removed and gives the copy its own generator. Every dependency
// object (damage resolver, AI deps, turn deps) reads the RNG through `session.state`
// rather than capturing it, so they are built once per session and a clone only has
// to rebuild them around its own state.

import { createBridgeDamageResolver } from '../damageResolver'
import { executeTurn, drainQueuedExtraAttacks, drainQueuedSwitches, roundStructsClear, turnStructsClear, type ActionOutcome, type DamageResolver, type TurnLoopDeps, type TurnOutcome } from '../turn'
import { applyBattleStartPass, getSingleUseAbilityCounter } from '../switchInAbility'
import { registerBattleEvent, runBattleEvents } from '../battleEvents'
import { chooseAiAction, type ChooseAiActionDeps } from '../ai/chooseAiAction'
import { createAiOpponentReplacement } from '../ai/aiSwitching'
import type { AiDamageDeps } from '../ai/aiCalcDamage'
import { clearFlag, PARTY_SIZE, STATUS2_FLINCHED } from '../constants'
import { createRandomSource } from '../rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from '../state'
import { canMegaEvolve } from '../formChange'
import type { GroundingContext } from '../grounding'
import { battlerHasSimAbility, runReactiveAbilityEffects } from '../statBuffs'
import { hasEmbargo } from '../unpack'
import type { SimDataContext } from '../dataContext'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import { naturalGiftPriority } from '../turnOrder'
import { isKeenEdgeMove, type StatusDeps } from '../statusEffects'
import { getOpponentSelectedMoveTarget, getPlayerSelectedMoveTarget, playerCanSelectMoveTarget } from '../moveTargetFlags'
import { applyEndOfTurnReplacements, type ReplacementDeps } from '../switchIn'
import { buildOpponentParty } from './buildParty'
import { buildBattleState, gatePlayerInnates } from './battleFormat'
import type { SimDataBundle, TrainerData } from './loadSimData'
import { partySlotsFor } from '../partySlots'

export type Tier = 'ace' | 'elite' | 'hell'

export interface SessionOptions {
  data: SimDataBundle
  playerParty: SimPartyMon[]
  opponentTrainer: TrainerData
  tier?: Tier
  rng: RandomSource
  /** Player party slot that starts on the field; default 0. */
  leadIndex?: number
  /** Which party slot the player sends in after a faint; default is the first live mon
   * that is not already out. `battlerId` is the fainting player battler (0 in singles,
   * 0 or 2 in a double). */
  playerReplacement?: (state: BattleState, battlerId: number) => number
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
  /** FlagGet(B_FLAG_INVERSE_BATTLE) for the whole battle (battle_util.c:8028): when true,
   * GetTypeModifier reads inverseTypeChart instead of typeChart. Callers derive it from
   * `isInverseBattleTrainer` in encounters.json's inverseBattles list. */
  inverseBattle?: boolean
}

export interface BattleSession {
  state: BattleState
  data: SimDataBundle
  trainer: TrainerData
  /** FlagGet(B_FLAG_INVERSE_BATTLE); see SessionOptions.inverseBattle. */
  inverseBattle: boolean
  turnDeps: TurnLoopDeps
  chooseAiDeps: ChooseAiActionDeps
  playerReplacement: (state: BattleState, battlerId: number) => number
  /** Notes from the battle-start pass. */
  startUnmodelled: string[]
}

export function cloneParty(party: SimPartyMon[]): SimPartyMon[] {
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

/** The first live reserve slot for one of the player's battlers, honouring that
 * battler's own slot range and excluding every active party slot of side 0. In singles
 * this is today's `index !== battler.partyIndex`; in doubles it must also skip the
 * partner's active slot (dbl-2a), and `battlerId` picks which half of a partner party
 * to scan -- battler 2 owns slots 3-5 in an INGAME_PARTNER fight (dbl-2b). */
export function firstLiveReplacement(state: BattleState, battlerId = 0): number {
  const side = battlerId & 1
  const party = state.sides[side].party
  const [first, last] = partySlotsFor(state, battlerId)
  const active = new Set<number>()
  for (let id = 0; id < state.battlers.length; id++) {
    if ((id & 1) !== side) continue
    const battler = state.battlers[id]
    if (battler) active.add(battler.partyIndex)
  }
  for (let i = first; i < Math.min(last, party.length); i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0 && !active.has(i)) return i
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

export function aiDamageDepsFor(data: SimDataBundle, state: BattleState, inverseBattle = false): AiDamageDeps {
  return {
    grounding: groundingFor(data, state),
    turnOrder: data.turnOrder,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    inverseBattle,
    moveData: data.moveData,
    typeChart: data.typeChart,
    inverseTypeChart: data.inverseTypeChart,
    moveBehaviors: data.moveBehaviors,
    battleConstants: data.battleConstants,
    holdEffectIds: data.holdEffectIds,
  }
}

/** A MOVE action for `moveId` aimed at the other side (or the user for self-targeting moves).
 *
 * The target is the CONTROLLER's choice at selection, which the C stores in
 * `gBattleStruct->moveTarget[]` and HandleAction_UseMove reads back at execution
 * (battle_util.c:242) -- it is not a pure function of the static target.
 * - Player (battle_controller_player.c:2385-2398): getPlayerSelectedMoveTarget, i.e. the
 *   dynamic flags with the Curse rule and the MOVE_TARGET_USER bit test.
 * - Opponent (battle_controller_opponent.c:1599-1611): getOpponentSelectedMoveTarget,
 *   i.e. the static `target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER)` -> self
 *   bit test and MOVE_TARGET_BOTH -> player left.
 *
 * `chosenTarget` is the pick made before the action was built: `gMultiUsePlayerCursor`
 * for a player battler, `gBattleStruct->aiChosenTarget` for the AI. It only survives
 * on the player side when the move is target-selectable in a double
 * (canSelectTarget, battle_controller_player.c:2402-2410 -- see
 * playerCanSelectMoveTarget); the AI's own choice is used as-is for any other static
 * target (battle_controller_opponent.c:1583, :1599-1611). Omitting it is exactly the old
 * behaviour.
 */
export function buildMoveAction(
  state: BattleState,
  data: SimDataBundle,
  battlerId: number,
  moveId: string,
  damage?: DamageResolver,
  chosenTarget?: number,
): ChosenAction {
  const mData = data.dataContext.move(moveId)
  const statusDeps: StatusDeps = { dataContext: data.dataContext, grounding: groundingFor(data, state) }
  const declaredType = mData?.type ?? 'NORMAL'
  // A chosen target is only meaningful as a battler id on the field.
  const chosenTargetId =
    chosenTarget !== undefined && Number.isInteger(chosenTarget) && chosenTarget >= 0 && chosenTarget < state.battlersCount
      ? chosenTarget
      : undefined
  // GetTypeBeforeUsingMove (battle_main.c:5206-5209, -> GetMoveTypeInternal :5093-5204):
  // the RESOLVED type, which getMovePriority forwards as the onPriority `moveType`
  // (turnOrder.ts:412). Target-independent, so the opposing battler only satisfies the
  // resolver's signature. Without the caller's resolver (`damage`; the session's own is
  // `session.turnDeps.damage`) the declared type stands in, leaving -ate / Weather Ball
  // / Electrify retypes unapplied for this view.
  const resolvedType =
    damage?.moveType && state.battlers[battlerId]
      ? (damage.moveType(state, battlerId, chosenTargetId ?? ((battlerId & 1) ^ 1), moveId).moveType ?? declaredType)
      : declaredType
  const view: TurnOrderMoveView = {
    id: moveId,
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
    isKeenEdge: isKeenEdgeMove(state, battlerId, moveId, statusDeps),
    naturalGiftPriority: mData?.effect === 'EFFECT_NATURAL_GIFT'
      ? naturalGiftPriority(state.battlers[battlerId]?.mon.itemId ?? null)
      : 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  const staticTarget = mData?.target ?? 'SELECTED'
  const target =
    (battlerId & 1) === 0
      ? chosenTargetId !== undefined && playerCanSelectMoveTarget(state, battlerId, moveId, mData, statusDeps, statusDeps)
        ? chosenTargetId
        : getPlayerSelectedMoveTarget(state, battlerId, moveId, mData, statusDeps, statusDeps)
      : getOpponentSelectedMoveTarget(
          battlerId,
          staticTarget,
          chosenTargetId ?? ((battlerId & 1) ^ 1),
          state.absentBattlerFlags,
        )
  const mega = canMegaEvolve(state, battlerId, data.dataContext)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target, ...(mega ? { mega: true } : {}) }
}

/** Builds the dependency objects around `state`. Nothing here captures `state.rng` itself. */
function buildDeps(
  state: BattleState,
  data: SimDataBundle,
  trainer: TrainerData,
  playerReplacement: (state: BattleState, battlerId: number) => number,
  inverseBattle: boolean,
): { turnDeps: TurnLoopDeps; chooseAiDeps: ChooseAiActionDeps } {
  const random: RandomSource = { random16: () => state.rng.random16() }
  const grounding = groundingFor(data, state)
  const damageResolver = createBridgeDamageResolver({
    dataContext: data.dataContext,
    grounding,
    turnOrder: data.turnOrder,
    statStageRatios: data.statStageRatios,
    inverseBattle,
    moveData: data.moveData,
    typeChart: data.typeChart,
    inverseTypeChart: data.inverseTypeChart,
    moveBehaviors: data.moveBehaviors,
    battleConstants: data.battleConstants,
    random,
  })

  const aiDamageDeps = aiDamageDepsFor(data, state, inverseBattle)
  const chooseAiDeps: ChooseAiActionDeps = { ...aiDamageDeps, trainer }

  const aiOpponentReplacement = createAiOpponentReplacement(aiDamageDeps)
  const replacementDeps: ReplacementDeps = {
    chooseReplacement(battleState: BattleState, battlerId: number, unmodelled: string[]): number {
      if ((battlerId & 1) === 1) return aiOpponentReplacement.chooseReplacement(battleState, battlerId, unmodelled)
      return playerReplacement(battleState, battlerId)
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
      inverseBattle,
    },
  }
  return { turnDeps, chooseAiDeps }
}

export function createSession(options: SessionOptions): BattleSession {
  const tier = options.tier ?? 'elite'
  const data = options.data
  const inverseBattle = options.inverseBattle ?? false
  // A forced-double trainer needs four battlers and the doubles turn loop, which this
  // cycle (dbl-2a) does not run. Refuse rather than silently build a singles state
  // that claims BATTLE_TYPE_DOUBLE.
  if (options.opponentTrainer.forcedDouble) {
    throw new Error(`createSession: forced-double trainer ${options.opponentTrainer.id} needs the doubles turn loop (dbl-3)`)
  }
  const playerParty = cloneParty(options.playerParty)
  if (playerParty.length === 0) throw new Error('createSession: playerParty must not be empty')
  const leadIndex = options.leadIndex ?? 0
  const lead = playerParty[leadIndex]
  if (!lead) throw new Error(`createSession: leadIndex ${leadIndex} is outside the ${playerParty.length}-mon playerParty`)
  // Only an explicitly chosen lead slot must be alive. With the default lead (leadIndex
  // undefined) the turn-1 battle-start sequence replaces a fainted slot itself
  // (HandleFaintedMonActions, battle_main.c:3407-3414), and existing callers rely on that.
  if (options.leadIndex !== undefined && lead.hp === 0) {
    throw new Error(`createSession: leadIndex ${leadIndex} names a fainted party slot`)
  }
  // GetInnateInSlot (src/battle_util.c:8799-8802) gates the PLAYER's innates by
  // level and difficulty; the AI keeps all three (buildOpponentParty is untouched).
  gatePlayerInnates(playerParty, tier)

  const playerMaxLevel = Math.max(...playerParty.map((m) => m.level))
  const opponentParty = buildOpponentParty(options.opponentTrainer, tier, playerMaxLevel, data)
  if (opponentParty.length === 0) {
    throw new Error(`createSession: opponentParty for ${options.opponentTrainer.id} (${tier}) must not be empty`)
  }

  const state = buildBattleState(
    { opponents: [options.opponentTrainer] },
    {
      data,
      tier,
      playerParty,
      opponentParties: [opponentParty],
      leadIndex: options.leadIndex,
      rng: options.rng,
    },
  )

  if (options.battleEvents) {
    for (const ev of options.battleEvents) {
      registerBattleEvent(state, ev.event, ev.data0 ?? 0, ev.data1 ?? 0)
    }
  }

  const playerReplacement = options.playerReplacement ?? firstLiveReplacement
  const { turnDeps, chooseAiDeps } = buildDeps(state, data, options.opponentTrainer, playerReplacement, inverseBattle)

  const startUnmodelled: string[] = []
  const startOutcomes: ActionOutcome[] = []
  // createBattleState pre-applies the :3406 decrement; the battle-start pass runs before it in C (isFirstTurn is still 2 there, Stakeout abilities.cc:2726).
  for (const battler of state.battlers) {
    if (battler) battler.volatiles.isFirstTurn = 2
  }
  // The battle-start pass drains a lead's queued entry move before the next lead's
  // abilities (battle_main.c:3380, :3320-3322). gCurrentTurnActionNumber is 0 there
  // only on the first battle since power-on; the steady-state value is gBattlersCount,
  // which is not modelled. Either way nothing has acted in *this* battle yet, so the
  // drain index is 0. See docs/battle-sim/battle-start-turn-action-number.md.
  const startOrder = applyBattleStartPass(
    state,
    {
      grounding: groundingFor(data, state),
      dataContext: data.dataContext,
      turnOrder: data.turnOrder,
      statStageRatios: data.statStageRatios,
      drainQueuedExtraAttacks: (order) => drainQueuedExtraAttacks(state, 0, order, turnDeps, startOutcomes),
    },
    startUnmodelled,
  )
  // battle_main.c:3392-3397 -- only after the lead loop is canProcessSwitches set,
  // and the re-entry that drains gQueuedSwitchData comes BEFORE the :3406 cleanup.
  // applyBattleStartPass cannot do this itself: inside the lead loop the switch half
  // is still filtered out (battle_util.c:785).
  drainQueuedSwitches(state, turnDeps, startUnmodelled, { index: 0, order: startOrder, outcomes: startOutcomes })
  // battle_main.c:3325-3328 then :3356 -- each re-entry drained by a queued switch first
  // dispatches B_ACTION_TRY_FINISH (drain gQueuedAttackCount) and then repeats
  // ABILITYEFFECT_REACTIVE. That check can queue another attack itself (Acid Reflux), so the
  // two queues are drained in that order until both are empty; only then does the function
  // fall through to TurnValuesCleanUp (:3406). Leaving a queued attack behind would run it at
  // turn 1's start, after the roundStructsClear that the C never crosses.
  const startReactiveDeps = { dataContext: data.dataContext, grounding: groundingFor(data, state) }
  const drainAttacksAndReact = () => {
    runReactiveAbilityEffects(state, startReactiveDeps, startUnmodelled)
    while (state.queuedExtraAttacks.length > 0) {
      drainQueuedExtraAttacks(state, 0, startOrder, turnDeps, startOutcomes)
      runReactiveAbilityEffects(state, startReactiveDeps, startUnmodelled)
    }
  }
  // Fold each ActionOutcome's notes into startUnmodelled exactly once. A later re-entry
  // pass appends more outcomes, so remember how many have been pushed instead of looping
  // over the whole array again (:286-289 shape).
  let pushedOutcomeNotes = 0
  const pushOutcomeNotes = () => {
    for (; pushedOutcomeNotes < startOutcomes.length; pushedOutcomeNotes++) {
      startUnmodelled.push(...startOutcomes[pushedOutcomeNotes]!.unmodelled)
    }
  }
  // TryDoEventsBeforeFirstTurn cleanup (battle_main.c:3406-3412), shared by the first pass
  // and by every replacement re-entry:
  // TurnValuesCleanUp(FALSE) zeroes gRoundStructs and decrements isFirstTurn (2 -> 1),
  // then :3407-3411 restores the protect a Coward lead armed on entry (abilities.cc:5441-5451)
  // because TurnValuesCleanUp just zeroed gRoundStructs, then TurnStructsClear() zeroes gTurnStructs.
  const cleanupTurnValues = () => {
    roundStructsClear(state)
    for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
      const battler = state.battlers[battlerId]
      if (!battler || battler.mon.hp === 0) continue
      if (getSingleUseAbilityCounter(state, battlerId, 'ABILITY_COWARD', data.dataContext) > 0) {
        battler.round.protectMove = 'MOVE_PROTECT'
      }
    }
    turnStructsClear(state)
  }
  drainAttacksAndReact()
  pushOutcomeNotes()
  cleanupTurnValues()
  // battle_main.c:3413-3414 -- gCurrentTurnActionNumber = gBattlersCount makes
  // HandleFaintedMonActions' "everyone acted" gates pass, so a lead that fainted
  // during battle start is replaced before turn 1's actions. The function returns
  // WITHOUT changing gBattleMainFunc (that is :3417), so after
  // BattleScript_HandleFaintedMon the C re-enters TryDoEventsBeforeFirstTurn and runs
  // it again: :3320-3322 (drain the replacement's queued entry attack) then :3356
  // (ABILITYEFFECT_REACTIVE), the lead loop is skipped because switchInAbilitiesCounter
  // already equals gBattlersCount, :3383 ClearMiscTurnFlags, :3392-3397 drain
  // gQueuedSwitchCount, a SECOND TurnValuesCleanUp(FALSE) (:3406), the Coward restore
  // (:3407-3411), TurnStructsClear (:3412) and another replacement attempt (:3413-3414).
  // Skipping that re-entry leaves the replacement's entry move queued for turn 1, keeps
  // isFirstTurn one too high for every battler, and leaves the round structs uncleaned.
  if (!state.battleOutcome && turnDeps.replacement) {
    const battlerKey = () =>
      state.battlers.map((b) => (b ? `${b.partyIndex}:${b.mon.speciesId}` : 'none')).join('|')
    let before = battlerKey()
    applyEndOfTurnReplacements(state, turnDeps.replacement, turnDeps, startUnmodelled)
    while (!state.battleOutcome && battlerKey() !== before) {
      drainAttacksAndReact()
      drainQueuedSwitches(state, turnDeps, startUnmodelled, { index: 0, order: startOrder, outcomes: startOutcomes })
      drainAttacksAndReact()
      pushOutcomeNotes()
      cleanupTurnValues()
      before = battlerKey()
      applyEndOfTurnReplacements(state, turnDeps.replacement, turnDeps, startUnmodelled)
    }
  }
  // Clear STATUS2_FLINCHED on every battler (:3422)
  for (const battler of state.battlers) {
    if (battler) {
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_FLINCHED)
    }
  }
  runBattleEvents(
    state,
    {
      dataContext: data.dataContext,
      grounding: groundingFor(data, state),
    },
    startUnmodelled,
  )

  return { state, data, trainer: options.opponentTrainer, inverseBattle, turnDeps, chooseAiDeps, playerReplacement, startUnmodelled }
}

/**
 * An independent copy of the session with its own generator seeded from `seed`. The copy
 * shares only the immutable data bundle with the original.
 */
export function cloneSession(session: BattleSession, seed: number): BattleSession {
  const { rng, ...rest } = session.state
  const copy = structuredClone(rest) as Omit<BattleState, 'rng'>
  const state = { ...copy, rng: createRandomSource(seed) } as BattleState
  const { turnDeps, chooseAiDeps } = buildDeps(state, session.data, session.trainer, session.playerReplacement, session.inverseBattle)
  void rng
  return { ...session, state, turnDeps, chooseAiDeps }
}

export interface StepResult {
  outcome: TurnOutcome
  /** Every unmodelled note raised by the AI and by the turn. */
  unmodelled: string[]
}

/** Chooses the opponent's action with the ported AI (or uses `fixedOpponentAction`, `null` meaning no action), then runs one turn with `playerAction`.
 *
 * `slotActions` supplies the actions for battlers 2 and 3 of a double, which the AI
 * does not select yet (dbl-4d). Without it the array is exactly today's
 * `[playerAction, opponentAction, null, null]`; battler 1's AI call is unchanged.
 */
export function stepTurn(
  session: BattleSession,
  playerAction: ChosenAction | null,
  fixedOpponentAction?: ChosenAction | null,
  slotActions?: { 2?: ChosenAction | null; 3?: ChosenAction | null },
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

  const outcome = executeTurn(
    state,
    [playerAction, opponentAction, slotActions?.[2] ?? null, slotActions?.[3] ?? null],
    session.turnDeps,
  )
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
