// Turn order resolution: who acts first.
//
// Ported from battle_main.c at the pinned SHA. The headline finding is that ER
// does NOT compare priority and then speed. It packs six fields into one u32
// (`union SpeedValue`, include/battle_main.h:29-40) and compares that single
// integer, so the precedence is fixed by BIT POSITION, from most significant
// down:
//
//   bit 26     afterYou          gRoundStructs[b].afterYou
//   bits 24-25 dazedNegation     ~(volatiles.dazed + round.waterlog)
//   bits 20-23 priority          7 + move priority, clamped 0..15
//   bits 18-19 goesFirst         round.quickDraw + round.usedCustapBerry
//   bits 16-17 goesLastNegation  ~(laggingTail + myceliumMight + drenched)
//   bits 0-15  effectiveSpeed    GetBattlerTotalSpeedStat, u16
//
// Two consequences that a plain "priority then speed" model gets wrong:
// After You outranks priority outright, and being dazed or waterlogged also
// outranks it (through a NEGATED field, so more dazed means lower). The header's
// own comment says "Compiler lays this out in reverse order"; on the GBA's
// little-endian ABI bitfields are allocated from the least significant bit, so
// `effectiveSpeed` -- declared first -- occupies the low half.
//
// Also ported: turn order is resolved LAZILY, one action at a time.
// SetActionsAndBattlersTurnOrder groups by action, and RecalculateMoveOrder then
// pulls the fastest remaining battler into a slot as that slot is reached.
// All four call sites, because two of them explain parameters nothing else does:
//
//   battle_main.c:4546  TryChangeTurnOrder, index 0, after Mega Evolution has
//                       been offered -- the turn-start sort. Gen 7 recomputes
//                       priority and speed on the turn a mon mega-evolves, which
//                       is why the first slot is sorted here and not earlier.
//   battle_util.c:839   HandleAction_NothingIsFainted, index = the NEXT action
//   battle_util.c:851   HandleAction_ActionFinished, index = the NEXT action
//   battle_main.c:3361  the switch-in ability loop, with ignoreChosenMove TRUE
//                       ("check all switch in abilities from the fastest mon to
//                       slowest", :3358) -- this is the ONLY caller that passes
//                       TRUE, and the only reason the parameter exists. At
//                       switch-in no move has been chosen, so priority is held
//                       at its neutral 7 and the sort is on raw speed alone.
//
// Speeds are therefore re-read mid-turn: a Speed drop inflicted by the first
// action changes who moves second.
//
// Scope: this module decides ORDER only. It does not execute anything, does not
// roll Quick Draw / Quick Claw / Custap (that is the start-of-turn phase, which
// writes the RoundState flags this module reads), and does not resolve move
// data or ability hooks -- see TurnOrderMoveView for the caller-resolved inputs
// and why they are inputs.
//
// Known loose ends, recorded so they are not rediscovered as findings:
//   - TurnOrderMoveView.isStatus is never read here. IS_MOVE_STATUS matters to
//     turn order only through MYCELIUM_MIGHT_AFFECTED, which the caller has
//     already folded into myceliumMightAffected. Kept because a caller building
//     the view has it to hand and the next consumer (move execution) needs it;
//     delete it if that turns out false.
//   - speedFromAbilities takes `state` and does not use it (`void state`). It is
//     there because GetSpeedFromAbilities loops over every battler on the field
//     (battle_main.c:4170-4176), which this port delegates to
//     ctx.applySpeedAbilities; when that seam is filled the loop comes back here
//     and will need the state.
//   - ctx.isTrickRoomActive and ctx.monotypeChampType can still disagree: a
//     FLYING champion suppresses Trick Room outright (battle_util.c:8672), so
//     both set at once is unreachable in the game and no invariant rejects it
//     here. Narrower than it was -- monotypeChampType replaced a separate
//     `monotypeChampFlying` boolean when the grounding port needed the GROUND
//     case, which removed the worse hazard of two booleans for one underlying
//     value. What remains is the same caller-consistency contract
//     engine/types.ts already accepts for isInverseRoomActive.

import type { BattleState, BattlerState } from './state'
import { applyExtraStatLevels, applyStatStage } from '../stats'
import { computeAbilityPriorityBonus } from '../abilities/dispatchPriority'
import {
  B_SIDE_PLAYER,
  DEFAULT_STAT_STAGE,
  MAX_BATTLERS_COUNT,
  SIDE_STATUS_TAILWIND,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_PARALYSIS,
  STATUS2_TRANSFORMED,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  hasFlag,
} from './constants'

