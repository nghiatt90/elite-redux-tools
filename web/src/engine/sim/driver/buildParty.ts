// Party builder for simulator driver.
// Constructs SimPartyMon[] rosters for opponent trainers (from trainers.json)
// and player specs. Stats are computed from game formulas (src/pokemon.c).

import { calcHp, calcStat } from '../../stats'
import type { Slot4, SimPartyMon } from '../state'
import type { AbilitySlots } from '../../abilities/dispatch'
import type { BattleStatKey, StatKey } from '../../types'
import { loadSimData, type SimDataBundle, type TrainerData, type TrainerMonData } from './loadSimData'

let cachedBundle: SimDataBundle | null = null

function getDefaultBundle(): SimDataBundle {
  if (!cachedBundle) {
    cachedBundle = loadSimData()
  }
  return cachedBundle
}

export interface PlayerMonSpec {
  species: string
  level?: number
  nature?: string
  evs?: Partial<Record<StatKey, number>>
  ability?: string | null
  item?: string | null
  moves: (string | null)[]
  ironPill?: boolean
  hiddenPowerType?: string | null
  gender?: 'MALE' | 'FEMALE' | 'GENDERLESS'
}

function resolveGender(speciesData: any, override?: 'MALE' | 'FEMALE' | 'GENDERLESS'): 'MALE' | 'FEMALE' | 'GENDERLESS' {
  if (override) return override
  if (speciesData.gender?.genderless) return 'GENDERLESS'
  if (speciesData.gender?.percentFemale === 100) return 'FEMALE'
  return 'MALE'
}

function resolveTypes(speciesData: any): [string, string, string] {
  const rawTypes = (speciesData.types ?? []) as string[]
  const bareTypes = rawTypes.map((t) => t.replace('TYPE_', ''))
  return [
    bareTypes[0] ?? 'MYSTERY',
    bareTypes[1] ?? 'MYSTERY',
    bareTypes[2] ?? 'MYSTERY',
  ]
}

function resolveMovesAndPp(
  moveIds: (string | null)[],
  bundle: SimDataBundle,
): { moves: Slot4<string | null>; pp: Slot4<number> } {
  const slotMoves: Slot4<string | null> = [
    moveIds[0] ?? null,
    moveIds[1] ?? null,
    moveIds[2] ?? null,
    moveIds[3] ?? null,
  ]
  const slotPp: Slot4<number> = [
    slotMoves[0] ? bundle.dataContext.move(slotMoves[0])?.pp ?? 0 : 0,
    slotMoves[1] ? bundle.dataContext.move(slotMoves[1])?.pp ?? 0 : 0,
    slotMoves[2] ? bundle.dataContext.move(slotMoves[2])?.pp ?? 0 : 0,
    slotMoves[3] ? bundle.dataContext.move(slotMoves[3])?.pp ?? 0 : 0,
  ]
  return { moves: slotMoves, pp: slotPp }
}

/**
 * Builds an opponent party for a given trainer and tier at the derived battle level.
 *
 * Stats are computed with IV 31 across all stats except Speed under ironPill (IV 0),
 * adhering to CalculateMonStatsMaster (src/pokemon.c:988-994).
 * Stat formula citations:
 *   - Out-of-battle stats: src/pokemon.c:955-960 (CALC_STAT) & 3485-3506 (ModifyStatByNature)
 *   - Max HP: src/pokemon.c:1003-1008
 */
