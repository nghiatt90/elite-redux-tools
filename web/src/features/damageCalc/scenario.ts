// Converts UI-level battler configuration into the engine's BattlerBattleState/
// MoveData/DamageCalcScenario shapes (web/src/engine/types.ts, engine/calculate.ts).

import { calcHp, calcStat } from '../../engine/stats'
import { calculateBattleStat } from '../../engine/battleStat'
import type { BattlerBattleState, FieldBattleState, StatKey } from '../../engine/types'
import type { DamageCalcScenario, MoveData } from '../../engine/calculate'
import type { MoveBehaviors } from '../../engine/basePower'
import type { BattleConstants, Item, Move, MoveBehaviorsFile, Species } from '../../lib/types'
import type { TypeChart } from '../../engine/typeEffectiveness'

export const STATUS_OPTIONS = [
  { id: null, label: 'Healthy' },
  { id: 'STATUS1_BURN', label: 'Burned' },
  { id: 'STATUS1_PARALYSIS', label: 'Paralyzed' },
  { id: 'STATUS1_POISON', label: 'Poisoned' },
  { id: 'STATUS1_TOXIC_POISON', label: 'Badly Poisoned' },
  { id: 'STATUS1_FROSTBITE', label: 'Frostbite' },
  { id: 'STATUS1_BLEED', label: 'Bleeding' },
  { id: 'STATUS1_SLEEP', label: 'Asleep' },
  { id: 'STATUS1_FREEZE', label: 'Frozen' },
] as const

/** Only meaningful as the DEFENDER -- see BattlerBattleState.semiInvulnerable's doc
 * on why this is a scenario toggle (Dig/Dive/Fly-style states this calculator has
 * no turn simulation to derive). */
export const SEMI_INVULNERABLE_OPTIONS = [
  { id: 'NONE', label: 'Normal' },
  { id: 'UNDERGROUND', label: 'Underground (Dig)' },
  { id: 'UNDERWATER', label: 'Underwater (Dive)' },
  { id: 'AIRBORNE', label: 'Airborne (Fly/Bounce)' },
] as const

export const WEATHER_OPTIONS = [
  { id: 'NONE', label: 'None' },
  { id: 'SUN_PERMANENT', label: 'Sun (weak, e.g. Drought)' },
  { id: 'SUN_TEMPORARY', label: 'Sun (strong, e.g. Sunny Day)' },
  { id: 'SUN_PRIMAL', label: 'Sun (Primal Groudon)' },
  { id: 'RAIN_PERMANENT', label: 'Rain (weak, e.g. Drizzle)' },
  { id: 'RAIN_TEMPORARY', label: 'Rain (strong, e.g. Rain Dance)' },
  { id: 'RAIN_PRIMAL', label: 'Rain (Primal Kyogre)' },
  { id: 'SANDSTORM', label: 'Sandstorm' },
  { id: 'HAIL', label: 'Hail' },
  { id: 'FOG', label: 'Fog' },
  { id: 'STRONG_WINDS', label: 'Strong Winds' },
] as const

export const TERRAIN_OPTIONS = [
  { id: null, label: 'None' },
  { id: 'TERRAIN_ELECTRIC', label: 'Electric' },
  { id: 'TERRAIN_PSYCHIC', label: 'Psychic' },
  { id: 'TERRAIN_GRASSY', label: 'Grassy' },
  { id: 'TERRAIN_MISTY', label: 'Misty' },
  { id: 'TERRAIN_TOXIC', label: 'Toxic' },
] as const

export interface BattlerConfig {
  speciesId: string
  level: number
  nature: string
  evs: Record<StatKey, number>
  ivs: Record<StatKey, number>
  abilityIndex: number // index into species.abilities, or -1 for "none selected"
  itemId: string | null
  statStages: { atk: number; def: number; spatk: number; spdef: number; spe: number } // -6..+6
  status: string | null // one of STATUS_OPTIONS' ids
  hpPercent: number // 1-100, current HP as a percent of max
  moveIds: (string | null)[] // 4 slots
  /** Dig/Dive/Fly-style semi-invulnerability -- only meaningful as the DEFENDER (see
   * BattlerBattleState.semiInvulnerable's doc); harmless to set on the attacker. */
  semiInvulnerable: 'NONE' | 'UNDERGROUND' | 'UNDERWATER' | 'AIRBORNE'
  /** See BattlerBattleState.abilityOn's doc -- a generic in-battle ability
   * activation toggle (Flash Fire triggered, Unburden's item lost, etc.),
   * meaningful on either side depending on the specific ability. */
  abilityOn: boolean
}

