import { GIFT_MON_UNLOCK } from '../../data/giftMonUnlocks'
import { displayName } from '../../lib/displayName'
import type { Item, Move, Species } from '../../lib/types'

export interface ChainNode {
  species: Species
  condition?: string // human-readable, e.g. "Lv. 16" or "Lv. 34 (male)" -- empty for the root
  label?: string // override for species.name -- needed for mega/primal forms, which
  // almost never have their own longName (form_of inherits the base species' plain
  // name, so "Charizard"'s three mega forms would otherwise all display identically)
}

/** Mirrors the exact in-game hint text Elite Redux itself generates from the same
 * field (GetMegaHintString / MegaHintGenerator.kt in eliteredux-source) -- this
 * isn't wording this app made up, it's what the game shows the player. The 19 items
 * with no `megaStoneHint` set at all get the game's own "Unknown unlock method."
 * fallback too, for the same reason (they're not implemented anywhere in
 * data/maps either -- plausibly Mystery Gift-only, but not confirmed as fact).
 *
 * `megaBadgeRequirement` (a separate field on Item) is deliberately not surfaced
 * here: it's per-item metadata from er-config, and at least one entry (Slowkingite,
 * badge 5) is provably wrong -- the live map script only grants it alongside the
 * Mind Badge (badge 7) itself. Rather than propagate a field with a known error
 * rate, the location text above is shown alone, same as the game's own hint screen.
 */
function megaStoneUnlockText(item: Item | undefined): string {
  const hint = item?.megaStoneHint
  switch (hint?.kind) {
    case 'nurseJoy':
      // The in-game hint just says "Talk to Nurse Joy," but that undersells the real
      // gate: every Mega, regardless of which specific stone, first needs the Mega
      // Bracelet itself (a one-time item from Norman, see PetalburgCity_Gym's
      // scripts.pory). Nurse Joy is where these particular stones come from after
      // that, but leading with the actual prerequisite is more useful to a player.
      return 'Obtain Mega Bracelet.'
    case 'adoptionCenter':
      return `Purchase ${item?.name} from an Adoption Center.`
    case 'legendarySage':
      return 'Talk to the legendary sage in Littleroot Town.'
    case 'uniqueLocation':
      return hint.text
    default:
      return 'Unknown unlock method.'
  }
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
  itemsById: Map<string, Item>,
): ChainNode[] {
  const anchorId = species.formOf ?? species.id
  const nodes: ChainNode[] = []

  if (anchorId !== species.id) {
    const anchor = speciesById.get(anchorId)
    if (anchor) nodes.push({ species: anchor, condition: 'base form', label: displayName(anchor, speciesById) })
  }

  for (const s of speciesById.values()) {
    if (s.formOf !== anchorId || s.id === species.id) continue

    // Not filtered by `m.from === anchorId`: a mega of a form-of-a-form (e.g. Typhlosion
    // Hisuian Mega) has `formOf: SPECIES_TYPHLOSION` -- flattened to the top-level base,
    // same as every other form -- but its own `megas[].from` correctly points at the
    // immediate species it evolves from (SPECIES_TYPHLOSION_HISUIAN), which never equals
    // anchorId. Filtering on that match silently dropped the condition for every such
    // case. A handful of species (Pikachu Partner Mega's cap variants, Toxtricity Mega,
    // Necrozma Ultra, ...) carry more than one megas/primals entry on themselves, one per
    // `from` variant, but every verified case uses the same item across all of them, so
    // taking the first is safe -- there's exactly one species-defining mega/primal here.
    const mega = s.megas[0]
    const primal = s.primals[0]
    // GIFT_MON_UNLOCK takes priority over the mega/primal item lookup: a few species
    // (Pikachu/Eevee/Meowth Partner Mega) need a stone that comes bundled with their
    // own gift mon rather than being independently obtainable, so items.json
    // legitimately has no hint for it -- the real answer only exists in the gift-mon
    // table, not on the item.
    const condition =
      GIFT_MON_UNLOCK[s.id] ??
      (mega
        ? mega.move
          ? `via ${movesById.get(mega.move)?.name ?? mega.move}`
          : megaStoneUnlockText(itemsById.get(mega.item ?? ''))
        : primal
          ? megaStoneUnlockText(itemsById.get(primal.item))
          : undefined)

    nodes.push({ species: s, condition, label: displayName(s, speciesById) })
  }
  return nodes
}
