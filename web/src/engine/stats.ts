// Stat calculation, ported from eliteredux-source's src/pokemon.c (out-of-battle
// stats and natures) and src/battle_util.c's CalculateStat (in-battle modifiers).

import { idiv } from './fixed'
import type { BaseStats, BattleStatKey, NatureStatTable } from './types'

const NATURE_STAT_NAME: Record<BattleStatKey, 'ATK' | 'DEF' | 'SPEED' | 'SPATK' | 'SPDEF'> = {
  atk: 'ATK',
  def: 'DEF',
  spatk: 'SPATK',
  spdef: 'SPDEF',
  spe: 'SPEED',
}

/**
 * Standard nature stat modifiers table, matching src/pokemon.c:3491 (gNatureStatTable)
 * and natures.json.
 */
export const DEFAULT_NATURE_STAT_TABLE: NatureStatTable = {
  NATURE_HARDY: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_LONELY: { ATK: 1, DEF: -1, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_BRAVE: { ATK: 1, DEF: 0, SPEED: -1, SPATK: 0, SPDEF: 0 },
  NATURE_ADAMANT: { ATK: 1, DEF: 0, SPEED: 0, SPATK: -1, SPDEF: 0 },
  NATURE_NAUGHTY: { ATK: 1, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: -1 },
  NATURE_BOLD: { ATK: -1, DEF: 1, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_DOCILE: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_RELAXED: { ATK: 0, DEF: 1, SPEED: -1, SPATK: 0, SPDEF: 0 },
  NATURE_IMPISH: { ATK: 0, DEF: 1, SPEED: 0, SPATK: -1, SPDEF: 0 },
  NATURE_LAX: { ATK: 0, DEF: 1, SPEED: 0, SPATK: 0, SPDEF: -1 },
  NATURE_TIMID: { ATK: -1, DEF: 0, SPEED: 1, SPATK: 0, SPDEF: 0 },
  NATURE_HASTY: { ATK: 0, DEF: -1, SPEED: 1, SPATK: 0, SPDEF: 0 },
  NATURE_SERIOUS: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_JOLLY: { ATK: 0, DEF: 0, SPEED: 1, SPATK: -1, SPDEF: 0 },
  NATURE_NAIVE: { ATK: 0, DEF: 0, SPEED: 1, SPATK: 0, SPDEF: -1 },
  NATURE_MODEST: { ATK: -1, DEF: 0, SPEED: 0, SPATK: 1, SPDEF: 0 },
  NATURE_MILD: { ATK: 0, DEF: -1, SPEED: 0, SPATK: 1, SPDEF: 0 },
  NATURE_QUIET: { ATK: 0, DEF: 0, SPEED: -1, SPATK: 1, SPDEF: 0 },
  NATURE_BASHFUL: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 0 },
  NATURE_RASH: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 1, SPDEF: -1 },
  NATURE_CALM: { ATK: -1, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 1 },
  NATURE_GENTLE: { ATK: 0, DEF: -1, SPEED: 0, SPATK: 0, SPDEF: 1 },
  NATURE_SASSY: { ATK: 0, DEF: 0, SPEED: -1, SPATK: 0, SPDEF: 1 },
  NATURE_CAREFUL: { ATK: 0, DEF: 0, SPEED: 0, SPATK: -1, SPDEF: 1 },
  NATURE_QUIRKY: { ATK: 0, DEF: 0, SPEED: 0, SPATK: 0, SPDEF: 0 },
}

/**
 * ModifyStatByNature's delta lookup (src/pokemon.c:3491, gNatureStatTable[nature][stat]),
 * as -1/0/+1 rather than the 0.9/1.0/1.1 it implies -- calcStat below needs the raw
 * delta to do the `n*110/100` integer arithmetic itself rather than a float multiply.
 */
export function natureDelta(natureId: string, stat: BattleStatKey, natureTable: NatureStatTable): -1 | 0 | 1 {
  return natureTable[natureId]?.[NATURE_STAT_NAME[stat]] ?? 0
}