export function defaultEvs(): Record<StatKey, number> {
  return { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 }
}
export function defaultIvs(): Record<StatKey, number> {
  // ER forces IVs to 31 on every stat recalculation (src/pokemon.c:970-1044) --
  // this is the honest default, not just a convenient one.
  return { hp: 31, atk: 31, def: 31, spatk: 31, spdef: 31, spe: 31 }
}

export function defaultBattlerConfig(speciesId: string): BattlerConfig {
  return {
    speciesId,
    level: 100,
    nature: 'NATURE_HARDY',
    evs: defaultEvs(),
    ivs: defaultIvs(),
    abilityIndex: 0,
    itemId: null,
    statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    status: null,
    hpPercent: 100,
    moveIds: [null, null, null, null],
    semiInvulnerable: 'NONE',
    abilityOn: false,
  }
}

function bareType(t: string): string {
  return t.replace('TYPE_', '')
}

export interface BuildContext {
  speciesById: Map<string, Species>
  itemsById: Map<string, Item>
  natures: BattleConstants
}

/** Builds a BattlerBattleState from UI config. `speed` is computed through the real
 * CalculateStat pipeline (so Electro Ball/Gyro Ball/Heat Crash read a genuinely
 * post-stage speed) but WITHOUT paralysis's speed-halving or any ability's onStat
 * contribution -- both are known v1 simplifications (paralysis has no UI toggle of
 * its own consequence beyond the status1 flag; onStat needs the opponent's ability
 * slots, which aren't available at battler-build time, before both battlers exist).
 */
export function buildBattlerState(config: BattlerConfig, ctx: BuildContext): BattlerBattleState {
  const species = ctx.speciesById.get(config.speciesId)
  if (!species) throw new Error(`unknown species ${config.speciesId}`)
  const item = config.itemId ? ctx.itemsById.get(config.itemId) : undefined
  const isShedinja = species.id === 'SPECIES_SHEDINJA' || species.id === 'SPECIES_SHEDINJA_MEGA'

  const rawStats: Record<StatKey, number> = {
    hp: calcHp(species.baseStats.hp, config.ivs.hp, config.evs.hp, config.level, isShedinja),
    atk: calcStat(species.baseStats.atk, config.ivs.atk, config.evs.atk, config.level, config.nature, 'atk', ctx.natures.natureStatTable),
    def: calcStat(species.baseStats.def, config.ivs.def, config.evs.def, config.level, config.nature, 'def', ctx.natures.natureStatTable),
    spatk: calcStat(species.baseStats.spatk, config.ivs.spatk, config.evs.spatk, config.level, config.nature, 'spatk', ctx.natures.natureStatTable),
    spdef: calcStat(species.baseStats.spdef, config.ivs.spdef, config.evs.spdef, config.level, config.nature, 'spdef', ctx.natures.natureStatTable),
    spe: calcStat(species.baseStats.spe, config.ivs.spe, config.evs.spe, config.level, config.nature, 'spe', ctx.natures.natureStatTable),
  }

  const speedStage = Math.max(0, Math.min(12, config.statStages.spe + 6))
  const speed = calculateBattleStat({
    rawStat: rawStats.spe,
    extraStatLevel: 0,
    statStage: speedStage,
    isUnaware: false,
    isWonderRoomActive: false,
    isOffensiveStatForWonderRoom: false,
    isCrit: false,
    isAttackRole: true,
    benefitsFromStatBuffs: config.status !== 'STATUS1_BLEED',
    preModify: (s) => s,
    applyOnStatHooks: (s) => s,
    secondaryStatPercent: 0,
    statStageRatios: ctx.natures.statStageRatios,
  })

  const maxHp = rawStats.hp
  const hp = Math.max(1, Math.round((maxHp * config.hpPercent) / 100))
  const status1 = new Set<string>(config.status ? [config.status] : [])

  const baseSpeciesId = species.isForm && species.formOf ? species.formOf : species.id

  return {
    condition: {
      speciesId: species.id,
      baseSpeciesId,
      heads: species.heads ?? 1,
      itemId: config.itemId,
      resolvedHoldEffect: item?.resolvedHoldEffect ?? null,
      itemNegated: false,
      status1,
      hasComatose: false,
      hasBloodStainEffect: false,
      isInfatuated: false,
      wasDamagedThisTurnBy: 'none',
      recentlyFainted: false,
      hp,
      maxHp,
      weight: species.weight,
      speed,
      positiveStatStageCount: Object.values(config.statStages).filter((s) => s > 0).length,
      negativeStatStageCount: Object.values(config.statStages).filter((s) => s < 0).length,
      usedMovePpRemaining: null,
      helpingHand: false,
      ghastlyEcho: false,
      chargedUp: false,
      meFirst: false,
      fear: false,
      safePassage: false,
      itemResolvedHoldEffectStrength: item?.holdEffectStrength ?? null,
      lastMoveFailed: false,
    },
    types: species.types.map(bareType),
    isGrounded: !species.types.includes('TYPE_FLYING'), // species-only baseline; calculate.ts reduces this further via the Levitate ability flag (see BattlerBattleState.isGrounded's doc)
    semiInvulnerable: config.semiInvulnerable,
    abilityOn: config.abilityOn,
    level: config.level,
    nature: config.nature,
    rawStats,
    statStages: config.statStages,
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: item?.holdEffectStrength ?? null,
    holdEffectType: item?.holdEffectType ?? null,
    isTransformed: false,
    canEvolveStrict: species.evolutions.length > 0,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    abilitySlots: {
      ability: config.abilityIndex >= 0 ? (species.abilities[config.abilityIndex] ?? null) : null,
      innates: [species.innates[0] ?? null, species.innates[1] ?? null, species.innates[2] ?? null],
    },
  }
}

