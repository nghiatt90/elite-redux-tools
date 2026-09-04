// Mirrors pipeline/src/erdata/emit.py's output shape exactly -- see data/v2.65beta/*.json.

export interface BaseStats {
  hp: number
  atk: number
  def: number
  spatk: number
  spdef: number
  spe: number
}

export interface Gender {
  genderless?: true
  percentFemale?: number
}

export interface Evolution {
  to: string
  level?: number
  gender?: string
}

export interface Mega {
  from: string
  megaType: string
  item?: string // ItemEnum id, e.g. "ITEM_CHARIZARDITE_X" -- look up in items.json
  move?: string
}

export interface Primal {
  from: string
  item: string // ItemEnum id, same as Mega.item
  primalType: string
}

export interface LevelUpEntry {
  level: number
  moves: string[]
}

export interface Learnset {
  levelUp: LevelUpEntry[]
  tutor: string[]
}

export interface Species {
  id: string
  speciesNum: number // raw SpeciesEnum value, e.g. 25 for Pikachu -- the "Pokemon ID", distinct from nationalDexNum
  name: string
  longName?: string
  category: string
  description: string
  nationalDexNum: number
  isForm: boolean
  formOf: string | null
  types: string[]
  baseStats: BaseStats
  abilities: string[]
  innates: string[]
  gender: Gender
  heads?: number
  evolutions: Evolution[]
  megas: Mega[]
  primals: Primal[]
  learnset: Learnset
}

export interface MoveFlags {
  [flag: string]: true
}

export interface Move {
  id: string
  name: string
  shortName: string
  description: string
  shortDescription: string
  type: string | null
  power: number
  accuracy: number
  pp: number
  priority: number
  effectChance: number
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  target: string | null
  flags: MoveFlags
  tutorCategory?: string
}

export interface Ability {
  id: string
  abilityNum: number // raw AbilityEnum value -- the randomizer's own numbering, gap-free 0..meta.abilitiesCount-1
  name: string
  description: string
  expandedDescription?: string
  grantsType?: string // bare type name, e.g. "DRAGON" -- this ability adds a type on top of the species' own
  components?: string[] // AbilityEnum ids -- present only for compound abilities (e.g. "Big Leaves"), whose
  // description is an exact " + "-joined list of these components' own names
  randomizerBanned: boolean // can never appear as a randomizer source or result (src/pokemon.c RandomizeAbility/RandomizeInnate)
  equivalenceGroup?: string[] // AbilityEnum ids (including this one) sharing an identical `description` --
  // interchangeable for randomizer-search purposes; see pipeline/src/erdata/emit.py
  nearEquivalentGroup?: string[] // AbilityEnum ids (including this one), hand-curated near-equivalents
  // exact-group derivation can't catch (e.g. Mold Breaker/Teravolt/Turboblaze) -- see ability_groups.py
}

// Mirrors er-config's own `mega_stone_hint` oneof -- the same 4-way choice that
// drives the in-game hint text (GetMegaHintString in the compiled ROM), not
// something this app invented. "uniqueLocation" carries the exact in-game string;
// the other 3 kinds are stable enough phrasing to hardcode at the call site.
export type MegaStoneHint =
  | { kind: 'nurseJoy' }
  | { kind: 'adoptionCenter' }
  | { kind: 'legendarySage' }
  | { kind: 'uniqueLocation'; text: string }

export interface Item {
  id: string
  itemNum: number // raw ItemEnum value
  name: string
  description: string
  grouping: string // Pocket enum, e.g. "POCKET_MEGA_STONES"
  holdEffect: string // HoldEffect enum, e.g. "HOLD_EFFECT_MEGA_STONE"
  useType: string
  holdEffectStrength?: number
  holdEffectType?: string // bare Type enum, e.g. "TYPE_FIRE" -- for Plates/Gems/etc.
  holdEffectAlias?: string
  holdEffectMiscParam?: string
  bpPrice?: number
  megaBadgeRequirement?: number // 1-8 = FLAG_BADGEnn_GET, 9 = FLAG_SYS_GAME_CLEAR --
  // per-item metadata from er-config, not independently verified against map
  // scripts for every item (at least one, Slowkingite, is known stale -- see
  // evolutionChain.ts), so treat as a hint rather than fact.
  megaStoneHint?: MegaStoneHint
  naturalGift?: { power: number; type: string; affectsUser: boolean; certain: boolean }
}

// typeChart[attackingType][defendingType] = multiplier
export type TypeChart = Record<string, Record<string, number>>

export interface Meta {
  gameVersion: string
  generatedAt: string
  sources: Record<string, { repo: string; sha: string; date: string }>
  counts: { species: number; moves: number; abilities: number; items: number }
  abilitiesCount: number // the randomizer LCG's modulus (ABILITIES_COUNT in-game); not
  // always equal to counts.abilities -- see emit.py's _abilities_count
}
