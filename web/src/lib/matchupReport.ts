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
import { ZERO_DAMAGE_BASE_POWER_EFFECTS, ZERO_DAMAGE_BASE_POWER_MOVE_IDS } from '../engine/basePower'
import type { MoveBehaviors } from '../engine/basePower'
import { calcHp, calcStat } from '../engine/stats'
import { calculateBattleStat, DEFAULT_STAT_STAGE } from '../engine/battleStat'
import { idiv } from '../engine/fixed'
import type { TypeChart } from '../engine/typeEffectiveness'
import { bareType, toMoveData } from './moveData'
import type { BattleConstants, FieldEffect, InverseBattle, Item, Move, Species, Trainer, TrainerMon } from './types'

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
  // Stands on its own rather than pointing at the double-battle banner -- a
  // 2026-09-15 browser review caught that the banner only renders for
  // trainer.forcedDouble, so on an ordinary singles trainer (most of them) that
  // cross-reference pointed at nothing on the page. This wording is a SUBSET of the
  // banner's own text (MatchupReportView.tsx's isForcedDouble block) -- keep the two
  // in sync.
  "Assumes the save's Double Battle Mode option is off. If it's on, EVERY trainer with two or more Pokemon fights as a double, " +
    "regardless of this trainer's own forcedDouble setting (option_plus_menu.c:1038, battle_main.c:1757-1758) -- for such a fight " +
    'this report still describes a one-on-one shape: no partner on either side, no targeting, and any move that would hit both ' +
    'foes is shown at full power where a double battle cuts it to 0.75x.',
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
  /** encounters.json's own two lists carrying this fight's real per-battle
   * conditions -- see resolveTrickRoomActive/resolveInverseBattleActive's own docs
   * for how they're consulted. Two independent facts from two independent lists
   * (Trick Room is a VAR_BATTLE_FIELD_* write, Inverse Battle a separate
   * FLAG_SYS_INVERSE_BATTLE setflag), not one inferred from the other, even though
   * the one real inverse fight also happens to have Trick Room active. */
  fieldEffects: FieldEffect[]
  inverseBattles: InverseBattle[]
}

/** Whether `trainerId` fights under a permanent Trick Room, per encounters.json's own
 * "fieldEffects" list -- restricted to UNGUARDED (guard === null) rows: a guarded row
 * (e.g. Steven's two save-state-dependent Gravity variants, or the Monotype Champion
 * rooms' own dialogue-guarded ones) belongs to a fight this report has no way to
 * confirm is the one being resolved, so it's treated as out of scope rather than
 * guessed at. Pure presentation fact -- see speedTiers's own doc for why this
 * touches no damage number, only that function's own sort order and note. */
export function resolveTrickRoomActive(trainerId: string, fieldEffects: FieldEffect[]): boolean {
  return fieldEffects.some(
    (fe) => fe.guard === null && fe.effectType === 'BATTLE_FIELD_EFFECT_ROOM' && fe.fieldId === 'STATUS_FIELD_TRICK_ROOM' && fe.trainers.includes(trainerId),
  )
}

/** Whether `trainerId` fights as a genuine Inverse Battle, per encounters.json's own
 * "inverseBattles" list (FLAG_SYS_INVERSE_BATTLE, battle_util.c:8028) -- same
 * unguarded-only restriction as resolveTrickRoomActive, for the same reason. Unlike
 * Trick Room, this is NOT presentation: it maps directly to
 * FieldBattleState.isInverseBattleFlagSet, which the engine's own GetTypeModifier
 * XORs into the type-chart selection (typeEffectiveness.ts) -- every damage number
 * the report computes for this fight is affected, not just how a table is sorted. */
export function resolveInverseBattleActive(trainerId: string, inverseBattles: InverseBattle[]): boolean {
  return inverseBattles.some((ib) => ib.guard === null && ib.trainers.includes(trainerId))
}

/** A turn-one, no-weather/terrain/hazard/screen field -- the neutral default this
 * report always starts from (see MATCHUP_REPORT_CAVEATS), EXCEPT for
 * isInverseBattleFlagSet, which buildMatchupReport resolves per-trainer from
 * encounters.json's own data before falling back to this default (see
 * resolveInverseBattleActive). Exported so a caller that wants to override the field
 * entirely (tests, or a future per-battle-field-effect extension beyond Trick
 * Room/Inverse Battle) has a documented starting point rather than reconstructing
 * one. */
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