export function buildOpponentParty(
  trainerRow: TrainerData,
  tier: 'ace' | 'elite' | 'hell',
  level: number,
  bundle: SimDataBundle = getDefaultBundle(),
): SimPartyMon[] {
  const partyList: TrainerMonData[] =
    trainerRow.parties?.[tier]?.length
      ? trainerRow.parties[tier]
      : trainerRow.parties?.elite?.length
        ? trainerRow.parties.elite
        : trainerRow.parties?.ace ?? []

  return partyList.map((mon) => {
    const species = bundle.speciesById.get(mon.species)
    if (!species) {
      throw new Error(`buildOpponentParty: unknown species ${mon.species} in trainer ${trainerRow.id}`)
    }

    const isShedinja = species.id === 'SPECIES_SHEDINJA' || species.id === 'SPECIES_SHEDINJA_MEGA'
    const ironPill = Boolean(mon.ironPill)
    const iv = (stat: StatKey): number => (stat === 'spe' && ironPill ? 0 : 31)

    const evs: Record<StatKey, number> = {
      hp: mon.evs?.hp ?? 0,
      atk: mon.evs?.atk ?? 0,
      def: mon.evs?.def ?? 0,
      spatk: mon.evs?.spatk ?? 0,
      spdef: mon.evs?.spdef ?? 0,
      spe: mon.evs?.spe ?? 0,
    }

    const nature = mon.nature
    const natureTable = bundle.battleConstants.natureStatTable

    const maxHp = calcHp(species.baseStats.hp, iv('hp'), evs.hp, level, isShedinja)
    const rawStats: Record<BattleStatKey, number> = {
      atk: calcStat(species.baseStats.atk, iv('atk'), evs.atk, level, nature, 'atk', natureTable),
      def: calcStat(species.baseStats.def, iv('def'), evs.def, level, nature, 'def', natureTable),
      spatk: calcStat(species.baseStats.spatk, iv('spatk'), evs.spatk, level, nature, 'spatk', natureTable),
      spdef: calcStat(species.baseStats.spdef, iv('spdef'), evs.spdef, level, nature, 'spdef', natureTable),
      spe: calcStat(species.baseStats.spe, iv('spe'), evs.spe, level, nature, 'spe', natureTable),
    }

    const innates = (species.innates ?? []) as (string | null)[]
    const abilities: AbilitySlots = {
      ability: mon.ability ?? null,
      innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
    }

    const types = resolveTypes(species)
    const { moves, pp } = resolveMovesAndPp(mon.moves ?? [], bundle)

    const itemId = mon.item && mon.item !== 'ITEM_NONE' ? mon.item : null
    const hiddenPowerType = mon.hiddenPowerType ? mon.hiddenPowerType.replace('TYPE_', '') : null
    const gender = resolveGender(species)

    return {
      speciesId: mon.species,
      hp: maxHp,
      maxHp,
      level,
      moves,
      pp,
      itemId,
      abilities,
      rawStats,
      nature,
      hiddenPowerType,
      speedDown: ironPill,
      gender,
      status1: 0,
      types,
    }
  })
}

/**
 * Builds a player party from a list of player Pokemon specifications.
 */
export function buildPlayerParty(
  specs: PlayerMonSpec[],
  defaultLevel = 50,
  bundle: SimDataBundle = getDefaultBundle(),
): SimPartyMon[] {
  return specs.map((spec) => {
    const species = bundle.speciesById.get(spec.species)
    if (!species) {
      throw new Error(`buildPlayerParty: unknown species ${spec.species}`)
    }

    const level = spec.level ?? defaultLevel
    const isShedinja = species.id === 'SPECIES_SHEDINJA' || species.id === 'SPECIES_SHEDINJA_MEGA'
    const ironPill = Boolean(spec.ironPill)
    const iv = (stat: StatKey): number => (stat === 'spe' && ironPill ? 0 : 31)

    const evs: Record<StatKey, number> = {
      hp: spec.evs?.hp ?? 0,
      atk: spec.evs?.atk ?? 0,
      def: spec.evs?.def ?? 0,
      spatk: spec.evs?.spatk ?? 0,
      spdef: spec.evs?.spdef ?? 0,
      spe: spec.evs?.spe ?? 0,
    }

    const nature = spec.nature ?? 'NATURE_HARDY'
    const natureTable = bundle.battleConstants.natureStatTable

    const maxHp = calcHp(species.baseStats.hp, iv('hp'), evs.hp, level, isShedinja)
    const rawStats: Record<BattleStatKey, number> = {
      atk: calcStat(species.baseStats.atk, iv('atk'), evs.atk, level, nature, 'atk', natureTable),
      def: calcStat(species.baseStats.def, iv('def'), evs.def, level, nature, 'def', natureTable),
      spatk: calcStat(species.baseStats.spatk, iv('spatk'), evs.spatk, level, nature, 'spatk', natureTable),
      spdef: calcStat(species.baseStats.spdef, iv('spdef'), evs.spdef, level, nature, 'spdef', natureTable),
      spe: calcStat(species.baseStats.spe, iv('spe'), evs.spe, level, nature, 'spe', natureTable),
    }

    const innates = (species.innates ?? []) as (string | null)[]
    const abilities: AbilitySlots = {
      ability: spec.ability ?? species.abilities?.[0] ?? null,
      innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
    }

    const types = resolveTypes(species)
    const { moves, pp } = resolveMovesAndPp(spec.moves ?? [], bundle)

    const itemId = spec.item && spec.item !== 'ITEM_NONE' ? spec.item : null
    const hiddenPowerType = spec.hiddenPowerType ? spec.hiddenPowerType.replace('TYPE_', '') : null
    const gender = resolveGender(species, spec.gender)

    return {
      speciesId: spec.species,
      hp: maxHp,
      maxHp,
      level,
      moves,
      pp,
      itemId,
      abilities,
      rawStats,
      nature,
      hiddenPowerType,
      speedDown: ironPill,
      gender,
      status1: 0,
      types,
    }
  })
}