/** `GetBattlerTotalSpeedStat`'s calcType argument -- include/battle_main.h:83-86.
 * QUASH is the interesting one: it skips ability speed modifiers, Tailwind,
 * Swamp, Steamroller AND stat stages, leaving only the raw stat, item effects
 * and extra stat levels. */
export const TOTAL_SPEED_FULL = 0
export const TOTAL_SPEED_PRIMARY = 1
export const TOTAL_SPEED_SECONDARY = 2
export const TOTAL_SPEED_QUASH = 3

/** Everything about the move being used that turn order reads but the state
 * model cannot supply on its own. Each field names the C expression it stands
 * for; the caller resolves it because every one of them needs move data, a
 * type-resolution pass or the ability registry, none of which the sim state
 * carries yet. Keeping them as separate named fields rather than one
 * pre-summed bonus preserves the ORDER in which getMovePriority applies them,
 * which is the part being ported. */
export interface TurnOrderMoveView {
  id: string
  /** `gBattleMoves[move].priority` -- the move's own declared value. */
  priority: number
  /** `gBattleMoves[move].effect` -- bare EFFECT_* name. */
  effect: string | null
  /** `IS_MOVE_STATUS(move)` -- split === STATUS. */
  isStatus: boolean
  /** `GetTypeBeforeUsingMove(move, battler)` -- the move's RESOLVED type. Read by
   * the Gale Wings ability family through onPriority. */
  resolvedType: string
  /** `gBattleMoves[move].power` -- read by Perfectionist through onPriority. */
  power: number
  /** `gBattleMoves[move].flags` -- moves.json's own shape. Read by the onPriority
   * dispatch (Blitz Boxer's punch check). */
  flags: Record<string, true>
  /** GetBattleMoveSplit(move). Needed alongside `flags` because
   * DoesMoveMatchFlag's ability-granted half is split-sensitive. */
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  /** `gBattleMoves[move].flags & FLAG_STRONG_JAW_BOOST` -- pairs with
   * STATUS4_COILED at battle_main.c:4274-4276. */
  hasStrongJawBoostFlag: boolean
  /** `IsKeenEdge(battler, move, GetTypeBeforeUsingMove(move, battler))` --
   * pairs with STATUS4_CUTTHROAT at :4278-4280. */
  isKeenEdge: boolean
  /** `NaturalGiftPriority(gBattleMons[battler].item)` -- added for
   * EFFECT_NATURAL_GIFT at :4272. 0 for every other move. */
  naturalGiftPriority: number
  /** `IsBattlerTerrainAffected(battler, STATUS_FIELD_GRASSY_TERRAIN)` -- the
   * grounded-ness half of EFFECT_GRASSY_GLIDE's check at :4266. The terrain bit
   * itself is in the field state, but "affected" also needs grounding, which the
   * state model does not derive. */
  isGrassyTerrainAffected: boolean
  /** `MYCELIUM_MIGHT_AFFECTED(battler, move)` (battle_main.c:4294-4295) -- the
   * holder has Mycelium Might, the move is status, and it is not self-targeting.
   * Feeds goesLastNegation, NOT priority. */
  myceliumMightAffected: boolean
}

/** One battler's chosen action for the turn.
 *
 * `moveToBeUsed` and `chosenMove` are separate because GetMoveSpeed reads two
 * different accessors, but NOT in the way the names suggest. Every value it
 * derives from a move -- priority (battle_main.c:4309, via GetChosenMovePriority,
 * which calls GetChosenMove itself at :4252), Mycelium Might (:4319) and the
 * speed-stat move argument (:4324) -- comes from `GetChosenMove`.
 * `GetMoveToBeUsed` is called once, at :4308, and its result feeds ONLY
 * `GetFullChosenTarget`. So `moveToBeUsed` here is "the move the target is
 * resolved against", nothing more.
 *
 * The two diverge on STATUS2_MULTIPLETURNS / STATUS2_RECHARGE, where
 * GetMoveToBeUsed returns gLockedMoves (battle_util.c:152-160), and on
 * gProcessingExtraAttacks, where GetChosenMove returns the queued extra attack
 * (:4242). NOT on Encore in the ordinary case: Encore writes
 * gChosenMoveByBattler at selection time, so both accessors agree. */
