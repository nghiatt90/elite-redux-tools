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
import { buildBattlerBattleState, buildFieldBattleState, type BridgeDeps } from './bridge'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import { calculateMoveDamage, type DamageCalcResult, type DamageCalcScenario } from '../calculate'

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

// Every move id this file asserts on must actually exist in the snapshot, so a
// renamed/removed id fails loudly here rather than silently degrading a test
// into a no-op via toMoveData's own throw only firing when exercised.
for (const id of [
  'MOVE_TACKLE', 'MOVE_ACID_ARMOR', 'MOVE_MAGNITUDE', 'MOVE_ARM_THRUST', 'MOVE_ECHOED_VOICE',
  'MOVE_ROLLOUT', 'MOVE_BEAT_UP', 'MOVE_FOCUS_PUNCH', 'MOVE_SELF_DESTRUCT', 'MOVE_PURSUIT',
]) {
  if (!moveById.has(id)) throw new Error(`snapshot is missing ${id}`)
}
if (!itemsById.has('ITEM_LOADED_DICE')) throw new Error('snapshot is missing ITEM_LOADED_DICE')
if (itemsById.get('ITEM_LOADED_DICE')!.resolvedHoldEffect !== 'HOLD_EFFECT_LOADED_DICE') throw new Error('ITEM_LOADED_DICE no longer resolves to HOLD_EFFECT_LOADED_DICE')
if (!itemsById.has('ITEM_METRONOME')) throw new Error('snapshot is missing ITEM_METRONOME')
if (itemsById.get('ITEM_METRONOME')!.resolvedHoldEffect !== 'HOLD_EFFECT_METRONOME') throw new Error('ITEM_METRONOME no longer resolves to HOLD_EFFECT_METRONOME')

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

/** Builds the SAME scenario shape createBridgeDamageResolver assembles, but calls
 * calculateMoveDamage directly with NO extra RNG draws -- so its `rolls`/
 * `critRolls`/`totalRolls` arrays are the independent ground truth a scripted
 * resolver run's `targetDamage` gets checked against, rather than re-deriving
 * the resolver's own output and trivially agreeing with itself. */
function directResult(moveId: string, a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, scenarioOverrides: Partial<DamageCalcScenario> = {}): DamageCalcResult {
  const s = state(a, d)
  const roles = { attackerId: 0, defenderId: 1 }
  const attacker = buildBattlerBattleState(s, 0, roles, bridge)
  const defender = buildBattlerBattleState(s, 1, roles, bridge)
  const field = buildFieldBattleState(s, roles, bridge)
  const move = toMoveData(moveId)
  const scenario: DamageCalcScenario = {
    move, attacker: attacker.battler, defender: defender.battler, field: field.field,
    typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: constants,
    attackerActsFirst: true, sameMoveTurnsInARow: 0, hitCount: 3, defenderIsSwitching: false,
    magnitudeTier: null, attackerRolloutCounter: 0, attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false, beatUpBaseAttack: attacker.battler.rawStats.atk, beatUpHitCount: 1,
    defenderUsedGlaiveRush: false, ...scenarioOverrides,
  }
  return calculateMoveDamage(scenario)
}

describe('createBridgeDamageResolver: null and zero semantics', () => {
  it('returns null for a non-move action', () => {
    const r = resolver()
    expect(r.resolve(state(), 0, 1, { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null })).toEqual({ targetDamage: null, attackerDamage: null, unmodelled: [] })
  })
  it('returns null plus a naming unmodelled line for an unknown move id', () => {
    const r = resolver()
    const unknown = { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { ...toMoveData('MOVE_TACKLE'), id: 'MOVE_DOES_NOT_EXIST' }, target: 1 } as ChosenAction
    const out = r.resolve(state(), 0, 1, unknown)
    expect(out.targetDamage).toBeNull()
    expect(out.unmodelled.join(' ')).toContain('MOVE_DOES_NOT_EXIST')
  })
  it('returns null for a status move', () => {
    expect(resolver().resolve(state(), 0, 1, action('MOVE_ACID_ARMOR')).targetDamage).toBeNull()
  })
  it('returns zero, not null, for an immune target (Normal into Ghost)', () => {
    const immune = resolver().resolve(state({}, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), 0, 1, action('MOVE_TACKLE'))
    expect(immune.targetDamage).toBe(0)
  })
})

describe('createBridgeDamageResolver: gap forwarding', () => {
  it('prefixes every battler gap with its role, for both sides', () => {
    const out = resolver().resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(out.unmodelled.some((u) => u.startsWith('attacker.'))).toBe(true)
    expect(out.unmodelled.some((u) => u.startsWith('defender.'))).toBe(true)
  })
})

