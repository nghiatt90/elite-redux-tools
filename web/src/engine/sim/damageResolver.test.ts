import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from './create'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import { createRandomSource } from './rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction } from './turnOrder'
import type { GroundingContext } from './grounding'
import type { BridgeDeps } from './bridge'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const moves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(moves.map((m) => [m.id as string, m]))
const species = read<Array<Record<string, any>>>('species.json')
const items = read<Array<Record<string, any>>>('items.json')
const speciesById = new Map(species.map((s) => [s.id as string, s]))
const itemsById = new Map(items.map((i) => [i.id as string, i]))
const natures = read<any>('natures.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = Object.fromEntries(Object.entries(read<Record<string, Record<string, number>>>('types.json')).map(([k, v]) => [k, v]))
const inverseChart = Object.fromEntries(Object.entries(read<Record<string, Record<string, number>>>('typesInverse.json')).map(([k, v]) => [k, v]))

function toMoveData(id: string): any {
  const move = moveById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  }
}

const grounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: () => undefined,
}
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const constants = natures

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return { speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY', hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng: createRandomSource(1) })
}
function action(id: string): ChosenAction { const move = toMoveData(id); return { action: 'USE_MOVE', moveToBeUsed: move, chosenMove: move, target: 1 } as ChosenAction }
function resolver(random: RandomSource = createRandomSource(1)): ReturnType<typeof createBridgeDamageResolver> {
  const deps: BridgeDamageResolverDeps = { ...bridge, moveData: (id) => moveById.has(id) ? toMoveData(id) : undefined, typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: constants, random }
  return createBridgeDamageResolver(deps)
}
function scripted(...values: number[]): RandomSource { let i = 0; return { random16: () => values[i++] ?? 0 } }

describe('createBridgeDamageResolver', () => {
  it('returns null for non-moves and unknown moves', () => {
    const r = resolver()
    expect(r.resolve(state(), 0, 1, { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null })).toMatchObject({ targetDamage: null })
    const unknown = { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { ...toMoveData('MOVE_TACKLE'), id: 'MOVE_DOES_NOT_EXIST' }, target: 1 } as ChosenAction
    expect(r.resolve(state(), 0, 1, unknown).unmodelled.join(' ')).toContain('MOVE_DOES_NOT_EXIST')
  })
  it('returns null for status and zero for Normal into Ghost immunity', () => {
    const r = resolver()
    expect(r.resolve(state(), 0, 1, action('MOVE_ACID_ARMOR')).targetDamage).toBeNull()
    const immune = r.resolve(state({}, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), 0, 1, action('MOVE_TACKLE'))
    expect(immune.targetDamage).toBe(0)
  })
  it('maps r=0 to max and r=15 to min, after the crit draw', () => {
    const max = resolver(scripted(0, 0, 65535, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    const min = resolver(scripted(0, 0, 65535, 15)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(max.targetDamage).not.toBe(min.targetDamage)
  })
  it('uses real move ids for every history gap note', () => {
    for (const id of ['MOVE_ECHOED_VOICE', 'MOVE_ROLLOUT', 'MOVE_BEAT_UP', 'MOVE_FOCUS_PUNCH', 'MOVE_SELF_DESTRUCT', 'MOVE_PURSUIT']) {
      if (!moveById.has(id)) throw new Error(`snapshot is missing ${id}`)
      expect(resolver().resolve(state(), 0, 1, action(id)).unmodelled.join(' ')).toMatch(/not tracked|switching is not modelled/)
    }
  })
  it('rolls Magnitude tier and variable multi-hit with scripted draws', () => {
    const magnitude = resolver(scripted(0, 0, 0)).resolve(state(), 0, 1, action('MOVE_MAGNITUDE'))
    expect(magnitude.targetDamage).not.toBeNull()
    const multi = resolver(scripted(0, 65535, 0, 0)).resolve(state(), 0, 1, action('MOVE_ARM_THRUST'))
    expect(multi.unmodelled).toContain('multi-hit per-hit rolls and crits are not independently drawn')
  })
})
