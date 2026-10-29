/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 98: CheckMoveLimitations (battle_util.c:1622-1666) as AI_DATA->
// moveLimitations, AI_THINKING_STRUCT->switchMon (:299-318, switch items :49-62),
// and the Power Outage / Drakelp Head move-end writers. Every id and datum
// asserted on below is verified against data/v2.65beta/*.json at module load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleConstants } from '../types'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { PARTY_SIZE, STAT_ATK, STATUS2_TORMENT, STATUS3_HEAL_BLOCK, STATUS3_IMPRISONED_OTHERS, STATUS_FIELD_GRAVITY } from './constants'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { MoveData } from '../calculate'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState } from './bridge'
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'
import { getSingleUseAbilityCounter } from './switchInAbility'
import { computeMoveLimitations } from './ai/aiMoveLimitations'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { AI_FLAG_CHECK_BAD_MOVE } from './ai/aiFlags'
import { chooseMoveOrActionSingles, setupAiScores } from './ai/aiPipeline'
import { shouldSwitch } from './ai/aiShouldSwitch'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const natures = snapshot<Record<string, unknown>>('natures.json')
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
const holdEffectIds = snapshot<Record<string, number>>('holdEffectIds.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function requireMove(id: string): SimMoveData {
  const m = moveById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  } as SimMoveData
}
function toMoveData(id: string): MoveData {
  const m = requireMove(id)
  const raw = moveById.get(id) as Record<string, unknown>
  const arg = raw.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power,
    type: String(m.type).replace(/^TYPE_/, ''),
    type2: m.type2 ? String(m.type2).replace(/^TYPE_/, '') : null,
    split: m.split,
    effectChance: m.effectChance,
    splitFlag: undefined,
    effect: m.effect,
    customBehavior: m.customBehavior,
    crit: undefined,
    flags: m.flags ?? {},
    priority: m.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
  } as MoveData
}
function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}
function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Module-load verification of every id/property the fixtures depend on.
// ---------------------------------------------------------------------------
const POWER_OUTAGE = requireAbility('ABILITY_POWER_OUTAGE')
const DRAKELP_HEAD = requireAbility('ABILITY_DRAKELP_HEAD')
const PERMANENCE = requireAbility('ABILITY_PERMANENCE')
const CLEAR_BODY = requireAbility('ABILITY_CLEAR_BODY')
const CHUCKSTER = requireAbility('ABILITY_CHUCKSTER')
requireAbility('ABILITY_KLUTZ')

for (const [id, type, power, split] of [
  ['MOVE_TACKLE', 'TYPE_NORMAL', 40, 'PHYSICAL'],
  ['MOVE_THUNDER_SHOCK', 'TYPE_ELECTRIC', 80, 'SPECIAL'],
  ['MOVE_TAIL_WHIP', 'TYPE_NORMAL', 0, 'STATUS'],
  ['MOVE_SPIT_UP', 'TYPE_NORMAL', 120, 'SPECIAL'],
  ['MOVE_SWALLOW', 'TYPE_NORMAL', 0, 'STATUS'],
  ['MOVE_RECOVER', 'TYPE_NORMAL', 0, 'STATUS'],
  ['MOVE_FLY', 'TYPE_FLYING', 110, 'PHYSICAL'],
  ['MOVE_HYPER_VOICE', 'TYPE_NORMAL', 95, 'SPECIAL'],
  ['MOVE_WATER_GUN', 'TYPE_WATER', 40, 'SPECIAL'],
  ['MOVE_EMBER', 'TYPE_FIRE', 20, 'SPECIAL'],
  ['MOVE_VINE_WHIP', 'TYPE_GRASS', 80, 'PHYSICAL'],
] as const) {
  const m = requireMove(id)
  if (m.type !== type || m.power !== power || m.split !== split) throw new Error(`${id} changed shape`)
}
if (requireMove('MOVE_SPIT_UP').effect !== 'EFFECT_SPIT_UP') throw new Error('SPIT_UP is no longer EFFECT_SPIT_UP')
if (requireMove('MOVE_SWALLOW').effect !== 'EFFECT_SWALLOW') throw new Error('SWALLOW is no longer EFFECT_SWALLOW')
if (requireMove('MOVE_RECOVER').effect !== 'EFFECT_RESTORE_HP') throw new Error('RECOVER is no longer EFFECT_RESTORE_HP')
if (!requireMove('MOVE_HYPER_VOICE').flags?.sound) throw new Error('HYPER_VOICE is no longer a sound move')
if (requireItem('ITEM_CHOICE_BAND').resolvedHoldEffect !== 'HOLD_EFFECT_CHOICE_BAND') throw new Error('CHOICE_BAND no longer resolves to HOLD_EFFECT_CHOICE_BAND')
for (const [id, bst] of [['SPECIES_MUDKIP', 320], ['SPECIES_CATERPIE', 195]] as const) {
  const s = requireSpecies(id)
  const total = Object.values(s.baseStats).reduce((a, b) => a + b, 0)
  if (total !== bst) throw new Error(`${id} base-stat total changed to ${total}`)
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (moveById.has(id) ? requireMove(id) : undefined),
}

