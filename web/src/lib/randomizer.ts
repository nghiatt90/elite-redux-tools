/** Reverse-search core for Elite Redux's ability/innate randomizer.
 *
 * The randomizer is a pure, deterministic function of
 * (source ability, species, personality/PID) -- not a per-save RNG seed. See
 * src/pokemon.c's RandomizeAbility/RandomizeInnate (eliteredux-source, pinned SHA in
 * sources.lock.json):
 *
 *   seed = source ^ iso(species) ^ pid
 *   do { seed = iso(seed); result = roll(seed) } while (banned(result))
 *   return result
 *
 * where iso(v) = 1103515245*v + 24691 (mod 2^32) and
 * roll(seed) = ((seed >>> 16) % (abilitiesCount - 1)) + 1. A banned *source* (this
 * includes ABILITY_NONE, itself banned) is returned unchanged, and so is any source
 * when the corresponding randomizedMode flag is off in-game.
 *
 * Because iso's multiplier is odd, it's a bijection mod 2^32 and the whole mapping
 * inverts analytically -- this module never brute-forces the 2^32 PID space; see
 * `searchSpecies` for the reverse-search algorithm.
 *
 * All arithmetic is forced to uint32 via Math.imul / >>> 0 -- the easiest thing to
 * get wrong in JS, where numbers are IEEE doubles that lose integer precision at 2^53
 * but silently misbehave under bitwise ops well before that unless coerced.
 */

import type { Ability, Species } from './types'

// ---------------------------------------------------------------------------------
// Forward math
// ---------------------------------------------------------------------------------

const MULTIPLIER = 1103515245
const INCREMENT = 24691

export function iso(v: number): number {
  return (Math.imul(MULTIPLIER, v) + INCREMENT) >>> 0
}

// Modular inverse of MULTIPLIER mod 2^32, via Newton's iteration -- valid because the
// multiplier is odd, hence invertible mod 2^32: inv_(k+1) = inv_k * (2 - a*inv_k).
// Starting from inv_0 = a (correct to 1 bit, since a odd => a*a === 1 mod 2), each
// round doubles the number of correct low bits; 5 rounds (1->2->4->8->16->32) reaches
// full 32-bit correctness.
function modularInverse(a: number): number {
  let inv = a
  for (let i = 0; i < 5; i++) {
    inv = Math.imul(inv, 2 - Math.imul(a, inv))
  }
  return inv >>> 0
}

const MULTIPLIER_INVERSE = modularInverse(MULTIPLIER)

/** The inverse of `iso`: `isoInverse(iso(v)) === v` for every uint32 v. */
export function isoInverse(v: number): number {
  return Math.imul(((v >>> 0) - INCREMENT) >>> 0, MULTIPLIER_INVERSE) >>> 0
}

/** `seed` here is the *post*-iso value (i.e. what `RandRangeDeterministic` computes
 * from *its* seed argument after advancing it once). */
export function roll(seed: number, abilitiesCount: number): number {
  return ((seed >>> 16) % (abilitiesCount - 1)) + 1
}

export interface RandomizerContext {
  abilitiesCount: number
  /** length `abilitiesCount`; 1 = randomizerBanned (includes ABILITY_NONE = 0). */
  bannedByNum: Uint8Array
}

function isFixed(source: number, ctx: RandomizerContext, enabled: boolean): boolean {
  return !enabled || ctx.bannedByNum[source] === 1
}

/** Faithful forward port of RandomizeInnate/RandomizeAbility. `enabled` mirrors the
 * corresponding `abilityRandomizedMode`/`innaterandomizedMode` save flag -- when off,
 * or when `source` is randomizer-banned, the value is returned unchanged. Otherwise
 * the reroll loop continues the LCG chain (it does not restart from the initial
 * seed), and a value may map to itself -- there is no identity guard here, unlike
 * RandomizeType. */
export function randomizeOne(
  source: number,
  species: number,
  pid: number,
  ctx: RandomizerContext,
  enabled: boolean,
): number {
  if (isFixed(source, ctx, enabled)) return source
  let seed = (source ^ iso(species) ^ pid) >>> 0
  let result: number
  do {
    seed = iso(seed)
    result = roll(seed, ctx.abilitiesCount)
  } while (ctx.bannedByNum[result])
  return result
}

// ---------------------------------------------------------------------------------
// Ability groups / accept-sets
// ---------------------------------------------------------------------------------

