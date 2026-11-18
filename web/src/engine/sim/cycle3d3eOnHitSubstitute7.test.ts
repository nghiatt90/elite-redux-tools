/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3e: attacker-half on-hit abilities that gate on `targetDamage > 0` alone require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4058-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/battle_script_commands.c:1877-1893, 1935-1959
//       The substitute branch only writes `dmg` and gHpDealt, leaving physicalDmg/specialDmg at zero.
//   src/abilities.cc:
//       1. Temporal Rupture :10043-10067: CHECK(move == MOVE_ROAR_OF_TIME), CHECK(ShouldApplyOnHitEffect(target))
//       2. Absorbant :5397-5408: CHECK(ShouldApplyOnHitEffect(target)), CHECK(effect == ABSORB || DREAM_EATER)
//       3. Elemental Charge :5494-5519: CHECK(ShouldApplyOnHitEffect(target)), CHECK(Random() % 100 < 20)
//       4. Envenom :10269-10276: CHECK(ShouldApplyOnHitEffect(target)), CHECK(Random() % 100 < 30)
//       5. Flaming Jaws / Maw :6668-6676, :7765: CHECK(ShouldApplyOnHitEffect(target)), CHECK(Random() % 2)
//       6. Grip Pincer family :4689-4705, :10249, :12007-12041, :12080: CHECK(ShouldApplyOnHitEffect(target)), CHECK(Random() % 2)
//       7. Growing Tooth :3847-3856: CHECK(ShouldApplyOnHitEffect(battler)) [battler = attacker]
//       8. Illuminate :912-942: CHECK(ShouldApplyOnHitEffect(target)), CHECK(IS_BATTLER_OF_TYPE(target, TYPE_GHOST))
//       9. Loud Bang :3898-3906: CHECK(ShouldApplyOnHitEffect(target)), CHECK(IsSoundMove), CHECK(Random() % 2)
//      10. Stench :484-491: CHECK(ShouldApplyOnHitEffect(target)), CHECK(Random() % 100 < 10)
//
// Behind a Substitute, hpDealt is 0 and physicalDmg/specialDmg are 0, so targetTurnDamaged is false.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_CONFUSION,
  STATUS2_FLINCHED,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_LEECHSEED,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id, power: m.power as number, type: m.type as string | null, split: m.split as SimMoveData['split'],
    effect: m.effect as string | null, flags: (m.flags as Record<string, true>) ?? {}, accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'], type2: m.type2 as string | null, target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'], argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined, priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined, pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}
function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id, resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null, grouping: (it.grouping as string | null) ?? null,
  }
}
function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id, baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0, formOf: (s.formOf as string | null | undefined) ?? null,
  }
}
const RATIOS: [number, number][] = [[2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2]]
const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null,
    statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}

type BattlerSpec = {
  spe?: number; atk?: number; def?: number; hp?: number; maxHp?: number; speciesId?: string
  abilities?: SimBattleMon['abilities']; moves?: SimBattleMon['moves']; pp?: SimBattleMon['pp']
  types?: [string, string, string]; itemId?: string | null; status1?: number; status2?: number
}
function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  extra?: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number },
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) => createBattlerState(i, mon({
      speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
      rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
      hp: s.hp ?? 300, maxHp: s.maxHp ?? 300,
      abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
      moves: s.moves ?? ['MOVE_TACKLE', null, null, null], pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
      types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'], itemId: s.itemId ?? null,
      status1: s.status1 ?? 0, status2: s.status2 ?? 0,
    }), 0)),
    rng,
    playerParty: extra?.playerParty,
    opponentParty: extra?.opponentParty,
    battleTypeFlags: extra?.battleTypeFlags,
  })
}
function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = { calls: 0, random16: () => { r.calls++; const val = values[idx] ?? 0; idx++; return val } }
  return r
}
function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id, priority: moveData.priority ?? 0, effect: moveData.effect, isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
    power: moveData.power, flags: moveData.flags, split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0,
    isGrassyTerrainAffected: false, myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}
function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return { resolve: () => ({ targetDamage: amount, attackerDamage: null, unmodelled: [], isCriticalHit, berryReduced: false, isSuperEffective: false }) }
}
function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest, grounding, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT, moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}
const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

