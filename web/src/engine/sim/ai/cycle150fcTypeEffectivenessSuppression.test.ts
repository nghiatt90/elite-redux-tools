/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150fc: the ON_ABILITY suppression filter (FILTER_NOT(IsSuppressed(...)),
// battle_util.h:269-275) inside MulByTypeEffectiveness's ability loop
// (battle_util.c:7847-7851). IsSuppressed (battle_util.c:9254-9261) is called
// with checkMoldBreaker = FALSE here, so only the Neutralizing Gas / Gastro Acid
// arm applies -- and DoesBattlerHaveAbilityShield can defeat it.
//
// ER redefines UQ_4_12_PRECISION to 10 (include/global.h:113), so every
// expectation uses uq() from ../../fixed, never a literal 2.0/4096. The plain
// chart value for Poison -> Steel is 0 in data/v2.65beta/types.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import { STATUS3_GASTRO_ACID } from '../constants'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { AiDamageDeps } from './aiCalcDamage'
import { calcPartyMonTypeEffectivenessMultiplier } from './aiShouldSwitch'
import { uq } from '../../fixed'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const abilityIds = new Set(read<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const natures = read<any>('natures.json')
const holdEffectIds = read<Record<string, number>>('holdEffectIds.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`moves.json is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

// Verify every fixture id at module load (the "never guess an id" rule).
const CORROSION = requireAbility('ABILITY_CORROSION')
if (moveById.get('MOVE_POISON_STING')?.type !== 'TYPE_POISON') throw new Error('MOVE_POISON_STING is no longer Poison-type')
for (const [id, effect] of [
  ['ITEM_RING_TARGET', 'HOLD_EFFECT_RING_TARGET'],
  ['ITEM_ABILITY_SHIELD', 'HOLD_EFFECT_ABILITY_SHIELD'],
] as const) {
  if ((itemsById.get(id) as Record<string, any> | undefined)?.resolvedHoldEffect !== effect) throw new Error(`${id} is no longer ${effect}`)
}
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')

const defaultGrounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: (id) => {
    const m = moveById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return { id, power: m.power, type: m.type, split: m.split, effect: m.effect, priority: m.priority, flags: m.flags ?? {}, accuracy: m.accuracy, argumentInt: arg?.kind === 'int' ? (arg.value as number) : null }
  },
}
const bridge: BridgeDeps = { grounding: defaultGrounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, holdEffectIds }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] }, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, gender: 'MALE', status1: 0, types: ['WATER', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}
/** battler 0 is the player's active mon -- the C's battlerAtk AND battlerDef. */
function battle(a: Partial<SimBattleMon>, b: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(b), 0)], rng: scripted() })
}
const MONO = (t: string): [string, string, string] => [t, t, 'MYSTERY']
function modifierAgainst(state: BattleState, moveId: string, types: [string, string, string], d: AiDamageDeps = deps): number {
  return calcPartyMonTypeEffectivenessMultiplier(state, partyMon({ types }), moveId, d, [])
}
const corrosion = (overrides: Partial<SimBattleMon> = {}): Partial<SimBattleMon> => ({
  abilities: { ability: CORROSION, innates: [null, null, null] },
  ...overrides,
})

describe('MulByTypeEffectiveness: ON_ABILITY suppression filter (battle_util.h:269-275)', () => {
  it('baseline: Corrosion forces Poison-vs-Steel super effective (chart 0)', () => {
    const s = battle(corrosion())
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(2.0))
  })

  it('Gastro Acid on battler 0 suppresses Corrosion, leaving the plain chart value (0)', () => {
    const s = battle(corrosion())
    s.battlers[0]!.statuses3 = STATUS3_GASTRO_ACID
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(0)
  })

  it('Neutralizing Gas suppresses Corrosion field-wide, leaving the plain chart value (0)', () => {
    const s = battle(corrosion())
    s.field.timers.neutralizingGas = true
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(0)
  })

  it('Ability Shield defeats the suppression: DoesBattlerHaveAbilityShield (:9258)', () => {
    const s = battle(corrosion({ itemId: 'ITEM_ABILITY_SHIELD' }))
    s.battlers[0]!.statuses3 = STATUS3_GASTRO_ACID
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(2.0))
  })

  it('suppression on battler 1 does not touch the loop, which reads battlerAtk = 0 (:8003)', () => {
    const s = battle(corrosion())
    s.battlers[1]!.statuses3 = STATUS3_GASTRO_ACID
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(2.0))
  })

  it('a suppressed ability leaves abilityModified FALSE, so Ring Target neutralises (:7854)', () => {
    const s = battle(corrosion({ itemId: 'ITEM_RING_TARGET' }))
    s.battlers[0]!.statuses3 = STATUS3_GASTRO_ACID
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(1.0))
  })
})
