// The simulator's view of the committed data snapshot.
//
// A PURE INTERFACE OF LOOKUPS. Nothing in `engine/` reads a file, parses JSON,
// knows a path or imports a loader, and that is not an accident of the current
// implementation -- it is the layering rule this module exists to protect.
//
// ==========================================================================
// IF YOU ARE HERE TO ADD A LOADER, DON'T.
//
// The pressure is real and will recur: it is inconvenient that every caller has
// to assemble one of these, and adding `loadSimDataContext()` that reads
// data/<version>/*.json would remove that inconvenience in about fifteen lines.
// It would also:
//
//   - make `engine/` depend on a filesystem, which kills its use from a Web
//     Worker and from the browser build, where there is no filesystem at all;
//   - hard-code a snapshot version inside the engine, so the engine would need
//     a change to read a repinned snapshot;
//   - invert the layering. `lib/moveData.ts` already imports FROM engine. An
//     engine-side loader would make engine import lib (or duplicate it), and
//     `engine/` currently imports nothing from `lib/` or `features/` -- checked,
//     not assumed.
//
// Callers own the loading. Tests build a context from the committed snapshot
// directly, the way `features/matchupReport/composition.test.ts` already does.
// The solver will do the same. If assembling one is too tedious, put a helper in
// the CALLER's layer, not here.
// ==========================================================================

import type { BaseStats } from '../types'
import type { MoveBehaviorEntry } from '../basePower'

export interface SimMegaEvolution {
  from: string
  item?: string
  move?: string
  megaType?: string
}

export interface SimPrimalReversion {
  from: string
  item: string
  primalType?: string
}

/** The species fields the bridge needs. A subset of species.json's entry, named
 * here so the engine does not depend on `lib/types.ts`'s full `Species` shape
 * (which carries learnsets, descriptions and sprite metadata the engine has no
 * use for). */
export interface SimSpeciesData {
  id: string
  baseStats: BaseStats
  types: string[]
  abilities: (string | null)[]
  innates: (string | null)[]
  /** Hectograms. ConditionBattlerContext.weight. */
  weight: number
  /** species.json's `heads` (F_TWO_HEADED / F_THREE_HEADED, pokemon.h:209-210),
   * default 1 -- Multi Headed's onParentalBond trigger. */
  heads?: number
  /** Non-empty when this species IS a Mega/Primal form -- the reverse lookup
   * ConditionBattlerContext.isMegaEvolved reads. */
  megas?: SimMegaEvolution[]
  primals?: SimPrimalReversion[]
  /** GET_BASE_SPECIES_ID's source. */
  formOf?: string | null
  /** Eviolite eligibility (canEvolveStrict). */
  evolutions?: unknown[]
}

/** The item fields the bridge needs. */
export interface SimItemData {
  id: string
  resolvedHoldEffect: string | null
  holdEffectStrength: number | null
  holdEffectType: string | null
  /** items.json's `naturalGift` (gNaturalGiftTable entry). `effect` / `affectsUser` / `certain` are the table's MoveEffect
   * (Natural Gift's SetMoveEffect case, battle_script_commands.c:3020-3024); absent in hand-built fixtures. */
  naturalGift: { power: number; type: string; effect?: string; affectsUser?: boolean; certain?: boolean } | null
  /** items.json's `grouping` (ItemList.proto Pocket, e.g. POCKET_BERRIES) --
   * `gItems[id].pocket` (ItemGenerator.kt:25), read by ItemId_GetPocket. */
  grouping?: string | null
}

