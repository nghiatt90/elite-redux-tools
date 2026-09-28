// Orchestration: BattleAI_SetupAIData (battle_ai_main.c:158-188),
// ChooseMoveOrAction_Singles (:270-339), BattleAI_DoAIProcessing (:442-474),
// ComputeBattleAiScores (:208-212), the singles-only half of
// BattleAI_ChooseMoveOrAction (:190-205), and the second switch check embedded
// in ChooseMoveOrAction_Singles (:294-318). Singles only, per this batch's own
// scope -- ChooseMoveOrAction_Doubles (:341-440) is not ported.
//
// AI_CheckBadMove PART 1 is wired for real as of the ai-checkbadmove-1 batch
// (aiCheckBadMove.ts, battle_ai_main.c:488-1298 through EFFECT_PERISH_SONG).
// AI_CheckViability is still STUBBED pass-through here -- batches 4-5. A stub
// still occupies its dispatch slot (bit 2), so the score-zeroing behaviour for
// an unusable move slot (PP exhausted, or MOVE_NONE) still applies identically
// to the real function, only the scorer body itself does nothing.

import type { BattleState, BattlerState } from '../state'
import type { BaseStats } from '../../types'
import { hasFlag, PARTY_SIZE, STATUS2_ESCAPE_PREVENTION, STATUS2_WRAPPED, STATUS3_ROOTED, STATUS4_COMMANDED } from '../constants'
import { AI_FLAG_CHECK_BAD_MOVE, AI_FLAG_CHECK_VIABILITY, AI_FLAG_PREFER_BATON_PASS, AI_FLAG_TRY_TO_FAINT } from './aiFlags'
import { aiHPAware, aiRisky, aiTryToFaint } from './aiScorers'
import { aiCheckBadMove } from './aiCheckBadMove'
import { getMostSuitableMonToSwitchInto, type AiSwitchingDeps } from './aiSwitching'
import type { AiDamageDeps } from './aiCalcDamage'

/** include/constants/battle.h:18, 66. Same values aiSwitching.ts's own module
 * header cites (BATTLE_TYPE_ARENA) and state.ts's aiFlags doc cites
 * (BATTLE_TYPE_PALACE, which SHARES A BIT with AI_FLAG_DISABLE_SWITCHING --
 * the known dead-flag bug, reproduced not fixed, see state.ts). */
const BATTLE_TYPE_ARENA = 1 << 18
const BATTLE_TYPE_PALACE = 1 << 17

/** MOVE_POWER-style stub score, unchanged. */
type ScorerResult = { score: number; unmodelled: string[] }
type Scorer = (state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, moveIndex: number, score: number, deps: AiDamageDeps) => ScorerResult

function checkViabilityStub(_s: BattleState, _a: number, _d: number, _m: string, _i: number, score: number): ScorerResult {
  return { score, unmodelled: [] }
}

/** sBattleAiFuncTable, battle_ai_main.c:60-93 -- restricted to the bits this
 * batch's `state.aiFlags` can ever carry (this module's own aiFlags finding:
 * every trainer's aiFlags is CHECK_BAD_MOVE|TRY_TO_FAINT|CHECK_VIABILITY|
 * CHECK_FOE|SMART_SWITCHING|HP_AWARE|WILL_SUICIDE, plus RISKY/STALL/
 * PREFER_STATUS_MOVES/DISABLE_SWITCHING per trainer -- never SETUP_FIRST_TURN,
 * PREFER_STRONGEST_MOVE or PREFER_BATON_PASS). Bits with no entry here behave
 * exactly like the C's own NULL table slots: BattleAI_DoAIProcessing's dispatch
 * guard (`sBattleAiFuncTable[aiLogicId] != NULL`) skips them, leaving the score
 * unchanged for that pass -- whether the C's own table slot is truly NULL (bits
 * 9, 11-14, 17-28) or non-NULL but never reached by a trainer's aiFlags (bits
 * 3, 5, 6, 7, 29-31), the OBSERVABLE effect on a trainer battle's scores is
 * identical, so this table only needs entries for bits a trainer can set. */