export function toMoveData(move: Move): MoveData {
  return {
    id: move.id,
    power: move.power,
    type: move.type ? bareType(move.type) : null,
    type2: move.type2 ? bareType(move.type2) : null,
    split: move.split,
    splitFlag: move.splitFlag,
    effect: move.effect,
    customBehavior: move.customBehavior,
    crit: move.crit,
    hitsAir: move.hitsAir,
    flags: move.flags,
    priority: move.priority,
  }
}

export interface FieldConfig {
  weather: FieldBattleState['weather']
  terrain: string | null
  gravity: boolean
  attackerSide: { reflect: boolean; lightScreen: boolean; auroraVeil: boolean; luckyChant: boolean }
  defenderSide: { reflect: boolean; lightScreen: boolean; auroraVeil: boolean; luckyChant: boolean }
}

export function defaultFieldConfig(): FieldConfig {
  return {
    weather: 'NONE',
    terrain: null,
    gravity: false,
    attackerSide: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
    defenderSide: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
  }
}

export function buildScenario(
  attackerConfig: BattlerConfig,
  defenderConfig: BattlerConfig,
  moveId: string,
  field: FieldConfig,
  ctx: BuildContext & { movesById: Map<string, Move>; typeChart: TypeChart; moveBehaviors: MoveBehaviorsFile },
): DamageCalcScenario {
  const move = ctx.movesById.get(moveId)
  if (!move) throw new Error(`unknown move ${moveId}`)

  return {
    move: toMoveData(move),
    attacker: buildBattlerState(attackerConfig, ctx),
    defender: buildBattlerState(defenderConfig, ctx),
    field: {
      gravityActive: field.gravity,
      terrain: field.terrain,
      weather: field.weather,
      sides: { attacker: field.attackerSide, defender: field.defenderSide },
      isDoubleBattle: false,
    },
    typeChart: ctx.typeChart,
    // lib/types.ts's MoveBehaviorsFile deliberately types `behaviors` loosely
    // (Record<string, unknown>) since the engine owns the precise shape (see
    // basePower.ts's MoveBehaviors) -- this is the one place that hands the fetched
    // JSON off to it.
    moveBehaviors: ctx.moveBehaviors.behaviors as unknown as MoveBehaviors,
    battleConstants: ctx.natures,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
  }
}