/** Positive control at the moveEnd boundary: hpDealt equal to targetDamage (DidMoveHit is true). Attacker has the ability. */
function runAttackerHit(
  moveId: string,
  ability: string,
  damage = 20,
  rolls: number[] = [0],
  extra?: { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec },
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage: damage,
    hpDealt: damage,
    deps: testDeps(fixedDamage(damage)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/** Substitute control at the moveEnd boundary: target absorbed the hit, hpDealt = 0. Attacker has the ability. */
function runAttackerSubstitute(
  moveId: string,
  ability: string,
  rolls: number[] = [0],
  targetDamage = 20,
  extra?: { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec },
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage,
    hpDealt: 0,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Temporal Rupture (src/abilities.cc:10043-10067)
// ---------------------------------------------------------------------------
describe('cycle3d3e 1: Temporal Rupture requires TARGET_TURN_DAMAGED (abilities.cc:10043-10067)', () => {
  it('behind a Substitute: target ability not replaced and slowStartTimer not set', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_ROAR_OF_TIME', 'ABILITY_TEMPORAL_RUPTURE', [0], 20, {
      targetSpec: { abilities: hasAbility('ABILITY_OVERGROW') },
    })
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_OVERGROW')
    expect(state.battlers[1]!.volatiles.slowStartTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: target ability replaced with Slow Start and slowStartTimer set to 5', () => {
    const { state, rng } = runAttackerHit('MOVE_ROAR_OF_TIME', 'ABILITY_TEMPORAL_RUPTURE', 20, [0], {
      targetSpec: { abilities: hasAbility('ABILITY_OVERGROW') },
    })
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_SLOW_START')
    expect(state.battlers[1]!.volatiles.slowStartTimer).toBe(5)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Absorbant (src/abilities.cc:5397-5408)
// ---------------------------------------------------------------------------
describe('cycle3d3e 2: Absorbant requires TARGET_TURN_DAMAGED (abilities.cc:5397-5408)', () => {
  it('behind a Substitute: target does not receive Leech Seed', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_GIGA_DRAIN', 'ABILITY_ABSORBANT', [0], 20, {
      targetSpec: { types: ['WATER', 'MYSTERY', 'MYSTERY'] },
    })
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: target receives Leech Seed from attacker', () => {
    const { state, rng } = runAttackerHit('MOVE_GIGA_DRAIN', 'ABILITY_ABSORBANT', 20, [0], {
      targetSpec: { types: ['WATER', 'MYSTERY', 'MYSTERY'] },
    })
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Elemental Charge (src/abilities.cc:5494-5519)
// ---------------------------------------------------------------------------
describe('cycle3d3e 3: Elemental Charge requires TARGET_TURN_DAMAGED (abilities.cc:5494-5519)', () => {
  it('behind a Substitute: target not paralyzed and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_THUNDER_SHOCK', 'ABILITY_ELEMENTAL_CHARGE', [19])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 19 < 20 inflicts paralysis', () => {
    const { state, rng } = runAttackerHit('MOVE_THUNDER_SHOCK', 'ABILITY_ELEMENTAL_CHARGE', 20, [19])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: roll 20 >= 20 does not inflict paralysis', () => {
    const { state, rng } = runAttackerHit('MOVE_THUNDER_SHOCK', 'ABILITY_ELEMENTAL_CHARGE', 20, [20])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Envenom (src/abilities.cc:10269-10276)
// ---------------------------------------------------------------------------
describe('cycle3d3e 4: Envenom requires TARGET_TURN_DAMAGED (abilities.cc:10269-10276)', () => {
  it('behind a Substitute: target not poisoned and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ENVENOM', [29])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 29 < 30 inflicts poison', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ENVENOM', 20, [29])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: roll 30 >= 30 does not inflict poison', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ENVENOM', 20, [30])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Flaming Jaws / Flaming Maw (src/abilities.cc:6668-6676, 7765)
// ---------------------------------------------------------------------------
describe('cycle3d3e 5: Flaming Jaws / Maw requires TARGET_TURN_DAMAGED (abilities.cc:6668-6676, 7765)', () => {
  it('behind a Substitute: target not burned and no roll drawn (Flaming Jaws)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_IRON_FANGS', 'ABILITY_FLAMING_JAWS', [1])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: target not burned and no roll drawn (Flaming Maw)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_IRON_FANGS', 'ABILITY_FLAMING_MAW', [1])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 1 (1 % 2 !== 0) inflicts burn', () => {
    const { state, rng } = runAttackerHit('MOVE_IRON_FANGS', 'ABILITY_FLAMING_JAWS', 20, [1])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: roll 0 (0 % 2 !== 0 is false) does not inflict burn', () => {
    const { state, rng } = runAttackerHit('MOVE_IRON_FANGS', 'ABILITY_FLAMING_JAWS', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. Grip Pincer family (src/abilities.cc:4689-4705, 10249, 12007-12041, 12080)
// ---------------------------------------------------------------------------
describe('cycle3d3e 6: Grip Pincer family requires TARGET_TURN_DAMAGED (abilities.cc:4689, 10249, 12007, 12080)', () => {
  it('behind a Substitute: target not wrapped and no roll drawn (Grip Pincer)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_GRIP_PINCER', [1, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: target not wrapped and no roll drawn (World Serpent)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_WORLD_SERPENT', [1, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: target not wrapped and no roll drawn (Serpent Bind)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_SERPENT_BIND', [1, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: target not wrapped and no roll drawn (Tentalock)', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_TENTALOCK', [1, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 1 inflicts wrap and rolls wrap turns', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_GRIP_PINCER', 20, [1, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(4) // (0 % 2) + 4 = 4
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: roll 0 does not inflict wrap', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_GRIP_PINCER', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. Growing Tooth (src/abilities.cc:3847-3856)
// ---------------------------------------------------------------------------
describe('cycle3d3e 7: Growing Tooth requires TARGET_TURN_DAMAGED and attacker alive (abilities.cc:3847-3856)', () => {
  it('behind a Substitute: attacker Attack stat stage not raised', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_IRON_FANGS', 'ABILITY_GROWING_TOOTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: attacker Attack stat stage raised by +1', () => {
    const { state, rng } = runAttackerHit('MOVE_IRON_FANGS', 'ABILITY_GROWING_TOOTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })

  it('moveEnd boundary: fainted attacker (hp = 0) does not raise Attack', () => {
    const { state, rng } = runAttackerHit('MOVE_IRON_FANGS', 'ABILITY_GROWING_TOOTH', 20, [0], {
      attackerSpec: { hp: 0 },
    })
    expect(state.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('turn loop: attacker faints from Rough Skin before case 6, so Attack is not raised', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { hp: 1, maxHp: 100, moves: ['MOVE_BITE', null, null, null], abilities: hasAbility('ABILITY_GROWING_TOOTH') },
      { hp: 100, maxHp: 100, abilities: hasAbility('ABILITY_ROUGH_SKIN') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_BITE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 8. Illuminate (src/abilities.cc:912-942)
// ---------------------------------------------------------------------------
describe('cycle3d3e 8: Illuminate requires TARGET_TURN_DAMAGED (abilities.cc:912-942)', () => {
  it('behind a Substitute: Ghost target types remain unchanged', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ILLUMINATE', [0], 20, {
      targetSpec: { types: ['GHOST', 'POISON', 'MYSTERY'] },
    })
    expect(state.battlers[1]!.mon.types).toEqual(['GHOST', 'POISON', 'MYSTERY'])
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: Ghost target types have Ghost removed', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ILLUMINATE', 20, [0], {
      targetSpec: { types: ['GHOST', 'POISON', 'MYSTERY'] },
    })
    expect(state.battlers[1]!.mon.types).toEqual(['POISON', 'POISON', 'MYSTERY'])
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 9. Loud Bang (src/abilities.cc:3898-3906)
// ---------------------------------------------------------------------------
describe('cycle3d3e 9: Loud Bang requires TARGET_TURN_DAMAGED (abilities.cc:3898-3906)', () => {
  it('behind a Substitute: target not confused and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HYPER_VOICE', 'ABILITY_LOUD_BANG', [1, 3])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 1 (1 % 2 !== 0) inflicts confusion', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_LOUD_BANG', 20, [1, 3])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(rng.calls).toBe(2) // roll 1 for chance, then roll for confusion duration
  })

  it('without a Substitute: roll 0 does not inflict confusion', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_LOUD_BANG', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 10. Stench (src/abilities.cc:484-491)
// ---------------------------------------------------------------------------
describe('cycle3d3e 10: Stench requires TARGET_TURN_DAMAGED (abilities.cc:484-491)', () => {
  it('behind a Substitute: target not flinched and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_STENCH', [9])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 9 < 10 inflicts flinch', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_STENCH', 20, [9])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: roll 10 >= 10 does not inflict flinch', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_STENCH', 20, [10])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})
