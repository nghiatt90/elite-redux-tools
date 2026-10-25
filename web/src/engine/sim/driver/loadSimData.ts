// Node-side data loader for simulator driver.
// Reads the committed v2.65beta JSON data snapshot from disk and builds
// SimDataContext, type charts, move behaviors, battle constants, and AI deps.
// Headless and React-free; no browser APIs.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MoveData } from '../../calculate'
import type { MoveBehaviors } from '../../basePower'
import type { BattleConstants } from '../../types'
import type { TypeChart } from '../../typeEffectiveness'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from '../dataContext'
import type { GroundingContext } from '../grounding'
import type { TurnOrderContext } from '../turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { TrainerAiRow } from '../ai/aiFlags'

export interface TrainerMonData {
  species: string
  item: string
  nature: string
  ability: string
  evs: {
    hp: number
    atk: number
    def: number
    spatk: number
    spdef: number
    spe: number
  }
  moves: string[]
  ironPill: boolean
  hiddenPowerType: string
  abilityDivergence?: boolean
  textprotoAbility?: string
  nonstandard?: string
}

export interface TrainerPartiesData {
  ace: TrainerMonData[]
  elite: TrainerMonData[]
  hell: TrainerMonData[]
}

export interface TrainerData extends TrainerAiRow {
  id: string
  trainerNum: number
  name: string
  gender: string
  forcedDouble: boolean
  risky: boolean
  preferStatus: boolean
  preferStall: boolean
  noSwitching: boolean
  class: string | null
  parties: TrainerPartiesData
}

export interface SimDataBundle {
  dataContext: SimDataContext
  typeChart: TypeChart
  inverseTypeChart: TypeChart
  moveBehaviors: MoveBehaviors
  battleConstants: BattleConstants
  holdEffectIds: Readonly<Record<string, number>>
  moveData(id: string): MoveData | undefined
  grounding: GroundingContext
  turnOrder: TurnOrderContext
  statStageRatios: [number, number][]
  speciesById: Map<string, any>
  itemsById: Map<string, any>
  movesById: Map<string, any>
  trainersById: Map<string, TrainerData>
  trainers: TrainerData[]
}

export interface LoadSimDataOptions {
  dataDir?: string
}