export interface ChosenAction {
  action: 'USE_MOVE' | 'USE_ITEM' | 'SWITCH'
  /** GetMoveToBeUsed's result. Used only to resolve `target`; no value read for
   * ordering comes from it. */
  moveToBeUsed: TurnOrderMoveView | null
  /** GetChosenMove's result -- the move every ordering value is read from. */
  chosenMove: TurnOrderMoveView | null
  /** The battler id GetFullChosenTarget resolves to -- only read by
   * EFFECT_THIEF's item comparison at battle_main.c:4270. */
  target: number | null
}

/** Field-wide facts turn order reads that the state model deliberately does not
 * derive, following the precedent engine/types.ts already set for
 * isInverseRoomActive / isWonderRoomActive. */
export interface TurnOrderContext {
  /** `IsTrickRoomActive()` (battle_util.c:8671-8678): STATUS_FIELD_TRICK_ROOM,
   * or Monotype Champion Normal on an odd turn, unless ABILITY_CLUELESS is on
   * the field or Monotype Champion is Flying. Collapsed into one caller-supplied
   * fact because Clueless-on-field and the champion type are not in the state --
   * the same line this project drew for Inverse and Wonder Room. */
  isTrickRoomActive: boolean
  /** `getMonotypeChampType()` -- a bare type name, or null when no Monotype
   * Champion is active.
   *
   * Was a `monotypeChampFlying` boolean. Generalised because the grounding port
   * needs the GROUND case too (battle_util.c:6656), and two independent booleans
   * for one underlying value is a consistency hazard: nothing would have
   * rejected flying-and-ground-at-once. FLYING doubles the OPPONENT side's speed
   * at battle_main.c:4205 when that side has no Tailwind, and also suppresses
   * Trick Room (battle_util.c:8672) -- which is why `isTrickRoomActive` below
   * stays the caller's to keep consistent with this. */
  monotypeChampType: string | null
  /** `GetBattlerHoldEffect(battler, TRUE)` -- the caller resolves items to hold
   * effects. Returns a bare HOLD_EFFECT_* name, or null. */
  holdEffectOf(battlerId: number): string | null
  /** `GetBattlerHoldEffectParam(battler)` -- unused by ordering itself; present
   * because the same resolver serves the start-of-turn Quick Claw roll. */
  holdEffectParamOf?(battlerId: number): number
  /** The summed `ON_ABILITY(... onStat ... STAT_SPEED ...)` contribution from
   * GetSpeedFromAbilities' loop over every battler (battle_main.c:4170-4176).
   * **Not ported yet** (unlike onPriority, which batch AS wired in): OnStatContext needs
   * a sim-state-to-engine-context bridge that does not exist. Return `speed`
   * unchanged to model "no speed abilities". */
  applySpeedAbilities(battlerId: number, moveId: string | null, speed: number): number
  /** `BATTLER_HAS_ABILITY(battler, ABILITY_QUICK_FEET)` -- exempts the holder
   * from the paralysis speed drop (battle_main.c:4185). A single named ability
   * check rather than a registry call, because the registry has no hook for it. */
  hasQuickFeet(battlerId: number): boolean
  /** `IsBattlerGrounded(battler)` -- the second half of Swamp's condition at
   * battle_main.c:4208. The state model has no grounding derivation (types,
   * Levitate, Air Balloon, Iron Ball, Gravity, Ingrain and Smacked Down all feed
   * it), so it is a seam.
   *
   * It gets a seam rather than an inline `true` for a reason worth stating,
   * because it is the rule for anything added to this interface later: every
   * other unported input here defaults to the NEUTRAL answer -- no ability
   * contribution, no hold effect, no Trick Room -- so a caller that supplies
   * nothing gets a battle with those effects absent, which is wrong only in the
   * direction of "less happens". Grounding is not like that. Most battlers are
   * grounded, so the neutral-looking default of `false` would silently exempt
   * everyone from Swamp, and the opposite default of `true` would silently slow
   * every Flying-type. Either way the error is invisible: there is no missing
   * effect to notice, just a wrong number. So it is a required method with no
   * default, and the neutral context below answers `true` explicitly, which is
   * right for the grounded majority and wrong loudly rather than quietly. */
  isBattlerGrounded(battlerId: number): boolean
}

