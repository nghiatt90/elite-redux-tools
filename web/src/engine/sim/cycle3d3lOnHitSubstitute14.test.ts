/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3l: attacker-half on-hit abilities Know Your Place/Tangled Tails, Paint Shot, Sinister Claws,
// Spinning Top, Venoblaze Pincers, Virus, Vitality Strike and Wings of Pestilence that gated on the bare
// `hpDealt > 0` require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Know Your Place :9074-9085: ShouldApplyOnHitEffect(target), target not already dazed, contact,
//          dazed = 5 + started.dazed; Tangled Tails :12001-12004 shares `.onAttacker`
//       2. Paint Shot      :10711-10725: ShouldApplyOnHitEffect(target), target not of the move's type,
//          IsMegaLauncherBoosted, type1 = type2 = moveType, type3 = TYPE_MYSTERY
//       3. Sinister Claws  :12415-12429: ShouldApplyOnHitEffect(target), MOVE_FLAG_KEEN_EDGE,
//          StatLowerableOrMirrorArmor(target, STAT_SPDEF), once-per-turn counter, SpDef -1
//       4. Spinning Top    :5116-5142: ShouldApplyOnHitEffect(battler) -- the HOLDER -- Fighting move,
//          CheckAndSetOncePerTurnAbility, clear hazards, Speed +1
//       5. Venoblaze Pincers :8129-8146: ShouldApplyOnHitEffect(target), physical, Random() % 100 < 20,
//          then Random() % 2 (0 burn via CanBeBurned, 1 toxic via CanBePoisoned)
//       6. Virus           :10907-10913: ShouldApplyOnHitEffect(target), moveType Electric, CanBePoisoned, poison
//       7. Vitality Strike :8545-8556: ShouldApplyOnHitEffect(battler) -- the ATTACKER -- not at max HP,
//          CanBattlerHeal, IsIronFistBoosted, heal max(1, floor(hpDealt / 10))
//       8. Wings of Pestilence :11297-11313: ShouldApplyOnHitEffect(target), Random() % 100 < 10 && !cursed,
//          Random() % 100 < 20 && CanBleed
//
// Behind a Substitute, hpDealt is 0 and physicalDmg/specialDmg are 0, so targetTurnDamaged is false. When an
// earlier hit of the same turn already removed HP, physicalDmg is nonzero and the effect still applies.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { getOncePerTurnAbilityCounter } from './switchInAbility'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_CURSED,
  STATUS2_SUBSTITUTE,
  hasFlag,
  setFlag,
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
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

type HelperExtra = {
  attackerSpec?: BattlerSpec
  targetSpec?: BattlerSpec
  isCriticalHit?: boolean
  /** State precondition a runner cannot express through BattlerSpec. */
  setup?: (state: BattleState) => void
}

