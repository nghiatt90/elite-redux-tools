import type { TypeChart } from '../../lib/types'

export interface Matchup {
  type: string // bare name
  multiplier: number
}

function bareType(t: string) {
  return t.startsWith('TYPE_') ? t.slice(5) : t
}

/** Every attacking type's combined multiplier against a (1 or 2 type) defender,
 * computed by multiplying each defending type's individual multiplier -- matches how
 * the game itself stacks dual-type matchups.
 */
export function defensiveMatchups(defenderTypes: string[], chart: TypeChart): Matchup[] {
  const defTypes = defenderTypes.map(bareType)
  const attackingTypes = Object.keys(chart)

  return attackingTypes.map((atk) => {
    const multiplier = defTypes.reduce((acc, def) => acc * (chart[atk]?.[def] ?? 1), 1)
    return { type: atk, multiplier }
  })
}

export function groupByMultiplier(matchups: Matchup[]) {
  const groups = new Map<number, string[]>()
  for (const { type, multiplier } of matchups) {
    if (multiplier === 1) continue // neutral -- not worth displaying
    const list = groups.get(multiplier)
    if (list) list.push(type)
    else groups.set(multiplier, [type])
  }
  // strongest weaknesses first, then strongest resistances/immunities
  return [...groups.entries()].sort((a, b) => b[0] - a[0])
}
