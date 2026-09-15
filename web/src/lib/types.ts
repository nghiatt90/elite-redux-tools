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
  height: number // decimetres
  weight: number // hectograms -- Low Kick/Heat Crash read this
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

// The Move.argument oneof (MoveList.proto's 6-way `Argument` message) -- the extra
// parameter some MoveBehaviors need. See pipeline/src/erdata/emit.py's
// _argument_to_dict.
export type MoveArgument =
  | { kind: 'type'; type: string }
  | { kind: 'effect'; effect: string; affectsUser: boolean; certain: boolean }
  | { kind: 'int'; value: number }
  | { kind: 'other'; value: string }
  | { kind: 'status'; status: string }
  | { kind: 'misc'; misc: string }

export interface Move {
  id: string
  name: string
  shortName: string
  description: string
  shortDescription: string
  type: string | null
  type2: string | null // ER dual-typed moves compute damage against both and keep the larger
  power: number
  accuracy: number
  pp: number
  priority: number
  effectChance: number
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  target: string | null
  // `effect` is the MoveBehavior enum -- the actual mechanic (multi-hit, recoil,
  // fixed damage, ...); `customBehavior` is a one-off inline MoveBehaviorConfig for
  // the handful of moves that don't reference a named behavior. Exactly one is set.
  effect: string | null
  customBehavior: MoveBehaviorConfig | null
  splitFlag?: string // USE_HIGHEST_OFFENSE | USE_LOWEST_DEFENSE | HITS_SPDEF | HITS_DEF | USE_HIGHEST_DAMAGE
  crit?: 'HIGH' | 'ALWAYS'
  hitsAir?: 'HITS' | 'DOUBLE_DAMAGE'
  hitCount?: number
  argument?: MoveArgument
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

// moveBehaviors.json / abilityHooks.json / natures.json -- damage-calculator-only
// artifacts (see lib/data.ts's loadMoveBehaviors/loadNatures/loadAbilityHooks).
// Kept loosely typed here rather than as a byte-precise mirror of
// erdata.move_behavior/behaviors/ability_hooks's output: the damage engine
// (web/src/engine/*.ts) owns the precise, strictly-typed shapes it actually
// pattern-matches on (MoveBehaviors in engine/basePower.ts, ScriptCondition in
// engine/conditions.ts, AbilityImpl/AbilityEntry in engine/abilities/types.ts) --
// these three are just what gets fetched-and-handed-off to it.
export type MoveBehaviorConfig = Record<string, unknown>
export interface MoveBehaviorsFile {
  behaviors: Record<string, MoveBehaviorConfig>
  moveEffectOptions: Record<string, Record<string, boolean>>
}
export interface BattleConstants {
  natureStatTable: Record<string, Record<'ATK' | 'DEF' | 'SPEED' | 'SPATK' | 'SPDEF', -1 | 0 | 1>>
  statStageRatios: [number, number][]
  criticalHitChance: number[]
  maxIvs: number
  maxEvPerStat: number
  maxEvTotal: number
  maxLevel: number
  defaultStatStage: number
  uq412Precision: number
}
export interface AbilityHookEntry {
  id: string
  sourceLine: number
  endLine: number
  hooks: Record<string, { form: string; source: string; aliasTarget?: string; aliasHook?: string; macroName?: string; macroArgs?: string }>
  applyOn: Record<string, string>
  bitfields: Record<string, string>
  damageRelevant: boolean
  damageRelevantReasons: string[]
}
export type AbilityHooks = Record<string, AbilityHookEntry>

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
  holdEffect: string // HoldEffect enum, e.g. "HOLD_EFFECT_MEGA_STONE" -- often "HOLD_EFFECT_CUSTOM" (17 of 20 real hold effects collapse to this in the raw proto); use resolvedHoldEffect for the actual mechanic
  resolvedHoldEffect: string // HOLD_EFFECT_CUSTOM de-aliased, e.g. "HOLD_EFFECT_LIFE_ORB" for Life Orb -- what the ROM's code actually gets
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
  naturalGift?: { power: number; type: string; affectsUser: boolean; certain: boolean; effect?: string; priority?: number }
}

export interface TrainerEvs {
  hp: number
  atk: number
  def: number
  spatk: number
  spdef: number
  spe: number
}

export interface TrainerMon {
  species: string
  item: string // ItemEnum id, e.g. "ITEM_LEFTOVERS"
  nature: string // Nature enum, e.g. "NATURE_ADAMANT"
  ability: string // GAME TRUTH: the AbilityEnum id of the ability *slot* the mon fights
  // with, resolved against its species' declared ability list the same way
  // TrainerPartyGenerator.kt does, NOT the textproto value transcribed verbatim (the two
  // differ on 252 party entries across 130 trainers: the codegen silently falls back to
  // the species' own slot 0 whenever the named ability isn't one of that species'
  // declared abilities -- 80 of those 252 name one of the species' own innates instead).
  // The species' three innates apply *on top of* this slot ability in-game, they are
  // never a substitute for it -- see that species' own "innates" in species.json, this
  // field only ever resolves to one of its "abilities". See
  // pipeline/src/erdata/emit.py's _resolve_effective_ability for the full citation.
  abilityDivergence?: boolean // true when "ability" above differs from the textproto's
  // named value (i.e. the codegen's indexOf fallback kicked in); absent when they agree.
  // Filter on this field alone to find every "config asked for something this species
  // cannot have" entry -- don't diff "ability" against "textprotoAbility" by hand.
  textprotoAbility?: string // CONFIG TRUTH: the textproto's named AbilityEnum id, present
  // only when abilityDivergence is true -- what er-config asked for, not what the ROM
  // fields. Kept as evidence the divergence exists, not silently discarded; a future
  // repin of er-config/eliteredux-source may make some of these resolve cleanly.
  evs: TrainerEvs
  moves: string[] // MoveEnum ids, up to 4
  ironPill: boolean // zeroes this mon's Speed IV; every other stat's IV is forced to 31 regardless
  hiddenPowerType: string // bare Type enum; defaults to "TYPE_NORMAL" when unset in the textproto
  nonstandard?: string // free-text override reason (e.g. "Invalid moves: [...]") that makes
  // the upstream codegen skip this mon; no runtime effect, carried through as a label only
}