/** A turn-order context for TESTS and for callers knowingly skipping the
 * unported hooks. Every seam returns its neutral value.
 *
 * **A turn loop must not use this.** `isBattlerGrounded` here answers `true`
 * unconditionally, which is the majority case and therefore wrong for exactly
 * the battlers Swamp is not supposed to slow. The type system does not stop
 * this: making `isBattlerGrounded` a required method only bites a caller
 * building a context from scratch, and reaching for this constant is the path of
 * least resistance. So the constraint is stated rather than enforced -- a real
 * battle must supply a real grounding predicate (type, Levitate, Air Balloon,
 * Iron Ball, Gravity, Ingrain, Smacked Down), and spreading over this constant
 * to get the other defaults leaves that one wrong.
 *
 * The same caveat applies to `applySpeedAbilities` and `holdEffectOf`, but less
 * sharply: those default to "the effect is absent", so their failure is a
 * missing behaviour rather than a wrong number. See TurnOrderContext's
 * isBattlerGrounded doc for the rule. */
export const NEUTRAL_TURN_ORDER_CONTEXT: TurnOrderContext = {
  isTrickRoomActive: false,
  monotypeChampType: null,
  holdEffectOf: () => null,
  applySpeedAbilities: (_battlerId, _moveId, speed) => speed,
  hasQuickFeet: () => false,
  isBattlerGrounded: () => true,
}

function idiv(a: number, b: number): number {
  return Math.trunc(a / b)
}

function battlerSide(battlerId: number): number {
  // GET_BATTLER_SIDE -- position & BIT_SIDE, and in singles/doubles the battler
  // id equals its position (gBattlerPositions is the identity for these
  // formats), so the parity of the id is the side.
  return battlerId & 1
}

/**
 * GetSpeedFromAbilities, battle_main.c:4167-4189. The ability loop is the
 * caller's seam; everything after it is state.
 */
function speedFromAbilities(state: BattleState, battler: BattlerState, moveId: string | null, ctx: TurnOrderContext, speed: number): number {
  let out = ctx.applySpeedAbilities(battler.id, moveId, speed)

  // :4178-4182 -- three separate sequential *150/100 steps, each truncating, not
  // one combined multiplier. Stacking all three is 1.5^3 with truncation at each
  // stage, which is not the same number as *337/100.
  if (battler.volatiles.violentRush) out = idiv(out * 150, 100)
  if (battler.volatiles.rapidResponse) out = idiv(out * 150, 100)
  if (battler.volatiles.showdownMode) out = idiv(out * 150, 100)

  // :4185-4186 -- B_PARALYSIS_SPEED is GEN_7 in this build
  // (include/constants/battle_config.h:21), so the divisor is 2, not vanilla's 4.
  if (hasFlag(battler.mon.status1, STATUS1_PARALYSIS) && !ctx.hasQuickFeet(battler.id)) out = idiv(out, 2)

  void state
  return out
}

/**
 * GetBattlerTotalSpeedStat, battle_main.c:4191-4239.
 *
 * Note the ORDER of the tail: extra stat levels are applied BEFORE stat stages
 * here (:4226-4236), which is the reverse of CalculateStat's own tail, where
 * stages come first (engine/battleStat.ts's applyStatTail). That is why this
 * function composes the two primitives itself instead of calling applyStatTail --
 * reusing applyStatTail would silently impose the damage path's order on turn
 * order.
 */