const bridge: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: RATIOS, dataContext: DATA_CONTEXT, inverseBattle: false }
const aiDeps: AiDamageDeps = {
  ...bridge,
  moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined),
  typeChart: typeChart as never,
  inverseTypeChart: inverseTypeChart as never,
  moveBehaviors,
  battleConstants: natures as unknown as BattleConstants,
  holdEffectIds,
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

type Spec = Partial<SimBattleMon>

function battle(a: Spec = {}, b: Spec = {}, rng: RandomSource = scriptedRng([]), reserves?: SimPartyMon[], aiFlags = 0): BattleState {
  const activeOpponent = partyMon({
    speciesId: b.speciesId ?? 'SPECIES_MUDKIP',
    hp: b.hp ?? 100,
    maxHp: b.maxHp ?? 100,
    moves: b.moves ?? ['MOVE_TACKLE', null, null, null],
    pp: b.pp ?? [35, 0, 0, 0],
    abilities: b.abilities ?? { ability: null, innates: [null, null, null] },
    types: b.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
    status1: b.status1 ?? 0,
  })
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(b), 0)],
    opponentParty: reserves ? [activeOpponent, ...reserves] : undefined,
    aiFlags,
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let i = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[i++] ?? 0
    },
  }
  return r
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps = (...values: number[]): SimBattleMon['pp'] => [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ?? 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20)): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

/** The move-end attacker dispatch alone (handler order, no queue drain). */
function dispatchAttacker(state: BattleState, moveId: string, targetDamage = 20) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

/** The move-end defender dispatch alone. */
function dispatchDefender(state: BattleState, moveId: string, targetDamage = 20) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

