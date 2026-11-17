export type GymNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface StageKey {
  highestBadge: number
  badgeCount: number
  braceletHeld: boolean
}

export interface ProgressionRow {
  fightId: string            // first trainer id of the fight in script order
  requiredBefore: GymNumber[] // gyms that must already be cleared when the fight can occur
  mayBefore: GymNumber[]      // skippable gyms that may or may not be cleared; empty on every real row (fixed route)
  evidence: string
  inferred?: boolean
  /**
   * Set when the Mega Bracelet is held even if badge 5 is not yet earned.
   * Sourced from decomp: PetalburgCity_Gym/scripts.pory:1741-1763 (case 6)
   * gives ITEM_MEGA_BRACELET on first talk before the battle, while
   * FLAG_BADGE05_GET is only set post-battle at :410.
   */
  holdsBracelet?: boolean
}

/**
 * Returns the gyms cleared before this fight. The route is fixed: gym N requires
 * gyms 1..N-1, so the cleared set is exactly requiredBefore.
 */
export function clearedBefore(row: ProgressionRow): Set<GymNumber> {
  return new Set<GymNumber>(row.requiredBefore)
}

/**
 * Derives the StageKey from clearedBefore.
 *
 * Rule source: solver-v2-plan.md:50-54.
 * - getHighestBadge returns the highest FLAG_BADGE0x_GET flag held (src/pokemon.c:4635-4647),
 *   not a badge count (0 if empty).
 * - The Mega Bracelet is handed over in Norman's Gym 5 script
 *   (data/maps/PetalburgCity_Gym/scripts.pory:1755-1761), so braceletHeld requires gym 5 cleared
 *   unless row.holdsBracelet === true.
 */
export function stageKeyFor(row: ProgressionRow): StageKey {
  const cleared = clearedBefore(row)
  let highestBadge = 0
  for (const gym of cleared) {
    if (gym > highestBadge) {
      highestBadge = gym
    }
  }
  return {
    highestBadge,
    badgeCount: cleared.size,
    braceletHeld: cleared.has(5) || row.holdsBracelet === true,
  }
}

/**
 * Highest badge min/max bounds for innate gating and level caps (innate-gating-plan decision 2).
 * min = largest of requiredBefore (0 if empty)
 * max = largest of requiredBefore ∪ mayBefore (0 if empty)
 */
export function highestBadgeRange(row: ProgressionRow): { min: number; max: number } {
  let min = 0
  for (const gym of row.requiredBefore) {
    if (gym > min) {
      min = gym
    }
  }
  let max = min
  for (const gym of row.mayBefore) {
    if (gym > max) {
      max = gym
    }
  }
  return { min, max }
}

/**
 * Stable string representation for de-duplicating StageKeys, e.g. "h3-n3-b0".
 */
export function stageKeyId(key: StageKey): string {
  return `h${key.highestBadge}-n${key.badgeCount}-b${key.braceletHeld ? 1 : 0}`
}

/**
 * De-duplicated StageKeys across all rows, sorted by stageKeyId.
 */
export function distinctStageKeys(rows: readonly ProgressionRow[]): StageKey[] {
  const map = new Map<string, StageKey>()
  for (const row of rows) {
    const key = stageKeyFor(row)
    const id = stageKeyId(key)
    if (!map.has(id)) {
      map.set(id, key)
    }
  }
  return Array.from(map.values()).sort((a, b) => stageKeyId(a).localeCompare(stageKeyId(b)))
}