export function getBattlerTotalSpeedStat(
  state: BattleState,
  battlerId: number,
  calcType: number,
  moveId: string | null,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): number {
  const battler = state.battlers[battlerId]
  if (!battler) return 0

  let speed = battler.mon.rawStats.spe
  const holdEffect = ctx.holdEffectOf(battlerId)
  let statStage = battler.mon.statStages[STAT_SPEED]
  const extraStatLevel = battler.volatiles.extraSpeedLevel

  if (calcType !== TOTAL_SPEED_QUASH) speed = speedFromAbilities(state, battler, moveId, ctx, speed)

  if (calcType === TOTAL_SPEED_PRIMARY) return speed

  if (calcType !== TOTAL_SPEED_QUASH) {
    // :4203-4206 -- Tailwind doubles; failing that, a Flying Monotype Champion
    // doubles the OPPONENT side only. else-if, so they never stack.
    if (hasFlag(state.sides[battlerSide(battlerId)].statuses, SIDE_STATUS_TAILWIND)) speed *= 2
    else if (battlerSide(battlerId) !== B_SIDE_PLAYER && ctx.monotypeChampType === 'FLYING') speed *= 2

    // :4208 -- Swamp requires BOTH the timer and IsBattlerGrounded(battler);
    // gating on the timer alone silently slows Flying-types.
    //
    // `speed /= 1.5` on a u32 in the C promotes to double, divides and truncates
    // on the way back. trunc(speed / 1.5) and idiv(speed * 2, 3) agree for most
    // inputs, but the C really does go through floating point, so this mirrors
    // that rather than the integer-arithmetic lookalike.
    if (state.sides[battlerSide(battlerId)].timers.swampTimer && ctx.isBattlerGrounded(battlerId)) speed = Math.trunc(speed / 1.5)

    if (calcType === TOTAL_SPEED_SECONDARY) return speed

    if (moveId === 'MOVE_STEAMROLLER') speed = idiv(3 * speed, 2)
  }

  // :4216-4224 -- item effects apply even under QUASH.
  if (holdEffect === 'HOLD_EFFECT_MACHO_BRACE' || holdEffect === 'HOLD_EFFECT_POWER_ITEM') speed = idiv(speed, 2)
  else if (holdEffect === 'HOLD_EFFECT_IRON_BALL') speed = idiv(speed, 2)
  else if (holdEffect === 'HOLD_EFFECT_CHOICE_SCARF') speed = idiv(speed * 150, 100)
  else if (holdEffect === 'HOLD_EFFECT_QUICK_POWDER' && battler.mon.speciesId === 'SPECIES_DITTO' && !isTransformed(battler)) speed *= 2

  // :4226-4228 -- before stages, see this function's own doc.
  if (extraStatLevel) speed = applyExtraStatLevels(speed, extraStatLevel)

  if (calcType !== TOTAL_SPEED_QUASH) {
    // :4232 -- Bleed caps the Speed STAGE at neutral rather than zeroing the
    // stat, so a bleeding mon keeps a negative stage but loses a positive one.
    if (hasFlag(battler.mon.status1, STATUS1_BLEED)) statStage = Math.min(statStage, DEFAULT_STAT_STAGE)
    speed = applyStatStage(speed, statStage, statStageRatios)
  }

  return speed
}

function isTransformed(battler: BattlerState): boolean {
  return hasFlag(battler.mon.status2, STATUS2_TRANSFORMED)
}

/**
 * GetMovePriority, battle_main.c:4257-4292. Returns the move's priority after
 * every modifier, which is then offset by 7 and clamped by getMoveSpeed.
 */
export function getMovePriority(state: BattleState, battlerId: number, move: TurnOrderMoveView, targetId: number | null): number {
  const battler = state.battlers[battlerId]
  if (!battler) return move.priority

  let priority = move.priority

  // :4262 -- Quash short-circuits everything below, including the ability hook.
  // `min(-4, priority)` keeps an already-lower priority, so Quash floors at -4
  // rather than forcing it.
  if (state.field.timers.quashTimer) return Math.min(-4, priority)

  // :4264 -- the ON_ABILITY sum, computed from the holder's own ability slots
  // rather than supplied. It is deliberately NOT a field on TurnOrderContext:
  // that interface has a neutral constant tests reach for, and routing abilities
  // through it would make "no priority abilities" the easy default again.
  priority += computeAbilityPriorityBonus({
    battlerId: String(battlerId),
    holderSlots: battler.mon.abilities,
    moveId: move.id,
    moveType: move.resolvedType,
    movePower: move.power,
    movePriority: move.priority,
    moveSplit: move.split,
    moveFlags: move.flags,
    holderHp: battler.mon.hp,
    holderMaxHp: battler.mon.maxHp,
    targetHp: targetId === null ? null : (state.battlers[targetId]?.mon.hp ?? null),
    targetMaxHp: targetId === null ? null : (state.battlers[targetId]?.mon.maxHp ?? null),
  })

  if (move.effect === 'EFFECT_GRASSY_GLIDE' && move.isGrassyTerrainAffected) priority++

  // :4270 -- Thief gains priority only when the user is itemless and the TARGET
  // is holding something.
  if (move.effect === 'EFFECT_THIEF' && targetId !== null) {
    const target = state.battlers[targetId]
    if (!battler.mon.itemId && target?.mon.itemId) priority++
  }

  if (move.effect === 'EFFECT_NATURAL_GIFT') priority += move.naturalGiftPriority

  if (hasFlag(battler.statuses4, STATUS4_COILED) && move.hasStrongJawBoostFlag) priority++

  if (hasFlag(battler.statuses4, STATUS4_CUTTHROAT) && move.isKeenEdge) priority++

  // :4282 -- Razor Wind checks BOTH sides' Tailwind, not the user's own.
  if (move.id === 'MOVE_RAZOR_WIND' && (hasFlag(state.sides[0].statuses, SIDE_STATUS_TAILWIND) || hasFlag(state.sides[1].statuses, SIDE_STATUS_TAILWIND))) {
    priority++
  }

  // :4284-4289 -- On The Prowl raises non-negative priority by one, and for a
  // NEGATIVE-priority move subtracts the move's own declared priority, i.e.
  // cancels it back toward whatever the modifiers above produced. Note both
  // branches test `gBattleMoves[move].priority`, the DECLARED value, not the
  // running total.
  if (battler.volatiles.onTheProwl) {
    if (move.priority >= 0) priority++
    else priority -= move.priority
  }

  return priority
}