/** Positive control at the moveEnd boundary: hpDealt equal to targetDamage (DidMoveHit is true). Attacker has the ability. */
function runAttackerHit(
  moveId: string,
  ability: string,
  damage = 20,
  rolls: number[] = [0],
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage: damage,
    hpDealt: damage,
    isCriticalHit: extra?.isCriticalHit ?? false,
    deps: testDeps(fixedDamage(damage, extra?.isCriticalHit ?? false)),
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
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage,
    hpDealt: 0,
    isCriticalHit: extra?.isCriticalHit ?? false,
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/**
 * Earlier-hit control: this hit dealt 0, but an earlier hit of the same turn recorded 20 in the target's
 * turn struct (battle.h:750), so TARGET_TURN_DAMAGED is true. No Substitute -- the effect must really apply.
 */
function runAttackerEarlierHitDamaged(
  moveId: string,
  ability: string,
  rolls: number[] = [0],
  targetDamage = 20,
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  state.battlers[1]!.turn.physicalDmg = 20
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage,
    hpDealt: 0,
    isCriticalHit: extra?.isCriticalHit ?? false,
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Know Your Place / Tangled Tails (src/abilities.cc:9074-9085, :12001-12004). Contact (MOVE_TACKLE),
// target not already dazed, no roll. Tangled Tails reuses Know Your Place's onAttacker lambda.
// ---------------------------------------------------------------------------
describe('cycle3d3l 1: Know Your Place / Tangled Tails require TARGET_TURN_DAMAGED (abilities.cc:9074-9085, :12001-12004)', () => {
  for (const ability of ['ABILITY_KNOW_YOUR_PLACE', 'ABILITY_TANGLED_TAILS']) {
    it(`hpDealt > 0: ${ability} sets dazed = 5 and the started bit with no roll`, () => {
      const { state, rng } = runAttackerHit('MOVE_TACKLE', ability, 20, [])
      expect(state.battlers[1]!.volatiles.dazed).toBe(5)
      expect(state.battlers[1]!.volatiles.started.dazed).toBe(true)
      expect(rng.calls).toBe(0)
    })

    it(`behind a Substitute: ${ability} leaves the target undazed and draws no roll`, () => {
      const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', ability, [])
      expect(state.battlers[1]!.volatiles.dazed).toBe(0)
      expect(state.battlers[1]!.volatiles.started.dazed).toBe(false)
      expect(rng.calls).toBe(0)
    })

    it(`earlier hit damaged the target: ${ability} still dazes on hpDealt 0`, () => {
      const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', ability, [])
      expect(state.battlers[1]!.volatiles.dazed).toBe(5)
      expect(state.battlers[1]!.volatiles.started.dazed).toBe(true)
      expect(rng.calls).toBe(0)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Paint Shot (src/abilities.cc:10711-10725). MOVE_WATER_GUN carries the bulletBased flag that
// IsMegaLauncherBoosted reads (battle_util.c:9373). The target starts NORMAL/MYSTERY, not WATER.
// ---------------------------------------------------------------------------
describe('cycle3d3l 2: Paint Shot requires TARGET_TURN_DAMAGED (abilities.cc:10711-10725)', () => {
  it('hpDealt > 0: retypes the target and draws no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_WATER_GUN', 'ABILITY_PAINT_SHOT', 20, [])
    expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: the target keeps its types and no roll is drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_WATER_GUN', 'ABILITY_PAINT_SHOT', [])
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still retypes', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_WATER_GUN', 'ABILITY_PAINT_SHOT', [])
    expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Sinister Claws (src/abilities.cc:12415-12429). MOVE_AERIAL_ACE is sliceBased (Keen Edge). The SpDef drop
// and the once-per-turn counter (1 << target) happen only after ShouldApplyOnHitEffect and the Keen Edge check.
// ---------------------------------------------------------------------------
describe('cycle3d3l 3: Sinister Claws requires TARGET_TURN_DAMAGED (abilities.cc:12415-12429)', () => {
  it('hpDealt > 0: drops SpDef one stage and consumes the once-per-turn counter, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_AERIAL_ACE', 'ABILITY_SINISTER_CLAWS', 20, [])
    expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SINISTER_CLAWS', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no stat drop and the once-per-turn counter stays unconsumed', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_AERIAL_ACE', 'ABILITY_SINISTER_CLAWS', [])
    expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SINISTER_CLAWS', DATA_CONTEXT)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still drops SpDef and consumes the counter', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_AERIAL_ACE', 'ABILITY_SINISTER_CLAWS', [])
    expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SINISTER_CLAWS', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Spinning Top (src/abilities.cc:5116-5142). ShouldApplyOnHitEffect(battler) is the HOLDER, so the liveness
// term stays on the attacker, but TARGET_TURN_DAMAGED is still the target's turn struct. MOVE_KARATE_CHOP is
// Fighting. Hazards live on the attacker's own side (sides[attackerId & 1]).
// ---------------------------------------------------------------------------
describe('cycle3d3l 4: Spinning Top requires TARGET_TURN_DAMAGED (abilities.cc:5116-5142)', () => {
  const hazardsUp = (state: BattleState) => {
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES)
  }

  it('hpDealt > 0: clears the holder side hazards and raises Speed, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_KARATE_CHOP', 'ABILITY_SPINNING_TOP', 20, [], { setup: hazardsUp })
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SPINNING_TOP', DATA_CONTEXT)).toBe(1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: hazards kept, no Speed change and the once-per-turn flag NOT consumed', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_KARATE_CHOP', 'ABILITY_SPINNING_TOP', [], 20, { setup: hazardsUp })
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SPINNING_TOP', DATA_CONTEXT)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still clears hazards and raises Speed', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_KARATE_CHOP', 'ABILITY_SPINNING_TOP', [], 20, { setup: hazardsUp })
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_SPINNING_TOP', DATA_CONTEXT)).toBe(1)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Venoblaze Pincers (src/abilities.cc:8129-8146). Physical move, Random() % 100 < 20, then Random() % 2:
// branch 0 burns (CanBeBurned), branch 1 badly poisons (CanBePoisoned). Two draws on a real hit.
// ---------------------------------------------------------------------------
describe('cycle3d3l 5: Venoblaze Pincers requires TARGET_TURN_DAMAGED (abilities.cc:8129-8146)', () => {
  it('hpDealt > 0: the 20% roll lands, branch 0 burns, two draws', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_VENOBLAZE_PINCERS', 20, [0, 0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(2)
  })

  it('behind a Substitute: no status and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_VENOBLAZE_PINCERS', [0, 0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns on the same two draws', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_VENOBLAZE_PINCERS', [0, 0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. Virus (src/abilities.cc:10907-10913). Electric move (MOVE_THUNDERBOLT), CanBePoisoned, no roll. The
// target is NORMAL/MYSTERY, so it is neither Poison nor Steel.
// ---------------------------------------------------------------------------
describe('cycle3d3l 6: Virus requires TARGET_TURN_DAMAGED (abilities.cc:10907-10913)', () => {
  it('hpDealt > 0: poisons with no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_THUNDERBOLT', 'ABILITY_VIRUS', 20, [])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no status and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_THUNDERBOLT', 'ABILITY_VIRUS', [])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still poisons', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_THUNDERBOLT', 'ABILITY_VIRUS', [])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Vitality Strike (src/abilities.cc:8545-8556). ShouldApplyOnHitEffect(battler) is the ATTACKER.
// MOVE_BULLET_PUNCH is punchBased (Iron Fist). Heal = max(1, floor(hpDealt / 10)); the earlier-hit case has
// hpDealt 0, so the C bumps -0 to -1, i.e. exactly +1 HP.
// ---------------------------------------------------------------------------
describe('cycle3d3l 7: Vitality Strike requires TARGET_TURN_DAMAGED (abilities.cc:8545-8556)', () => {
  const hurtAttacker: HelperExtra = { attackerSpec: { hp: 100, maxHp: 300 } }

  it('hpDealt > 0: heals floor(hpDealt / 10) with no ability roll', () => {
    const { state, rng } = runAttackerHit('MOVE_BULLET_PUNCH', 'ABILITY_VITALITY_STRIKE', 50, [], hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(105)
    expect(rng.calls).toBe(0)
  })

  it('hpDealt below 10 floors to exactly 1 HP', () => {
    const { state, rng } = runAttackerHit('MOVE_BULLET_PUNCH', 'ABILITY_VITALITY_STRIKE', 7, [], hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(101)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no heal and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_BULLET_PUNCH', 'ABILITY_VITALITY_STRIKE', [], 50, hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still heals the bumped minimum of 1', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_BULLET_PUNCH', 'ABILITY_VITALITY_STRIKE', [], 50, hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(101)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Wings of Pestilence (src/abilities.cc:11297-11313). Both draws happen after ShouldApplyOnHitEffect: the
// 10% curse roll (drawn before the STATUS2_CURSED test) and the 20% bleed roll (drawn before CanBleed).
// ---------------------------------------------------------------------------
describe('cycle3d3l 8: Wings of Pestilence requires TARGET_TURN_DAMAGED (abilities.cc:11297-11313)', () => {
  it('hpDealt > 0: curses and bleeds on two draws', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_WINGS_OF_PESTILENCE', 20, [0, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('behind a Substitute: no curse, no bleed and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_WINGS_OF_PESTILENCE', [0, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still curses and bleeds on the same two draws', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_WINGS_OF_PESTILENCE', [0, 0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(rng.calls).toBe(2)
  })
})