/** Printed alongside the speed-tier table itself by the view (imported directly,
 * the same way it imports MATCHUP_REPORT_CAVEATS -- NOT carried on MatchupReport;
 * see the 2026-09-15 browser-review finding below for why it no longer is), not
 * just folded into the general MATCHUP_REPORT_CAVEATS list -- a reader glancing at an
 * ordering titled "who moves first" will otherwise assume it's the final answer.
 * Each move's own `priority` field (MatchupMoveEntry.priority) is the correction, and
 * it only works if the table tells the reader to go look for it. Rendered in the
 * danger color, unconditionally, regardless of Trick Room -- this is a genuine
 * limitation (priority is never modelled in the ordering) whether or not Trick Room
 * happens to also be active for this fight. */
// The example is deliberately phrased by TABLE POSITION ("listed lower"), not by
// raw Speed magnitude ("lower-Speed") -- a 2026-09-15 browser review caught that the
// old wording ("a lower-Speed mon using a priority move still acts first") reads
// backwards on a Trick Room page, where this text renders directly beneath
// TRICK_ROOM_SPEED_TIER_NOTE: under Trick Room the lower-Speed mon already moves
// first on its own, so a priority move is what lets a HIGHER-Speed one jump ahead
// instead. "Listed lower in the table" is true under both orderings, since the
// table itself is already sorted correctly for whichever one applies.
export const SPEED_TIER_CAVEAT = 'Ordered by raw Speed stat only -- ignores move priority. Check each move’s own priority in the damage tables below: a Pokemon listed lower in the table using a priority move can still act first.'

/** The Trick-Room-active fact, rendered by the view ONLY when `isTrickRoomActive`,
 * ABOVE SPEED_TIER_CAVEAT and in a NEUTRAL color (no danger styling) -- unlike
 * SPEED_TIER_CAVEAT above, this describes a condition the report correctly accounts
 * for (speedTiers really does reverse the sort for this fight), not a limitation, so
 * it shouldn't share SPEED_TIER_CAVEAT's red. A 2026-09-15 browser review caught this
 * note's earlier version doing exactly that -- it used to merge this fact with a
 * second copy of SPEED_TIER_CAVEAT's own "still ignores priority" sentence into one
 * red string, which meant an APPLIED effect (matching the Inverse Battle banner's own
 * neutral styling, see MatchupReport.isInverseBattleActive's own doc) was sharing a
 * color meant to mean "this doesn't fully apply". Split apart: this constant now
 * states only the applied fact; SPEED_TIER_CAVEAT above carries the actual limitation
 * and is rendered unconditionally, so no information was dropped, only recolored.
 * Presentation only -- Trick Room doesn't touch any damage number (nothing in
 * CalculateStat/CalcFinalDmg branches on it), so this stays entirely inside
 * speedTiers's own sort, never reaching the engine. Kept as a SEPARATE fact from
 * isInverseBattleActive's own banner -- a reader has to be able to tell "the order is
 * flipped" apart from "the damage numbers are inverted", different kinds of fact
 * about the same fight. */
export const TRICK_ROOM_SPEED_TIER_NOTE = 'Trick Room is active in this fight -- the table above is sorted with LOWER Speed first, the reverse of normal order.'

/** "Exact speed tiers": every battler's real, post-nature/EV/IV/level Speed stat
 * (neutral stage, per MATCHUP_REPORT_CAVEATS), sorted fastest-first -- or slowest-
 * first under Trick Room, real Pokemon's own turn-order reversal, per
 * `isTrickRoomActive` (see resolveTrickRoomActive). Real ties are kept adjacent and
 * flagged by the caller via matching `speed` values -- the ROM breaks a real Speed
 * tie with Random() (battle_main.c), not something a static report can resolve, so
 * this deliberately doesn't guess a winner, under either ordering. Priority is
 * DELIBERATELY not folded in here -- see SPEED_TIER_CAVEAT's own doc for why this is
 * a separate, narrower fact than "who actually moves first for a given move pair". */
