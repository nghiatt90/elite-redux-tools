import type { Move, Species } from '../../lib/types'

export interface ChainNode {
  species: Species
  condition?: string // human-readable, e.g. "Lv. 16" or "Lv. 34 (male)" -- empty for the root
  label?: string // override for species.name -- needed for mega/primal forms, which
  // almost never have their own longName (form_of inherits the base species' plain
  // name, so "Charizard"'s three mega forms would otherwise all display identically)
}

function conditionLabel(level?: number, gender?: string): string | undefined {
  const parts: string[] = []
  if (level) parts.push(`Lv. ${level}`)
  if (gender) parts.push(`(${gender.toLowerCase()})`)
  return parts.length ? parts.join(' ') : undefined
}

/** Walks up to the earliest known pre-evolution, then breadth-first back down through
 * every branch (handles split lines like Eevee), capped at a few stages as a loop
 * guard. Returns one array per stage; a stage can hold multiple species.
 */
export function buildEvolutionChain(
  species: Species,
  speciesById: Map<string, Species>,
): ChainNode[][] {
  // reverse map: target id -> [{from, level, gender}]
  const preEvolutionOf = new Map<string, { fromId: string; level?: number; gender?: string }>()
  for (const s of speciesById.values()) {
    for (const evo of s.evolutions) {
      if (!preEvolutionOf.has(evo.to)) {
        preEvolutionOf.set(evo.to, { fromId: s.id, level: evo.level, gender: evo.gender })
      }
    }
  }

  let rootId = species.id
  const seen = new Set<string>([rootId])
  for (let i = 0; i < 5; i++) {
    const pre = preEvolutionOf.get(rootId)
    if (!pre || seen.has(pre.fromId)) break
    rootId = pre.fromId
    seen.add(rootId)
  }

  const root = speciesById.get(rootId)
  if (!root) return [[{ species }]]

  const stages: ChainNode[][] = [[{ species: root }]]
  const visited = new Set<string>([rootId])

  for (let depth = 0; depth < 4; depth++) {
    const prevStage = stages[depth]
    const nextStage: ChainNode[] = []
    for (const { species: parent } of prevStage) {
      for (const evo of parent.evolutions) {
        if (visited.has(evo.to)) continue
        const child = speciesById.get(evo.to)
        if (!child) continue
        visited.add(evo.to)
        nextStage.push({ species: child, condition: conditionLabel(evo.level, evo.gender) })
      }
    }
    if (nextStage.length === 0) break
    stages.push(nextStage)
  }

  return stages
}

/** Mega/primal forms are stored on the FORM species itself (e.g. Mega Charizard X's
 * own `megas` array points `from: "SPECIES_CHARIZARD"`), not on the base species --
 * the reverse of how evolutions work. So finding "what can this species mega evolve
 * into" means scanning every species for one whose megas[].from matches, not reading
 * a field on `species` directly.
 */
const MEGA_TYPE_SUFFIX: Record<string, string> = {
  MEGA_X: 'X',
  MEGA_Y: 'Y',
  MEGA_Z: 'Z',
  MEGA_A: 'A',
  MEGA_B: 'B',
  MEGA_C: 'C',
}

export function findMegaAndPrimalForms(
  species: Species,
  allSpecies: Species[],
  movesById: Map<string, Move>,
): ChainNode[] {
  const nodes: ChainNode[] = []
  for (const s of allSpecies) {
    const mega = s.megas.find((m) => m.from === species.id)
    if (mega) {
      const suffix = MEGA_TYPE_SUFFIX[mega.megaType]
      const condition = mega.move ? `via ${movesById.get(mega.move)?.name ?? mega.move}` : 'via held item'
      nodes.push({ species: s, condition, label: `Mega ${species.name}${suffix ? ` ${suffix}` : ''}` })
    }
    const primal = s.primals.find((p) => p.from === species.id)
    if (primal) {
      nodes.push({ species: s, condition: 'via held item', label: `Primal ${species.name}` })
    }
  }
  return nodes
}
