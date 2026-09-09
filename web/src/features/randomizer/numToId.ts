import type { Ability } from '../../lib/types'

/** abilityNum -> AbilityEnum id, e.g. 25 -> "ABILITY_WONDER_GUARD". Built once per
 * game-data load and shared by both routes to translate a worker result's numeric
 * abilityNums back into ids for display. */
export function buildIdByNum(abilities: Ability[]): string[] {
  const idByNum: string[] = []
  for (const a of abilities) idByNum[a.abilityNum] = a.id
  return idByNum
}