export function speedTiers(player: BattlerBattleState, enemies: { speciesId: string; battler: BattlerBattleState }[], isTrickRoomActive: boolean): SpeedEntry[] {
  const entries: SpeedEntry[] = [
    { label: 'You', speed: player.condition.speed },
    ...enemies.map((e) => ({ label: e.speciesId, speed: e.battler.condition.speed })),
  ]
  const fastestFirst = entries.sort((a, b) => b.speed - a.speed)
  return isTrickRoomActive ? fastestFirst.reverse() : fastestFirst
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
 *
 * EFFECT_METAL_BURST (MOVE_METAL_BURST, MOVE_COMEUPPANCE) added 2026-09-15,
 * alongside basePower.ts's own UNMODELLED_BASE_POWER_EFFECTS -- same retaliation
 * shape as Counter, confirmed absent from both CalcMoveBasePower's switch and
 * AI_CalcDamage's dynamic-damage switch the same way. Declares power=0, not
 * power=1 like the other three here, so it takes the EARLY-RETURN branch in
 * evaluateMoveEntry below (`!move.power`) rather than reaching this function's own
 * call site -- that branch has its own, separate check for this set, added at the
 * same time (a review caught that adding the effect here ALONE would do nothing
 * for a power=0 move: this function is only ever called downstream of the early
 * return, never for a move that took it).
 *
 * MOVE_SQUALL_HAMMER is NOT in this set (a 2026-09-15 review caught an earlier
 * version of this file putting it here, which is the exact mislabel
 * ZERO_DAMAGE_BASE_POWER_MOVE_IDS below exists to avoid): Squall Hammer's real
 * damage isn't "exists but uncomputed" like Counter/Mirror Coat/Bide/Metal
 * Burst/Seismic Toss above, it's a script-confirmed ZERO (BattleScript_EffectDefog,
 * battle_scripts_1.s:1560-1592, has no damage step on any path) -- see
 * isZeroDamageBasePower's own doc below for that distinction and where it's
 * actually handled.
 */
const TRUE_DAMAGE_UNAVAILABLE_EFFECTS = new Set(['EFFECT_COUNTER', 'EFFECT_MIRROR_COAT', 'EFFECT_BIDE', 'EFFECT_METAL_BURST'])
const TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS = new Set(['MOVE_SEISMIC_TOSS'])

function isTrueDamageUnavailable(move: MoveData): boolean {
  return TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS.has(move.id) || Boolean(move.effect && TRUE_DAMAGE_UNAVAILABLE_EFFECTS.has(move.effect))
}

/** basePower.ts's ZERO_DAMAGE_BASE_POWER_EFFECTS/_MOVE_IDS, imported directly
 * rather than copied -- a 2026-09-15 review caught that this file's OWN copy of
 * the equivalent sets (TRUE_DAMAGE_UNAVAILABLE_* above, DYNAMIC_DAMAGE_EFFECTS
 * below) is exactly how EFFECT_METAL_BURST/MOVE_SQUALL_HAMMER ended up added to
 * basePower.ts first and only reached this file in a follow-up once the two
 * surfaces were caught disagreeing (a bare, unexplained dash here while the
 * calculator had already started warning). Importing these two specific sets
 * closes that gap for good rather than adding a third copy that can drift the
 * same way again: MOVE_AIRBORNE_SLAM/MOVE_FETCH/MOVE_SQUALL_HAMMER now read the
 * SAME zero-damage fact this file's own damage computation already reflects
 * (see evaluateMoveEntry below), from one source. A DIFFERENT class from
 * isTrueDamageUnavailable above: not "real damage exists, this engine can't
 * compute it" (a real, nonzero, unported number), but "the real damage IS
 * zero, script-confirmed" -- MOVE_SQUALL_HAMMER's own AI-belief column still
 * runs the ordinary formula and shows a real (if "wrong") number, same as
 * Counter/Mirror Coat/Bide/Metal Burst above, because AI_CalcDamage computes
 * from the formula, not from the script -- only the TRUE-damage column is
 * affected. */