export interface TrainerParties {
  ace: TrainerMon[]
  elite: TrainerMon[] // falls back to ace when empty in the textproto (common: 503 of the 932
  // real trainers -- the id-0 TRAINER_NONE placeholder already dropped -- leave the raw
  // textproto elite tier empty; re-measured against TrainerList.textproto directly, see
  // pipeline/src/erdata/trainers.py's resolve_party_tiers comment)
  hell: TrainerMon[] // falls back to the *resolved* elite (which may itself have fallen back to
  // ace), not directly to ace (common: 533 of the same 932 real trainers leave the raw
  // textproto hell tier empty) -- see resolve_party_tiers
}

// Deliberately absent: level (derived at battle time from the player's highest party
// level, see CLAUDE.md -- not parsed game data), IVs (forced to 31 on recalculation),
// trainer-level bag items and isAlpha (no such fields exist in the Trainer message).
export interface Trainer {
  id: string // TrainerEnum id, e.g. "TRAINER_SAWYER_1"
  trainerNum: number // raw TrainerEnum value
  name: string
  gender: string // "MALE" | "FEMALE" | ...
  hasTrainerFlag: boolean // present in the schema but never read by gTrainers[] emission -- purpose unverified
  forcedDouble: boolean
  risky: boolean
  preferStatus: boolean
  preferStall: boolean
  noSwitching: boolean
  class: string | null // TrainerClass enum, e.g. "TRAINER_CLASS_HIKER"
  pic: string | null // TrainerPic enum
  music: string | null // TrainerMusic enum
  parties: TrainerParties
}

// Mirrors pipeline/src/erdata/encounters.py's scrape_encounters() output exactly --
// per-battle environment facts scraped from map scripts, not proto data. "guard" is
// the innermost enclosing condition's own source text (or its negation, for an
// `else`), or null when unconditional -- see that module's own doc for the
// innermost-only limitation and the frame-compatible "trainers" aggregation.
export interface FieldEffect {
  map: string
  script: string
  effectType: string // e.g. "BATTLE_FIELD_EFFECT_ROOM", "BATTLE_FIELD_EFFECT_MONOCHAMP"
  fieldId: string // e.g. "STATUS_FIELD_TRICK_ROOM" for ROOM, "TYPE_NORMAL" for MONOCHAMP
  guard: string | null
  trainers: string[]
}

export interface BattleEvent {
  map: string
  script: string
  event: string // e.g. "BATTLE_EVENT_SPIKES" -- a gym's per-trainer Hell-mode skill
  data0: number | null
  data1: number | null
  guard: string | null
}

export interface TrainerChain {
  map: string
  script: string
  trainers: string[] // 2+ distinct ids, reachable together in one playthrough
  healFree: boolean // FLAG_SYS_DISABLE_AUTOHEAL bracketed every member but the first
}

export interface TagBattle {
  map: string
  script: string
  trainers: [string, string] // starttagbattle's own two ids, in call order
  guard: string | null
}

// FLAG_SYS_INVERSE_BATTLE (aliased B_FLAG_INVERSE_BATTLE) activations -- a
// battle-format flag, not a VAR_BATTLE_FIELD_* write, so it's tracked and emitted
// separately from "fieldEffects" even though the one real occurrence sits alongside
// a Trick Room fieldEffects row for the same trainer. See _pair_inverse_battles's
// own doc (encounters.py) for why this is the same {map, script, guard, trainers}
// shape as FieldEffect rather than a bespoke one.
export interface InverseBattle {
  map: string
  script: string
  guard: string | null
  trainers: string[]
}

export interface Encounters {
  fieldEffects: FieldEffect[]
  battleEvents: BattleEvent[]
  trainerChains: TrainerChain[]
  tagBattles: TagBattle[]
  inverseBattles: InverseBattle[]
}

// typeChart[attackingType][defendingType] = multiplier
export type TypeChart = Record<string, Record<string, number>>

export interface Meta {
  gameVersion: string
  generatedAt: string
  sources: Record<string, { repo: string; sha: string; date: string }>
  counts: { species: number; moves: number; abilities: number; items: number; moveBehaviors: number; abilityHooks: number; trainers: number }
  abilitiesCount: number // the randomizer LCG's modulus (ABILITIES_COUNT in-game); not
  // always equal to counts.abilities -- see emit.py's _abilities_count
}
