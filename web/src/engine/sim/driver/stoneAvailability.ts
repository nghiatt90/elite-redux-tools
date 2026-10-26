// Which Mega Stones the player can have when facing gym N, from the same item fields the Pokedex
// shows (`megaStoneHint`, `megaBadgeRequirement`; see web/src/features/pokedex/evolutionLines.ts).
//
// Rules, each read from the game:
//  - Permanent Mega Mode only turns a mon into its Mega when the Mega Bracelet is in the bag
//    (GetFormChangeForMon, src/pokemon.c:6019). Norman hands the bracelet over just before the
//    Gym 5 fight (data/maps/PetalburgCity_Gym/scripts.pory:1755-1761), so no Mega exists before gym 5.
//  - That same script calls giveBattleItems, which adds every Nurse Joy stone to the bag
//    (ScrCmd_giveBattleItems, src/scrcmd.c:2489), so every `nurseJoy` stone is available from gym 5.
//  - A stone with `megaBadgeRequirement` needs that many badges; before gym N the player holds N-1.
//  - Monotype Champion rewards are end-game: never available before the Elite Four.
//  - Adoption Center and legendary sage stones have no badge gate in the data; they are treated as
//    available from gym 5 and listed as `unverified` so a result that relies on one can be checked.

import type { SimDataBundle } from './loadSimData'

export interface StoneAvailability {
  available: boolean
  reason: string
  /** True when the rule used is an assumption rather than a gate found in the data. */
  unverified: boolean
}

interface RawItem {
  id: string
  resolvedHoldEffect?: string | null
  megaBadgeRequirement?: number | null
  megaStoneHint?: { kind: string; text?: string }
}

const BRACELET_GYM = 5

export function stoneAvailability(item: RawItem, gym: number): StoneAvailability {
  if (gym < BRACELET_GYM) return { available: false, reason: 'no Mega Bracelet before gym 5', unverified: false }
  const hint = item.megaStoneHint
  const badges = gym - 1
  if (!hint) return { available: false, reason: 'no known unlock method', unverified: false }

  if (hint.kind === 'nurseJoy') return { available: true, reason: 'Nurse Joy stone (given at gym 5)', unverified: false }

  if (hint.kind === 'uniqueLocation') {
    const text = hint.text ?? ''
    if (/Monotype Champion/i.test(text)) return { available: false, reason: text, unverified: false }
    const required = item.megaBadgeRequirement
    if (required != null) {
      return badges >= required
        ? { available: true, reason: `${text} (needs ${required} badges)`, unverified: false }
        : { available: false, reason: `${text} (needs ${required} badges, have ${badges})`, unverified: false }
    }
    return { available: true, reason: `${text} (no badge requirement in data)`, unverified: true }
  }

  return { available: true, reason: `${hint.kind} stone, no gate in data`, unverified: true }
}

/** Stones available at `gym`, with the reason for each. */
export function availableStones(data: SimDataBundle, gym: number): Map<string, StoneAvailability> {
  const out = new Map<string, StoneAvailability>()
  for (const raw of data.itemsById.values() as Iterable<RawItem>) {
    if (raw.resolvedHoldEffect !== 'HOLD_EFFECT_MEGA_STONE') continue
    const result = stoneAvailability(raw, gym)
    if (result.available) out.set(raw.id, result)
  }
  return out
}
