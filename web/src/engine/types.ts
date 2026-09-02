// Shared engine types. `erasableSyntaxOnly` (tsconfig.app.json) bans TS `enum` --
// every enum-like value here is a `const` array/object plus a derived union type.

export const STAT_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe'] as const
export type StatKey = (typeof STAT_KEYS)[number]

/** The five stats a nature, stat stage, or battle modifier can touch -- everything
 * except HP, which is fixed once calculated and never boosted/lowered in battle. */
export const BATTLE_STAT_KEYS = ['atk', 'def', 'spatk', 'spdef', 'spe'] as const
export type BattleStatKey = (typeof BATTLE_STAT_KEYS)[number]

export interface BaseStats {
  hp: number
  atk: number
  def: number
  spatk: number
  spdef: number
  spe: number
}

/** EVs or IVs -- one number per stat, HP included (unlike BattleStatKey). */
export type StatSpread = Record<StatKey, number>

/** src/pokemon.c's gNatureStatTable key order: ATK, DEF, SPEED, SPATK, SPDEF (no HP,
 * no accuracy/evasion -- ModifyStatByNature explicitly excludes those). Mirrors
 * natures.json's own key names exactly, which is why this isn't just BattleStatKey
 * spelled differently: "SPEED" here, "spe" there. */
export type NatureStatName = 'ATK' | 'DEF' | 'SPEED' | 'SPATK' | 'SPDEF'

/** natures.json's natureStatTable shape: {"NATURE_ADAMANT": {ATK: 1, ..., SPDEF: 0}, ...} */
export type NatureStatTable = Record<string, Record<NatureStatName, -1 | 0 | 1>>

/** natures.json's full shape, as emitted by erdata.natures.battle_constants_to_dict(). */
export interface BattleConstants {
  natureStatTable: NatureStatTable
  statStageRatios: [number, number][] // index 0..12, stage -6..+6
  criticalHitChance: number[] // index 0..4, {24, 8, 2, 1, 1} in ER (GEN_7)
  maxIvs: number
  maxEvPerStat: number
  maxEvTotal: number
  maxLevel: number
  defaultStatStage: number
  uq412Precision: number
}