export interface AbilityGroups {
  abilitiesCount: number
  numById: Map<string, number>
  idByNum: string[]
  bannedByNum: Uint8Array
  /** abilityNum -> component abilityNums, for compound abilities. */
  componentsByNum: Map<number, number[]>
  /** abilityNum -> compounds (abilityNums) whose components include it. */
  compoundsContainingByNum: Map<number, number[]>
  /** abilityNum -> the full exact-equivalence group it belongs to (including itself). */
  equivalenceGroupByNum: Map<number, number[]>
  /** abilityNum -> the full curated near-equivalent group it belongs to (including itself). */
  nearEquivalentGroupByNum: Map<number, number[]>
}

export function buildAbilityGroups(abilities: Ability[], abilitiesCount: number): AbilityGroups {
  const numById = new Map<string, number>()
  const idByNum: string[] = new Array(abilitiesCount)
  const bannedByNum = new Uint8Array(abilitiesCount)
  for (const a of abilities) {
    numById.set(a.id, a.abilityNum)
    idByNum[a.abilityNum] = a.id
    if (a.randomizerBanned) bannedByNum[a.abilityNum] = 1
  }

  const componentsByNum = new Map<number, number[]>()
  const compoundsContainingByNum = new Map<number, number[]>()
  const equivalenceGroupByNum = new Map<number, number[]>()
  const nearEquivalentGroupByNum = new Map<number, number[]>()

  for (const a of abilities) {
    const num = a.abilityNum
    if (a.components) {
      const componentNums = a.components.map((id) => numById.get(id)!).filter((n) => n !== undefined)
      componentsByNum.set(num, componentNums)
      for (const c of componentNums) {
        const list = compoundsContainingByNum.get(c) ?? []
        list.push(num)
        compoundsContainingByNum.set(c, list)
      }
    }
    if (a.equivalenceGroup) {
      equivalenceGroupByNum.set(num, a.equivalenceGroup.map((id) => numById.get(id)!))
    }
    if (a.nearEquivalentGroup) {
      nearEquivalentGroupByNum.set(num, a.nearEquivalentGroup.map((id) => numById.get(id)!))
    }
  }

  return {
    abilitiesCount,
    numById,
    idByNum,
    bannedByNum,
    componentsByNum,
    compoundsContainingByNum,
    equivalenceGroupByNum,
    nearEquivalentGroupByNum,
  }
}

export function contextFromGroups(groups: AbilityGroups): RandomizerContext {
  return { abilitiesCount: groups.abilitiesCount, bannedByNum: groups.bannedByNum }
}

export interface AcceptSetOptions {
  compounds: boolean
  exactGroups: boolean
  curatedGroups: boolean
}

/** accept(A) = {A} ∪ exactGroup(A) ∪ curatedGroup(A) ∪ { C : C compound, A ∈ components(C) } --
 * each term gated by its own toggle. Only A's own compounds are unioned in (not a
 * group-sibling's), matching the pipeline's per-ability `components`/group fields. */
export function buildAcceptSet(targetNum: number, groups: AbilityGroups, options: AcceptSetOptions): Uint8Array {
  const set = new Uint8Array(groups.abilitiesCount)
  set[targetNum] = 1
  if (options.exactGroups) {
    for (const n of groups.equivalenceGroupByNum.get(targetNum) ?? []) set[n] = 1
  }
  if (options.curatedGroups) {
    for (const n of groups.nearEquivalentGroupByNum.get(targetNum) ?? []) set[n] = 1
  }
  if (options.compounds) {
    for (const n of groups.compoundsContainingByNum.get(targetNum) ?? []) set[n] = 1
  }
  return set
}

export function acceptSetSize(set: Uint8Array): number {
  let n = 0
  for (const v of set) n += v
  return n
}

export function acceptSetMembers(set: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < set.length; i++) if (set[i]) out.push(i)
  return out
}

export interface Condition {
  /** Original locked ability, for display -- not used in matching itself. */
  targetNum: number
  acceptSet: Uint8Array
}

export function buildCondition(targetNum: number, groups: AbilityGroups, options: AcceptSetOptions): Condition {
  return { targetNum, acceptSet: buildAcceptSet(targetNum, groups, options) }
}

// ---------------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------------

