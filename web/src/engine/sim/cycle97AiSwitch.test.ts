/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 97: FindMonThatAbsorbsOpponentsMove (:147-263) and
// FindMonWithFlagsAndSuperEffective (:414-500), plus every caller in
// shouldSwitch. Every id and type-chart value asserted on below is verified
// against data/v2.65beta/*.json at module load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from './create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { PARTY_SIZE, STATUS1_SLEEP } from './constants'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import type { MoveData } from '../calculate'
import type { BridgeDeps } from './bridge'
import { aiGetTypeEffectiveness, type AiDamageDeps } from './ai/aiCalcDamage'
import { shouldSwitch } from './ai/aiShouldSwitch'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
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
function requireMove(id: string): Record<string, any> {
  const move = moveById.get(id)
  if (!move) throw new Error(`moves.json is missing ${id}`)
  return move
}
function toMoveData(id: string): MoveData {
  const move = requireMove(id)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

const WATER_ABSORB = requireAbility('ABILITY_WATER_ABSORB')
const NATURAL_CURE = requireAbility('ABILITY_NATURAL_CURE')
// Every absorber id the port's per-type list names, plus Wonder Guard.
for (const id of [
  'ABILITY_FLASH_FIRE',
  'ABILITY_WATER_ABSORB',
  'ABILITY_STORM_DRAIN',
  'ABILITY_DRY_SKIN',
  'ABILITY_VOLT_ABSORB',
  'ABILITY_MOTOR_DRIVE',
  'ABILITY_LIGHTNING_ROD',
  'ABILITY_SAP_SIPPER',
  'ABILITY_EARTH_EATER',
  'ABILITY_WONDER_GUARD',
]) {
  requireAbility(id)
}

for (const [id, type, power] of [
  ['MOVE_WATER_GUN', 'TYPE_WATER', 40],
  ['MOVE_THUNDER_SHOCK', 'TYPE_ELECTRIC', 80],
  ['MOVE_ABSORB', 'TYPE_GRASS', 50],
  ['MOVE_VINE_WHIP', 'TYPE_GRASS', 80],
  ['MOVE_TACKLE', 'TYPE_NORMAL', 40],
  ['MOVE_TAIL_WHIP', 'TYPE_NORMAL', 0],
  ['MOVE_EMBER', 'TYPE_FIRE', 20],
] as const) {
  const move = requireMove(id)
  if (move.type !== type || move.power !== power) throw new Error(`${id} is no longer ${type} with power ${power}`)
}
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')
// The exact chart entries the flag-helper fixtures rely on.
if (chart.ELECTRIC?.GROUND !== 0) throw new Error('Electric is no longer immune against Ground')
if (chart.ELECTRIC?.GRASS !== 0.5) throw new Error('Electric is no longer resisted by Grass')
if (chart.ELECTRIC?.NORMAL !== 1) throw new Error('Electric is no longer neutral against Normal')
if (chart.FIRE?.GRASS !== 2) throw new Error('Fire is no longer super-effective against Grass')

const grounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
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
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
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
/** `reserves` are IN ADDITION TO the opponent's own active mon, which slot 0
 * holds (createBattlerState(1, ..., 0)); the helper skips slot 0 as the AI's
 * own party index, so a caller naming "one reserve" only passes one entry. */
function battle(a: Partial<SimBattleMon>, b: Partial<SimBattleMon>, rng: RandomSource, reserves?: SimPartyMon[]): BattleState {
  const opponentParty = reserves ? [partyMon({ hp: b.hp ?? 100 }), ...reserves] : undefined
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(b), 0)], rng, opponentParty })
}
/** Scripted rng that also counts every draw, so the tests can pin the C's exact
 * call order (all of these helpers use `Random()` at most once per branch). */
function scripted(...values: number[]): RandomSource & { calls: number } {
  let i = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return values[i++] ?? 0
    },
  }
  return rng
}

const NO_GAP_NOTE = (unmodelled: string[]) => unmodelled.some((u) => u.includes('gLastLandedMoves'))
const LEVEL_NOTE = 'CalcPartyMonTypeEffectivenessMultiplier (battle_util.c:7998) passes the mon\'s level as battlerDef'
const OOB_LEVEL_NOTE = (unmodelled: string[]) => unmodelled.some((u) => u.includes(LEVEL_NOTE) && u.includes('out-of-bounds gBattleMons[level]'))

