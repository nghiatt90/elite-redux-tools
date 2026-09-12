// Section B of the battle-sim plan (~/.claude/plans/we-already-have-a-parsed-nova.md)
// -- a turn-one descriptive report for one player Pokemon against a real trainer's
// party. Not a build recommender: the plan's own review found that predicate
// ill-posed (the AI recomputes its move choice from your live stats every turn, so
// "invest until you survive its best move" has no fixed point). What DOES survive is
// thresholding against the opponent's WHOLE moveset -- an upper bound over its entire
// action set that re-selection can't escape -- so that's what this reports: speed,
// a two-way damage matrix, and (the actual point of the exercise) two ways of stating
// how much damage the player takes, because they measure different things. See
// docs/battle-sim/er-descriptive-report-viability.md for the full derivation.
//
// Headless and React-free by design (matches lib/randomizer.ts) -- the player's own
// BattlerBattleState/MoveData are built by the caller (features/damageCalc/scenario.ts
// already does this for the damage calculator; the matchup-report UI reuses it), so
// this module only has to build the ENEMY side, whose shape (TrainerMon) is fixed
// data, not a UI config with defaults to invent.

import { calculateMoveDamage } from '../engine/calculate'
import type { BattlerBattleState, FieldBattleState } from '../engine/types'
import type { MoveData } from '../engine/calculate'
import type { MoveBehaviors } from '../engine/basePower'
import { calcHp, calcStat } from '../engine/stats'
import { calculateBattleStat, DEFAULT_STAT_STAGE } from '../engine/battleStat'
import { idiv } from '../engine/fixed'
import type { TypeChart } from '../engine/typeEffectiveness'
import { bareType, toMoveData } from './moveData'
import type { BattleConstants, Item, Move, Species, Trainer, TrainerMon } from './types'

/**
 * Turn-one caveats this report deliberately does not model -- printed on the page
 * itself (features/matchupReport's own React layer), not buried in a code comment,
 * per the plan's own instruction. Kept as one shared list so the pure layer and the
 * UI can never state the scope differently from each other.
 */
export const MATCHUP_REPORT_CAVEATS: string[] = [
  'Turn-one state only: no stat stages, status conditions, hazards, screens, or weather/terrain set mid-battle.',
  'No Mega Evolution and no on-switch-in ("entry") abilities.',
  'No residual (end-of-turn) damage -- Leftovers, poison, sandstorm, etc.',
  'No accuracy -- every move is assumed to hit.',
  "No move priority beyond what's shown per move -- turn order for a specific move pair isn't resolved, only each side's raw Speed stat.",
  'ActsAfter-style moves (Payback, Bolt Beak, Assurance) are evaluated as if the user moves first, matching this calculator’s existing default.',
  "The enemy level shown assumes HELL_MODE_EXTRA_LEVELS_FLAG is unset -- Hell-tier fights under that flag add a further per-trainer level bonus this report doesn't add (battle_main.c:1819-1827).",
  "Assumes the save's enableEvs setting is on. If it's off, neither side has EVs and the enemy's real stats are lower than shown (src/pokemon.c:996-997).",
]

export type TrainerTier = 'ace' | 'elite' | 'hell'

export interface MatchupContext {
  speciesById: Map<string, Species>
  itemsById: Map<string, Item>
  movesById: Map<string, Move>
  natures: BattleConstants
  typeChart: TypeChart
  inverseTypeChart: TypeChart
  moveBehaviors: MoveBehaviors
}

/** A turn-one, no-weather/terrain/hazard/screen field -- the neutral default this
 * report always starts from (see MATCHUP_REPORT_CAVEATS). Exported so the optional
 * per-battle-field-effect follow-up (encounters.json's fieldEffect, not built here)
 * has a documented starting point to override rather than reconstructing one. */
export function neutralField(): FieldBattleState {
  return {
    gravityActive: false,
    terrain: null,
    weather: 'NONE',
    sides: {
      attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
      defender: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
    },
    isDoubleBattle: false,
    isInverseRoomActive: false,
    isInverseBattleFlagSet: false,
    isWonderRoomActive: false,
  }
}

