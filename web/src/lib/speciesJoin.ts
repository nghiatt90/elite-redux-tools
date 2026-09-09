/** Species-wide reverse search by joining condition pre-image sets.
 *
 * The Species Finder's original shape was "run the per-species search over a random
 * sample of species" -- 40 full ~25M-candidate passes, minutes of work, and an answer
 * extrapolated from 2% of the species list. This module answers the same question
 * across *every* species at once, by searching in a space where the species doesn't
 * appear at all.
 *
 * Two facts do the work:
 *
 * 1. **Species identity is a final XOR.** A roll is `chain(source ^ iso(species) ^ pid)`,
 *    so with `Q = iso(species) ^ pid` it is `chain(source ^ Q)` -- and `Q` carries no
 *    species information. A solution found in Q-space converts to a PID for *any*
 *    species via `pid = Q ^ iso(species)`. Solutions are per-source-tuple, not
 *    per-species; the species list only decides who can use them.
 *
 * 2. **Locked abilities force near-equal seeds.** If condition `c` is satisfied by
 *    source `v_c`, then `w_c = v_c ^ Q` lies in `S(A_c)`, the pre-image set of that
 *    condition's accept-set -- which depends on neither species nor source, so it is
 *    computed once. And since every ability number is below 2^11,
 *
 *        w_1 ^ w_c === v_1 ^ v_c < 2^11
 *
 *    meaning every `w_c` shares the **same top 21 bits**. Bucketing the pre-image sets
 *    on those 21 bits turns the search into a join: only tuples inside one bucket can
 *    possibly belong to the same PID, and the low 11 bits of their XOR say exactly
 *    which pair of source abilities produced them.
 *
 * So: bucket the pre-image sets, walk the tuples inside each bucket, and look their
 * XOR signature up in an index of source values that actually co-occur on a species.
 * More locked abilities make the index sparser and the search *cheaper*, which is the
 * opposite of how the per-species scan behaves and the right way round -- a 4-lock
 * query is the one worth asking.
 */

import {
  generableSize,
  evaluateSpeciesAtPid,
  iso,
  isoInverse,
  roll,
  type Condition,
  type MatchResult,
  type RandomizerContext,
  type SearchModes,
  type SpeciesEntry,
} from './randomizer'

/** Ability numbers occupy 11 bits, so two of them XOR to something below 2^11 and the
 * remaining 21 bits of a seed are shared by every `w_c` of one solution. */
const DELTA_BITS = 11
const DELTA_COUNT = 1 << DELTA_BITS
const BUCKET_COUNT = 1 << (32 - DELTA_BITS)

/** Structurally joining more than three conditions would need a key wider than a
 * 32-bit index; the fourth is cheaper to verify forward on the (by then tiny) survivor
 * set anyway. */
const MAX_JOINED = 3

/** Each accepted target contributes ~4.35M seeds at 4 bytes, so this caps the joined
 * pre-image sets at roughly 200MB -- comfortable for a browser worker. Accept-set
 * expansion (compounds and equivalence groups, both on by default) is what pushes a
 * condition past one target: the widest in the real data is 8. When the budget won't
 * stretch to three conditions the join takes two and verifies the rest forward, which
 * costs time rather than correctness. */
const MAX_JOINED_TARGETS = 12

/** How many conditions to join, and in what order -- smallest generable accept-set
 * first, since pre-image size scales with it. Returns null when even the two cheapest
 * conditions would not fit, which sends the query to the per-species scan. */
function planJoin(
  conditions: Condition[],
  ctx: RandomizerContext,
): { ordered: Condition[]; joined: number } | null {
  const ordered = [...conditions].sort(
    (a, b) => generableSize(a.acceptSet, ctx) - generableSize(b.acceptSet, ctx),
  )
  let targets = 0
  let joined = 0
  for (const c of ordered) {
    if (joined === MAX_JOINED) break
    const size = generableSize(c.acceptSet, ctx)
    if (size === 0 || targets + size > MAX_JOINED_TARGETS) break
    targets += size
    joined++
  }
  return joined >= 2 ? { ordered, joined } : null
}