const DISPATCH: Record<number, Scorer> = {
  0: (s, a, d, m, _i, sc, deps) => aiCheckBadMove(s, a, d, m, sc, deps), // AI_FLAG_CHECK_BAD_MOVE -- part 1 (this batch), part 2 to follow
  1: (s, a, d, m, i, sc, deps) => aiTryToFaint(s, a, d, m, i, sc, deps), // AI_FLAG_TRY_TO_FAINT
  2: checkViabilityStub, // AI_FLAG_CHECK_VIABILITY -- stub (batches 4-5)
  4: (s, a, d, m, _i, sc, deps) => aiRisky(s, a, d, m, sc, deps), // AI_FLAG_RISKY
  8: (s, a, d, m, _i, sc, deps) => aiHPAware(s, a, d, m, sc, deps), // AI_FLAG_HP_AWARE
}

/**
 * BattleAI_SetupAIData, battle_ai_main.c:158-188, called as
 * `BattleAI_SetupAIData(0xF)` by ComputeBattleAiScores -- every score slot
 * starts at 100. `AI_DATA->moveLimitations` (Taunt/Disable/Torment/Imprison/
 * heal-block-style move limitations, CheckMoveLimitations) is not modelled by
 * this sim (no caller populates a limitations bitmask), so the C's own
 * `if (gBitTable[i] & moveLimitations) score[i] = 0` never fires here -- a gap
 * only in the sense that a limited move would incorrectly score, reported once
 * per `setupAiScores` call as a standing caveat rather than a per-move note,
 * since there is no per-move signal to attach it to.
 *
 * `gBattlerTarget = SetRandomTarget(sBattler_AI)` (:186) is NOT a caller
 * responsibility to seed RNG for: SetRandomTarget (battle_util.c:6326-6341)
 * only draws `Random() % 2` inside its `BATTLE_TYPE_DOUBLE` branch, which this
 * singles-only sim never takes -- the else branch is a pure function of side,
 * `targets[side][0]`, equal to `battlerId ^ 1` in singles. No RNG draw.
 */
export function setupAiScores(state: BattleState, battlerAtk: number): { scores: [number, number, number, number]; unmodelled: string[] } {
  const battler = state.battlers[battlerAtk]
  const unmodelled = ['AI_DATA->moveLimitations (Taunt/Disable/Torment/Imprison/heal-block move limitations) is not modelled; every move is treated as usable by BattleAI_SetupAIData']
  const scores: [number, number, number, number] = [100, 100, 100, 100]
  if (!battler) return { scores, unmodelled }
  for (let i = 0; i < 4; i++) {
    if (!battler.mon.moves[i] || battler.mon.pp[i] === 0) scores[i] = 0
  }
  return { scores, unmodelled }
}

/** SetRandomTarget's singles-only else branch, battle_util.c:6337 -- see
 * `setupAiScores`'s own doc for why this draws no RNG. */
export function setRandomTargetSingles(battlerAtk: number): number {
  return battlerAtk ^ 1
}

/**
 * BattleAI_DoAIProcessing, battle_ai_main.c:442-474 -- one pass over all four
 * move slots for ONE aiLogicId (flag bit). A slot whose move is MOVE_NONE or
 * whose PP is 0 gets its score forced to 0 EVERY pass (moveConsidered==0 at
 * :449, which the C's own AIState_Processing branch at :462-464 turns into
 * `score[i] = 0` unconditionally) -- so this is re-checked every call rather
 * than assumed to stay zeroed from `setupAiScores`.
 */
export function doAiProcessing(state: BattleState, battlerAtk: number, battlerDef: number, bit: number, scores: [number, number, number, number], deps: AiDamageDeps): string[] {
  const unmodelled: string[] = []
  const battler = state.battlers[battlerAtk]
  if (!battler) return unmodelled
  const scorer = DISPATCH[bit]

  for (let i = 0; i < 4; i++) {
    const moveId = battler.mon.moves[i]
    const usable = !!moveId && battler.mon.pp[i] !== 0
    if (!usable || scores[i] <= 0) {
      scores[i] = 0
      continue
    }
    if (scorer) {
      const result = scorer(state, battlerAtk, battlerDef, moveId as string, i, scores[i], deps)
      scores[i] = result.score
      unmodelled.push(...result.unmodelled)
    }
    // A bit with no dispatch entry (this table's own doc) leaves scores[i]
    // unchanged, matching the C's NULL-slot skip.
  }
  return unmodelled
}