function isZeroDamageBasePower(move: MoveData): boolean {
  return ZERO_DAMAGE_BASE_POWER_MOVE_IDS.has(move.id) || Boolean(move.effect && ZERO_DAMAGE_BASE_POWER_EFFECTS.has(move.effect))
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
    //
    // A THIRD source added 2026-09-15: isTrueDamageUnavailable(move) below is
    // ALSO checked here, not only past this early return -- EFFECT_METAL_BURST
    // declares power=0 (Counter/Mirror Coat/Bide/Seismic Toss are all power=1, so
    // they never took this branch and were already covered by the isImmune=false
    // return further down), so a caller that only added it to
    // TRUE_DAMAGE_UNAVAILABLE_EFFECTS without this check would see it hit `!move.power`
    // above and take this branch with the isDynamicDamageEffect ternary skipping it
    // silently -- the exact divergence a review caught between this file and
    // basePower.ts's own UNMODELLED_BASE_POWER_EFFECTS after that set gained
    // EFFECT_METAL_BURST first.
    //
    // A FOURTH source added the same day: isZeroDamageBasePower(move) below,
    // for MOVE_AIRBORNE_SLAM/MOVE_FETCH (also power=0, so they take this same
    // branch). Unlike the other three sources, calculateMoveDamage is never
    // invoked here (this branch returns before scenarioBase even exists), so
    // there's no `result.unmodelled` to draw the engine's own zero-damage
    // message from -- built inline instead, using the exact literal
    // basePower.ts's own calculate.ts uses, so a reader sees the identical
    // wording whichever code path produced it.
    const trueDamageUnavailableAtZeroPower = isTrueDamageUnavailable(move)
    const zeroDamageEffect = move.effect && ZERO_DAMAGE_BASE_POWER_EFFECTS.has(move.effect) ? move.effect : null
    const zeroDamageMoveId = ZERO_DAMAGE_BASE_POWER_MOVE_IDS.has(move.id) ? move.id : null
    const unmodelled = isDynamicDamageEffect
      ? [`${move.effect}: not modelled`]
      : trueDamageUnavailableAtZeroPower
        ? [`${move.id}: real damage not modelled (unported battle-script effect -- see matchupReport.ts's TRUE_DAMAGE_UNAVAILABLE_* doc)`]
        : zeroDamageEffect
          ? [`${zeroDamageEffect}: its battle script deals no damage in this build`]
          : zeroDamageMoveId
            ? [`${zeroDamageMoveId}: its battle script deals no damage in this build`]
            : []
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
  // MOVE_SQUALL_HAMMER (power=95) reaches here rather than the early-return branch
  // above -- same treatment: suppress the true-damage column, keep the AI-belief
  // one, since isZeroDamageBasePower's own doc explains why the AI's belief is
  // still a real (if "wrong") number, computed from the formula, not the script.
  const zeroDamage = isZeroDamageBasePower(move)
  const maxRollDamage = trueDamageUnavailable || zeroDamage ? null : result.isImmune ? 0 : result.rolls[result.rolls.length - 1]

  let aiEstimatedDamage: number | null = null
  if (estimateAiBelief) {
    const aiDefender = defenderForAiBelief ?? defender
    const aiResult = calculateMoveDamage({ ...scenarioBase, defender: aiDefender })
    const normalDmg = aiResult.isImmune ? 0 : aiResult.rolls[aiResult.rolls.length - 1]
    const critDmg = aiResult.isImmune ? 0 : aiResult.critRolls ? aiResult.critRolls[aiResult.critRolls.length - 1] : normalDmg
    aiEstimatedDamage = aiCritBlend(normalDmg, critDmg, aiResult.critChanceDenominator)
  }

  // The engine's own calculateMoveDamage call above already pushes the right
  // message into result.unmodelled for BOTH isTrueDamageUnavailable and
  // isZeroDamageBasePower moves (UNMODELLED_BASE_POWER_EFFECTS/_MOVE_IDS and
  // ZERO_DAMAGE_BASE_POWER_EFFECTS/_MOVE_IDS in basePower.ts, reached via
  // move.effect/move.id inside calculateMoveDamage -- see calculate.ts's own
  // checks). This file's own extra append below is therefore only needed for
  // TRUE_DAMAGE_UNAVAILABLE_* entries the engine does NOT ALSO warn on by
  // move id -- guarded by the `!result.unmodelled.includes(...)` check so
  // MOVE_SEISMIC_TOSS (in BOTH this file's TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS
  // and basePower.ts's own UNMODELLED_BASE_POWER_MOVE_IDS) doesn't carry two
  // notes saying the same thing in different words -- a 2026-09-15 review
  // caught exactly that duplicate. Counter/Mirror Coat/Bide/Metal Burst are
  // effect-keyed on the engine side (`${move.effect}: not modelled`) but
  // move-id-keyed on this file's own extra note, so they don't collide and
  // keep both (the extra note's "see matchupReport.ts's TRUE_DAMAGE_UNAVAILABLE_*
  // doc" pointer is genuinely additional context for those, not a restatement).
  const engineAlreadyNotedThisMoveId = result.unmodelled.includes(`${move.id}: not modelled`)
  return {
    ...base,
    maxRollDamage,
    maxRollPercent: maxRollDamage === null ? null : toPercent(maxRollDamage, maxHp),
    aiEstimatedDamage,
    aiEstimatedPercent: aiEstimatedDamage === null ? null : toPercent(aiEstimatedDamage, maxHp),
    isImmune: trueDamageUnavailable || zeroDamage ? false : result.isImmune,
    unmodelled:
      trueDamageUnavailable && !engineAlreadyNotedThisMoveId
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
  /** Whether this specific trainer fight runs under a permanent Trick Room, per
   * encounters.json (see resolveTrickRoomActive). Presentation only -- already
   * folded into `speedTiers`'s own ordering; exposed here so the UI can render
   * TRICK_ROOM_SPEED_TIER_NOTE (imported directly, like MATCHUP_REPORT_CAVEATS and
   * SPEED_TIER_CAVEAT -- see those constants' own docs for why neither is carried on
   * this result) without re-deriving the lookup. */
  isTrickRoomActive: boolean
  /** Whether the field ACTUALLY USED to compute `mons` below has
   * `isInverseBattleFlagSet` set -- read back off that field, not re-derived from
   * encounters.json independently (a caller-supplied `field` can disagree with the
   * lookup; see buildMatchupReport's own comment on why this has to be the field's
   * own value). NOT presentation -- every damage number under `mons` below already
   * reflects the inverted type chart when this is true; this flag exists so the UI
   * can (and must) render a SEPARATE, explicit banner making that plain, rather
   * than a reader discovering it only from the numbers looking unusual. */
  isInverseBattleActive: boolean
  /** trainer.forcedDouble, already-parsed trainer data -- no lookup needed, this is
   * a straight passthrough. A forced-double fight puts two Pokemon per side on the
   * field at once; this report (like the plan's own literal `isDoubleBattle: false`
   * engine type) is singles-only, so for a fight flagged this way the whole report
   * -- speed order, both damage columns, all of it -- describes a battle shape that
   * does not occur. NOT the same kind of fact as isTrickRoomActive/
   * isInverseBattleActive, which describe conditions this report DOES account for:
   * this one describes a fight the report CANNOT account for at all. Keep its own
   * banner separate from those two for exactly that reason -- see
   * MatchupReportView's own doc on why the three don't collapse into one block. */
  isForcedDouble: boolean
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
  const isTrickRoomActive = resolveTrickRoomActive(trainer.id, ctx.fieldEffects)
  // Only used to build the DEFAULT field below, not reported directly -- a caller
  // that supplies its own `field` (tests, or a future extension) can disagree with
  // this lookup, and the report must describe the field it actually computed `mons`
  // with, not this independent fact. See isInverseBattleActive's own doc below.
  const lookedUpInverseBattleActive = resolveInverseBattleActive(trainer.id, ctx.inverseBattles)
  const field = input.field ?? { ...neutralField(), isInverseBattleFlagSet: lookedUpInverseBattleActive }
  const isInverseBattleActive = field.isInverseBattleFlagSet
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
      isTrickRoomActive,
    ),
    isTrickRoomActive,
    isInverseBattleActive,
    isForcedDouble: trainer.forcedDouble,
    mons,
  }
}
