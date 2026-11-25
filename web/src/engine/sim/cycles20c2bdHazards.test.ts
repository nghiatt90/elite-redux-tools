/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2bd: Hot Coals and Caltrops applied on switch-in.
//
// Every case is hand-derived from the C at the pinned SHA:
// - VARIOUS_DO_HAZARD_DAMAGE's HAZARD_MODE_FIRE_TRAP (:8800-8822) and
//   HAZARD_MODE_CALTROPS (:8823-8836), src/battle_script_commands.c. Both open
//   with the outer `IsBattlerAlive` (:8712), gate on the side timer,
//   IsBattlerAffectedByHazards (:8522-8530) and IsBattlerGrounded (:6679-6683),
//   clear the timer BEFORE the status predicate, then run CanBeBurned
//   (:5061-5070) / CanBleed (:5106-5114).
// - Script order: data/battle_scripts_1.s:7690-7712 (Fire Trap, then Caltrops).
// - SetOnMoveEffectReactionFlags for the burn (:8811-8816); Caltrops calls none.
// - IsMyceliumMightActive, src/battle_main.c:4249: the hit marker is set only for
//   the attacker's own status move, so it is inactive during a switch-in.
//
// Most cases call `applySwitchInHazards` directly so the state can be set up
// exactly; two real switch-ins go through `enterReserve` (executeTurn) as the
// brief requires. Nothing here draws a random number.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import {
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_NONE,
  STATUS1_POISON,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { HazardDeps } from './hazards'
import { applySwitchInHazards } from './hazards'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { findAbilitySlot } from './statusEffects'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    sheerForceBoost: m.sheerForceBoost as true | undefined,
  }
}

const LEVITATE = requireAbility('ABILITY_LEVITATE')
const SHIELD_DUST = requireAbility('ABILITY_SHIELD_DUST')
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const MYCELIUM_MIGHT = requireAbility('ABILITY_MYCELIUM_MIGHT')
const WATER_VEIL = requireAbility('ABILITY_WATER_VEIL')
const SET_ABLAZE = requireAbility('ABILITY_SET_ABLAZE')
const BLOOD_BATH = requireAbility('ABILITY_BLOOD_BATH')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]
const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
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
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 80,
    maxHp: 80,
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
    status1: STATUS1_NONE,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

const noAbilities: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

/** Battler 0 (player, low HP, slow) and battler 1 (opponent, fast); the opponent's ability is configurable. */
function battle(playerParty: SimPartyMon[], opponentAbility: string | null = null, opponentParty: SimPartyMon[] = [partyMon({ hp: 100, maxHp: 100 })]): BattleState {
  const spec = (i: number, spe: number, hp: number, abilities: SimBattleMon['abilities']) =>
    createBattlerState(i, mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe }, hp, maxHp: 100, abilities }), 0)
  return createBattleState({
    battlers: [spec(0, 50, 5, noAbilities), spec(1, 200, 100, { ability: opponentAbility, innates: [null, null, null] })],
    rng: { random16: () => 0 } as RandomSource,
    playerParty,
    opponentParty,
  })
}

interface Hazards {
  hotCoals?: boolean
  caltrops?: boolean
  spikes?: number
  toxic?: number
}

function setHazards(state: BattleState, sideIndex: 0 | 1, h: Hazards): void {
  const side = state.sides[sideIndex]
  if (h.hotCoals) side.timers.hotCoals = true
  if (h.caltrops) side.timers.caltrops = true
  if (h.spikes) {
    side.statuses |= SIDE_STATUS_SPIKES
    side.timers.spikesAmount = h.spikes
  }
  if (h.toxic) {
    side.statuses |= SIDE_STATUS_TOXIC_SPIKES
    side.timers.toxicSpikesAmount = h.toxic
  }
}

function moveView(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  return {
    id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', power: 40, flags: {}, split: 'PHYSICAL',
    hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0, isGrassyTerrainAffected: false, myceliumMightAffected: false,
    ...overrides,
  }
}
function moveAction(target: number, m: TurnOrderMoveView = moveView()): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