/**
 * ComputeBattleAiScores, battle_ai_main.c:208-212 + BattleAI_ChooseMoveOrAction's
 * singles half (:190-205) -- iterates every set bit in `state.aiFlags` from bit
 * 0 upward (the C's own `while (flags) { if (flags&1) DoAIProcessing(); flags
 * >>= 1; aiLogicId++ }`), running `doAiProcessing` for each. The C's own
 * `gRoundStructs[gActiveBattler]` memset-except-protectMove (:200-201) has no
 * effect on scoring (it runs AFTER scores are already finalised, before
 * returning), so it is not reproduced by this scoring function -- a caller
 * driving a real RoundState reset does that itself, the same layering
 * `executeTurn` already uses for round-state resets elsewhere.
 */
export function computeBattleAiScores(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiDamageDeps): { scores: [number, number, number, number]; unmodelled: string[] } {
  const setup = setupAiScores(state, battlerAtk)
  const scores = setup.scores
  const unmodelled = [...setup.unmodelled]
  const aiFlags = state.aiFlags

  for (let bit = 0; bit < 32; bit++) {
    if (!hasFlag(aiFlags, 1 << bit)) continue
    unmodelled.push(...doAiProcessing(state, battlerAtk, battlerDef, bit, scores, deps))
  }

  return { scores, unmodelled }
}

/**
 * CountUsablePartyMons, battle_ai_util.c:2447-2474 -- singles-only (both
 * "on field" slots collapse to the same `battlerOnField1 === battlerOnField2`
 * the C's own else branch sets at :2461-2462). Eggs are not modelled (same
 * precedent as aiSwitching.ts's own SimPartyMon doc).
 */
export function countUsablePartyMons(state: BattleState, battlerId: number): number {
  const battler = state.battlers[battlerId]
  if (!battler) return 0
  const side = battlerId & 1
  const party = state.sides[side].party
  let count = 0
  for (let i = 0; i < PARTY_SIZE; i++) {
    if (i === battler.partyIndex) continue
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp !== 0) count++
  }
  return count
}

/** The 5 abilities with an `onTrap` hook in abilityHooks.json at the pinned
 * snapshot (data/v2.65beta/abilityHooks.json, grep-verified against the
 * `hooks.onTrap` key): Arena Trap, Frenzied Phantom, Magnet Pull, Sap Trap,
 * Shadow Tag. */
const TRAPPING_ABILITIES = new Set(['ABILITY_ARENA_TRAP', 'ABILITY_FRENZIED_PHANTOM', 'ABILITY_MAGNET_PULL', 'ABILITY_SAP_TRAP', 'ABILITY_SHADOW_TAG'])

/**
 * IsAbilityPreventingEscape, battle_util.c:4826-4834 -- ALWAYS returns "not
 * prevented" (0/false) here. The real function calls each living opponent's
 * `onTrap` ability hook (ON_ABILITY, ability registry), which needs the
 * ability-dispatch bridge this batch does not wire up (no OnTrapContext exists
 * yet), and also needs Shed Shell / Ghost-type immunity checked first. Reported
 * as a gap only when the opposing battler actually holds one of the 5
 * `onTrap`-hooked abilities in ANY slot (`TRAPPING_ABILITIES` above) -- i.e.
 * only when the missing check could actually have changed the answer.
 */
export function isAbilityPreventingEscape(state: BattleState, battlerId: number): { prevents: boolean; unmodelled: string[] } {
  const opposingId = battlerId ^ 1
  const opposing = state.battlers[opposingId]
  const unmodelled: string[] = []
  if (opposing) {
    const slots = [opposing.mon.abilities.ability, ...opposing.mon.abilities.innates]
    if (slots.some((id) => id && TRAPPING_ABILITIES.has(id))) {
      unmodelled.push(`IsAbilityPreventingEscape (battle_util.c:4826-4834) not ported -- opponent battler ${opposingId} has a trapping-capable ability; escape-prevention not checked, treated as not preventing`)
    }
  }
  return { prevents: false, unmodelled }
}

/** GetTotalBaseStat -- reused from species data via `deps.dataContext.species`
 * (SimSpeciesData.baseStats, engine/sim/dataContext.ts). */
function getTotalBaseStat(baseStats: BaseStats): number {
  return Object.values(baseStats).reduce((a: number, b: number) => a + b, 0)
}