describe('createBridgeDamageResolver: crit and roll draw order', () => {
  // battleConstants.criticalHitChance[0] = 24 (natures.json), so a non-zero
  // first draw that is not a multiple of 24 -- here 1 -- never forces a crit,
  // while 0 always does (0 % n === 0 for every n). This is what makes the two
  // halves of this describe block distinguishable rather than coincidentally
  // agreeing.
  // Every move -- multi-hit or not -- draws the shared hitCount toggle FIRST
  // (damageResolver.ts always rolls it, so a consumer can never read an
  // unrolled constant); Tackle never reads it, but the draws are still
  // consumed. (0, 0) here are those two irrelevant hitCount draws.
  it('maps a non-crit r=0 draw to exactly rolls[15] (the maximum)', () => {
    const direct = directResult('MOVE_TACKLE')
    const out = resolver(scripted(0, 0, 1, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(out.targetDamage).toBe(direct.rolls[15])
  })
  it('maps a non-crit r=15 draw to exactly rolls[0] (the minimum)', () => {
    const direct = directResult('MOVE_TACKLE')
    const out = resolver(scripted(0, 0, 1, 15)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(out.targetDamage).toBe(direct.rolls[0])
  })
  it('draws crit BEFORE the damage roll: a forced-crit r=0 draw uses critRolls, not rolls', () => {
    const direct = directResult('MOVE_TACKLE')
    expect(direct.critRolls).not.toBeNull()
    const crit = resolver(scripted(0, 0, 0, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(crit.targetDamage).toBe(direct.critRolls![15])
    // A crit changes the outcome versus the same roll index without one.
    expect(crit.targetDamage).not.toBe(direct.rolls[15])
  })
  it('consumes exactly one draw for the crit check before the roll draw (a 2nd scripted value alone flips the outcome)', () => {
    const forcedCrit = resolver(scripted(0, 0, 0, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE')).targetDamage
    const noCrit = resolver(scripted(0, 0, 1, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE')).targetDamage
    expect(forcedCrit).not.toBe(noCrit)
  })
})

describe('createBridgeDamageResolver: Magnitude tier thresholds', () => {
  // magnitudeTier()'s table (damageResolver.ts): <5:4 <15:5 <35:6 <65:7 <85:8 <95:9 else:10.
  // Draw order for MOVE_MAGNITUDE: hitCount's two draws (irrelevant here, scripted
  // 0,0), the magnitude roll, a non-crit draw (1), then a max damage roll (0), so
  // each case reduces to comparing against a tier forced directly through
  // calculateMoveDamage -- independent ground truth, not the resolver's own math.
  it.each([
    [4, 4],
    [5, 5],
    [94, 9],
    [95, 10],
  ] as const)('a magnitude roll of %i resolves to tier %i', (roll, tier) => {
    const direct = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: tier as 4 | 5 | 6 | 7 | 8 | 9 | 10 })
    const out = resolver(scripted(0, 0, roll, 1, 0)).resolve(state(), 0, 1, action('MOVE_MAGNITUDE'))
    expect(out.targetDamage).toBe(direct.rolls[15])
  })
  it('a magnitude roll one below a boundary does NOT resolve to the tier above it', () => {
    const tier4 = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: 4 })
    const tier5 = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: 5 })
    expect(tier4.rolls[15]).not.toBe(tier5.rolls[15])
    const belowBoundary = resolver(scripted(0, 0, 4, 1, 0)).resolve(state(), 0, 1, action('MOVE_MAGNITUDE'))
    expect(belowBoundary.targetDamage).toBe(tier4.rolls[15])
    expect(belowBoundary.targetDamage).not.toBe(tier5.rolls[15])
  })
})

describe('createBridgeDamageResolver: variable multi-hit formula (MULTIHIT_TWO_TO_FIVE, battle_util.c:3523)', () => {
  it.each([
    [1, 3, 5], // 2 + 1%2 + 2*(3%3==0) = 2 + 1 + 2 = 5
    [0, 1, 2], // 2 + 0%2 + 2*(1%3==0) = 2 + 0 + 0 = 2
  ] as const)('draws (%i, %i) roll a hit count of %i', (r1, r2, expected) => {
    const direct = directResult('MOVE_ARM_THRUST', {}, {}, { hitCount: expected })
    expect(direct.hitCount).toBe(expected)
    // Non-crit (1), max damage roll (0) after the two hit-count draws.
    const out = resolver(scripted(r1, r2, 1, 0)).resolve(state(), 0, 1, action('MOVE_ARM_THRUST'))
    expect(out.targetDamage).toBe(direct.totalRolls![15])
  })
})

describe('createBridgeDamageResolver: Loaded Dice (battle_util.c:3578-3586)', () => {
  it.each([
    [1, 5], // 4 + 1%2 = 5
    [0, 4], // 4 + 0%2 = 4
  ] as const)('draws a single value (%i) for a 4-or-5 hit count of %i, not the two-draw formula', (r, expected) => {
    const a = { itemId: 'ITEM_LOADED_DICE' }
    const direct = directResult('MOVE_ARM_THRUST', a, {}, { hitCount: expected })
    expect(direct.hitCount).toBe(expected)
    // Only ONE draw for the dice roll, then non-crit (1), then max roll (0) --
    // if the resolver mistakenly used the two-draw formula here, this 3-value
    // script would desync and the comparison below would fail.
    const out = resolver(scripted(r, 1, 0)).resolve(state(a), 0, 1, action('MOVE_ARM_THRUST'))
    expect(out.targetDamage).toBe(direct.totalRolls![15])
  })
})

describe('createBridgeDamageResolver: Parental Bond TWO_TO_FIVE (ABILITY_UNRELENTING)', () => {
  it('rolls a shared TWO_TO_FIVE hit count for a non-multi-hit move via Unrelenting', () => {
    const a = { abilities: { ability: 'ABILITY_UNRELENTING', innates: [null, null, null] as [string | null, string | null, string | null] } }
    // MOVE_TACKLE is not itself multi-hit, so this ONLY happens via Parental Bond.
    const direct = directResult('MOVE_TACKLE', a, {}, { hitCount: 5 })
    expect(direct.hitCount).toBe(5)
    const out = resolver(scripted(1, 3, 1, 0)).resolve(state(a), 0, 1, action('MOVE_TACKLE')) // 2 + 1%2 + 2*(3%3==0) = 5
    expect(out.targetDamage).toBe(direct.totalRolls![15])
    expect(out.unmodelled).toContain('multi-hit per-hit rolls and crits are not independently drawn')
  })
})

describe('createBridgeDamageResolver: neutralToggleNotes keyed on the real consumer', () => {
  it('fires sameMoveTurnsInARow only when the attacker holds Metronome, never for plain Echoed Voice', () => {
    // This dataset's MOVE_ECHOED_VOICE has effect EFFECT_TRIPLE_KICK, not
    // EFFECT_ECHOED_VOICE (which appears nowhere in moves.json) -- the real
    // consumer of sameMoveTurnsInARow is HOLD_EFFECT_METRONOME's item boost
    // (calculate.ts's attackerFinalItemMultiplier), for ANY move.
    const plain = resolver().resolve(state(), 0, 1, action('MOVE_ECHOED_VOICE'))
    expect(plain.unmodelled.some((u) => u.includes('sameMoveTurnsInARow'))).toBe(false)
    const withMetronome = resolver().resolve(state({ itemId: 'ITEM_METRONOME' }), 0, 1, action('MOVE_TACKLE'))
    expect(withMetronome.unmodelled.some((u) => u.includes('sameMoveTurnsInARow'))).toBe(true)
  })
  it('fires the rollout/defense-curl note for EFFECT_ROLLOUT and the beat-up note for EFFECT_BEAT_UP', () => {
    expect(resolver().resolve(state(), 0, 1, action('MOVE_ROLLOUT')).unmodelled.some((u) => u.includes('attackerRolloutCounter'))).toBe(true)
    expect(resolver().resolve(state(), 0, 1, action('MOVE_BEAT_UP')).unmodelled.some((u) => u.includes('beatUpBaseAttack'))).toBe(true)
    // Tackle triggers neither -- the notes are keyed on the move's effect, not emitted unconditionally.
    const plain = resolver().resolve(state(), 0, 1, action('MOVE_TACKLE')).unmodelled
    expect(plain.some((u) => u.includes('attackerRolloutCounter'))).toBe(false)
    expect(plain.some((u) => u.includes('beatUpBaseAttack'))).toBe(false)
  })
  it('fires attackerWasHitThisTurn for EFFECT_FOCUS_PUNCH and for the move id MOVE_SELF_DESTRUCT specifically', () => {
    expect(resolver().resolve(state(), 0, 1, action('MOVE_FOCUS_PUNCH')).unmodelled.some((u) => u.includes('attackerWasHitThisTurn'))).toBe(true)
    expect(resolver().resolve(state(), 0, 1, action('MOVE_SELF_DESTRUCT')).unmodelled.some((u) => u.includes('attackerWasHitThisTurn'))).toBe(true)
  })
  it('fires defenderIsSwitching only for EFFECT_PURSUIT', () => {
    expect(resolver().resolve(state(), 0, 1, action('MOVE_PURSUIT')).unmodelled.some((u) => u.includes('defenderIsSwitching'))).toBe(true)
    expect(resolver().resolve(state(), 0, 1, action('MOVE_TACKLE')).unmodelled.some((u) => u.includes('defenderIsSwitching'))).toBe(false)
  })
})