export interface SpeciesEntry {
  num: number
  id: string
  /** Up to 3 declared ability-slot source values (ABILITY_NONE dropped). Player
   * picks exactly one at a time via GetAbilityBySpecies(species, abilityNum). */
  abilityOptions: number[]
  /** Up to 3 declared innate source values (ABILITY_NONE dropped); all present at once. */
  innateSources: number[]
  fullyEvolved: boolean
}

export function buildSpeciesEntry(species: Species, groups: AbilityGroups): SpeciesEntry {
  const toNums = (ids: string[]) =>
    ids.map((id) => groups.numById.get(id) ?? 0).filter((n) => n !== 0)
  return {
    num: species.speciesNum,
    id: species.id,
    abilityOptions: toNums(species.abilities),
    innateSources: toNums(species.innates),
    fullyEvolved: species.evolutions.length === 0,
  }
}

// ---------------------------------------------------------------------------------
// Matching model
// ---------------------------------------------------------------------------------

export interface MatchResult {
  speciesNum: number
  pid: number
  /** Which declared ability-slot index (0-based) the player must pick. */
  abilityNum: number
  /** Minimum number of distinct result elements that cover every condition -- a
   * lower cost means an ability/compound/group did double duty. */
  slotCost: number
  /** [activeAbility, ...innates] for the winning abilityNum choice. */
  resultAbilities: number[]
}

function popcount4(n: number): number {
  return ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1)
}

/** Brute-forced minimum hitting set over `memberBitmasks` (one bitmask per condition,
 * bit j set iff result element j satisfies it) -- at most 16 subsets since a result
 * has at most 4 elements. */
function minHittingSetSize(resultLength: number, memberBitmasks: number[]): number {
  const full = 1 << resultLength
  let best = resultLength
  for (let subset = 1; subset < full; subset++) {
    const size = popcount4(subset)
    if (size >= best) continue
    if (memberBitmasks.every((bits) => (subset & bits) !== 0)) best = size
  }
  return best
}

/** Evaluates one (species, pid) pair against every condition, enumerating each
 * declared ability-slot choice k independently -- this is what makes mutual
 * exclusivity correct by construction: two conditions satisfiable only via two
 * *different* ability options can never both be served within the same k's result.
 * Returns the lowest-slot-cost matching k, or null if no k satisfies every condition. */
export function evaluateSpeciesAtPid(
  species: SpeciesEntry,
  pid: number,
  conditions: Condition[],
  ctx: RandomizerContext,
  modes: SearchModes,
): MatchResult | null {
  if (conditions.length === 0 || species.abilityOptions.length === 0) return null

  const innateResults = species.innateSources.map((src) =>
    randomizeOne(src, species.num, pid, ctx, modes.innateRandomized),
  )

  let best: MatchResult | null = null

  for (let k = 0; k < species.abilityOptions.length; k++) {
    const abilityResult = randomizeOne(species.abilityOptions[k], species.num, pid, ctx, modes.abilityRandomized)
    const r = [abilityResult, ...innateResults]

    const memberBitmasks: number[] = []
    let allSatisfied = true
    for (const cond of conditions) {
      let bits = 0
      for (let j = 0; j < r.length; j++) {
        if (cond.acceptSet[r[j]]) bits |= 1 << j
      }
      if (bits === 0) {
        allSatisfied = false
        break
      }
      memberBitmasks.push(bits)
    }
    if (!allSatisfied) continue

    const slotCost = minHittingSetSize(r.length, memberBitmasks)
    if (!best || slotCost < best.slotCost || (slotCost === best.slotCost && k < best.abilityNum)) {
      best = { speciesNum: species.num, pid, abilityNum: k, slotCost, resultAbilities: r }
    }
  }

  return best
}

export interface SearchModes {
  abilityRandomized: boolean
  innateRandomized: boolean
}

// ---------------------------------------------------------------------------------
// Reverse search
// ---------------------------------------------------------------------------------

/** The ~63 values of `h` (top 16 bits of a post-iso seed) in [0, 2^16) with
 * `roll((h<<16)|lo) === target` for every `lo` -- roll only depends on the top bits. */
function terminalHValues(target: number, abilitiesCount: number): number[] {
  const modulus = abilitiesCount - 1
  const remainder = (target - 1) % modulus
  const hs: number[] = []
  for (let h = remainder; h < 65536; h += modulus) hs.push(h)
  return hs
}

/** Given a terminal seed `s` with `roll(s) === target`, returns every valid seed0
 * (the pre-loop `source ^ iso(species) ^ pid` value) that reaches `target` through
 * `s` -- normally just one (no reroll), but extends backwards through banned-reroll
 * chains: while the previous step's roll would have been banned (forcing a reroll in
 * the forward direction), the seed before *that* is a valid seed0 too. */