export type AiChoice = { kind: 'switch' } | { kind: 'move'; moveIndex: number }

/**
 * ChooseMoveOrAction_Singles, battle_ai_main.c:270-339 -- the second switch
 * check (:294-318) plus the tie-break (:320-338). `AI_ACTION_FLEE`/`AI_ACTION_
 * WATCH` (:295-296, Roaming/Safari-only actions this batch's aiFlags can never
 * set -- AI_Roaming/AI_Safari are never dispatched, see DISPATCH's own doc) are
 * not checked, since `state.aiFlags` can never carry AI_FLAG_ROAMING/SAFARI on
 * a trainer battle.
 *
 * The second switch check's own guard skips `STATUS3_ROOTED`/`STATUS4_COMMANDED`/
 * `skyDropped`/`fear`/wrap-or-escape-prevention/BATTLE_TYPE_ARENA|PALACE exactly
 * as the C does; `IsAbilityPreventingEscape` is approximated (see its own doc).
 */
export function chooseMoveOrActionSingles(state: BattleState, battlerAtk: number, scores: [number, number, number, number], deps: AiSwitchingDeps): { choice: AiChoice; unmodelled: string[] } {
  const unmodelled: string[] = []
  const battler = state.battlers[battlerAtk] as BattlerState

  const gateFlags = AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_PREFER_BATON_PASS
  const usableParty = countUsablePartyMons(state, battlerAtk)
  const escapeCheck = isAbilityPreventingEscape(state, battlerAtk)
  unmodelled.push(...escapeCheck.unmodelled)

  const canConsiderSwitch =
    usableParty > 0 &&
    !escapeCheck.prevents &&
    !hasFlag(battler.mon.status2, STATUS2_WRAPPED | STATUS2_ESCAPE_PREVENTION) &&
    !hasFlag(battler.statuses3, STATUS3_ROOTED) &&
    !hasFlag(battler.statuses4, STATUS4_COMMANDED) &&
    !battler.volatiles.skyDropped &&
    !battler.volatiles.fear &&
    !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA | BATTLE_TYPE_PALACE) &&
    hasFlag(state.aiFlags, gateFlags)

  if (canConsiderSwitch) {
    const species = deps.dataContext.species(battler.mon.speciesId)
    const bst = species ? getTotalBaseStat(species.baseStats) : 0
    const notWeak = bst >= 310 && battler.mon.hp >= Math.floor(battler.mon.maxHp / 2)
    if (notWeak) {
      const cap = hasFlag(state.aiFlags, AI_FLAG_CHECK_VIABILITY) ? 95 : 93
      const allBelowCap = scores.every((s) => s <= cap)
      if (allBelowCap) {
        const result = getMostSuitableMonToSwitchInto(state, battlerAtk, deps)
        unmodelled.push(...result.unmodelled)
        if (result.partyIndex !== PARTY_SIZE) {
          return { choice: { kind: 'switch' }, unmodelled }
        }
      }
    }
  }

  // Tie-break, :320-338. Only slots with an actual move (MOVE_NONE excluded,
  // matching `gBattleMons[sBattler_AI].moves[i] != MOVE_NONE` at :325) compete.
  // The C seeds currentMoveArray[0]/consideredMoveArray[0] from slot 0
  // UNCONDITIONALLY (:321-322), even if slot 0 is MOVE_NONE -- then the loop
  // from i=1 only ever ADDS to or REPLACES consideredMoveArray, never removes
  // slot 0 for being MOVE_NONE. A MOVE_NONE slot 0 therefore stays eligible
  // for the final `Random() % numOfBestMoves` pick whenever no other slot's
  // score exceeds its (forced-to-0) score, an observable oddity this port
  // reproduces rather than "fixes" -- matching aiSwitching.ts's own precedent
  // for a transcribed rather than corrected bug.
  let bestScore = scores[0]
  let bestIndices = [0]
  for (let i = 1; i < 4; i++) {
    if (battler.mon.moves[i] === null) continue
    if (scores[i] === bestScore) {
      bestIndices.push(i)
    } else if (scores[i] > bestScore) {
      bestScore = scores[i]
      bestIndices = [i]
    }
  }

  const pick = bestIndices[state.rng.random16() % bestIndices.length]
  return { choice: { kind: 'move', moveIndex: pick }, unmodelled }
}