export function loadSimData(options?: LoadSimDataOptions): SimDataBundle {
  const dataDir = options?.dataDir ?? resolve(import.meta.dirname, '../../../../../data/v2.65beta')

  const readJson = <T>(filename: string): T => {
    return JSON.parse(readFileSync(join(dataDir, filename), 'utf8')) as T
  }

  const rawSpecies = readJson<any[]>('species.json')
  const rawMoves = readJson<any[]>('moves.json')
  const rawItems = readJson<any[]>('items.json')
  const trainers = readJson<TrainerData[]>('trainers.json')
  const battleConstants = readJson<BattleConstants>('natures.json')
  const moveBehaviors = readJson<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
  const holdEffectIds = readJson<Record<string, number>>('holdEffectIds.json')
  const typeChart = readJson<TypeChart>('types.json')
  const inverseTypeChart = readJson<TypeChart>('typesInverse.json')

  const speciesById = new Map<string, any>(rawSpecies.map((s) => [s.id as string, s]))
  const movesById = new Map<string, any>(rawMoves.map((m) => [m.id as string, m]))
  const itemsById = new Map<string, any>(rawItems.map((i) => [i.id as string, i]))
  const trainersById = new Map<string, TrainerData>(trainers.map((t) => [t.id, t]))

  const dataContext: SimDataContext = {
    species(id: string): SimSpeciesData | undefined {
      const s = speciesById.get(id)
      if (!s) return undefined
      return {
        id: s.id as string,
        baseStats: s.baseStats,
        types: (s.types ?? []).map((t: string) => t.replace('TYPE_', '')),
        abilities: (s.abilities ?? []) as (string | null)[],
        innates: (s.innates ?? []) as (string | null)[],
        weight: (s.weight ?? 0) as number,
        heads: s.heads as number | undefined,
        megas: s.megas as unknown[] | undefined,
        primals: s.primals as unknown[] | undefined,
        formOf: (s.formOf ?? null) as string | null,
        evolutions: s.evolutions as unknown[] | undefined,
      }
    },

    item(id: string): SimItemData | undefined {
      const i = itemsById.get(id)
      if (!i) return undefined
      return {
        id: i.id as string,
        resolvedHoldEffect: (i.resolvedHoldEffect ?? null) as string | null,
        holdEffectStrength: (i.holdEffectStrength ?? null) as number | null,
        holdEffectType: (i.holdEffectType ?? null) as string | null,
        naturalGift: (i.naturalGift ?? null) as { power: number; type: string } | null,
        grouping: (i.grouping ?? null) as string | null,
      }
    },

    move(id: string): SimMoveData | undefined {
      const m = movesById.get(id)
      if (!m) return undefined
      const arg = m.argument as Record<string, unknown> | undefined
      return {
        id,
        power: (m.power ?? 0) as number,
        type: m.type ? String(m.type).replace('TYPE_', '') : null,
        type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
        split: (m.split ?? null) as SimMoveData['split'],
        effect: (m.effect ?? null) as string | null,
        target: m.target as string | undefined,
        priority: (m.priority ?? 0) as number,
        flags: (m.flags ?? {}) as Record<string, true>,
        accuracy: (m.accuracy ?? 0) as number,
        hitsAir: m.hitsAir as SimMoveData['hitsAir'],
        argumentInt: arg?.kind === 'int' ? (arg.value as number) : null,
        sheerForceBoost: m.sheerForceBoost as true | undefined,
        effectChance: m.effectChance as number | undefined,
        pp: m.pp as number | undefined,
        argument: (arg ?? null) as SimMoveData['argument'],
        customBehavior: m.customBehavior ?? null,
      }
    },
  }

  function moveData(id: string): MoveData | undefined {
    const m = movesById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return {
      id,
      power: (m.power ?? 0) as number,
      type: m.type ? String(m.type).replace('TYPE_', '') : null,
      type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
      split: (m.split ?? null) as MoveData['split'],
      effectChance: (m.effectChance ?? 0) as number,
      splitFlag: m.splitFlag as string | undefined,
      effect: (m.effect ?? null) as string | null,
      customBehavior: m.customBehavior,
      crit: m.crit as MoveData['crit'],
      hitsAir: m.hitsAir as MoveData['hitsAir'],
      flags: (m.flags ?? {}) as Record<string, true>,
      priority: (m.priority ?? 0) as number,
      changeTypeHoldEffect:
        m.effect === 'EFFECT_CHANGE_TYPE_ON_ITEM' && arg?.kind === 'other'
          ? (arg.value as string)
          : arg?.kind === 'holdEffect'
            ? (arg.value as string)
            : null,
      miscEffect:
        m.effect === 'EFFECT_MISC_HIT' && arg?.kind === 'misc'
          ? (arg.misc as string) ?? (arg.value as string) ?? null
          : null,
      multiHitArgument:
        m.effect === 'EFFECT_DOUBLE_HIT' && arg?.kind === 'int'
          ? (arg.value as number)
          : null,
      target: m.target as string | undefined,
    }
  }

  const grounding: GroundingContext = {
    holdEffectOf: () => null,
    monotypeChampType: null,
    isCluelessOnField: false,
    attackerHasMoldBreaker: false,
  }

  const turnOrder: TurnOrderContext = NEUTRAL_TURN_ORDER_CONTEXT

  return {
    dataContext,
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    holdEffectIds,
    moveData,
    grounding,
    turnOrder,
    statStageRatios: battleConstants.statStageRatios,
    speciesById,
    itemsById,
    movesById,
    trainersById,
    trainers,
  }
}