/** The decoded form of `union SpeedValue`, kept so tests can assert a field
 * rather than a packed integer. `comparable` is the only thing the game ever
 * compares. */
export interface SpeedValue {
  afterYou: number
  dazedNegation: number
  priority: number
  goesFirst: number
  goesLastNegation: number
  effectiveSpeed: number
  comparable: number
}

/**
 * GetMoveSpeed, battle_main.c:4297-4327.
 *
 * Every field is truncated to its declared bit width by the assignment into the
 * union, and two of them are stored NEGATED, so the packing is the semantics.
 */
export function getMoveSpeed(
  state: BattleState,
  battlerId: number,
  action: ChosenAction | null,
  ignoreChosenMove: boolean,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): SpeedValue {
  const battler = state.battlers[battlerId]
  const quash = state.field.timers.quashTimer

  let afterYou = 0
  let dazedNegation = 0
  if (!quash && battler) {
    afterYou = battler.round.afterYou ? 1 : 0
    // :4304 -- `~(dazed + waterlog)` into a 2-BIT field. dazed is a 3-bit
    // counter, so a sum of 4 complements back to 3, the same value as a sum of
    // 0: a battler dazed to 4 sorts as if it were not dazed at all. Transcribed,
    // not corrected.
    const dazedSum = battler.volatiles.dazed + (battler.round.waterlog ? 1 : 0)
    dazedNegation = ~dazedSum & 0x3
  }

  // :4300, :4307-4315 -- the neutral priority is 7, so the 4-bit field spans
  // move priorities -7..+8 before clamping. ignoreChosenMove leaves it at 7,
  // which is how RecalculateMoveOrder compares raw speed during switch-in.
  let priority = 7
  if (!ignoreChosenMove && action?.chosenMove && battler) {
    // :4309 -- GetChosenMovePriority reads GetChosenMove, not the move
    // GetMoveToBeUsed returned one line earlier; that one only picks the target.
    priority += getMovePriority(state, battlerId, action.chosenMove, action.target)
    if (priority > 15) priority = 15
    else if (priority < 0) priority = 0
  }

  let goesFirst = 0
  let goesLastNegation = 0
  let effectiveSpeed = 0
  if (battler) {
    // :4317 -- Quick Draw and Quick Claw/Custap are SUMMED into a 2-bit field,
    // so holding both beats holding one. These flags are set by the
    // start-of-turn rolls (SetActionsAndBattlersTurnOrder, :4404-4414), which
    // this module reads but does not perform.
    goesFirst = ((battler.round.quickDraw ? 1 : 0) + (battler.round.usedCustapBerry ? 1 : 0)) & 0x3

    let goesLast = ctx.holdEffectOf(battlerId) === 'HOLD_EFFECT_LAGGING_TAIL' ? 1 : 0
    if (!ignoreChosenMove && !quash && action?.chosenMove?.myceliumMightAffected) goesLast++
    // :4320 -- a plain ++, so any nonzero `drenched` adds exactly one.
    if (!quash && battler.volatiles.drenched) goesLast++
    goesLastNegation = ~goesLast & 0x3

    const speedMove = ignoreChosenMove ? null : (action?.chosenMove?.id ?? null)
    const total = getBattlerTotalSpeedStat(state, battlerId, quash ? TOTAL_SPEED_QUASH : TOTAL_SPEED_FULL, speedMove, ctx, statStageRatios)
    // :4323-4325 -- the u32 result lands in a u16 field, so speed wraps at
    // 65536. Trick Room is then a bitwise complement WITHIN that u16, not a
    // reversed comparison and not a negation: 65535 - speed.
    effectiveSpeed = total & 0xffff
    if (!quash && ctx.isTrickRoomActive) effectiveSpeed = ~effectiveSpeed & 0xffff
  }

  const comparable =
    ((afterYou << 26) | (dazedNegation << 24) | (priority << 20) | (goesFirst << 18) | (goesLastNegation << 16) | effectiveSpeed) >>> 0

  return { afterYou, dazedNegation, priority, goesFirst, goesLastNegation, effectiveSpeed, comparable }
}

