// Stat calculation, ported from eliteredux-source's src/pokemon.c (out-of-battle
// stats and natures) and src/battle_util.c's CalculateStat (in-battle modifiers).

import { idiv } from './fixed'
import type { BattleStatKey, NatureStatTable } from './types'

const NATURE_STAT_NAME: Record<BattleStatKey, 'ATK' | 'DEF' | 'SPEED' | 'SPATK' | 'SPDEF'> = {
  atk: 'ATK',
  def: 'DEF',
  spatk: 'SPATK',
  spdef: 'SPDEF',
  spe: 'SPEED',
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
