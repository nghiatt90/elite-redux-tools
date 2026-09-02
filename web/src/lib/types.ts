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
  item?: number // raw ItemEnum id -- not resolved to a name, no items.json exists yet
  move?: string
}

export interface Primal {
  from: string
  item: number // raw ItemEnum id, same caveat as Mega.item
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
  name: string
  description: string
  expandedDescription?: string
  grantsType?: string // bare type name, e.g. "DRAGON" -- this ability adds a type on top of the species' own
  components?: string[] // AbilityEnum ids -- present only for compound abilities (e.g. "Big Leaves"), whose
  // description is an exact " + "-joined list of these components' own names
}

// typeChart[attackingType][defendingType] = multiplier
export type TypeChart = Record<string, Record<string, number>>

export interface Meta {
  gameVersion: string
  generatedAt: string
  sources: Record<string, { repo: string; sha: string; date: string }>
  counts: { species: number; moves: number; abilities: number }
}