function fixedDamage(targetDamage: number): DamageResolver {
  return { resolve: () => ({ targetDamage, attackerDamage: null, unmodelled: [] }) }
}

interface DepsOptions {
  holdEffects?: Record<number, string>
  replacement?: ReplacementDeps
  withTypes?: boolean
  inverseBattle?: boolean
}
function deps(damage: DamageResolver, o: DepsOptions = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => o.holdEffects?.[id] ?? null }
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement: o.replacement,
    hazardTypes: o.withTypes === false ? undefined : { typeChart, inverseTypeChart, inverseBattle: o.inverseBattle ?? false },
  }
}

/** Replacement choices consumed in order. */
function chooser(...indices: number[]): ReplacementDeps & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    chooseReplacement(_state, battlerId) {
      calls.push(battlerId)
      return indices[calls.length - 1]!
    },
  }
}

/** The opponent KOs the player's 5-HP active mon; the single reserve (party slot 1) switches in and meets `hazards`. */
function enterReserve(reserve: SimPartyMon, hazards: Hazards, o: DepsOptions = {}, opponentAbility: string | null = null) {
  const state = battle([partyMon({ hp: 5 }), reserve], opponentAbility)
  setHazards(state, 0, hazards)
  const rep = chooser(1)
  const out = executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { ...o, replacement: rep }))
  return { state, out, battler: state.battlers[0]! }
}

// ---------------------------------------------------------------------------
// Direct-call helpers: one hand-built battler 0 (the entrant) plus battler 1.
// ---------------------------------------------------------------------------

/** A two-battler state whose active mon 0 is `overrides` and whose opponent
 * carries `opponentAbility`. No parties: the direct calls only read timers and
 * the active mons. */
function directState(overrides: Partial<SimBattleMon> = {}, opponentAbility: string | null = null): BattleState {
  return createBattleState({
    battlers: [
      createBattlerState(0, mon(overrides), 0),
      createBattlerState(1, mon({ abilities: { ability: opponentAbility, innates: [null, null, null] } }), 0),
    ],
    rng: { random16: () => 0 } as RandomSource,
  })
}