/**
 * GetWhoStrikesFirst, battle_main.c:4386-4398 -- returns 0 if battler1 goes
 * first, 1 if battler2 does. A tie is `Random() % 2`; we use the seeded source,
 * not the game's stream, per the plan's statistical-fidelity decision.
 */
export function getWhoStrikesFirst(
  state: BattleState,
  battler1: number,
  battler2: number,
  actions: (ChosenAction | null)[],
  ignoreChosenMoves: boolean,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): 0 | 1 {
  const s1 = getMoveSpeed(state, battler1, actions[battler1] ?? null, ignoreChosenMoves, ctx, statStageRatios).comparable
  const s2 = getMoveSpeed(state, battler2, actions[battler2] ?? null, ignoreChosenMoves, ctx, statStageRatios).comparable

  if (s1 < s2) return 1
  if (s1 > s2) return 0
  return (state.rng.random16() % 2) as 0 | 1
}

/**
 * GetFastestBattler, battle_main.c:4329-4347.
 *
 * Reproduces the reservoir-style tie-break exactly: `dupeCount` starts at 2 and
 * increments on every tie, so in an N-way tie each entrant has an equal chance.
 * Note `maxSpeed` starts at 0 and `maxBattler` at 0, and the loop uses a strict
 * `>` -- a battler whose comparable is 0 can still win the ties branch against
 * the initial state, which is why battler 0 is the default answer.
 */
export function getFastestBattler(
  state: BattleState,
  actions: (ChosenAction | null)[],
  ignoreChosenMoves: boolean,
  exceptMask: number,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): number {
  let maxBattler = 0
  let maxSpeed = 0
  let dupeCount = 2

  for (let i = 0; i < state.battlersCount; i++) {
    if (exceptMask & (1 << i)) continue
    const speed = getMoveSpeed(state, i, actions[i] ?? null, ignoreChosenMoves, ctx, statStageRatios).comparable
    if (speed > maxSpeed) {
      maxSpeed = speed
      maxBattler = i
      dupeCount = 2
    } else if (speed === maxSpeed && state.rng.random16() % dupeCount++ === 0) {
      maxBattler = i
    }
  }

  return maxBattler
}

/** The mutable turn order: which battler acts in each slot, and what they do.
 * Mirrors `gBattlerByTurnOrder` / `gActionsByTurnOrder` (battle.h:960-961). */
export interface TurnOrder {
  battlerByTurnOrder: number[]
  actionsByTurnOrder: ChosenAction['action'][]
}

/**
 * RecalculateMoveOrder, battle_main.c:4551-4566 -- the lazy re-sort. Called with
 * the slot about to be executed; picks the fastest battler not already ordered
 * before it and swaps it in.
 *
 * The early return at :4553 is what preserves the item/switch grouping: a slot
 * whose action is not USE_MOVE is left exactly where SetActionsAndBattlersTurnOrder
 * put it.
 */