// ---------------------------------------------------------------------------------
// Pre-image sets
// ---------------------------------------------------------------------------------

/** Every seed `w` whose reroll chain terminates inside `accept`, bucketed by its top
 * 21 bits: `values` holds the seeds grouped by bucket, `starts[b]` is where bucket `b`
 * begins (and `starts[b + 1]` where it ends). */
interface Bucketed {
  values: Uint32Array
  starts: Int32Array
}

/** Walks every seed whose chain terminates inside `accept`. Deliberately re-runnable:
 * bucketing counts on the first pass and fills on the second, which keeps only the
 * final `values` array in memory. Materializing an unsorted copy first would double
 * peak usage, and at ~4.35M seeds per accepted target that is the difference between
 * ~50MB and ~500MB for a wide accept-set -- an out-of-memory worker rather than a slow
 * one. The walk itself is ~150ms per target, so paying for it twice is cheap. */
function enumeratePreimages(accept: Uint8Array, ctx: RandomizerContext, emit: (w: number) => void): void {
  const modulus = ctx.abilitiesCount - 1
  const banned = ctx.bannedByNum
  for (let target = 0; target < ctx.abilitiesCount; target++) {
    if (!accept[target] || banned[target]) continue
    const remainder = (target - 1) % modulus
    for (let h = remainder; h < 65536; h += modulus) {
      const base = h << 16
      for (let lo = 0; lo < 65536; lo++) {
        let cur = (base | lo) >>> 0
        for (;;) {
          emit(isoInverse(cur))
          cur = isoInverse(cur)
          if (!banned[roll(cur, ctx.abilitiesCount)]) break
        }
      }
    }
  }
}

function buildBucketed(accept: Uint8Array, ctx: RandomizerContext): Bucketed {
  const starts = new Int32Array(BUCKET_COUNT + 1)
  let n = 0
  enumeratePreimages(accept, ctx, (w) => {
    starts[(w >>> DELTA_BITS) + 1]++
    n++
  })
  for (let b = 0; b < BUCKET_COUNT; b++) starts[b + 1] += starts[b]

  const values = new Uint32Array(n)
  const cursor = starts.slice(0, BUCKET_COUNT)
  enumeratePreimages(accept, ctx, (w) => {
    values[cursor[w >>> DELTA_BITS]++] = w
  })
  return { values, starts }
}

// ---------------------------------------------------------------------------------
// Source-tuple index
// ---------------------------------------------------------------------------------

/** One species, reduced to the distinct source abilities that actually get randomized.
 * Mutual exclusivity between the declared ability options is *not* modelled here --
 * `evaluateSpeciesAtPid` enforces it when a candidate is checked, so the index can stay
 * a flat source list. */
interface SpeciesSources {
  entry: SpeciesEntry
  sources: Int32Array
}

/** Maps the XOR signature of a source tuple to the (species, tuple) records carrying
 * it, as an intrusive linked list over parallel arrays -- ~360k records for a 3-way
 * join over the real species list, so the flat 2^22-entry head table is affordable and
 * lookups are one indexed read. */
interface TupleIndex {
  head: Int32Array
  next: Int32Array
  entryOf: Int32Array
  /** `slot[r * joined + c]` -> index into that entry's `sources` for condition `c`. */
  slot: Int32Array
  joined: number
}

function buildTupleIndex(list: SpeciesSources[], joined: number): TupleIndex {
  const keySpace = joined === 2 ? DELTA_COUNT : DELTA_COUNT * DELTA_COUNT
  const head = new Int32Array(keySpace).fill(-1)

  let capacity = 0
  for (const s of list) capacity += s.sources.length ** joined
  const next = new Int32Array(capacity)
  const entryOf = new Int32Array(capacity)
  const slot = new Int32Array(capacity * joined)
  let r = 0

  const record = (e: number, indices: number[], key: number) => {
    entryOf[r] = e
    for (let c = 0; c < joined; c++) slot[r * joined + c] = indices[c]
    next[r] = head[key]
    head[key] = r
    r++
  }

  for (let e = 0; e < list.length; e++) {
    const src = list[e].sources
    const n = src.length
    for (let i0 = 0; i0 < n; i0++) {
      for (let i1 = 0; i1 < n; i1++) {
        const d1 = (src[i0] ^ src[i1]) >>> 0
        if (joined === 2) {
          record(e, [i0, i1], d1)
          continue
        }
        for (let i2 = 0; i2 < n; i2++) {
          const d2 = (src[i0] ^ src[i2]) >>> 0
          record(e, [i0, i1, i2], d1 * DELTA_COUNT + d2)
        }
      }
    }
  }
  return { head, next, entryOf, slot, joined }
}

