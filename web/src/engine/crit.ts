// Critical hit determination, ported from src/battle_script_commands.c:1523-1596.
// ER pins B_CRIT_CHANCE to GEN_7 (natures.json's criticalHitChance: [24, 8, 2, 1, 1],
// each entry a "1 in N" denominator for stages 0..3+).

export const ALWAYS_CRIT = 3
export const NEVER_CRIT = -2

export interface CritStageInputs {
  /** Field/side blockers that force NEVER_CRIT outright (:1526-1528): Lucky Chant on
   * the defender's side, or STATUS3_CANT_SCORE_A_CRIT on the attacker. */
  isBlocked: boolean
  /** Any condition that forces ALWAYS_CRIT (:1539-1544): Laser Focus,
   * EFFECT_ALWAYS_CRIT, the move's own `alwaysCrit` flag, Flail/Reversal-style moves
   * at <=50% HP, or Showdown Mode. Callers combine these -- they're mutually additive
   * preconditions, not a single C field. */
  isGuaranteed: boolean
  /** onCrit ability hooks, pre-summed (accumulated stage bonus); an ability
   * returning NEVER_CRIT should be represented as isBlocked=true instead, matching
   * the C's early return on that specific case (:1535). Defaults to 0 until the
   * ability registry is wired. */
  abilityCritBonus: number
  hasHighCritFlag: boolean // FLAG_HIGH_CRIT on the move
  hasScopeLens: boolean
  /** Lucky Punch on the Chansey/Blissey/Happiny line -- worth +2 stages (:1550-1554). */
  hasLuckyPunchOnChanseyLine: boolean
  /** Leek on the Farfetch'd/Sirfetch'd line (BENEFITS_FROM_LEEK, :1521-1523). */
  hasLeekOnFarfetchdLine: boolean
  isViseGrip: boolean // move === MOVE_VISE_GRIP
}

/** CalcCritChanceStage, src/battle_script_commands.c:1523-1558. Returns NEVER_CRIT,
 * ALWAYS_CRIT, or a stage 0..ALWAYS_CRIT-1 to index criticalHitChance with. */
export function calcCritStage(inputs: CritStageInputs): number {
  if (inputs.isBlocked) return NEVER_CRIT
  if (inputs.isGuaranteed) return ALWAYS_CRIT

  let critChance = inputs.abilityCritBonus
  critChance += inputs.hasHighCritFlag ? 1 : 0
  critChance += inputs.hasScopeLens ? 1 : 0
  critChance += inputs.hasLuckyPunchOnChanseyLine ? 2 : 0
  critChance += inputs.hasLeekOnFarfetchdLine ? 1 : 0
  critChance += inputs.isViseGrip ? 1 : 0

  return Math.min(critChance, ALWAYS_CRIT)
}

/** GetInverseCritChance + SetCritFlag's non-random parts (:1563-1596): the
 * denominator for a "1 in N" crit roll, or null if a crit can never happen at this
 * stage. Stages >= ALWAYS_CRIT collapse to the ALWAYS_CRIT entry (min(stage, ALWAYS_CRIT)
 * indexing, :1569), so a stage that's already been clamped in calcCritStage is safe
 * to pass straight through here too. */
export function critChanceDenominator(stage: number, criticalHitChance: number[]): number | null {
  if (stage <= NEVER_CRIT) return null
  const index = Math.min(stage, ALWAYS_CRIT)
  return criticalHitChance[index]
}

/** SetCritFlag's roll, src/battle_script_commands.c:1592-1596, with the 0..23
 * MakeCritRoll() value passed in explicitly (this engine evaluates all crit outcomes
 * rather than drawing one random roll -- see calculate.ts). */
export function isCriticalHit(critRoll: number, denominator: number | null): boolean {
  if (denominator === null || denominator <= 0) return false
  return critRoll % denominator === 0
}