export function recalculateMoveOrder(
  order: TurnOrder,
  state: BattleState,
  actions: (ChosenAction | null)[],
  index: number,
  ignoreChosenMove: boolean,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): void {
  if (!ignoreChosenMove && order.actionsByTurnOrder[index] !== 'USE_MOVE') return

  let exclude = 0
  for (let i = 0; i < index; i++) exclude |= 1 << order.battlerByTurnOrder[i]

  const fastest = getFastestBattler(state, actions, ignoreChosenMove, exclude, ctx, statStageRatios)
  if (order.battlerByTurnOrder[index] === fastest) return

  for (let i = index + 1; i < state.battlersCount; i++) {
    if (order.battlerByTurnOrder[i] !== fastest) continue
    swapTurnOrder(order, index, i)
    return
  }
}

/** SwapTurnOrder, battle_main.c:4160-4165 -- swaps BOTH arrays together. */
export function swapTurnOrder(order: TurnOrder, id1: number, id2: number): void {
  const b = order.battlerByTurnOrder[id1]
  order.battlerByTurnOrder[id1] = order.battlerByTurnOrder[id2]
  order.battlerByTurnOrder[id2] = b
  const a = order.actionsByTurnOrder[id1]
  order.actionsByTurnOrder[id1] = order.actionsByTurnOrder[id2]
  order.actionsByTurnOrder[id2] = a
}

/**
 * SetActionsAndBattlersTurnOrder's ordering half, battle_main.c:4456-4480.
 *
 * The result is NOT speed-sorted, and that is not a simplification. The two
 * loops at :4458-4475 between them cover every battler -- items, switches and
 * ball throws first in ascending battler id, then everything else in ascending
 * battler id -- and each sets its bit in `except`. By the time
 * `SortBattlersExcept(&gActionsByTurnOrder[turnOrderId], FALSE, except)` runs at
 * :4476, `except` holds every battler, so the function's own
 * `FILTER_NOT(except & (1 << i))` skips them all, it writes nothing and returns
 * 0. The follow-up loop at :4477 starts at `turnOrderId`, which now equals
 * gBattlersCount, so it does not run either. The speed sort in
 * SetActionsAndBattlersTurnOrder is dead code.
 *
 * Speed ordering really happens afterwards, in RecalculateMoveOrder, called once
 * per action. Reproducing the dead sort as a no-op is deliberate: the grouping it
 * leaves behind is what RecalculateMoveOrder's :4553 guard then preserves for
 * non-move actions.
 *
 * The Safari, link and B_ACTION_RUN branches (:4416-4455) are omitted -- none
 * occur in a trainer battle.
 */
export function setActionsAndBattlersTurnOrder(state: BattleState, actions: (ChosenAction | null)[]): TurnOrder {
  const battlerByTurnOrder: number[] = []
  const actionsByTurnOrder: ChosenAction['action'][] = []

  const isFirstGroup = (a: ChosenAction | null): boolean => a?.action === 'USE_ITEM' || a?.action === 'SWITCH'

  for (let i = 0; i < state.battlersCount; i++) {
    if (!isFirstGroup(actions[i] ?? null)) continue
    battlerByTurnOrder.push(i)
    actionsByTurnOrder.push(actions[i]?.action ?? 'USE_MOVE')
  }
  for (let i = 0; i < state.battlersCount; i++) {
    if (isFirstGroup(actions[i] ?? null)) continue
    battlerByTurnOrder.push(i)
    actionsByTurnOrder.push(actions[i]?.action ?? 'USE_MOVE')
  }

  return { battlerByTurnOrder, actionsByTurnOrder }
}

/** Runs the lazy algorithm to completion against a state that is ASSUMED NOT TO
 * CHANGE, and is named for that assumption because it is otherwise the first
 * thing a caller reaches for and the failure is silent.
 *
 * The real loop calls recalculateMoveOrder after every action
 * (battle_util.c:839, :851) and re-reads speeds each time, so any Speed change,
 * paralysis, faint or item trigger during the turn makes this function's answer
 * diverge from the game's. A turn loop must drive recalculateMoveOrder itself.
 * This exists for tests and for callers that genuinely want a snapshot; it
 * should be deleted once the turn loop lands if nothing else uses it. */
export function resolveTurnOrderAssumingNoMidTurnChanges(
  state: BattleState,
  actions: (ChosenAction | null)[],
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
): TurnOrder {
  const order = setActionsAndBattlersTurnOrder(state, actions)
  for (let i = 0; i < order.battlerByTurnOrder.length && i < MAX_BATTLERS_COUNT; i++) {
    recalculateMoveOrder(order, state, actions, i, false, ctx, statStageRatios)
  }
  return order
}