describe('FindMonThatAbsorbsOpponentsMove', () => {
  it('Water last landed move: a Water Absorb reserve is chosen on a Random() & 1 hit, one draw total', () => {
    const rng = scripted(1)
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    const { shouldSwitch: result, unmodelled } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(1)
    expect(NO_GAP_NOTE(unmodelled)).toBe(false)
  })

  it('a failed Random() & 1 bit continues to the next absorber slot', () => {
    const rng = scripted(0, 1)
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(2)
    expect(rng.calls).toBe(2)
  })

  it('a power-0 last landed move is FALSE before any draw', () => {
    const rng = scripted()
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_TAIL_WHIP'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(0)
  })

  it('a Normal-type last landed move has no absorber list -- FALSE, no draw', () => {
    const rng = scripted()
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('the active mon already holding the absorbing ability is FALSE (GetBattlerAbility reads abilities[0])', () => {
    const rng = scripted()
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null], abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(0)
  })

  it('null and MOVE_UNSET last landed moves both take the early return, no draw', () => {
    for (const lastLandedMove of [null, 'MOVE_UNSET']) {
      const rng = scripted()
      const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
        partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
      ])
      s.battlers[1]!.lastLandedMove = lastLandedMove
      expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
      expect(rng.calls).toBe(0)
    }
  })

  it('a fainted absorber reserve is skipped without drawing', () => {
    const rng = scripted()
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 0, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
      partyMon({ hp: 100 }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(0)
  })

  it('a super-effective move in hand draws Random() % 3 first; 0 proceeds, then the absorber bit', () => {
    const rng = scripted(0, 1)
    const s = battle({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_EMBER', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    const emberVsGrass = aiGetTypeEffectiveness(s, 'MOVE_EMBER', 1, 0, deps).effectiveness
    if (emberVsGrass < 2048) throw new Error('MOVE_EMBER is no longer super-effective vs pure Grass')
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(2)
  })
})

describe('FindMonWithFlagsAndSuperEffective', () => {
  it('encored AI: a Ground reserve immune to the Electric last move, with a super-effective move, is chosen; one Random() % 1 draw', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GROUND', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', null, null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    const { shouldSwitch: result, unmodelled } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(1)
    expect(OOB_LEVEL_NOTE(unmodelled)).toBe(true)
  })

  it('a resisting (not immune) reserve reaches the NOT_VERY_EFFECTIVE call, not the first', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GRASS', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', null, null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(1)
  })

  it('a neutral reserve is never chosen; the Encored final Random() & 1 is the only draw', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', null, null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(1)
  })

  it('a reserve with the right flag but no super-effective move is not chosen', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GROUND', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_TACKLE', null, null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(1)
  })

  it('shouldSwitch tail, DOESNT_AFFECT_FOE + modulo 2: a failed roll continues to the next move', () => {
    const rng = scripted(1, 0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GROUND', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', 'MOVE_VINE_WHIP', null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(2)
  })

  it('shouldSwitch tail, DOESNT_AFFECT_FOE + modulo 2: a 0 roll selects the first move', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GROUND', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', 'MOVE_VINE_WHIP', null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('shouldSwitch tail, NOT_VERY_EFFECTIVE + modulo 3: a failed roll continues to the next move', () => {
    const rng = scripted(1, 0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GRASS', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', 'MOVE_VINE_WHIP', null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
    expect(rng.calls).toBe(2)
  })

  it('lastHitBy === 0xFF with a real last landed move makes the flag helper FALSE with zero draws', () => {
    const rng = scripted()
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [partyMon({ hp: 100 })])
    s.battlers[1]!.lastLandedMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
    expect(rng.calls).toBe(0)
  })
})

describe('ShouldSwitchIfNaturalCure draw order with a real last landed move', () => {
  it('lastLandedMove === null keeps the two-draw path', () => {
    const rng = scripted(0, 1)
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, rng, [
      partyMon({ hp: 100 }),
    ])
    expect(s.battlers[1]!.lastLandedMove).toBeNull()
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(2)
  })

  it('a power-0 status move draws the else-if bit but not the first', () => {
    const rng = scripted(1)
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, rng, [
      partyMon({ hp: 100 }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_TAIL_WHIP'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(1)
  })

  it('a damaging last landed move draws neither of the first two and goes to the flag helpers + final draw', () => {
    const rng = scripted(1)
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, rng, [
      partyMon({ hp: 100 }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(rng.calls).toBe(1)
  })
})

describe('removed gap notes', () => {
  it('no helper reports the old gLastLandedMoves gap, and the out-of-bounds level note is present when a fold runs', () => {
    const rng = scripted(0)
    const s = battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, types: ['GROUND', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_ABSORB', null, null, null] }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_THUNDER_SHOCK'
    s.battlers[1]!.lastHitBy = 0
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    const { unmodelled } = shouldSwitch(s, 1, deps)
    expect(NO_GAP_NOTE(unmodelled)).toBe(false)
    expect(unmodelled.some((u) => u.includes('FindMonThatAbsorbsOpponentsMove (battle_ai_switch_items.c:147)'))).toBe(false)
    expect(unmodelled.some((u) => u.includes('FindMonWithFlagsAndSuperEffective (battle_ai_switch_items.c:414)'))).toBe(false)
    expect(OOB_LEVEL_NOTE(unmodelled)).toBe(true)
  })

  it('the out-of-bounds level note is not emitted when no reserve reaches the type fold', () => {
    const rng = scripted(1)
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, rng, [
      partyMon({ hp: 100, abilities: { ability: WATER_ABSORB, innates: [null, null, null] } }),
    ])
    s.battlers[1]!.lastLandedMove = 'MOVE_WATER_GUN'
    expect(OOB_LEVEL_NOTE(shouldSwitch(s, 1, deps).unmodelled)).toBe(false)
  })
})