// ---------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------

export interface JoinSearchResult {
  kind: 'join'
  /** Exact when every bucket was visited, extrapolated from `coverage` otherwise. */
  total: number
  exact: boolean
  /** Fraction of the seed space actually walked, in (0, 1]. */
  coverage: number
  bySlotCost: Map<number, number>
  matchedSpecies: Set<number>
  promoted: (MatchResult & { speciesNum: number })[]
  sample: (MatchResult & { speciesNum: number })[]
}

/** True when the join can answer this query exactly. Fixed slots (a banned source, or
 * a randomizer mode switched off) satisfy their condition for *every* PID, which puts
 * no constraint on the seed at all -- there is nothing to join on, and those searches
 * stay on the per-species path where fixed slots are modelled directly. */
export function canJoin(conditions: Condition[], ctx: RandomizerContext, modes: SearchModes): boolean {
  if (conditions.length < 2) return false
  if (!modes.abilityRandomized || !modes.innateRandomized) return false
  for (const c of conditions) {
    for (let n = 0; n < ctx.abilitiesCount; n++) {
      if (c.acceptSet[n] && ctx.bannedByNum[n]) return false
    }
  }
  return planJoin(conditions, ctx) !== null
}

export interface JoinOptions {
  promotedSize?: number
  reservoirSize?: number
  rng?: () => number
  /** Stop after this many candidate evaluations and extrapolate. A 2-locked-ability
   * query really does have ~10^8 solutions across the species list, so enumerating
   * them all is not a goal -- the budget is what keeps a loose query fast while a
   * tight one (3-4 locks, the query worth asking) still finishes exactly. */
  budget?: number
  onProgress?: (visitedBuckets: number, totalBuckets: number) => boolean
}

