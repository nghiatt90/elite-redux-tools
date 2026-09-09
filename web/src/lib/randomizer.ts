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

/** How many of an accept-set's members the randomizer can actually *produce*. Banned
 * abilities are never rolled, so they only ever appear as an untouched source -- a
 * condition with no generable member cannot enumerate candidates at all and can only
 * be satisfied by a fixed slot. */
export function generableSize(set: Uint8Array, ctx: RandomizerContext): number {
  let n = 0
  for (let i = 0; i < set.length; i++) if (set[i] && !ctx.bannedByNum[i]) n++
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
  /** [activeAbility, ...innates] for the winning abilityNum choice -- the values
   * matching and slot cost are computed over. */
  resultAbilities: number[]
  /** *Every* declared ability slot rolled, in slot order -- what the in-game ability
   * picker actually offers, of which `abilityNum` is the one to select. Only the
   * chosen one is live at a time, so this is display context, not part of matching. */
  abilityResults: number[]
}

function popcount4(n: number): number {
  return ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1)
}

/** Brute-forced minimum hitting set over `memberBitmasks` (one bitmask per condition,
 * bit j set iff result element j satisfies it) -- at most 16 subsets since a result
 * has at most 4 elements. */
function minHittingSetSize(
  resultLength: number,
  memberBitmasks: ArrayLike<number>,
  conditionCount: number = memberBitmasks.length,
): number {
  const full = 1 << resultLength
  let best = resultLength
  for (let subset = 1; subset < full; subset++) {
    const size = popcount4(subset)
    if (size >= best) continue
    let hitsAll = true
    for (let c = 0; c < conditionCount; c++) {
      if ((subset & memberBitmasks[c]) === 0) {
        hitsAll = false
        break
      }
    }
    if (hitsAll) best = size
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
  // Rolled for every slot rather than per k: the roll depends only on the source
  // ability, so the picker's other options are already determined and worth reporting.
  const abilityResults = species.abilityOptions.map((src) =>
    randomizeOne(src, species.num, pid, ctx, modes.abilityRandomized),
  )

  let best: MatchResult | null = null

  for (let k = 0; k < species.abilityOptions.length; k++) {
    const r = [abilityResults[k], ...innateResults]

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
      best = { speciesNum: species.num, pid, abilityNum: k, slotCost, resultAbilities: r, abilityResults }
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

// ---------------------------------------------------------------------------------
// Fused enumeration
// ---------------------------------------------------------------------------------

/** Precomputed per-species scratch for `searchSpecies`'s hot loop.
 *
 * `reverseSearchOne` + `evaluateSpeciesAtPid` say the same thing far more readably and
 * remain the reference the tests check against. This exists because the readable form
 * allocates: an array per terminal seed, a ~4.4M-entry array per (source, target)
 * pair, several small arrays per candidate, and -- worst of all -- a dedup hash table
 * sized from the candidate estimate, which for a 6-source search rounded up to 2^26
 * entries, i.e. ~335MB allocated and discarded *per species*. At tens of millions of
 * candidates that allocation, not the arithmetic, was the runtime.
 *
 * Two structural facts make the fused form possible:
 *
 * 1. **One seed0 serves every source.** A candidate is `q = seed0 ^ sources[g]`, and
 *    the roll for source `i` is over `sources[i] ^ q === seed0 ^ (sources[i] ^
 *    sources[g])`. So every (candidate, source) combination is `chain(seed0 ^ d)` for
 *    some pairwise XOR `d` -- at most 16 distinct values for 6 sources, against the 36
 *    chain walks a naive m x m loop would do.
 * 2. **Dedup needs no table.** A PID reachable through several source slots is emitted
 *    once per slot; keeping only the lowest-indexed slot whose result lands in the
 *    generating accept-set picks exactly one, and every value that test needs is
 *    already sitting in `chainCache`.
 */
interface FusedPlan {
  /** Number of deduped variable (randomized, non-banned) source ability values. */
  m: number
  sources: Int32Array
  /** Distinct pairwise XORs of `sources`; `deltas[0]` is always 0. */
  deltas: Int32Array
  /** `deltaIndex[g * m + i]` -> index into `deltas` for `sources[g] ^ sources[i]`. */
  deltaIndex: Int32Array
  /** Per declared slot: index into `sources`, or -1 when the slot is a fixed constant
   * (banned source, or its randomizer mode is off) whose value is in `*Fixed`. */
  abilitySlot: Int32Array
  abilityFixed: Int32Array
  innateSlot: Int32Array
  innateFixed: Int32Array
}

function buildFusedPlan(species: SpeciesEntry, ctx: RandomizerContext, modes: SearchModes): FusedPlan {
  const sourceList = variableSources(species, ctx, modes)
  const m = sourceList.length
  const sources = Int32Array.from(sourceList)
  const indexOfSource = new Map<number, number>()
  sourceList.forEach((v, i) => indexOfSource.set(v, i))

  const deltaList: number[] = [0]
  const deltaOf = new Map<number, number>([[0, 0]])
  const deltaIndex = new Int32Array(m * m)
  for (let g = 0; g < m; g++) {
    for (let i = 0; i < m; i++) {
      const d = (sources[g] ^ sources[i]) >>> 0
      let idx = deltaOf.get(d)
      if (idx === undefined) {
        idx = deltaList.length
        deltaList.push(d)
        deltaOf.set(d, idx)
      }
      deltaIndex[g * m + i] = idx
    }
  }

  function mapSlots(values: number[], enabled: boolean) {
    const slot = new Int32Array(values.length)
    const fixed = new Int32Array(values.length)
    values.forEach((src, i) => {
      if (isFixed(src, ctx, enabled)) {
        slot[i] = -1
        fixed[i] = src
      } else {
        slot[i] = indexOfSource.get(src)!
      }
    })
    return { slot, fixed }
  }

  const ability = mapSlots(species.abilityOptions, modes.abilityRandomized)
  const innate = mapSlots(species.innateSources, modes.innateRandomized)

  return {
    m,
    sources,
    deltas: Int32Array.from(deltaList),
    deltaIndex,
    abilitySlot: ability.slot,
    abilityFixed: ability.fixed,
    innateSlot: innate.slot,
    innateFixed: innate.fixed,
  }
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

  const plan = buildFusedPlan(species, ctx, modes)
  if (plan.m === 0) return empty

  // Candidates are enumerated from one condition's accept-set, so that condition must
  // contain something the randomizer can actually roll. Picking on raw accept-set size
  // alone would let an all-banned condition (size 1, unbeatable) win the tie-break and
  // enumerate nothing -- silently reporting zero matches, and doing so only when that
  // condition happened to be listed first. Rank on generable size instead, and drop
  // conditions with none: those are satisfiable only by a fixed slot, which
  // findTrivialAllMatchK has already ruled on above.
  let generatingCondition: Condition | null = null
  let generatingSize = Infinity
  for (const c of conditions) {
    const size = generableSize(c.acceptSet, ctx)
    if (size > 0 && size < generatingSize) {
      generatingSize = size
      generatingCondition = c
    }
  }
  // Every condition needs a fixed slot to be satisfiable, and findTrivialAllMatchK
  // found no single ability choice where they all are -- so nothing matches.
  if (!generatingCondition) return empty

  const { m, deltas, deltaIndex, abilitySlot, abilityFixed, innateSlot, innateFixed } = plan
  const gen = generatingCondition.acceptSet
  const banned = ctx.bannedByNum
  const abilitiesCount = ctx.abilitiesCount
  const modulus = abilitiesCount - 1
  const speciesIso = iso(species.num)
  const nAbility = abilitySlot.length
  const nInnate = innateSlot.length
  const rLen = 1 + nInnate
  const nConditions = conditions.length
  const acceptSets = conditions.map((c) => c.acceptSet)

  // Reused across every candidate -- see FusedPlan for why that matters.
  const chainCache = new Int32Array(deltas.length)
  const r = new Int32Array(rLen)
  const bitmasks = new Int32Array(nConditions)

  let total = 0
  const bySlotCost = new Map<number, number>()
  const promoted: MatchResult[] = []
  const reservoir: MatchResult[] = []

  /** Called only for results actually kept (promoted or sampled), so a MatchResult's
   * arrays are allocated a few thousand times rather than tens of millions. */
  function materialize(gRow: number, k: number, slotCost: number, pid: number): MatchResult {
    const abilityResults: number[] = []
    for (let i = 0; i < nAbility; i++) {
      const idx = abilitySlot[i]
      abilityResults.push(idx < 0 ? abilityFixed[i] : chainCache[deltaIndex[gRow + idx]])
    }
    const resultAbilities: number[] = [abilityResults[k]]
    for (let i = 0; i < nInnate; i++) {
      const idx = innateSlot[i]
      resultAbilities.push(idx < 0 ? innateFixed[i] : chainCache[deltaIndex[gRow + idx]])
    }
    return { speciesNum: species.num, pid, abilityNum: k, slotCost, resultAbilities, abilityResults }
  }

  for (let target = 0; target < abilitiesCount; target++) {
    if (!gen[target] || banned[target]) continue
    const remainder = (target - 1) % modulus
    for (let h = remainder; h < 65536; h += modulus) {
      const base = h << 16
      for (let lo = 0; lo < 65536; lo++) {
        let cur = (base | lo) >>> 0
        // Walk back through any banned-reroll chain exactly as
        // seed0CandidatesFromTerminal does -- every seed0 on it reaches `target` too.
        for (;;) {
          const seed0 = isoInverse(cur)

          chainCache[0] = target // delta 0 is the terminal seed itself
          for (let d = 1; d < deltas.length; d++) {
            let seed = (seed0 ^ deltas[d]) >>> 0
            let value: number
            do {
              seed = (Math.imul(MULTIPLIER, seed) + INCREMENT) >>> 0
              value = ((seed >>> 16) % modulus) + 1
            } while (banned[value])
            chainCache[d] = value
          }

          for (let g = 0; g < m; g++) {
            const gRow = g * m
            let canonical = true
            for (let i = 0; i < g; i++) {
              if (gen[chainCache[deltaIndex[gRow + i]]]) {
                canonical = false
                break
              }
            }
            if (!canonical) continue

            for (let i = 0; i < nInnate; i++) {
              const idx = innateSlot[i]
              r[1 + i] = idx < 0 ? innateFixed[i] : chainCache[deltaIndex[gRow + idx]]
            }

            let bestK = -1
            let bestCost = rLen + 1
            for (let k = 0; k < nAbility; k++) {
              const idx = abilitySlot[k]
              r[0] = idx < 0 ? abilityFixed[k] : chainCache[deltaIndex[gRow + idx]]

              let satisfied = true
              for (let c = 0; c < nConditions; c++) {
                const set = acceptSets[c]
                let bits = 0
                for (let j = 0; j < rLen; j++) if (set[r[j]]) bits |= 1 << j
                if (bits === 0) {
                  satisfied = false
                  break
                }
                bitmasks[c] = bits
              }
              if (!satisfied) continue

              const slotCost = minHittingSetSize(rLen, bitmasks, nConditions)
              if (slotCost < bestCost) {
                bestCost = slotCost
                bestK = k
              }
            }
            if (bestK < 0) continue

            total++
            bySlotCost.set(bestCost, (bySlotCost.get(bestCost) ?? 0) + 1)
            const pid = (seed0 ^ plan.sources[g] ^ speciesIso) >>> 0

            if (promoted.length < promotedSize || bestCost <= promoted[promoted.length - 1].slotCost) {
              insertPromoted(promoted, materialize(gRow, bestK, bestCost, pid), promotedSize)
            }
            if (reservoir.length < reservoirSize) {
              reservoir.push(materialize(gRow, bestK, bestCost, pid))
            } else {
              const j = Math.floor(rng() * total)
              if (j < reservoirSize) reservoir[j] = materialize(gRow, bestK, bestCost, pid)
            }
          }

          cur = isoInverse(cur)
          if (!banned[((cur >>> 16) % modulus) + 1]) break
        }
      }
    }
  }

  return { kind: 'complete', total, bySlotCost, promoted, sample: reservoir }
}
