// N-hit KO probability over the 16-roll damage distribution calculateMoveDamage()
// produces. Not a port of any specific C function -- ER's own code doesn't compute
// this at all, it's purely a convenience this calculator adds on top of the real
// damage rolls, the same way Pokemon Showdown's damage calculator does.
//
// Each of the up to MAX_HITS hits independently draws one of the 16 equiprobable
// rolls (1/16 each). This is the standard simplifying assumption every Showdown-style
// calculator makes: it ignores that a real battle can change state between hits
// (a status could be cured, an item consumed, a stat boosted) and ignores residual
// per-turn damage (Leftovers, Poison, ...). It is exact for "N clean hits of this
// exact move in a row with nothing else happening," which is the scenario a
// calculator is answering in the first place.

const MAX_HITS = 9

export interface KoChanceEntry {
  hits: number
  probability: number // 0..1
}

/**
 * Computes, for each hit count 1..MAX_HITS, the probability the defender's HP has
 * reached 0 by then. `rolls` should be calculateMoveDamage()'s `rolls` (or
 * `critRolls`) array -- any 16 (or fewer) equiprobable damage values.
 *
 * Damage is clamped to `maxHp` at each step (a mon can't go "past" 0 HP in a way that
 * matters for KO counting), which both matches how KOs actually work and keeps the
 * distribution's key space bounded to `maxHp + 1` entries rather than growing
 * unboundedly across hits.
 */
export function calcKoChances(rolls: number[], maxHp: number): KoChanceEntry[] {
  if (rolls.length === 0 || maxHp <= 0) return []

  const entries: KoChanceEntry[] = []
  let distribution = new Map<number, number>([[0, 1]])

  for (let hit = 1; hit <= MAX_HITS; hit++) {
    const next = new Map<number, number>()
    for (const [hpLost, probability] of distribution) {
      for (const roll of rolls) {
        const total = Math.min(hpLost + roll, maxHp)
        next.set(total, (next.get(total) ?? 0) + probability / rolls.length)
      }
    }
    distribution = next

    const koProbability = distribution.get(maxHp) ?? 0
    entries.push({ hits: hit, probability: koProbability })
    if (koProbability > 1 - 1e-9) break // effectively guaranteed -- no need to keep computing
  }

  return entries
}

/** The lowest hit count with (effectively) guaranteed KO probability, or null if no
 * hit count up to MAX_HITS guarantees it (report as "not a guaranteed KO within N hits"). */
export function guaranteedKoHits(entries: KoChanceEntry[]): number | null {
  const guaranteed = entries.find((e) => e.probability > 1 - 1e-9)
  return guaranteed ? guaranteed.hits : null
}

/** The lowest hit count with a non-zero KO chance -- the "best case" KO count callers
 * conventionally lead with (e.g. "2HKO: 37.5%"), or null if the move can never KO
 * within MAX_HITS at all. */
export function minimumPossibleKoHits(entries: KoChanceEntry[]): number | null {
  const first = entries.find((e) => e.probability > 0)
  return first ? first.hits : null
}