// ---------------------------------------------------------------------------
// Item A: CheckMoveLimitations, battle_util.c:1622-1666.
// ---------------------------------------------------------------------------
describe('Cycle 98 - CheckMoveLimitations bitmask (battle_util.c:1622-1666)', () => {
  function limits(state: BattleState) {
    return computeMoveLimitations(state, 0, aiDeps)
  }

  it('marks empty slots only (:1634)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE'), pp: pps(35) })
    expect(limits(state).mask).toBe(0b1110)
  })

  it('marks a 0-PP slot (:1635-1639)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 0, 20, 20) })
    expect(limits(state).mask).toBe(0b0010)
  })

  it('spares Spit Up / Swallow at 0 PP only while a stockpile exists (:1635-1639)', () => {
    const empty = battle({ moves: slot('MOVE_SPIT_UP', 'MOVE_SWALLOW', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(0, 0, 20, 20) })
    expect(limits(empty).mask).toBe(0b0011)

    const stocked = battle({ moves: slot('MOVE_SPIT_UP', 'MOVE_SWALLOW', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(0, 0, 20, 20) })
    stocked.battlers[0]!.volatiles.stockpileCounter = 1
    expect(limits(stocked).mask).toBe(0)
  })

  it('marks the disabled move (:1640)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20) })
    state.battlers[0]!.volatiles.disabledMove = 'MOVE_WATER_GUN'
    expect(limits(state).mask).toBe(0b0010)
  })

  it('marks the last move under Torment (:1641-1642)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20) })
    state.battlers[0]!.mon.status2 |= STATUS2_TORMENT
    state.battlers[0]!.lastMove = 'MOVE_WATER_GUN'
    expect(limits(state).mask).toBe(0b0010)
  })

  it('marks a power-0 move under Taunt (:1643)', () => {
    const state = battle({ moves: slot('MOVE_TAIL_WHIP', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(20, 20, 20, 20) })
    state.battlers[0]!.volatiles.tauntTimer = 2
    expect(limits(state).mask).toBe(0b0001)
  })

  it('marks moves an opposing Imprison covers (:1644)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20) })
    state.battlers[1]!.statuses3 |= STATUS3_IMPRISONED_OTHERS
    state.battlers[1]!.mon.moves = slot('MOVE_WATER_GUN')
    expect(limits(state).mask).toBe(0b0010)
  })

  it('marks every slot but the encored move (:1645)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20) })
    state.battlers[0]!.volatiles.encoreTimer = 3
    state.battlers[0]!.volatiles.encoredMove = 'MOVE_WATER_GUN'
    expect(limits(state).mask).toBe(0b1101)
  })

  it('marks Gravity-prevented moves (:1649)', () => {
    const state = battle({ moves: slot('MOVE_FLY', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(20, 20, 20, 20) })
    state.field.statuses |= STATUS_FIELD_GRAVITY
    expect(limits(state).mask).toBe(0b0001)
  })

  it('marks healing status moves under Heal Block (:1650, battle_util.c:1400-1404)', () => {
    const state = battle({ moves: slot('MOVE_RECOVER', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(20, 20, 20, 20) })
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    expect(limits(state).mask).toBe(0b0001)
  })

  it('treats a live opposing PERMANENCE as Heal Block (:1650, IsAbilityOnOpposingSide)', () => {
    const state = battle(
      { moves: slot('MOVE_RECOVER', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(20, 20, 20, 20) },
      { abilities: hasAbility(PERMANENCE) },
    )
    expect(limits(state).mask).toBe(0b0001)

    // A fainted PERMANENCE holder is not "on the opposing side".
    state.battlers[1]!.mon.hp = 0
    expect(limits(state).mask).toBe(0)
  })

  it('marks sound moves under Throat Chop (:1652)', () => {
    const state = battle({ moves: slot('MOVE_HYPER_VOICE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(20, 20, 20, 20) })
    state.battlers[0]!.volatiles.throatChopTimer = 2
    expect(limits(state).mask).toBe(0b0001)
  })

  it('returns 0 when every slot is usable', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20) })
    expect(limits(state).mask).toBe(0)
    expect(limits(state).unmodelled.some((n) => n.includes('battle_util.c:'))).toBe(false)
  })

  it('reports the Choice item lock as unmodelled, naming battle_util.c:1646', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20), itemId: 'ITEM_CHOICE_BAND' })
    const result = limits(state)
    // No invented bit: choicedMove is not in the sim state.
    expect(result.mask).toBe(0)
    expect(result.unmodelled.some((n) => n.includes('battle_util.c:1646'))).toBe(true)
  })

  it('does not report the Choice note for a negated item (Embargo/Klutz, battle_util.c:6520-6524)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 20, 20, 20), itemId: 'ITEM_CHOICE_BAND' })
    state.battlers[0]!.mon.abilities = hasAbility('ABILITY_KLUTZ')
    expect(limits(state).unmodelled.some((n) => n.includes('battle_util.c:1646'))).toBe(false)
  })

  it('does not compute limitations for a fainted battler (AI_DATA->moveLimitations is per live battler)', () => {
    const state = battle({ moves: slot('MOVE_TACKLE'), pp: pps(35), hp: 0 })
    expect(limits(state).mask).toBe(0)
    expect(limits(state).unmodelled.length).toBe(0)
  })

  it('wires the mask into setupAiScores: a flagged slot scores 0', () => {
    const state = battle({ moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP'), pp: pps(35, 0, 20, 20) })
    const { scores } = setupAiScores(state, 0, aiDeps)
    expect(scores).toEqual([100, 0, 100, 100])
  })
})

