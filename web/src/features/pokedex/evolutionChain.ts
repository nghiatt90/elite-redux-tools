import { displayName } from '../../lib/displayName'
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

/** Every kind of form -- mega, primal, Redux, regional (Galarian/Alolan/Hisuian),
 * battle forms, capes, and whatever else Elite Redux adds -- is stored the same way:
 * on the FORM species itself via `formOf` pointing back at the base, the reverse of
 * how regular evolutions work. So finding "what forms does this species have" means
 * scanning every species for a matching `formOf`, not reading a field on `species`
 * directly.
 *
 * Works from either side of the family: `species.formOf` gives the anchor (the base)
 * whether `species` itself is the base or one of its forms, so a form's own detail
 * page shows the same set -- the base plus every sibling form, excluding itself --
 * not an empty section. (Previously this only ever scanned for `s.formOf ===
 * species.id`, which is only ever true when `species` already is the base, so
 * viewing any form's own page showed nothing.) Lists every form regardless of
 * whether it's also a standalone list entry in its own right (see displayName.ts's
 * isStandaloneForm) -- this section is the cross-link either way.
 */
export function findOtherForms(
  species: Species,
  speciesById: Map<string, Species>,
  movesById: Map<string, Move>,
): ChainNode[] {
  const anchorId = species.formOf ?? species.id
  const nodes: ChainNode[] = []

  if (anchorId !== species.id) {
    const anchor = speciesById.get(anchorId)
    if (anchor) nodes.push({ species: anchor, condition: 'base form', label: displayName(anchor, speciesById) })
  }

  for (const s of speciesById.values()) {
    if (s.formOf !== anchorId || s.id === species.id) continue

    const mega = s.megas.find((m) => m.from === anchorId)
    const primal = s.primals.find((p) => p.from === anchorId)
    const condition = mega
      ? mega.move
        ? `via ${movesById.get(mega.move)?.name ?? mega.move}`
        : 'via held item'
      : primal
        ? 'via held item'
        : undefined

    nodes.push({ species: s, condition, label: displayName(s, speciesById) })
  }
  return nodes
}