/**
 * Builds one trainer mon's BattlerBattleState for turn one: healthy, unboosted, no
 * volatile status, no switch-in ability triggered yet. Unlike
 * features/damageCalc/scenario.ts's buildBattlerState (a UI form with a config
 * object for every one of those), a TrainerMon has no such fields to read them
 * from -- CLAUDE.md's "IVs are not a variable" applies to BOTH sides, so there is
 * nothing to configure here, only to derive.
 *
 * `level` is the CALLER's responsibility (battle_main.c:1819-1827: the player's
 * highest party level, not anything stored per trainer -- see resolveEnemyLevel).
 */
export function buildEnemyBattlerState(mon: TrainerMon, level: number, ctx: MatchupContext): BattlerBattleState {
  const species = ctx.speciesById.get(mon.species)
  if (!species) throw new Error(`unknown species ${mon.species}`)
  const item = mon.item ? ctx.itemsById.get(mon.item) : undefined
  const isShedinja = species.id === 'SPECIES_SHEDINJA' || species.id === 'SPECIES_SHEDINJA_MEGA'

  // Every IV is forced to 31 on recalculation, for both sides, EXCEPT the
  // speedDown "iron pill" flag, which zeroes Speed's IV alone
  // (src/pokemon.c:988-994, cited in CLAUDE.md).
  const iv = (stat: 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'spe') => (stat === 'spe' && mon.ironPill ? 0 : 31)

  const rawStats = {
    hp: calcHp(species.baseStats.hp, iv('hp'), mon.evs.hp, level, isShedinja),
    atk: calcStat(species.baseStats.atk, iv('atk'), mon.evs.atk, level, mon.nature, 'atk', ctx.natures.natureStatTable),
    def: calcStat(species.baseStats.def, iv('def'), mon.evs.def, level, mon.nature, 'def', ctx.natures.natureStatTable),
    spatk: calcStat(species.baseStats.spatk, iv('spatk'), mon.evs.spatk, level, mon.nature, 'spatk', ctx.natures.natureStatTable),
    spdef: calcStat(species.baseStats.spdef, iv('spdef'), mon.evs.spdef, level, mon.nature, 'spdef', ctx.natures.natureStatTable),
    spe: calcStat(species.baseStats.spe, iv('spe'), mon.evs.spe, level, mon.nature, 'spe', ctx.natures.natureStatTable),
  }

  // Neutral (stage 0) speed -- CalculateStat with no ability/Wonder-Room/crit
  // context, matching scenario.ts's own buildBattlerState treatment of speed.
  const speed = calculateBattleStat({
    rawStat: rawStats.spe,
    extraStatLevel: 0,
    statStage: DEFAULT_STAT_STAGE,
    isUnaware: false,
    isWonderRoomActive: false,
    isOffensiveStatForWonderRoom: false,
    isCrit: false,
    isAttackRole: true,
    benefitsFromStatBuffs: true,
    preModify: (s) => s,
    applyOnStatHooks: (s) => s,
    secondaryStatPercent: 0,
    statStageRatios: ctx.natures.statStageRatios,
  })

  const maxHp = rawStats.hp
  const baseSpeciesId = species.isForm && species.formOf ? species.formOf : species.id

  return {
    condition: {
      speciesId: species.id,
      baseSpeciesId,
      heads: species.heads ?? 1,
      isMegaEvolved: false, // no Mega Evolution turn one -- MATCHUP_REPORT_CAVEATS
      itemId: mon.item,
      resolvedHoldEffect: item?.resolvedHoldEffect ?? null,
      itemNegated: false,
      status1: new Set(),
      hasComatose: false,
      hasBloodStainEffect: false,
      isInfatuated: false,
      isConfused: false,
      isEnraged: false,
      wasDamagedThisTurnBy: 'none',
      recentlyFainted: false,
      hp: maxHp,
      maxHp,
      weight: species.weight,
      speed,
      positiveStatStageCount: 0,
      negativeStatStageCount: 0,
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
    isGrounded: !species.types.includes('TYPE_FLYING'),
    semiInvulnerable: 'NONE',
    abilityOn: false, // no ability activated yet turn one (Flash Fire triggered, etc.)
    // Not derivable without a personality value (see BattlerBattleState.gender's own
    // doc) -- defaulted the same way scenario.ts's BattlerConfig does, overridden for
    // a genuinely genderless species. Only Rivalry reads this.
    gender: species.gender.genderless ? 'GENDERLESS' : 'MALE',
    boostedStat: null,
    alliesFainted: 0,
    slowStartTimer: 5, // not yet expired -- Slow Start/Lethargy inactive turn one
    level,
    nature: mon.nature,
    rawStats,
    statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: item?.holdEffectStrength ?? null,
    holdEffectType: item?.holdEffectType ? bareType(item.holdEffectType) : null,
    naturalGift: item?.naturalGift ? { power: item.naturalGift.power, type: bareType(item.naturalGift.type) } : null,
    hiddenPowerType: bareType(mon.hiddenPowerType),
    isTransformed: false,
    canEvolveStrict: species.evolutions.length > 0,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    hasMiracleEye: false,
    // GAME TRUTH ability (lib/types.ts's TrainerMon.ability doc) plus the species'
    // three innates, which apply ON TOP OF the slot ability, never instead of it.
    abilitySlots: {
      ability: mon.ability,
      innates: [species.innates[0] ?? null, species.innates[1] ?? null, species.innates[2] ?? null],
    },
  }
}

/** battle_main.c:1819-1827: GetHighestLevelInPlayerParty() + partyData[i].lvl (always
 * 0 -- the codegen emits no .lvl field) + extraLevels (0 unless
 * HELL_MODE_EXTRA_LEVELS_FLAG, not modelled here -- see MATCHUP_REPORT_CAVEATS). So
 * the enemy level is just the player's own highest party level, unchanged; this
 * function exists so every call site says WHY rather than assigning the number
 * directly. */
export function resolveEnemyLevel(playerHighestLevel: number): number {
  return playerHighestLevel
}

export function movesForMon(mon: TrainerMon, movesById: Map<string, Move>): MoveData[] {
  return mon.moves.filter((id) => id && id !== 'MOVE_NONE').map((id) => {
    const move = movesById.get(id)
    if (!move) throw new Error(`unknown move ${id}`)
    return toMoveData(move)
  })
}

export interface SpeedEntry {
  label: string // 'You' for the player row, the species id for an enemy row
  speed: number
}

/** Printed alongside the speed-tier table itself (MatchupReport.speedTierNote), not
 * just folded into the general MATCHUP_REPORT_CAVEATS list -- a reader glancing at an
 * ordering titled "who moves first" will otherwise assume it's the final answer.
 * Each move's own `priority` field (MatchupMoveEntry.priority) is the correction, and
 * it only works if the table tells the reader to go look for it. */
export const SPEED_TIER_CAVEAT = 'Ordered by raw Speed stat only -- ignores move priority. Check each move’s own priority in the damage tables below: a lower-Speed mon using a priority move still acts first.'

/** "Exact speed tiers": every battler's real, post-nature/EV/IV/level Speed stat
 * (neutral stage, per MATCHUP_REPORT_CAVEATS), sorted fastest-first. Real ties are
 * kept adjacent and flagged by the caller via matching `speed` values -- the ROM
 * breaks a real Speed tie with Random() (battle_main.c), not something a static
 * report can resolve, so this deliberately doesn't guess a winner. Priority is
 * DELIBERATELY not folded in here -- see SPEED_TIER_CAVEAT's own doc for why this is
 * a separate, narrower fact than "who actually moves first for a given move pair". */
export function speedTiers(player: BattlerBattleState, enemies: { speciesId: string; battler: BattlerBattleState }[]): SpeedEntry[] {
  const entries: SpeedEntry[] = [
    { label: 'You', speed: player.condition.speed },
    ...enemies.map((e) => ({ label: e.speciesId, speed: e.battler.condition.speed })),
  ]
  return entries.sort((a, b) => b.speed - a.speed)
}

export interface MatchupMoveEntry {
  moveId: string
  priority: number
  /** `null` in three DISTINCT cases, all meaning "this engine has no real number to
   * show", not "the ROM does 0 damage":
   * 1. Declared power is 0 (every STATUS move) -- AI_CalcDamage's own gate,
   *    `if (gBattleMoves[move].power)` (battle_ai_util.c:665).
   * 2. The move's effect is one of AI_CalcDamage's own dynamic-damage special cases
   *    (EFFECT_SUPER_FANG/_HAZE, EFFECT_LEVEL_DAMAGE, EFFECT_PSYWAVE,
   *    EFFECT_DRAGON_RAGE, EFFECT_ENDEAVOR, EFFECT_FINAL_GAMBIT --
   *    battle_ai_util.c:684-703) -- this engine has no port of any of them (see
   *    calculate.ts). Checked SEPARATELY from the power gate above: in THIS
   *    redesigned ER data, four of these (Super Fang, Endeavor, Final Gambit,
   *    Night Shade's EFFECT_LEVEL_DAMAGE, Natures Madness/Ruination's
   *    EFFECT_SUPER_FANG_HAZE) declare power 1, not 0 -- re-measured directly
   *    against moves.json, not assumed from vanilla Pokemon's own power-0
   *    convention for these move IDs. A power-only gate would silently run them
   *    through the ordinary base-power formula with power=1 and print a small,
   *    wrong number instead of admitting the gap. (EFFECT_PSYWAVE and
   *    EFFECT_DRAGON_RAGE currently have no move using them at all in this data --
   *    both moves were redesigned into ordinary power-based moves with different
   *    effects -- kept in the gate anyway for fidelity to the C, in case that
   *    changes on a future repin.) For case 2, `aiEstimatedDamage` is ALSO null --
   *    AI_CalcDamage computes the same real special-case value for its own belief,
   *    which this engine doesn't have either.
   * 3. isTrueDamageUnavailable(move) -- see its own doc (Counter/Mirror Coat/Bide/
   *    Seismic Toss): declares power 1 like case 2, but AI_CalcDamage does NOT
   *    special-case these, so unlike case 2 `aiEstimatedDamage` is STILL populated
   *    here, computed the same ordinary way as any other move -- that genuinely is
   *    the AI's own (mistaken) belief, not a gap in this engine. */
  maxRollDamage: number | null
  maxRollPercent: number | null
  /** AI_CalcDamage's own crit-blended estimate (battle_ai_util.c:673-676) -- only
   * meaningful for a move the ENEMY uses against the player (see buildMatchupReport).
   * `null` for the player's own moves (there's no AI on that side to have a belief),
   * and for case 2 of maxRollDamage's own doc above. NOT null for case 3
   * (isTrueDamageUnavailable) -- see that doc for why those two columns
   * deliberately diverge for Counter/Mirror Coat/Bide/Seismic Toss. */
  aiEstimatedDamage: number | null
  aiEstimatedPercent: number | null
  /** True type immunity (typeEffectiveness === 0, ability-absorbed, etc.) -- distinct
   * from "no direct damage to compute" (maxRollDamage === null): an immune move DOES
   * have a real, meaningful damage figure (0), it just isn't from a `power` gate. */
  isImmune: boolean
  unmodelled: string[]
}

/**
 * AI_CalcDamage's crit blend (battle_ai_util.c:673-676):
 *   dmg = (critDmg + normalDmg * (critChance - 1)) / critChance
 * where normalDmg/critDmg are each CalculateMoveDamage's OWN max-roll output
 * (randomFactor=FALSE, battle_util.c:7791-7795) and critChance is
 * GetInverseCritChance's "1 in N" denominator -- exactly this engine's
 * critChanceDenominator (crit.ts), confirmed by both being NEVER_CRIT/null on the
 * same condition. `critChance == -1` (this engine: denominator === null) skips the
 * blend entirely and returns the plain max roll.
 */
function aiCritBlend(normalDmg: number, critDmg: number, denominator: number | null): number {
  if (denominator === null) return normalDmg
  return idiv(critDmg + normalDmg * (denominator - 1), denominator)
}

function toPercent(dmg: number, maxHp: number): number {
  return (dmg / maxHp) * 100
}

/** AI_CalcDamage's own dynamic-damage effect set (battle_ai_util.c:684-703) -- this
 * engine has no port of ANY of these (a plain grep of web/src/engine turns up zero
 * hits), so a move using one of them has to be excluded explicitly rather than
 * relying on power===0: re-measured against moves.json directly, EFFECT_SUPER_FANG,
 * EFFECT_ENDEAVOR, EFFECT_FINAL_GAMBIT, EFFECT_LEVEL_DAMAGE and
 * EFFECT_SUPER_FANG_HAZE all declare power 1 in this ER data (not 0), so the
 * power-only gate would miss them and silently run the ordinary formula on power=1.
 * EFFECT_PSYWAVE/EFFECT_DRAGON_RAGE currently have no move using them (Psywave and
 * Dragon Rage were redesigned into ordinary power-based moves with different
 * effects in ER) -- kept for fidelity to the C regardless. */
const DYNAMIC_DAMAGE_EFFECTS = new Set([
  'EFFECT_SUPER_FANG',
  'EFFECT_SUPER_FANG_HAZE',
  'EFFECT_LEVEL_DAMAGE',
  'EFFECT_PSYWAVE',
  'EFFECT_DRAGON_RAGE',
  'EFFECT_ENDEAVOR',
  'EFFECT_FINAL_GAMBIT',
])

/**
 * A SECOND, narrower gap, distinct from DYNAMIC_DAMAGE_EFFECTS above: re-measuring
 * every power===1 move in moves.json (20 total) turned up 14 outside that set. Ten
 * are fine -- Low Kick/Grass Knot, Heat Crash/Heavy Slam/Splash, Electro Ball, Gyro
 * Ball, Natural Gift, Beat Up and Magnitude all have real handlers in basePower.ts
 * that compute their true power from weight/speed/etc., so the ordinary formula
 * downstream of that IS correct for them.
 *
 * The remaining four -- Counter, Mirror Coat, Bide, Seismic Toss -- have no handler
 * anywhere (confirmed by grep) AND no declarative `attack.damage` block in
 * moveBehaviors.json (each is `legacyConfig`-only, i.e. battle-script bytecode this
 * pipeline can't scrape -- see docs/battle-sim's own finding on that). Their REAL
 * damage (double whatever was received, double the 2-turn accumulated total, or --
 * per this move's own redesigned description -- level-based) has nothing to do with
 * their declared power=1, so `maxRollDamage` is null for them.
 *
 * They are NOT added to DYNAMIC_DAMAGE_EFFECTS above, because that set's other
 * members are ALSO special-cased inside AI_CalcDamage's own body with a real
 * alternate formula (battle_ai_util.c:684-703), so the AI's belief for those needs
 * excluding too. Counter/Mirror Coat/Bide are NOT special-cased there (confirmed by
 * reading AI_CalcDamage's full body, battle_ai_util.c:650-765) -- so AI_CalcDamage
 * itself falls through to the ordinary power=1 formula for them, meaning that small,
 * "wrong" number genuinely IS the AI's own belief, not an artifact of this engine's
 * gap. `aiEstimatedDamage` is therefore still computed normally for these three.
 *
 * Seismic Toss is gated by MOVE ID, not by effect: it shares EFFECT_SKY_DROP with
 * MOVE_SKY_DROP (power=60, a REAL two-turn move whose final hit uses the ordinary
 * formula correctly) -- confirmed by checking every move using EFFECT_SKY_DROP
 * directly. Gating on the effect would have wrongly nulled Sky Drop too.
 * `IsGravityPreventingMove`/`Cmd_setsemiinvulnerablebit` (battle_util.c:1379-1398,
 * battle_script_commands.c:11541-11566) confirm Seismic Toss deliberately shares
 * Sky Drop's airborne mechanic in this ER build -- a real redesign, not a scrape
 * artifact -- but neither site shows a level-based damage override, so what its own
 * moves.json description claims ("Inflicts level damage") isn't verifiable from the
 * available decompiled source; nulling the true-damage column is the honest response
 * either way, matching AI_CalcDamage's own lack of a special case for it too.
 */
const TRUE_DAMAGE_UNAVAILABLE_EFFECTS = new Set(['EFFECT_COUNTER', 'EFFECT_MIRROR_COAT', 'EFFECT_BIDE'])
const TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS = new Set(['MOVE_SEISMIC_TOSS'])

function isTrueDamageUnavailable(move: MoveData): boolean {
  return TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS.has(move.id) || Boolean(move.effect && TRUE_DAMAGE_UNAVAILABLE_EFFECTS.has(move.effect))
}

/** One move's report row. `estimateAiBelief` should be true only for the enemy's own
 * moves landing on the player -- see MatchupMoveEntry.aiEstimatedDamage's own doc for
 * why this isn't meaningful in the other direction. `defenderForAiBelief`, when
 * given, is a SEPARATE copy of the defender's battler state with its held item
 * zeroed (SetBattlerData, battle_ai_util.c:538, only for the non-AI-controlled
 * battler and only while BATTLE_HISTORY->itemEffects is still 0 -- always true turn
 * one, before any item has ever triggered) -- the AI's own estimate of incoming
 * damage ignores an item it hasn't seen fire yet, which is exactly the asymmetry the
 * plan asked this report to surface rather than silently match against column one. */
function evaluateMoveEntry(
  move: MoveData,
  attacker: BattlerBattleState,
  defender: BattlerBattleState,
  field: FieldBattleState,
  ctx: MatchupContext,
  estimateAiBelief: boolean,
  defenderForAiBelief: BattlerBattleState | null,
): MatchupMoveEntry {
  const base = {
    moveId: move.id,
    priority: move.priority ?? 0,
  }
  const isDynamicDamageEffect = Boolean(move.effect && DYNAMIC_DAMAGE_EFFECTS.has(move.effect))
  if (!move.power || isDynamicDamageEffect) {
    // Two separate reasons collapse to the same "no number" result -- see
    // MatchupMoveEntry.maxRollDamage's own doc for why these can't be merged into
    // one check: AI_CalcDamage's own `else { dmg = 0; }` branch for a truly
    // powerless move, and its own dynamic-damage switch for a move this engine has
    // no port of at all (checked independently of power, since several of these
    // declare power 1 in this ER data, not 0).
    //
    // `unmodelled` is EMPTY for a plain powerless move (a STATUS move genuinely has
    // no direct damage -- there's nothing to warn about) but carries a real note for
    // isDynamicDamageEffect -- a review finding on the React surface caught that
    // without this split, Super Fang/Endeavor/Final Gambit/Night Shade/Natures
    // Madness read as harmless (the SAME bare dash a status move gets), when they're
    // actually the exact same class of engine gap as Counter/Mirror Coat/Bide/
    // Seismic Toss below, which DO get a warning. See MatchupReportView.tsx's own
    // "dash means three different things" note.
    const unmodelled = isDynamicDamageEffect ? [`${move.effect}: not modelled`] : []
    return { ...base, maxRollDamage: null, maxRollPercent: null, aiEstimatedDamage: null, aiEstimatedPercent: null, isImmune: false, unmodelled }
  }

  const scenarioBase = {
    move,
    attacker,
    defender,
    field,
    typeChart: ctx.typeChart,
    inverseTypeChart: ctx.inverseTypeChart,
    moveBehaviors: ctx.moveBehaviors,
    battleConstants: ctx.natures,
    attackerActsFirst: true, // see MATCHUP_REPORT_CAVEATS -- ActsAfter moves assume the user goes first
    sameMoveTurnsInARow: 0,
    hitCount: 3, // EFFECT_MULTI_HIT's own average -- see damageCalc/scenario.ts's defaultFieldConfig
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0 as const,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: 80,
    beatUpHitCount: 5,
    defenderUsedGlaiveRush: false,
  }

  const result = calculateMoveDamage(scenarioBase)
  const maxHp = defender.condition.maxHp
  // See isTrueDamageUnavailable's own doc -- Counter/Mirror Coat/Bide/Seismic Toss
  // declare power 1 like the DYNAMIC_DAMAGE_EFFECTS group above, but AI_CalcDamage
  // does NOT special-case them, so only THIS column (the real, in-game outcome) is
  // suppressed; aiEstimatedDamage below still runs the ordinary formula.
  const trueDamageUnavailable = isTrueDamageUnavailable(move)
  const maxRollDamage = trueDamageUnavailable ? null : result.isImmune ? 0 : result.rolls[result.rolls.length - 1]

  let aiEstimatedDamage: number | null = null
  if (estimateAiBelief) {
    const aiDefender = defenderForAiBelief ?? defender
    const aiResult = calculateMoveDamage({ ...scenarioBase, defender: aiDefender })
    const normalDmg = aiResult.isImmune ? 0 : aiResult.rolls[aiResult.rolls.length - 1]
    const critDmg = aiResult.isImmune ? 0 : aiResult.critRolls ? aiResult.critRolls[aiResult.critRolls.length - 1] : normalDmg
    aiEstimatedDamage = aiCritBlend(normalDmg, critDmg, aiResult.critChanceDenominator)
  }

  return {
    ...base,
    maxRollDamage,
    maxRollPercent: maxRollDamage === null ? null : toPercent(maxRollDamage, maxHp),
    aiEstimatedDamage,
    aiEstimatedPercent: aiEstimatedDamage === null ? null : toPercent(aiEstimatedDamage, maxHp),
    isImmune: trueDamageUnavailable ? false : result.isImmune,
    unmodelled: trueDamageUnavailable
      ? [...result.unmodelled, `${move.id}: real damage not modelled (unported battle-script effect -- see matchupReport.ts's TRUE_DAMAGE_UNAVAILABLE_* doc)`]
      : result.unmodelled,
  }
}

/** Zeroes exactly what SetBattlerData zeroes on a non-AI-controlled battler, turn one
 * (battle_ai_util.c:520-543): the held item, unconditionally, since
 * BATTLE_HISTORY->itemEffects[battler] is always 0 before any item has triggered.
 * (SetBattlerData also zeroes unrevealed move SLOTS on whichever battler is passed
 * as -- here always the DEFENDER, i.e. the player -- but nothing in this engine's
 * damage formula reads the defender's own moveset, so that half has no effect to
 * reproduce and is left alone.) */
function withItemHiddenFromAi(battler: BattlerBattleState): BattlerBattleState {
  return {
    ...battler,
    condition: { ...battler.condition, itemId: null, resolvedHoldEffect: null, itemResolvedHoldEffectStrength: null },
    holdEffectStrength: null,
    holdEffectType: null,
    naturalGift: null,
  }
}

export interface MatchupMonReport {
  speciesId: string
  level: number
  speed: number
  maxHp: number
  /** Your moves landing on this mon -- maxRoll only, no AI-belief column (there is no
   * AI evaluating your side of the exchange). */
  yourMoves: MatchupMoveEntry[]
  /** This mon's moves landing on you -- both survival columns populated. This is the
   * half of the report the plan calls "the point of the exercise". */
  itsMoves: MatchupMoveEntry[]
}

export interface MatchupReport {
  playerSpeciesId: string
  tier: TrainerTier
  enemyLevel: number
  speedTiers: SpeedEntry[]
  /** SPEED_TIER_CAVEAT -- carried on the result itself (not just the general
   * MATCHUP_REPORT_CAVEATS list) so the UI renders it right next to the table it
   * qualifies, rather than relying on a reader to have read the caveats section
   * first. */
  speedTierNote: string
  mons: MatchupMonReport[]
}

export interface MatchupReportInput {
  player: { speciesId: string; battler: BattlerBattleState; moves: MoveData[] }
  trainer: Trainer
  tier: TrainerTier
  playerHighestLevel: number
  ctx: MatchupContext
  /** Defaults to neutralField() -- see that function's own doc. */
  field?: FieldBattleState
}

/** party[tier] with the plan's own documented fallback chain (lib/types.ts's
 * TrainerParties doc): elite falls back to ace when empty, hell falls back to the
 * RESOLVED elite (which may itself already be the ace fallback), not straight to
 * ace. */
export function resolveParty(trainer: Trainer, tier: TrainerTier): TrainerMon[] {
  const ace = trainer.parties.ace
  const elite = trainer.parties.elite.length > 0 ? trainer.parties.elite : ace
  if (tier === 'ace') return ace
  if (tier === 'elite') return elite
  return trainer.parties.hell.length > 0 ? trainer.parties.hell : elite
}

export function buildMatchupReport(input: MatchupReportInput): MatchupReport {
  const { player, trainer, tier, playerHighestLevel, ctx } = input
  const field = input.field ?? neutralField()
  const enemyLevel = resolveEnemyLevel(playerHighestLevel)
  const party = resolveParty(trainer, tier)

  const enemies = party.map((mon) => ({
    mon,
    speciesId: mon.species,
    battler: buildEnemyBattlerState(mon, enemyLevel, ctx),
  }))

  const playerItemHidden = withItemHiddenFromAi(player.battler)

  const mons: MatchupMonReport[] = enemies.map(({ mon, speciesId, battler }) => {
    const enemyMoves = movesForMon(mon, ctx.movesById)
    return {
      speciesId,
      level: enemyLevel,
      speed: battler.condition.speed,
      maxHp: battler.condition.maxHp,
      yourMoves: player.moves.map((move) => evaluateMoveEntry(move, player.battler, battler, field, ctx, false, null)),
      itsMoves: enemyMoves.map((move) => evaluateMoveEntry(move, battler, player.battler, field, ctx, true, playerItemHidden)),
    }
  })

  return {
    playerSpeciesId: player.speciesId,
    tier,
    enemyLevel,
    speedTiers: speedTiers(
      player.battler,
      enemies.map((e) => ({ speciesId: e.speciesId, battler: e.battler })),
    ),
    speedTierNote: SPEED_TIER_CAVEAT,
    mons,
  }
}