// ---------------------------------------------------------------------------
// Item B: AI_THINKING_STRUCT->switchMon.
// ---------------------------------------------------------------------------
describe('Cycle 98 - persistent switchMon (battle_ai_main.c:299-318, battle_ai_switch_items.c:49-62)', () => {
  function switchBattle(a: Spec = {}, b: Spec = {}, reserves: SimPartyMon[] = [partyMon()]) {
    return battle(a, b, scriptedRng([]), reserves, AI_FLAG_CHECK_BAD_MOVE)
  }

  it('is set when ChooseMoveOrAction_Singles takes its second switch check', () => {
    const state = switchBattle()
    const out = chooseMoveOrActionSingles(state, 1, [0, 0, 0, 0], aiDeps)
    expect(out.choice.kind).toBe('switch')
    expect(state.aiSwitchMon).toBe(true)
  })

  it('is consumed by ShouldSwitchIfAllBadMoves, which queues the PARTY_SIZE sentinel', () => {
    const state = switchBattle()
    chooseMoveOrActionSingles(state, 1, [0, 0, 0, 0], aiDeps)
    const out = shouldSwitch(state, 1, aiDeps)
    expect(out.shouldSwitch).toBe(true)
    expect(state.aiSwitchMon).toBe(false)
    // The C writes PARTY_SIZE before ShouldSwitch's later resolution runs.
    expect(state.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('a second evaluation in the same selection is no longer decided by the flag', () => {
    const state = switchBattle()
    chooseMoveOrActionSingles(state, 1, [0, 0, 0, 0], aiDeps)
    expect(shouldSwitch(state, 1, aiDeps).shouldSwitch).toBe(true)
    state.battlers[1]!.aiMonToSwitchIntoId = PARTY_SIZE
    const second = shouldSwitch(state, 1, aiDeps)
    expect(second.shouldSwitch).toBe(false)
    expect(state.aiSwitchMon).toBe(false)
  })

  it('is NOT set when any score exceeds the cap (:305-311)', () => {
    const state = switchBattle()
    const out = chooseMoveOrActionSingles(state, 1, [0, 96, 0, 0], aiDeps)
    expect(out.choice.kind).toBe('move')
    expect(state.aiSwitchMon).toBe(false)
  })

  it('is NOT set for a weak mon (BST < 310, :305)', () => {
    const state = switchBattle({}, { speciesId: 'SPECIES_CATERPIE' })
    const out = chooseMoveOrActionSingles(state, 1, [0, 0, 0, 0], aiDeps)
    expect(out.choice.kind).toBe('move')
    expect(state.aiSwitchMon).toBe(false)
  })

  it('setupAiScores clears a stale flag (BattleAI_SetupAIData memset, :164)', () => {
    const state = switchBattle()
    state.aiSwitchMon = true
    setupAiScores(state, 1, aiDeps)
    expect(state.aiSwitchMon).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item C: Power Outage (abilities.cc:12352-12371) and Drakelp Head
// (abilities.cc:12055-12079).
// ---------------------------------------------------------------------------
describe('Cycle 98 - Power Outage writer (abilities.cc:12352-12371)', () => {
  const ELECTRIC: [string, string, string] = ['ELECTRIC', 'MYSTERY', 'MYSTERY']

  it('useMove builds the USE_MOVE action the turn loop feeds to the writer', () => {
    const action = useMove(1, move('MOVE_THUNDER_SHOCK'))
    expect(action.action).toBe('USE_MOVE')
    expect(action.moveToBeUsed?.id).toBe('MOVE_THUNDER_SHOCK')
  })

  it('sets the ability state and strips Electric from an Electric attacker on the first Electric move', () => {
    const state = battle({ abilities: hasAbility(POWER_OUTAGE), types: ELECTRIC })
    dispatchAttacker(state, 'MOVE_THUNDER_SHOCK')
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(state.battlers[0]!.mon.types).toEqual(['MYSTERY', 'MYSTERY', 'MYSTERY'])
  })

  it('is one-shot: a second Electric move leaves an already-discharged holder alone', () => {
    const state = battle({ abilities: hasAbility(POWER_OUTAGE), types: ELECTRIC })
    dispatchAttacker(state, 'MOVE_THUNDER_SHOCK')
    state.battlers[0]!.mon.types = ELECTRIC
    dispatchAttacker(state, 'MOVE_THUNDER_SHOCK')
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(state.battlers[0]!.mon.types).toEqual(ELECTRIC)
  })

  it('still sets the flag for a non-Electric attacker but does not lose a type (:12358-12360 CHECK)', () => {
    const state = battle({ abilities: hasAbility(POWER_OUTAGE), types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    dispatchAttacker(state, 'MOVE_THUNDER_SHOCK')
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('does nothing on a non-Electric move (:12354-12355)', () => {
    const state = battle({ abilities: hasAbility(POWER_OUTAGE), types: ELECTRIC })
    dispatchAttacker(state, 'MOVE_TACKLE')
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    expect(state.battlers[0]!.mon.types).toEqual(ELECTRIC)
  })

  it('bridge abilityOn follows the raw flag (calc inverts it: set == discharged)', () => {
    const state = battle({ abilities: hasAbility(POWER_OUTAGE), types: ELECTRIC })
    expect(buildBattlerBattleState(state, 0, { attackerId: 0, defenderId: 1 }, aiDeps).battler.abilityOn).toBe(false)
    state.battlers[0]!.volatiles.abilityState[0] = 1
    expect(buildBattlerBattleState(state, 0, { attackerId: 0, defenderId: 1 }, aiDeps).battler.abilityOn).toBe(true)
  })
})

describe('Cycle 98 - Drakelp Head onDefender (abilities.cc:12055-12079)', () => {
  it('on the first hit sets the single-use counter and lowers the attacker Attack by 1', () => {
    const state = battle({}, { abilities: hasAbility(DRAKELP_HEAD) })
    const { res } = dispatchDefender(state, 'MOVE_TACKLE')
    expect(res.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: -1 }])
    expect(getSingleUseAbilityCounter(state, 1, DRAKELP_HEAD, DATA_CONTEXT)).toBe(1)
  })

  it('is one-shot: a second hit neither drops Attack again nor rewrites the counter', () => {
    const state = battle({}, { abilities: hasAbility(DRAKELP_HEAD) })
    dispatchDefender(state, 'MOVE_TACKLE')
    const { res } = dispatchDefender(state, 'MOVE_TACKLE')
    expect(res.statChanges).toEqual([])
    expect(getSingleUseAbilityCounter(state, 1, DRAKELP_HEAD, DATA_CONTEXT)).toBe(1)
  })

  it('does nothing on a miss (DidMoveHit false), keeping the counter clear', () => {
    const state = battle({}, { abilities: hasAbility(DRAKELP_HEAD) })
    const { res } = dispatchDefender(state, 'MOVE_TACKLE', 0)
    expect(res.statChanges).toEqual([])
    expect(getSingleUseAbilityCounter(state, 1, DRAKELP_HEAD, DATA_CONTEXT)).toBe(0)
  })

  it('spends the counter even when Clear Body blocks the drop (:12060-12062)', () => {
    const state = battle({ abilities: hasAbility(CLEAR_BODY) }, { abilities: hasAbility(DRAKELP_HEAD) })
    const { res } = dispatchDefender(state, 'MOVE_TACKLE')
    expect(res.statChanges).toEqual([])
    expect(getSingleUseAbilityCounter(state, 1, DRAKELP_HEAD, DATA_CONTEXT)).toBe(1)
  })

  it('the bridge reads the real single-use store (not abilityState)', () => {
    const state = battle({}, { abilities: hasAbility(DRAKELP_HEAD) })
    expect(buildBattlerBattleState(state, 1, { attackerId: 0, defenderId: 1 }, aiDeps).battler.abilityOn).toBe(false)
    dispatchDefender(state, 'MOVE_TACKLE')
    expect(buildBattlerBattleState(state, 1, { attackerId: 0, defenderId: 1 }, aiDeps).battler.abilityOn).toBe(true)
  })
})

describe('Cycle 98 - Chuckster hook (queued-switch drain added in Cycle 98b)', () => {
  it('arms abilityState and queues the attacker switch instead of reporting itself as not modelled', () => {
    const state = battle({}, { abilities: hasAbility(CHUCKSTER) })
    const { unmodelled } = dispatchDefender(state, 'MOVE_TACKLE')
    expect(unmodelled).not.toContain('move-end defender ability ABILITY_CHUCKSTER is not modelled yet')
    expect(state.queuedSwitches).toEqual([
      { ability: CHUCKSTER, setAbilityState: false, switchingBattler: 0, sourceBattler: 1 },
    ])
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
  })
})