/** The move fields the bridge needs beyond what a TurnOrderMoveView carries. */
export interface SimMoveData {
  id: string
  power: number
  type: string | null
  /** moves.json's `type2` -- `gBattleMoves[move].type2`, read by Cmd_tryconversiontypechange
   * (battle_script_commands.c:10216). */
  type2?: string | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  effect: string | null
  target?: string
  priority?: number
  flags: Record<string, true>
  /** moves.json's own `accuracy` (MoveList.proto `accuracy`, GetTotalAccuracy's
   * moveAcc source, battle_script_commands.c:1284). 0 means "no accuracy
   * check" (ACCURACY_HITS_IF_POSSIBLE), same as the AccuracyInputs field it
   * feeds. Not carried by `MoveData` (calculate.ts) -- the damage path never
   * needed it -- so accuracyBridge.ts reads this shape instead. */
  accuracy: number
  /** moves.json's `hitsAir` (HitsAir enum: DOESNT_HIT_AIR/HITS/DOUBLE_DAMAGE,
   * MoveList.proto). HITS is FLAG_DMG_IN_AIR, DOUBLE_DAMAGE is
   * FLAG_DMG_2X_IN_AIR -- see accuracy.ts's AccuracyInputs doc for why they
   * are two separate bits. Undefined/absent means neither flag is set. */
  hitsAir?: 'HITS' | 'DOUBLE_DAMAGE'
  /** moves.json's `argument` when its kind is `int` -- `gBattleMoves[move].argument`
   * (MoveList.proto field 12's sibling `argument` field, ArgumentCase.INT),
   * read by GetMultihitType's EFFECT_DOUBLE_HIT case (battle_util.c:3589) to
   * tell Surging Strikes/Sparkling Barrage's own 3-hit variant (argument==3)
   * apart from every other Double-Hit-family move (2 hits). null when
   * moves.json's argument is absent or a non-int kind (type/effect/status/
   * misc/other) -- those aren't read by anything attackCanceller.ts needs. */
  argumentInt?: number | null
  /** moves.json's `sheerForceBoost` (FLAG_SHEER_FORCE_BOOST, BattleMovesGenerator.kt:70-77). */
  sheerForceBoost?: true
  /** moves.json's `effectChance` (MoveList.proto `effect_chance`). */
  effectChance?: number
  /** moves.json's `pp` -- gBattleMoves[move].pp, read by VARIOUS_RESTORE_PP (Lunar Dance). */
  pp?: number
  /** moves.json's `argument` when kind is 'effect' or other structured argument. */
  argument?: {
    kind: string
    effect?: string
    affectsUser?: boolean
    certain?: boolean
    [key: string]: unknown
  } | null
  /** moves.json's inline `customBehavior`. */
  customBehavior?: MoveBehaviorEntry | null
}

/**
 * gPokeblockFlavorCompatibilityTable's row order: the game's own nature enum
 * (include/constants/pokemon.h:77-102, NATURE_HARDY=0 .. NATURE_QUIRKY=24), NOT
 * natures.json's alphabetical key order. Index = nature id, value = bare NATURE_*
 * name.
 */
export const NATURE_ORDER: readonly string[] = [
  'NATURE_HARDY',
  'NATURE_LONELY',
  'NATURE_BRAVE',
  'NATURE_ADAMANT',
  'NATURE_NAUGHTY',
  'NATURE_BOLD',
  'NATURE_DOCILE',
  'NATURE_RELAXED',
  'NATURE_IMPISH',
  'NATURE_LAX',
  'NATURE_TIMID',
  'NATURE_HASTY',
  'NATURE_SERIOUS',
  'NATURE_JOLLY',
  'NATURE_NAIVE',
  'NATURE_MODEST',
  'NATURE_MILD',
  'NATURE_QUIET',
  'NATURE_BASHFUL',
  'NATURE_RASH',
  'NATURE_CALM',
  'NATURE_GENTLE',
  'NATURE_SASSY',
  'NATURE_CAREFUL',
  'NATURE_QUIRKY',
]

/** FLAVOR_COUNT (include/constants/berry.h:18): Spicy, Dry, Sweet, Bitter, Sour
 * (:13-17, FLAVOR_SPICY=0 .. FLAVOR_SOUR=4). */
export const FLAVOR_COUNT = 5

/**
 * gPokeblockFlavorCompatibilityTable (src/pokeblock.c:141-167), copied verbatim:
 * 25 natures x 5 flavors, row-major by NATURE_ORDER. -1 = the nature dislikes the
 * flavor, +1 = likes it, 0 = neutral. GetFlavorRelationByNature
 * (src/pokemon.c:4185-4188) is a bare `gPokeblockFlavorCompatibilityTable[nature *
 * FLAVOR_COUNT + flavor]`, so this table IS the answer; there is no formula.
 */