function seed0CandidatesFromTerminal(terminalSeed: number, ctx: RandomizerContext): number[] {
  const seed0s: number[] = []
  let cur = terminalSeed >>> 0
  seed0s.push(isoInverse(cur))
  for (;;) {
    cur = isoInverse(cur)
    if (!ctx.bannedByNum[roll(cur, ctx.abilitiesCount)]) break
    seed0s.push(isoInverse(cur))
  }
  return seed0s
}

/** Every PID such that `randomizeOne(source, species, pid, ctx, true) === target`,
 * for a non-banned target. ~4.1M terminal seeds (63 h-values × 65536 lo) instead of
 * scanning the full 2^32 PID space. */
export function reverseSearchOne(source: number, target: number, species: number, ctx: RandomizerContext): number[] {
  if (ctx.bannedByNum[target]) return []
  const speciesIso = iso(species)
  const pids: number[] = []
  for (const h of terminalHValues(target, ctx.abilitiesCount)) {
    const base = h << 16
    for (let lo = 0; lo < 65536; lo++) {
      const terminal = (base | lo) >>> 0
      for (const seed0 of seed0CandidatesFromTerminal(terminal, ctx)) {
        pids.push((seed0 ^ source ^ speciesIso) >>> 0)
      }
    }
  }
  return pids
}

function variableSources(species: SpeciesEntry, ctx: RandomizerContext, modes: SearchModes): number[] {
  const sources = new Set<number>()
  for (const src of species.abilityOptions) if (!isFixed(src, ctx, modes.abilityRandomized)) sources.add(src)
  for (const src of species.innateSources) if (!isFixed(src, ctx, modes.innateRandomized)) sources.add(src)
  return [...sources]
}

/** A species whose *every* declared ability-slot choice k has all its conditions
 * satisfied purely by fixed (banned/mode-off) slots matches every PID -- not
 * enumerable, and must be surfaced distinctly rather than silently truncated. Returns
 * the first such k, or null. */
function findTrivialAllMatchK(
  species: SpeciesEntry,
  conditions: Condition[],
  ctx: RandomizerContext,
  modes: SearchModes,
): number | null {
  for (let k = 0; k < species.abilityOptions.length; k++) {
    const fixedValues: number[] = []
    if (isFixed(species.abilityOptions[k], ctx, modes.abilityRandomized)) fixedValues.push(species.abilityOptions[k])
    for (const src of species.innateSources) {
      if (isFixed(src, ctx, modes.innateRandomized)) fixedValues.push(src)
    }
    if (conditions.every((c) => fixedValues.some((v) => c.acceptSet[v]))) return k
  }
  return null
}

// A single locked condition's candidates commonly run into the tens of millions (the
// plan's own estimate: ~25M PIDs for one locked ability, once every source slot is
// counted) -- well past V8's native Set/Map size cap (~2^24 entries in this Node/V8),
// which a plain `Set<number>` silently hits with "Set maximum size exceeded". This is
// a bare open-addressing hash set over uint32 values instead, backed by typed arrays,
// with no such ceiling; it grows by doubling when its load factor passes 0.7.
class Uint32HashSet {
  private table: Uint32Array
  private occupied: Uint8Array
  private mask: number
  size = 0

  constructor(initialCapacity = 1 << 16) {
    let capacity = 1
    while (capacity < initialCapacity) capacity *= 2
    this.table = new Uint32Array(capacity)
    this.occupied = new Uint8Array(capacity)
    this.mask = capacity - 1
  }

  add(value: number): void {
    if ((this.size + 1) / this.table.length > 0.7) this.grow()
    let idx = (Math.imul(value, 2654435761) >>> 0) & this.mask
    while (this.occupied[idx]) {
      if (this.table[idx] === value) return
      idx = (idx + 1) & this.mask
    }
    this.table[idx] = value
    this.occupied[idx] = 1
    this.size++
  }

  private grow(): void {
    const oldTable = this.table
    const oldOccupied = this.occupied
    const newCapacity = this.table.length * 2
    this.table = new Uint32Array(newCapacity)
    this.occupied = new Uint8Array(newCapacity)
    this.mask = newCapacity - 1
    this.size = 0
    for (let i = 0; i < oldTable.length; i++) {
      if (oldOccupied[i]) this.add(oldTable[i])
    }
  }