/**
 * CALC_STAT macro + ModifyStatByNature, src/pokemon.c:955-960, 3485-3506. Atk/Def/
 * SpAtk/SpDef/Speed only -- see calcHp for HP, which has its own formula and no
 * nature modifier.
 *
 *   n = floor((2*base + iv + floor(ev/4)) * level / 100) + 5
 *   nature +1 -> floor(n*110/100); nature -1 -> floor(n*90/100); else n
 */
export function calcStat(
  base: number,
  iv: number,
  ev: number,
  level: number,
  natureId: string,
  stat: BattleStatKey,
  natureTable: NatureStatTable,
): number {
  const n = idiv((2 * base + iv + idiv(ev, 4)) * level, 100) + 5
  const delta = natureDelta(natureId, stat, natureTable)
  if (delta === 1) return idiv(n * 110, 100)
  if (delta === -1) return idiv(n * 90, 100)
  return n
}

/**
 * Calculates out-of-battle rawStats (Atk, Def, SpAtk, SpDef, Spe) for a Pokemon.
 * Follows CalculateMonStatsMaster (src/pokemon.c:988-1025) and driver/buildParty.ts:
 *   - IVs: 31 on all stats, except Speed = 0 when speedDown (ironPill) is true.
 *   - EVs: 0 (disabled or default 0).
 */
export function calculateRawStats(
  baseStats: BaseStats,
  level: number,
  nature: string,
  speedDown: boolean,
  natureTable: NatureStatTable = DEFAULT_NATURE_STAT_TABLE,
): Record<BattleStatKey, number> {
  const iv = (stat: BattleStatKey): number => (stat === 'spe' && speedDown ? 0 : 31)
  return {
    atk: calcStat(baseStats.atk, iv('atk'), 0, level, nature, 'atk', natureTable),
    def: calcStat(baseStats.def, iv('def'), 0, level, nature, 'def', natureTable),
    spatk: calcStat(baseStats.spatk, iv('spatk'), 0, level, nature, 'spatk', natureTable),
    spdef: calcStat(baseStats.spdef, iv('spdef'), 0, level, nature, 'spdef', natureTable),
    spe: calcStat(baseStats.spe, iv('spe'), 0, level, nature, 'spe', natureTable),
  }
}

/**
 * HP formula, src/pokemon.c:1003-1008. Shedinja and Shedinja-Mega always have exactly
 * 1 max HP regardless of base stat, IV, EV or level (`species == SPECIES_SHEDINJA ||
 * ... SHEDINJA_MEGA`) -- callers pass `isShedinja` rather than this module knowing
 * about specific species ids.
 */
export function calcHp(baseHp: number, iv: number, ev: number, level: number, isShedinja: boolean): number {
  if (isShedinja) return 1
  const n = 2 * baseHp + iv
  return idiv((n + idiv(ev, 4)) * level, 100) + level + 10
}

/**
 * gStatStageRatios application, src/pokemon.c:172-186 & src/battle_util.c's
 * CalculateStat (~:7231): two separate integer operations in the C
 * (`statBase *= ratio[0]; statBase /= ratio[1];`), not one combined fraction -- the
 * multiply happens in full before the single truncating divide.
 */
export function applyStatStage(value: number, stage: number, statStageRatios: [number, number][]): number {
  const [numerator, denominator] = statStageRatios[stage]
  return idiv(value * numerator, denominator)
}

/**
 * ER's "extra stat levels" (src/battle_util.c, CalculateStat's tail:
 * `statBase = statBase + ((statBase / 5) * extraStatLevel)`), applied after the
 * ordinary stat-stage ratio -- +20% of the post-stage value per level, distinct from
 * ordinary stat stages and not clamped to +-6.
 */
export function applyExtraStatLevels(value: number, extraStatLevel: number): number {
  return value + idiv(value, 5) * extraStatLevel
}

/**
 * Burn halves Attack (src/battle_util.c:7158) and frostbite halves Sp. Attack
 * (:7169-7172) -- BEFORE stat stages are applied, unlike vanilla Pokemon's
 * damage-stage burn penalty. `EFFECT_FACADE` and ER's `negatesBurnAtkDrop` abilities
 * are exemptions the caller (battleStat.ts, once written) is responsible for, not
 * this primitive.
 */
export function applyStatusHalving(value: number): number {
  return idiv(value, 2)
}
