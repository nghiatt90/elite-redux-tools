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
  // FIX CYCLE 6: the resolver no longer draws a hit count at all (see
  // damageResolver.ts's own header) -- CANCELLER_MULTIHIT_MOVES
  // (attackCanceller.ts) is the real draw site now, exercised in
  // turnCanceller.test.ts, not here. These scripts used to lead with two
  // irrelevant hitCount draws (0, 0); they no longer do.
  it('maps a non-crit r=0 draw to exactly rolls[15] (the maximum)', () => {
    const direct = directResult('MOVE_TACKLE')
    const out = resolver(scripted(1, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(out.targetDamage).toBe(direct.rolls[15])
  })
  it('maps a non-crit r=15 draw to exactly rolls[0] (the minimum)', () => {
    const direct = directResult('MOVE_TACKLE')
    const out = resolver(scripted(1, 15)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(out.targetDamage).toBe(direct.rolls[0])
  })
  it('draws crit BEFORE the damage roll: a forced-crit r=0 draw uses critRolls, not rolls', () => {
    const direct = directResult('MOVE_TACKLE')
    expect(direct.critRolls).not.toBeNull()
    const crit = resolver(scripted(0, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE'))
    expect(crit.targetDamage).toBe(direct.critRolls![15])
    // A crit changes the outcome versus the same roll index without one.
    expect(crit.targetDamage).not.toBe(direct.rolls[15])
  })
  it('consumes exactly one draw for the crit check before the roll draw (a 2nd scripted value alone flips the outcome)', () => {
    const forcedCrit = resolver(scripted(0, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE')).targetDamage
    const noCrit = resolver(scripted(1, 0)).resolve(state(), 0, 1, action('MOVE_TACKLE')).targetDamage
    expect(forcedCrit).not.toBe(noCrit)
  })
})

describe('createBridgeDamageResolver: Magnitude tier thresholds', () => {
  // magnitudeTier()'s table (damageResolver.ts): <5:4 <15:5 <35:6 <65:7 <85:8 <95:9 else:10.
  // FIX CYCLE 6: no leading hitCount draws any more (see the crit/roll describe
  // block above) -- draw order for MOVE_MAGNITUDE is now just the magnitude
  // roll, a non-crit draw (1), then a max damage roll (0), so each case
  // reduces to comparing against a tier forced directly through
  // calculateMoveDamage -- independent ground truth, not the resolver's own math.
  it.each([
    [4, 4],
    [5, 5],
    [94, 9],
    [95, 10],
  ] as const)('a magnitude roll of %i resolves to tier %i', (roll, tier) => {
    const direct = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: tier as 4 | 5 | 6 | 7 | 8 | 9 | 10 })
    const out = resolver(scripted(roll, 1, 0)).resolve(state(), 0, 1, action('MOVE_MAGNITUDE'))
    expect(out.targetDamage).toBe(direct.rolls[15])
  })
  it('a magnitude roll one below a boundary does NOT resolve to the tier above it', () => {
    const tier4 = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: 4 })
    const tier5 = directResult('MOVE_MAGNITUDE', {}, {}, { magnitudeTier: 5 })
    expect(tier4.rolls[15]).not.toBe(tier5.rolls[15])
    const belowBoundary = resolver(scripted(4, 1, 0)).resolve(state(), 0, 1, action('MOVE_MAGNITUDE'))
    expect(belowBoundary.targetDamage).toBe(tier4.rolls[15])
    expect(belowBoundary.targetDamage).not.toBe(tier5.rolls[15])
  })
})

// FIX CYCLE 6: MULTIHIT_TWO_TO_FIVE and MULTIHIT_FOUR_OR_FIVE's own RNG draws
// (formerly duplicated here) moved to their real C site, CANCELLER_MULTIHIT_MOVES
// (attackCanceller.ts, exercised by turnCanceller.test.ts) -- see
// damageResolver.ts's own header. This resolver now just READS
// BattlerState.turn.multiHitCounter, already drawn by the time it runs; these
// two describe blocks assert that reading, not a draw, by setting
// multiHitCounter directly rather than scripting the old formula's RNG values.
describe('createBridgeDamageResolver: reads multiHitCounter, does not draw it (MULTIHIT_TWO_TO_FIVE, battle_util.c:3523)', () => {
  it.each([5, 2] as const)('passes an already-set multiHitCounter of %i straight through as scenario.hitCount', (count) => {
    const direct = directResult('MOVE_ARM_THRUST', {}, {}, { hitCount: count })
    expect(direct.hitCount).toBe(count)
    const s = state()
    s.battlers[0]!.turn.multiHitCounter = count
    // Only crit (1) then a max damage roll (0) -- no hitCount draws at all.
    const out = resolver(scripted(1, 0)).resolve(s, 0, 1, action('MOVE_ARM_THRUST'))
    expect(out.targetDamage).toBe(direct.totalRolls![15])
  })
})

describe('createBridgeDamageResolver: Loaded Dice (battle_util.c:3578-3586)', () => {
  it.each([5, 4] as const)('an already-set multiHitCounter of %i (as the canceller\'s own Loaded Dice draw would set) passes straight through', (count) => {
    const a = { itemId: 'ITEM_LOADED_DICE' }
    const direct = directResult('MOVE_ARM_THRUST', a, {}, { hitCount: count })
    expect(direct.hitCount).toBe(count)
    const s = state(a)
    s.battlers[0]!.turn.multiHitCounter = count
    // No dice-roll draw here either -- attackCanceller.ts's own Loaded Dice
    // branch (GetMultihitType, battle_util.c:3586) draws that; this resolver
    // just reads its result. Only crit (1) then a max damage roll (0).
    const out = resolver(scripted(1, 0)).resolve(s, 0, 1, action('MOVE_ARM_THRUST'))
    expect(out.targetDamage).toBe(direct.totalRolls![15])
  })
})

describe('createBridgeDamageResolver: Parental Bond TWO_TO_FIVE (ABILITY_UNRELENTING) -- a found, unfixed gap', () => {
  it('with no canceller run first, multiHitCounter is 0 and multiHit.ts\'s own (pre-existing, unfixed) clamp floors it to 2, not a real draw', () => {
    // See damageResolver.ts's own header for the full citation trail:
    // GetParentalBondCount (battle_script_commands.c:1010-1044) has NO case
    // for MULTIHIT_TWO_TO_FIVE (the value Unrelenting's onParentalBond hook
    // returns), so it falls to the switch's own `return 1` default and
    // Cmd_attackcanceler's `i > 1` check (:1086) never fires -- Unrelenting's
    // Parental Bond bonus hit never actually triggers in the real game, and
    // there is no Random() draw anywhere for it to have. multiHit.ts's own
    // parentalBondHitCount still clamps whatever it is given into [2, 5]
    // regardless (a separate, pre-existing bug outside this fix's two named
    // defects and outside engine/sim/), so this resolver -- now correctly
    // NOT drawing anything -- still passes through a spurious 2-hit result
    // instead of the true single hit. Asserted here so the gap has a failing
    // canary if multiHit.ts is ever corrected without updating this test.
    const a = { abilities: { ability: 'ABILITY_UNRELENTING', innates: [null, null, null] as [string | null, string | null, string | null] } }
    const direct = directResult('MOVE_TACKLE', a, {}, { hitCount: 2 })
    expect(direct.hitCount).toBe(2)
    const out = resolver(scripted(1, 0)).resolve(state(a), 0, 1, action('MOVE_TACKLE'))
    expect(out.targetDamage).toBe(direct.totalRolls![15])
    expect(out.unmodelled).toContain('multi-hit per-hit rolls and crits are not independently drawn')
  })
})

describe('createBridgeDamageResolver: neutralToggleNotes keyed on the real consumer', () => {
  it('reads sameMoveTurnsInARow from real state.battlers[attacker].sameMoveTurns (turn.ts:deductPp), not a hardcoded 0', () => {
    // This dataset's MOVE_ECHOED_VOICE has effect EFFECT_TRIPLE_KICK, not
    // EFFECT_ECHOED_VOICE (which appears nowhere in moves.json) -- the real
    // consumer of sameMoveTurnsInARow is HOLD_EFFECT_METRONOME's item boost
    // (calculate.ts's attackerFinalItemMultiplier), for ANY move. Both a
    // fresh battler (sameMoveTurns 0, create.ts) and turn.ts's deductPp
    // (always resets to 0 in this batch, see state.ts's field doc) leave it
    // at 0, so this is no longer an unmodelled gap -- it is asserted by
    // reading the resolver's scenario input directly, the same way
    // damageResolver.test.ts's other real-consumer tests below do.
    const withMetronome = state({ itemId: 'ITEM_METRONOME' })
    // The SAME scripted draw sequence for both resolves, so hitCount/crit/roll
    // are identical and sameMoveTurns is the only thing that differs.
    const baseline = resolver(scripted(1, 3, 1, 0)).resolve(withMetronome, 0, 1, action('MOVE_TACKLE'))
    withMetronome.battlers[0]!.sameMoveTurns = 5
    const boosted = resolver(scripted(1, 3, 1, 0)).resolve(withMetronome, 0, 1, action('MOVE_TACKLE'))
    // attackerFinalItemMultiplier (calculate.ts:1219-1222) scales with
    // sameMoveTurnsInARow (20% per stack for ITEM_METRONOME, items.json), so
    // 5 stacks must read through as strictly more damage than 0.
    expect(baseline.targetDamage).not.toBeNull()
    expect(boosted.targetDamage).not.toBeNull()
    expect(boosted.targetDamage!).toBeGreaterThan(baseline.targetDamage!)
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