function hazardDeps(holdEffects: Record<number, string> = {}): HazardDeps {
  return {
    dataContext: DATA_CONTEXT,
    grounding: { ...GROUNDING, holdEffectOf: (id) => holdEffects[id] ?? null },
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

interface ApplyOptions {
  holdEffects?: Record<number, string>
  opponentAbility?: string | null
  tweak?: (state: BattleState) => void
}

/** Runs the switch-in hazard port on battler 0 after setting `timers` on side 0. */
function apply(
  overrides: Partial<SimBattleMon>,
  timers: { hotCoals?: boolean; caltrops?: boolean } = {},
  opts: ApplyOptions = {},
) {
  const state = directState(overrides, opts.opponentAbility ?? null)
  if (timers.hotCoals) state.sides[0].timers.hotCoals = true
  if (timers.caltrops) state.sides[0].timers.caltrops = true
  opts.tweak?.(state)
  const unmodelled: string[] = []
  applySwitchInHazards(state, 0, hazardDeps(opts.holdEffects), unmodelled)
  return { state, unmodelled, battler: state.battlers[0]! }
}

const withAbility = (ability: string): Pick<SimBattleMon, 'abilities'> => ({ abilities: { ability, innates: [null, null, null] } })

describe('s20c2bd - Hot Coals and Caltrops on switch-in', () => {
  it('Hot Coals burns a grounded entrant and clears the timer', () => {
    const { battler, state } = apply({}, { hotCoals: true })
    expect(battler.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('Caltrops bleeds a grounded entrant and clears the timer', () => {
    const { battler, state } = apply({}, { caltrops: true })
    expect(battler.mon.status1).toBe(STATUS1_BLEED)
    expect(state.sides[0].timers.caltrops).toBe(false)
  })

  it('Hot Coals burns through a real switch-in (executeTurn)', () => {
    const { battler, state } = enterReserve(partyMon(), { hotCoals: true })
    expect(battler.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('Caltrops bleeds through a real switch-in (executeTurn)', () => {
    const { battler, state } = enterReserve(partyMon(), { caltrops: true })
    expect(battler.mon.status1).toBe(STATUS1_BLEED)
    expect(state.sides[0].timers.caltrops).toBe(false)
  })

  it("consumes only the switching side's timer", () => {
    const { state } = apply({}, { hotCoals: true, caltrops: true }, {
      tweak: (s) => {
        s.sides[1].timers.hotCoals = true
        s.sides[1].timers.caltrops = true
      },
    })
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(state.sides[0].timers.caltrops).toBe(false)
    expect(state.sides[1].timers.hotCoals).toBe(true)
    expect(state.sides[1].timers.caltrops).toBe(true)
  })

  it.each<[string, Partial<SimBattleMon>, Record<number, string> | undefined]>([
    ['a Flying type', { types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, undefined],
    ['Levitate', withAbility(LEVITATE), undefined],
    ['Heavy-Duty Boots', {}, { 0: 'HOLD_EFFECT_HEAVY_DUTY_BOOTS' }],
    ['Shield Dust', withAbility(SHIELD_DUST), undefined],
  ])('does not affect %s: no status and the timer stays set', (_name, overrides, holdEffects) => {
    const hot = apply(overrides, { hotCoals: true }, { holdEffects })
    expect(hot.battler.mon.status1).toBe(STATUS1_NONE)
    expect(hot.state.sides[0].timers.hotCoals).toBe(true)

    const cal = apply(overrides, { caltrops: true }, { holdEffects })
    expect(cal.battler.mon.status1).toBe(STATUS1_NONE)
    expect(cal.state.sides[0].timers.caltrops).toBe(true)
  })

  it('Magic Guard is NOT protected: Hot Coals burns and Caltrops bleeds it', () => {
    // Only Spikes and Stealth Rock call IsMagicGuardProtected; the two status
    // hazards do not (:8800-8836).
    const hot = apply(withAbility(MAGIC_GUARD), { hotCoals: true })
    expect(hot.battler.mon.status1).toBe(STATUS1_BURN)
    const cal = apply(withAbility(MAGIC_GUARD), { caltrops: true })
    expect(cal.battler.mon.status1).toBe(STATUS1_BLEED)
  })

  it('a Fire type fades Hot Coals with no burn', () => {
    const { battler, state } = apply({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { hotCoals: true })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it.each<[string, Partial<SimBattleMon>]>([
    ['a Rock type', { types: ['ROCK', 'MYSTERY', 'MYSTERY'] }],
    ['a Ghost type', { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }],
  ])('%s fades Caltrops with no bleed', (_name, overrides) => {
    const { battler, state } = apply(overrides, { caltrops: true })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.caltrops).toBe(false)
  })

  it('an already-statused mon keeps its status and both timers fade', () => {
    const hot = apply({ status1: STATUS1_POISON }, { hotCoals: true })
    expect(hot.battler.mon.status1).toBe(STATUS1_POISON)
    expect(hot.state.sides[0].timers.hotCoals).toBe(false)

    const cal = apply({ status1: STATUS1_POISON }, { caltrops: true })
    expect(cal.battler.mon.status1).toBe(STATUS1_POISON)
    expect(cal.state.sides[0].timers.caltrops).toBe(false)
  })

  it('Water Veil blocks the burn but Hot Coals still fades', () => {
    // STATUS_IMMUNITY_ABILITIES lists ABILITY_WATER_VEIL with CHECK_BURN.
    const { battler, state } = apply(withAbility(WATER_VEIL), { hotCoals: true })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('Safeguard blocks both statuses but both timers fade', () => {
    const hot = apply({}, { hotCoals: true }, { tweak: (s) => (s.sides[0].statuses |= SIDE_STATUS_SAFEGUARD) })
    expect(hot.battler.mon.status1).toBe(STATUS1_NONE)
    expect(hot.state.sides[0].timers.hotCoals).toBe(false)

    const cal = apply({}, { caltrops: true }, { tweak: (s) => (s.sides[0].statuses |= SIDE_STATUS_SAFEGUARD) })
    expect(cal.battler.mon.status1).toBe(STATUS1_NONE)
    expect(cal.state.sides[0].timers.caltrops).toBe(false)
  })

  it('a Fire-type Mycelium Might mon is not burned', () => {
    // IsMyceliumMightActive reads the HITMARKER (battle_main.c:4249), which is not
    // set on switch-in, so the Fire immunity still wins.
    const { battler, state } = apply({ types: ['FIRE', 'MYSTERY', 'MYSTERY'], ...withAbility(MYCELIUM_MIGHT) }, { hotCoals: true })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('with both timers set, Hot Coals burns first and Caltrops cannot bleed', () => {
    // STATUS1_ANY after the burn makes CanBleed false, but the Caltrops timer still clears.
    const { battler, state } = apply({}, { hotCoals: true, caltrops: true })
    expect(battler.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(state.sides[0].timers.caltrops).toBe(false)
  })

  it('a Fire type with both timers set: Hot Coals fades, then Caltrops bleeds', () => {
    const { battler, state } = apply({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { hotCoals: true, caltrops: true })
    expect(battler.mon.status1).toBe(STATUS1_BLEED)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(state.sides[0].timers.caltrops).toBe(false)
  })

  it('Toxic Spikes poison leaves Hot Coals unable to burn, but its timer still fades', () => {
    const { battler, state } = apply({}, { hotCoals: true }, { tweak: (s) => setHazards(s, 0, { toxic: 1 }) })
    expect(battler.mon.status1).toBe(STATUS1_POISON)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('a mon that Spikes faints never reaches either hazard, so both timers stay set', () => {
    // 3 layers: maxHp / ((5 - 3) * 2) = 100 / 4 = 25, which is exactly its 10 HP.
    const { battler, state } = apply({ hp: 10, maxHp: 100 }, { hotCoals: true, caltrops: true }, { tweak: (s) => setHazards(s, 0, { spikes: 3 }) })
    expect(battler.mon.hp).toBe(0)
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(true)
    expect(state.sides[0].timers.caltrops).toBe(true)
  })

  describe('SetOnMoveEffectReactionFlags (Hot Coals burn only)', () => {
    it('arms the opposing Set Ablaze slot with 1 << battlerId', () => {
      const { state } = apply({}, { hotCoals: true }, { opponentAbility: SET_ABLAZE })
      const foe = state.battlers[1]!
      const slot = findAbilitySlot(foe.mon.abilities, SET_ABLAZE)
      expect(slot).toBe(0)
      expect(foe.volatiles.abilityState[slot]! & (1 << 0)).toBe(1 << 0)
    })

    it('arms nothing when the entrant is a Fire type (no burn happens)', () => {
      const { battler, state } = apply({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { hotCoals: true }, { opponentAbility: SET_ABLAZE })
      expect(battler.mon.status1).toBe(STATUS1_NONE)
      const foe = state.battlers[1]!
      const slot = findAbilitySlot(foe.mon.abilities, SET_ABLAZE)
      expect(foe.volatiles.abilityState[slot]).toBe(0)
    })

    it('Caltrops calls no reaction flags: a Blood Bath opponent gets no bit', () => {
      const { battler, state } = apply({}, { caltrops: true }, { opponentAbility: BLOOD_BATH })
      expect(battler.mon.status1).toBe(STATUS1_BLEED)
      const foe = state.battlers[1]!
      const slot = findAbilitySlot(foe.mon.abilities, BLOOD_BATH)
      expect(slot).toBe(0)
      expect(foe.volatiles.abilityState[slot]).toBe(0)
    })
  })
})