export function joinSearchSpecies(
  speciesList: SpeciesEntry[],
  conditions: Condition[],
  ctx: RandomizerContext,
  modes: SearchModes,
  options: JoinOptions = {},
): JoinSearchResult {
  const promotedSize = options.promotedSize ?? 20
  const reservoirSize = options.reservoirSize ?? 1000
  const rng = options.rng ?? Math.random
  const budget = options.budget ?? 8_000_000

  const plan = planJoin(conditions, ctx)
  if (!plan) throw new Error('joinSearchSpecies called on a query canJoin() rejects')
  const { ordered, joined } = plan

  const list: SpeciesSources[] = []
  for (const entry of speciesList) {
    // Banned sources are excluded: they are never randomized, so they pin no seed and
    // (given canJoin) can satisfy no condition -- indexing them would only add tuples
    // the canonical check is guaranteed to reject.
    const sources = [...new Set([...entry.abilityOptions, ...entry.innateSources])].filter(
      (v) => !ctx.bannedByNum[v],
    )
    if (sources.length > 0 && entry.abilityOptions.length > 0) {
      list.push({ entry, sources: Int32Array.from(sources) })
    }
  }

  const sets = ordered.slice(0, joined).map((c) => buildBucketed(c.acceptSet, ctx))
  const index = buildTupleIndex(list, joined)
  const acceptSets = ordered.map((c) => c.acceptSet)

  let total = 0
  let evaluated = 0
  const bySlotCost = new Map<number, number>()
  const matchedSpecies = new Set<number>()
  const promoted: (MatchResult & { speciesNum: number })[] = []
  const reservoir: (MatchResult & { speciesNum: number })[] = []
  const res = new Int32Array(8)

  const rank = (m: MatchResult) => m.slotCost * 2 ** 32 + m.pid
  function keepPromoted(match: MatchResult & { speciesNum: number }) {
    if (promoted.length < promotedSize) {
      promoted.push(match)
      promoted.sort((a, b) => rank(a) - rank(b))
      return
    }
    if (rank(match) < rank(promoted[promoted.length - 1])) {
      promoted[promoted.length - 1] = match
      promoted.sort((a, b) => rank(a) - rank(b))
    }
  }

  /** Checks one (species, Q) proposal. Returns true when it is a genuine, not-already-
   * counted match. */
  function consider(e: number, w0: number, record: number): boolean {
    const { entry, sources } = list[e]
    const q = (w0 ^ sources[index.slot[record * joined]]) >>> 0

    for (let i = 0; i < sources.length; i++) {
      let seed = (sources[i] ^ q) >>> 0
      let value: number
      do {
        seed = iso(seed)
        value = roll(seed, ctx.abilitiesCount)
      } while (ctx.bannedByNum[value])
      res[i] = value
    }

    // One (species, Q) is proposed once per source assignment that satisfies the
    // joined conditions. Keeping only the assignment that always picks the
    // lowest-indexed satisfying source counts it exactly once, with no dedup table.
    for (let c = 0; c < joined; c++) {
      const accept = acceptSets[c]
      let lowest = -1
      for (let i = 0; i < sources.length; i++) {
        if (accept[res[i]]) {
          lowest = i
          break
        }
      }
      if (lowest !== index.slot[record * joined + c]) return false
    }

    const pid = (q ^ iso(entry.num)) >>> 0
    const match = evaluateSpeciesAtPid(entry, pid, conditions, ctx, modes)
    if (!match) return false

    total++
    matchedSpecies.add(entry.num)
    bySlotCost.set(match.slotCost, (bySlotCost.get(match.slotCost) ?? 0) + 1)
    const withSpecies = { ...match, speciesNum: entry.num }
    keepPromoted(withSpecies)
    if (reservoir.length < reservoirSize) reservoir.push(withSpecies)
    else {
      const j = Math.floor(rng() * total)
      if (j < reservoirSize) reservoir[j] = withSpecies
    }
    return true
  }

  // Buckets partition the seed space, and every w of one solution shares a bucket, so
  // visiting them in a random order makes an early stop an unbiased sample.
  const order = new Int32Array(BUCKET_COUNT)
  for (let b = 0; b < BUCKET_COUNT; b++) order[b] = b
  for (let i = BUCKET_COUNT - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }

  const [s0, s1, s2] = sets
  let visited = 0
  for (; visited < BUCKET_COUNT; visited++) {
    const b = order[visited]
    const a0 = s0.starts[b]
    const e0 = s0.starts[b + 1]
    if (a0 !== e0) {
      const a1 = s1.starts[b]
      const e1 = s1.starts[b + 1]
      for (let p = a0; p < e0; p++) {
        const w0 = s0.values[p]
        for (let r1 = a1; r1 < e1; r1++) {
          const d1 = (w0 ^ s1.values[r1]) >>> 0
          if (joined === 2) {
            for (let rec = index.head[d1]; rec !== -1; rec = index.next[rec]) {
              evaluated++
              consider(index.entryOf[rec], w0, rec)
            }
            continue
          }
          const a2 = s2.starts[b]
          const e2 = s2.starts[b + 1]
          const keyBase = d1 * DELTA_COUNT
          for (let r2 = a2; r2 < e2; r2++) {
            const key = keyBase + ((w0 ^ s2.values[r2]) >>> 0)
            for (let rec = index.head[key]; rec !== -1; rec = index.next[rec]) {
              evaluated++
              consider(index.entryOf[rec], w0, rec)
            }
          }
        }
      }
    }

    if ((visited & 0xfff) === 0xfff) {
      if (options.onProgress && !options.onProgress(visited + 1, BUCKET_COUNT)) break
      if (evaluated >= budget) {
        visited++
        break
      }
    }
  }

  const coverage = Math.min(1, visited / BUCKET_COUNT)
  const exact = visited >= BUCKET_COUNT
  return {
    kind: 'join',
    total: exact ? total : Math.round(total / coverage),
    exact,
    coverage,
    bySlotCost,
    matchedSpecies,
    promoted,
    sample: reservoir,
  }
}
