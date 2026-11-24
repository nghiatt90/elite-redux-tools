// Pure, headless inputs the solver-v2 role policies read before choosing an
// action: our own damage rolls, a sampled view of the opponent's next action,
// and the pivot-move list. No policy rules live here -- only the primitives.
//
// `predictAi` reproduces expectimax.ts's unexported `sampleOpponent`
// (expectimax.ts:1108-1124) so a policy can ask "what will the AI do?" without
// exporting it from there; it clones the session per sample, so the real
// session is never stepped or otherwise advanced.

import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import { chooseAiAction } from '../ai/chooseAiAction'
import { createAiOpponentReplacement } from '../ai/aiSwitching'
import { PARTY_SIZE } from '../constants'
import type { ChosenAction } from '../turnOrder'
import type { SimDataBundle } from './loadSimData'
import { aiDamageDepsFor, cloneSession } from './session'
import type { BattleSession } from './session'

/**
 * `calculateMoveDamage`'s 16-roll result for OUR move, with our real held item
 * and moves -- see `aiDamageRolls`' doc for how this differs from the AI's own
 * blended estimate.
 */
export function ourDamageRange(
  session: BattleSession,
  moveId: string,
  attackerId: number,
  defenderId: number,
): AiDamageRolls | null {
  return aiDamageRolls(
    session.state,
    moveId,
    attackerId,
    defenderId,
    aiDamageDepsFor(session.data, session.state, session.inverseBattle),
  )
}

/** The lowest roll of a range against a target's current HP: a guaranteed KO
 * needs the WORST roll to finish it. Multi-hit moves use their summed total
 * (`totalRolls`), which `rolls` alone would understate. */
export function guaranteedKo(range: AiDamageRolls, hp: number): boolean {
  const rolls = range.totalRolls ?? range.rolls
  return rolls[0]! >= hp
}

/** The highest roll of a range against a target's current HP: a possible KO
 * only needs the BEST roll to finish it. */
export function possibleKo(range: AiDamageRolls, hp: number): boolean {
  const rolls = range.totalRolls ?? range.rolls
  return rolls[15]! >= hp
}

export interface AiPrediction {
  /** The AI's next action, or null when battler 1 is absent or fainted. */
  action: ChosenAction | null
  /** Party slot the AI would switch into, when the action is a SWITCH;
   * null otherwise (and null if no slot can be resolved). */
  switchSlot: number | null
  /** The seed this sample's probe session was cloned with. */
  seed: number
}

/**
 * Samples the opponent's action `n` times, mirroring `sampleOpponent`
 * (expectimax.ts:1108-1124). Each sample clones the session (its own RNG, the
 * real one untouched) and asks the ported AI. Singles only: battler 3 is out of
 * scope for this helper.
 *
 * `chooseAiAction` leaves `monToSwitchIntoId` at `PARTY_SIZE` on the branch
 * where step 1 itself chose a switch (chooseAiAction.ts's own doc), because the
 * real game resolves the mon later in `OpponentHandleChoosePokemon`. That
 * resolution is `createAiOpponentReplacement(...).chooseReplacement`, the same
 * port `executeTurn`'s SWITCH step falls back to (turn.ts:1864-1871).
 */
export function predictAi(session: BattleSession, n = 3, seedBase = 0): AiPrediction[] {
  const predictions: AiPrediction[] = []
  for (let k = 0; k < n; k++) {
    const seed = (seedBase + k * 0x9e3779b1) >>> 0
    const probe = cloneSession(session, seed)
    const opp = probe.state.battlers[1]
    const action = opp && opp.mon.hp > 0 ? chooseAiAction(probe.state, 1, probe.chooseAiDeps).action : null
    let switchSlot: number | null = null
    if (action && action.action === 'SWITCH' && opp) {
      let slot = opp.monToSwitchIntoId
      if (slot === PARTY_SIZE) {
        const replacement = createAiOpponentReplacement(
          aiDamageDepsFor(probe.data, probe.state, probe.inverseBattle),
        )
        slot = replacement.chooseReplacement(probe.state, 1, [])
      }
      switchSlot = slot === PARTY_SIZE ? null : slot
    }
    predictions.push({ action, switchSlot, seed })
  }
  return predictions
}

/** The move effects that make the user switch out (U-turn family, Baton Pass,
 * Parting Shot, Shed Tail, Chilly Reception, Safe Passage/Teleport, Septic
 * Switch). Verified against data/v2.65beta/moves.json: exactly 12 moves. */
const PIVOT_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_HIT_ESCAPE',
  'EFFECT_PARTING_SHOT',
  'EFFECT_SWITCH_ARGUMENT',
  'EFFECT_SEPTIC_SWITCH',
  'EFFECT_CHILLY_RECEPTION',
  'EFFECT_SHED_TAIL',
  'EFFECT_BATON_PASS',
])

/** Every move id in `data.movesById` whose effect switches the user out, sorted
 * ascending (12 on the pinned snapshot). */
export function pivotMoves(data: SimDataBundle): string[] {
  const ids: string[] = []
  for (const [id, move] of data.movesById) {
    if (move && PIVOT_EFFECTS.has(move.effect)) ids.push(id)
  }
  return ids.sort()
}