  *[Symbol.iterator](): Generator<number> {
    for (let i = 0; i < this.table.length; i++) {
      if (this.occupied[i]) yield this.table[i]
    }
  }
}

function generateCandidatePids(
  targetAcceptSet: Uint8Array,
  sources: number[],
  species: SpeciesEntry,
  ctx: RandomizerContext,
): Uint32HashSet {
  // ~4.1M candidates per (source, target) pair at the real modulus -- size the table
  // up front so `add` isn't doubling+rehashing repeatedly during the biggest search.
  const perPairEstimate = Math.ceil(65536 / (ctx.abilitiesCount - 1)) * 65536 * 1.1
  const targetCount = acceptSetSize(targetAcceptSet)
  const pids = new Uint32HashSet(Math.ceil((sources.length * targetCount * perPairEstimate) / 0.7) + 16)
  for (const source of sources) {
    for (let target = 0; target < ctx.abilitiesCount; target++) {
      if (!targetAcceptSet[target]) continue
      for (const pid of reverseSearchOne(source, target, species.num, ctx)) pids.add(pid)
    }
  }
  return pids
}

// ---------------------------------------------------------------------------------
// Results: promoted (bounded top-K by slot cost) + reservoir sample
// ---------------------------------------------------------------------------------

function insertPromoted(promoted: MatchResult[], match: MatchResult, cap: number): void {
  const rank = (m: MatchResult) => m.slotCost * 2 ** 32 + m.pid
  if (promoted.length < cap) {
    promoted.push(match)
    promoted.sort((a, b) => rank(a) - rank(b))
    return
  }
  const worst = promoted[promoted.length - 1]
  if (rank(match) < rank(worst)) {
    promoted[promoted.length - 1] = match
    promoted.sort((a, b) => rank(a) - rank(b))
  }
}

export type RandomizerResults =
  | { kind: 'trivial-all-match'; abilityNum: number }
  | {
      kind: 'complete'
      total: number
      bySlotCost: Map<number, number>
      promoted: MatchResult[]
      sample: MatchResult[]
    }

/** Exact, complete reverse search for one species: every PID matching every locked
 * condition. Generates candidates only from the condition with the smallest
 * accept-set (across every variable source slot the species has), then verifies each
 * candidate against *all* conditions -- so completeness never depends on which
 * condition happened to generate a given candidate. */
export function searchSpecies(
  species: SpeciesEntry,
  conditions: Condition[],
  ctx: RandomizerContext,
  modes: SearchModes,
  options: { promotedSize?: number; reservoirSize?: number; rng?: () => number } = {},
): RandomizerResults {
  const promotedSize = options.promotedSize ?? 20
  const reservoirSize = options.reservoirSize ?? 1000
  const rng = options.rng ?? Math.random

  const empty: RandomizerResults = {
    kind: 'complete',
    total: 0,
    bySlotCost: new Map(),
    promoted: [],
    sample: [],
  }
  if (conditions.length === 0 || species.abilityOptions.length === 0) return empty

  const trivialK = findTrivialAllMatchK(species, conditions, ctx, modes)
  if (trivialK !== null) return { kind: 'trivial-all-match', abilityNum: trivialK }

  const sources = variableSources(species, ctx, modes)
  if (sources.length === 0) return empty

  let generatingCondition = conditions[0]
  for (const c of conditions) {
    if (acceptSetSize(c.acceptSet) < acceptSetSize(generatingCondition.acceptSet)) generatingCondition = c
  }

  const candidates = generateCandidatePids(generatingCondition.acceptSet, sources, species, ctx)

  let total = 0
  const bySlotCost = new Map<number, number>()
  const promoted: MatchResult[] = []
  const reservoir: MatchResult[] = []

  for (const pid of candidates) {
    const match = evaluateSpeciesAtPid(species, pid, conditions, ctx, modes)
    if (!match) continue
    total++
    bySlotCost.set(match.slotCost, (bySlotCost.get(match.slotCost) ?? 0) + 1)
    insertPromoted(promoted, match, promotedSize)

    if (reservoir.length < reservoirSize) {
      reservoir.push(match)
    } else {
      const j = Math.floor(rng() * total)
      if (j < reservoirSize) reservoir[j] = match
    }
  }

  return { kind: 'complete', total, bySlotCost, promoted, sample: reservoir }
}