export const POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE: readonly (readonly number[])[] = [
  /* Hardy   */ [0, 0, 0, 0, 0],
  /* Lonely  */ [1, 0, 0, 0, -1],
  /* Brave   */ [1, 0, -1, 0, 0],
  /* Adamant */ [1, -1, 0, 0, 0],
  /* Naughty */ [1, 0, 0, -1, 0],
  /* Bold    */ [-1, 0, 0, 0, 1],
  /* Docile  */ [0, 0, 0, 0, 0],
  /* Relaxed */ [0, 0, -1, 0, 1],
  /* Impish  */ [0, -1, 0, 0, 1],
  /* Lax     */ [0, 0, 0, -1, 1],
  /* Timid   */ [-1, 0, 1, 0, 0],
  /* Hasty   */ [0, 0, 1, 0, -1],
  /* Serious */ [0, 0, 0, 0, 0],
  /* Jolly   */ [0, -1, 1, 0, 0],
  /* Naive   */ [0, 0, 1, -1, 0],
  /* Modest  */ [-1, 1, 0, 0, 0],
  /* Mild    */ [0, 1, 0, 0, -1],
  /* Quiet   */ [0, 1, -1, 0, 0],
  /* Bashful */ [0, 0, 0, 0, 0],
  /* Rash    */ [0, 1, 0, -1, 0],
  /* Calm    */ [-1, 0, 0, 1, 0],
  /* Gentle  */ [0, 0, 0, 1, -1],
  /* Sassy   */ [0, 0, -1, 1, 0],
  /* Careful */ [0, -1, 0, 1, 0],
  /* Quirky  */ [0, 0, 0, 0, 0],
]

/**
 * GetFlavorRelationByNature (src/pokemon.c:4185-4188) over the table above.
 * Deliberately THROWS on an unknown nature or flavor instead of returning a neutral
 * 0: a silent 0 would hide the HealConfuseBerry confusion this exists to answer
 * (battle_util.c:5181-5186) and turn a wrong answer into a plausible one -- the same
 * failure mode SimDataContext's own doc refuses to allow for a missed lookup.
 */
export function flavorRelationByNature(nature: string, flavor: number): number {
  const row = NATURE_ORDER.indexOf(nature)
  if (row < 0) throw new Error(`flavorRelationByNature: unknown nature ${nature}`)
  if (!Number.isInteger(flavor) || flavor < 0 || flavor >= FLAVOR_COUNT) {
    throw new Error(`flavorRelationByNature: flavor ${flavor} is outside 0..${FLAVOR_COUNT - 1} (FLAVOR_* constants)`)
  }
  return POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[row]![flavor]!
}

/**
 * HealConfuseBerry's flavorId argument per HOLD_EFFECT_CONFUSE_* case
 * (src/battle_util.c:5442-5456 and :5717-5731, both pass the same ids; the move-end
 * block at :5892-5906 is identical). No table lookup exists in the C -- the switch
 * case hard-codes the flavor.
 */
export const CONFUSE_BERRY_FLAVORS: Readonly<Record<string, number>> = {
  HOLD_EFFECT_CONFUSE_SPICY: 0,
  HOLD_EFFECT_CONFUSE_DRY: 1,
  HOLD_EFFECT_CONFUSE_SWEET: 2,
  HOLD_EFFECT_CONFUSE_BITTER: 3,
  HOLD_EFFECT_CONFUSE_SOUR: 4,
}

/**
 * Lookups the bridge performs. Every method may return undefined; the bridge
 * treats a miss as a GAP rather than substituting a default, so a context
 * missing an entry produces a visibly incomplete answer instead of a plausible
 * one.
 */
export interface SimDataContext {
  species(id: string): SimSpeciesData | undefined
  item(id: string): SimItemData | undefined
  move(id: string): SimMoveData | undefined
  megaEvolutionSpecies?(speciesId: string, itemId: string): string | undefined
  primalReversionSpecies?(speciesId: string, itemId: string): string | undefined
  /** GetFlavorRelationByNature (src/pokemon.c:4185-4188), for HealConfuseBerry's
   * `relation < 0` confusion branch (src/battle_util.c:5181-5186). `flavor` is one
   * of FLAVOR_SPICY..FLAVOR_SOUR (include/constants/berry.h:13-17); see
   * CONFUSE_BERRY_FLAVORS for the HOLD_EFFECT_CONFUSE_* -> flavor mapping.
   * MUST throw on an unknown nature rather than return 0 -- see
   * flavorRelationByNature's own doc. Optional only because hand-built test
   * fixtures predate it; the driver's context (driver/loadSimData.ts) always
   * supplies it, and callers fall back to the exported flavorRelationByNature
   * when it is absent, which throws the same way. */
  natureFlavorRelation?(nature: string, flavor: number): number
}
