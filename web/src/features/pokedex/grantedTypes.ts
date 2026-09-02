import type { Ability, Species } from '../../lib/types'

export interface GrantedType {
  type: string // bare type name
  viaAbility: string // display name of the ability that grants it
}

function bareType(t: string) {
  return t.startsWith('TYPE_') ? t.slice(5) : t
}

/** Types a species can carry conditionally, via one of its abilities/innates (e.g.
 * Charmander's Half Drake adds Dragon) -- distinct from its own fixed 1-2 base types
 * since only one ability is ever active at a time. Deduped by type: if two different
 * abilities grant the same type, only the first is kept for display.
 */
export function grantedTypes(species: Species, abilitiesById: Map<string, Ability>): GrantedType[] {
  const baseTypes = new Set(species.types.map(bareType))
  const seen = new Set<string>()
  const out: GrantedType[] = []

  for (const id of [...species.abilities, ...species.innates]) {
    const ability = abilitiesById.get(id)
    if (!ability?.grantsType) continue
    if (baseTypes.has(ability.grantsType) || seen.has(ability.grantsType)) continue
    seen.add(ability.grantsType)
    out.push({ type: ability.grantsType, viaAbility: ability.name })
  }

  return out
}
