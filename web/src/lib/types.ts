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
  item?: string
  move?: string
}

export interface Primal {
  from: string
  item: string
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
}

// typeChart[attackingType][defendingType] = multiplier
export type TypeChart = Record<string, Record<string, number>>

export interface Meta {
  gameVersion: string
  generatedAt: string
  sources: Record<string, { repo: string; sha: string; date: string }>
  counts: { species: number; moves: number; abilities: number }
}
