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
  megas?: unknown[]
  primals?: unknown[]
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
  naturalGift: { power: number; type: string } | null
  /** items.json's `grouping` (ItemList.proto Pocket, e.g. POCKET_BERRIES) --
   * `gItems[id].pocket` (ItemGenerator.kt:25), read by ItemId_GetPocket. */
  grouping?: string | null
}

/** The move fields the bridge needs beyond what a TurnOrderMoveView carries. */
export interface SimMoveData {
  id: string
  power: number
  type: string | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  effect: string | null
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
}
