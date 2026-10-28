// Entry hazards on switch-in and Rapid Spin's removal (cycle 34, step 5, batch 9).
//
// Every expected value is hand-derived from the C at the pinned SHA:
// - Cmd_switchineffects (src/battle_script_commands.c:5495-5541), VARIOUS_DO_HAZARD_DAMAGE (:8711-8830)
// - BattleScript_ResolveAllHazards chain / BattleScript_StickyWebOnSwitchIn (data/battle_scripts_1.s:7690-7771)
// - GetStealthHazardDamage (src/battle_util.c:8040-8079), IsBattlerAffectedByHazards (:8522-8530)
// - BattleScript_EffectRapidSpin (data/battle_scripts_1.s:5402-5435), Cmd_rapidspinfree (:11367-11425)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_BURN,
  STATUS1_NONE,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS3_LEECHSEED,
  STATUS_FIELD_INVERSE_ROOM,
  STAT_SPEED,
  hasFlag,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { MIRROR_ARMOR_ABILITIES, STEALTH_ROCK_IMMUNE_ABILITIES, TECTONIZE_IMMUNITIES_ABILITIES } from './hazards'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const abilityHooks = snapshot<Record<string, { bitfields?: Record<string, string> }>>('abilityHooks.json')
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

const MOVE_RAPID_SPIN = requireMove('MOVE_RAPID_SPIN')

const LEVITATE = requireAbility('ABILITY_LEVITATE')
const TECTONIZE = requireAbility('ABILITY_TECTONIZE')
const MOLTEN_CORE = requireAbility('ABILITY_MOLTEN_CORE')
const MOUNTAINEER = requireAbility('ABILITY_MOUNTAINEER')
const IMMUNITY = requireAbility('ABILITY_IMMUNITY')
const CLEAR_BODY = requireAbility('ABILITY_CLEAR_BODY')
const MIRROR_ARMOR = requireAbility('ABILITY_MIRROR_ARMOR')
const SHIELD_DUST = requireAbility('ABILITY_SHIELD_DUST')
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
// An onEntry ability that is still unported, so it reports the HandleSwitchInAbility gap.
const UNPORTED_ENTRY = requireAbility('ABILITY_FOREWARN')
const CORROSION = requireAbility('ABILITY_CORROSION')
const HEMOTOXIN = requireAbility('ABILITY_HEMOTOXIN')
const SUBDUE = requireAbility('ABILITY_SUBDUE')

// Pin the bitfield lists hazards.ts transcribes, so a repin that changes them fails here.
function abilitiesWithBitfield(field: string): string[] {
  return Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.[field] === 'TRUE').map(([id]) => id).sort()
}
describe('pinned ability lists', () => {
  it('match abilityHooks.json', () => {
    expect([...STEALTH_ROCK_IMMUNE_ABILITIES]).toEqual(abilitiesWithBitfield('stealthRockImmune'))
    expect([...TECTONIZE_IMMUNITIES_ABILITIES]).toEqual(abilitiesWithBitfield('tectonizeImmunities'))
    expect([...MIRROR_ARMOR_ABILITIES]).toEqual(abilitiesWithBitfield('mirrorArmor'))
    expect(itemsById.get('ITEM_HEAVY_DUTY_BOOTS')?.resolvedHoldEffect).toBe('HOLD_EFFECT_HEAVY_DUTY_BOOTS')
    expect(rawItems.filter((i) => i.resolvedHoldEffect === 'HOLD_EFFECT_HEAVY_DUTY_BOOTS').map((i) => i.id)).toEqual(['ITEM_HEAVY_DUTY_BOOTS'])
  })
})

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
  spikes?: number
  toxic?: number
  rockType?: number
  web?: boolean
  /** gBattleStruct->stickyWebUser: the battler that set the web (0xFF / unset = none on the field). */
  webUser?: number
  foamyWeb?: boolean
}
const TYPE_ROCK = 5
const TYPE_GRASS = 12

function setHazards(state: BattleState, sideIndex: 0 | 1, h: Hazards): void {
  const side = state.sides[sideIndex]
  if (h.spikes) {
    side.statuses |= SIDE_STATUS_SPIKES
    side.timers.spikesAmount = h.spikes
  }
  if (h.toxic) {
    side.statuses |= SIDE_STATUS_TOXIC_SPIKES
    side.timers.toxicSpikesAmount = h.toxic
  }
  if (h.rockType !== undefined) {
    side.statuses |= SIDE_STATUS_STEALTH_ROCK
    side.timers.stealthRockType = h.rockType
  }
  if (h.web) side.statuses |= SIDE_STATUS_STICKY_WEB
  if (h.webUser !== undefined) state.stickyWebUser = h.webUser
  if (h.foamyWeb) side.timers.foamyWeb = true
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
function rapidSpinAction(target: number): ChosenAction {
  const view = moveView({ id: MOVE_RAPID_SPIN.id, effect: MOVE_RAPID_SPIN.effect, resolvedType: 'NORMAL', power: MOVE_RAPID_SPIN.power, flags: MOVE_RAPID_SPIN.flags })
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
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

describe('Spikes', () => {
  it.each([
    [1, 70], // 80 / ((5-1)*2 = 8) = 10
    [2, 67], // 80 / 6 = 13.33 -> 13
    [3, 60], // 80 / 4 = 20
  ])('%i layer(s) deal maxHp / ((5 - layers) * 2): HP %i of 80', (layers, hp) => {
    const { battler, state } = enterReserve(partyMon(), { spikes: layers })
    expect(battler.mon.hp).toBe(hp)
    expect(state.sides[0].party[1]!.hp).toBe(hp)
  })

  it('deals at least 1 when the division truncates to 0', () => {
    const { battler } = enterReserve(partyMon({ hp: 5, maxHp: 5 }), { spikes: 1 }) // 5 / 8 = 0 -> 1
    expect(battler.mon.hp).toBe(4)
  })

  it.each<[string, Partial<SimPartyMon>, Record<number, string> | undefined]>([
    ['a Flying type', { types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, undefined],
    ['Levitate', { abilities: { ability: LEVITATE, innates: [null, null, null] } }, undefined],
    ['an Air Balloon holder', {}, { 0: 'HOLD_EFFECT_AIR_BALLOON' }],
    ['Magic Guard', { abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, undefined],
    ['Heavy-Duty Boots', {}, { 0: 'HOLD_EFFECT_HEAVY_DUTY_BOOTS' }],
    ['Shield Dust', { abilities: { ability: SHIELD_DUST, innates: [null, null, null] } }, undefined],
    ['a Ground type with Tectonize', { types: ['GROUND', 'MYSTERY', 'MYSTERY'], abilities: { ability: TECTONIZE, innates: [null, null, null] } }, undefined],
  ])('does not hurt %s', (_name, overrides, holdEffects) => {
    const { battler } = enterReserve(partyMon(overrides), { spikes: 3 }, { holdEffects })
    expect(battler.mon.hp).toBe(80)
  })

  it('a Ground type without Tectonize is hurt normally', () => {
    const { battler } = enterReserve(partyMon({ types: ['GROUND', 'MYSTERY', 'MYSTERY'] }), { spikes: 1 })
    expect(battler.mon.hp).toBe(70)
  })

  it('the hazard stays on the side after damaging', () => {
    const { state } = enterReserve(partyMon(), { spikes: 2 })
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[0].timers.spikesAmount).toBe(2)
  })
})

describe('Stealth Rock', () => {
  it.each<[string, SimPartyMon['types'], number]>([
    ['Water, 1x', ['WATER', 'MYSTERY', 'MYSTERY'], 70], // 80 / 8
    ['Fire/Flying, 4x', ['FIRE', 'FLYING', 'MYSTERY'], 40], // 2 * 2 = 4.0 -> 80 / 2
    ['Fighting/Ground, 0.25x', ['FIGHTING', 'GROUND', 'MYSTERY'], 78], // 0.5 * 0.5 -> 80 / 32 = 2
    ['Steel, 0.5x', ['STEEL', 'MYSTERY', 'MYSTERY'], 75], // 80 / 16
    ['Bug, 2x', ['BUG', 'MYSTERY', 'MYSTERY'], 60], // 80 / 4
    ['Fighting/Ground/Steel, 0.125x falls through GetStealthHazardDamage\'s switch', ['FIGHTING', 'GROUND', 'STEEL'], 80],
  ])('%s', (_name, types, hp) => {
    const { battler } = enterReserve(partyMon({ types }), { rockType: TYPE_ROCK })
    expect(battler.mon.hp).toBe(hp)
  })

  it('Creeping Thorns (stealthRockType Grass) uses the Grass chart', () => {
    expect(enterReserve(partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }), { rockType: TYPE_GRASS }).battler.mon.hp).toBe(60) // 2x -> 80 / 4
    expect(enterReserve(partyMon({ types: ['FIRE', 'FLYING', 'MYSTERY'] }), { rockType: TYPE_GRASS }).battler.mon.hp).toBe(78) // 0.5 * 0.5 -> 2
  })

  it('also hurts an ungrounded Flying type (no grounding check)', () => {
    expect(enterReserve(partyMon({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] }), { rockType: TYPE_ROCK }).battler.mon.hp).toBe(60) // Rock vs Flying 2x
  })

  it('uses the inverse chart under B_FLAG_INVERSE_BATTLE and Inverse Room', () => {
    const steel = () => partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })
    expect(enterReserve(steel(), { rockType: TYPE_ROCK }, { inverseBattle: true }).battler.mon.hp).toBe(60) // inverse Rock vs Steel 2x -> 80 / 4
    const state = battle([partyMon({ hp: 5 }), steel()])
    setHazards(state, 0, { rockType: TYPE_ROCK })
    state.field.statuses |= STATUS_FIELD_INVERSE_ROOM
    executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it.each<[string, Partial<SimPartyMon>, Record<number, string> | undefined]>([
    ['Molten Core', { abilities: { ability: MOLTEN_CORE, innates: [null, null, null] } }, undefined],
    ['Mountaineer (as an innate)', { abilities: { ability: null, innates: [MOUNTAINEER, null, null] } }, undefined],
    ['Heavy-Duty Boots', {}, { 0: 'HOLD_EFFECT_HEAVY_DUTY_BOOTS' }],
    ['Magic Guard', { abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, undefined],
    ['Shield Dust', { abilities: { ability: SHIELD_DUST, innates: [null, null, null] } }, undefined],
    ['a Ground type with Tectonize', { types: ['GROUND', 'MYSTERY', 'MYSTERY'], abilities: { ability: TECTONIZE, innates: [null, null, null] } }, undefined],
  ])('%s takes no damage', (_name, overrides, holdEffects) => {
    expect(enterReserve(partyMon(overrides), { rockType: TYPE_ROCK }, { holdEffects }).battler.mon.hp).toBe(80)
  })

  it('Molten Core does not block Creeping Thorns (stealthRock is only TRUE for a Rock hazard)', () => {
    const molten = partyMon({ abilities: { ability: MOLTEN_CORE, innates: [null, null, null] } })
    expect(enterReserve(molten, { rockType: TYPE_GRASS }).battler.mon.hp).toBe(60)
  })

  it('a Ground type without Tectonize takes Rock x0.5 = 5', () => {
    expect(enterReserve(partyMon({ types: ['GROUND', 'MYSTERY', 'MYSTERY'] }), { rockType: TYPE_ROCK }).battler.mon.hp).toBe(75)
  })

  it('is gapped, not guessed, when the loop was given no type tables', () => {
    const { battler, out } = enterReserve(partyMon(), { rockType: TYPE_ROCK }, { withTypes: false })
    expect(battler.mon.hp).toBe(80)
    expect(out.replacementUnmodelled.some((g) => g.includes('Stealth Rock damage') && g.includes('hazardTypes'))).toBe(true)
  })
})

describe('Toxic Spikes', () => {
  it('1 layer poisons', () => {
    const { battler, state } = enterReserve(partyMon(), { toxic: 1 })
    expect(battler.mon.status1).toBe(STATUS1_POISON)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
  })

  it('2 layers badly poison', () => {
    expect(enterReserve(partyMon(), { toxic: 2 }).battler.mon.status1).toBe(STATUS1_TOXIC_POISON)
  })

  it('a grounded Poison type absorbs them (flag and layers cleared, no status)', () => {
    const { battler, state } = enterReserve(partyMon({ types: ['POISON', 'MYSTERY', 'MYSTERY'] }), { toxic: 2 })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
    expect(state.sides[0].timers.toxicSpikesAmount).toBe(0)
  })

  it('Immunity absorbs them', () => {
    const { battler, state } = enterReserve(partyMon({ abilities: { ability: IMMUNITY, innates: [null, null, null] } }), { toxic: 1 })
    expect(battler.mon.status1).toBe(STATUS1_NONE)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
  })

  it('Heavy-Duty Boots stop the poisoning but a Poison type still absorbs them (the absorb branch has no boots check)', () => {
    const boots = { holdEffects: { 0: 'HOLD_EFFECT_HEAVY_DUTY_BOOTS' } }
    const water = enterReserve(partyMon(), { toxic: 1 }, boots)
    expect(water.battler.mon.status1).toBe(STATUS1_NONE)
    expect(hasFlag(water.state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    const poison = enterReserve(partyMon({ types: ['POISON', 'MYSTERY', 'MYSTERY'] }), { toxic: 1 }, boots)
    expect(hasFlag(poison.state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
  })

  it.each<[string, Partial<SimPartyMon>, Record<number, string> | undefined]>([
    ['a Flying type', { types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, undefined],
    ['Levitate', { abilities: { ability: LEVITATE, innates: [null, null, null] }, }, undefined],
    ['a Flying Poison type (ungrounded, so it neither absorbs nor is poisoned)', { types: ['POISON', 'FLYING', 'MYSTERY'] }, undefined],
    ['an already-statused mon', { status1: STATUS1_BURN }, undefined],
    ['a Steel type', { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }, undefined],
  ])('does not poison %s and leaves the layers in place', (_name, overrides) => {
    const { battler, state } = enterReserve(partyMon(overrides), { toxic: 2 })
    expect(battler.mon.status1).toBe(overrides.status1 ?? STATUS1_NONE)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    expect(state.sides[0].timers.toxicSpikesAmount).toBe(2)
  })

  it('the attacker for CanBePoisoned is the opposing battler: Corrosion poisons a Steel type', () => {
    const { battler } = enterReserve(partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] }), { toxic: 1 }, {}, CORROSION)
    expect(battler.mon.status1).toBe(STATUS1_POISON)
  })

  it('gaps SetOnMoveEffectReactionFlags only when the opposing mon has a poison-reaction ability', () => {
    expect(enterReserve(partyMon(), { toxic: 1 }, {}, HEMOTOXIN).out.replacementUnmodelled.some((g) => g.includes('SetOnMoveEffectReactionFlags'))).toBe(true)
    expect(enterReserve(partyMon(), { toxic: 1 }).out.replacementUnmodelled.some((g) => g.includes('SetOnMoveEffectReactionFlags'))).toBe(false)
  })
})

describe('Sticky Web', () => {
  it('lowers Speed by 1 stage', () => {
    const { battler, state } = enterReserve(partyMon(), { web: true })
    expect(battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
  })

  it.each<[string, Partial<SimPartyMon>, Record<number, string> | undefined]>([
    ['a Flying type', { types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, undefined],
    ['Levitate', { abilities: { ability: LEVITATE, innates: [null, null, null] } }, undefined],
    ['Heavy-Duty Boots', {}, { 0: 'HOLD_EFFECT_HEAVY_DUTY_BOOTS' }],
    ['Shield Dust', { abilities: { ability: SHIELD_DUST, innates: [null, null, null] } }, undefined],
    ['Clear Body', { abilities: { ability: CLEAR_BODY, innates: [null, null, null] } }, undefined],
  ])('does not lower Speed of %s', (_name, overrides, holdEffects) => {
    expect(enterReserve(partyMon(overrides), { web: true }, { holdEffects }).battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Magic Guard does not stop it (the web is not damage)', () => {
    const reserve = partyMon({ abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } })
    expect(enterReserve(reserve, { web: true }).battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  const mirror = partyMon({ abilities: { ability: MIRROR_ARMOR, innates: [null, null, null] } })

  it('Mirror Armor reflects the drop onto the web\'s setter (BattleScript_MirrorArmorReflectStickyWeb, s:3711-3715)', () => {
    const { battler, state, out } = enterReserve(mirror, { web: true, webUser: 1 })
    expect(battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(out.replacementUnmodelled.some((g) => g.includes('Mirror Armor'))).toBe(false)
  })

  it('Mirror Armor with no setter on the field (stickyWebUser unset or fainted) takes no drop and reflects nothing (s:3713)', () => {
    const none = enterReserve(mirror, { web: true })
    expect(none.battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(none.state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    // A setter whose mon is down counts as none (FaintClearSetData, battle_main.c:2990).
    const downed = battle([partyMon({ hp: 5 }), mirror], null)
    setHazards(downed, 0, { web: true, webUser: 1 })
    downed.battlers[1]!.mon.hp = 0
    executeTurn(downed, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(downed.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('the setter is the attacker of the drop: its Subdue doubles it (VARIOUS_SET_ATTACKER_STICKY_WEB_USER, :8082-8088)', () => {
    const { battler } = enterReserve(partyMon(), { web: true, webUser: 1 }, {}, SUBDUE)
    expect(battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 2)
    // With no setter the switching mon is its own attacker, so the foe's Subdue does nothing.
    expect(enterReserve(partyMon(), { web: true }, {}, SUBDUE).battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

describe('order, fainting and the second pass', () => {
  it('runs Spikes, Stealth Rock, Toxic Spikes and Sticky Web together on one switch-in', () => {
    const { battler } = enterReserve(partyMon(), { spikes: 1, rockType: TYPE_ROCK, toxic: 1, web: true })
    expect(battler.mon.hp).toBe(60) // 80 - 10 (Spikes) - 10 (Rock)
    expect(battler.mon.status1).toBe(STATUS1_POISON)
    expect(battler.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('a mon that faints to Spikes takes no later hazard, has no switch-in gaps, and is replaced again', () => {
    // 10 HP: Spikes (1 layer) deals 80/8 = 10 -> faints before Stealth Rock, Toxic Spikes and the web.
    const weak = partyMon({ hp: 10, abilities: { ability: UNPORTED_ENTRY, innates: [null, null, null] } })
    const strong = partyMon({ hp: 80, abilities: { ability: UNPORTED_ENTRY, innates: [null, null, null] } })
    const state = battle([partyMon({ hp: 5 }), weak, strong])
    setHazards(state, 0, { spikes: 1, rockType: TYPE_ROCK, toxic: 1, web: true })
    const rep = chooser(1, 2)
    const out = executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { replacement: rep }))

    expect(rep.calls).toEqual([0, 0])
    expect(state.sides[0].party[1]!.hp).toBe(0)
    expect(state.sides[0].party[1]!.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].faintedCount).toBe(2) // the original KO + the hazard faint
    expect(state.battlers[0]!.partyIndex).toBe(2)
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(state.battleOutcome).toBeNull()
    // Only the survivor reports a switch-in ability gap.
    expect(out.replacementUnmodelled.filter((g) => g.includes('HandleSwitchInAbility'))).toHaveLength(1)
  })

  it('the last reserve fainting to its own entry hazards decides the battle', () => {
    const state = battle([partyMon({ hp: 5 }), partyMon({ hp: 10 })])
    setHazards(state, 0, { spikes: 1 })
    const out = executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battleOutcome).toBe('LOST')
    expect(out.outcome).toBe('LOST')
  })

  it('hazards on the OTHER side do not touch the switching mon', () => {
    const state = battle([partyMon({ hp: 5 }), partyMon()])
    setHazards(state, 1, { spikes: 3, rockType: TYPE_ROCK, toxic: 2, web: true })
    executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('a voluntary SWITCH action meets the hazards too', () => {
    const state = battle([partyMon({ hp: 100, maxHp: 100 }), partyMon({ hp: 90, maxHp: 90 })])
    state.battlers[0]!.mon.hp = 100
    state.sides[0].party[0]!.hp = 100
    state.battlers[0]!.monToSwitchIntoId = 1
    setHazards(state, 0, { spikes: 3 })
    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    executeTurn(state, [switchAction, null], deps(fixedDamage(0)))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(68) // 90 - 90/4 (22)
  })

  it('gaps Hot Coals / Caltrops only when set', () => {
    const state = battle([partyMon({ hp: 5 }), partyMon()])
    state.sides[0].timers.hotCoals = true
    const out = executeTurn(state, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(out.replacementUnmodelled.some((g) => g.includes('Hot Coals'))).toBe(true)
    const clean = battle([partyMon({ hp: 5 }), partyMon()])
    const out2 = executeTurn(clean, [null, moveAction(0)], deps(fixedDamage(999), { replacement: chooser(1) }))
    expect(out2.replacementUnmodelled.some((g) => /Hot Coals|Caltrops/.test(g))).toBe(false)
  })
})

describe('Rapid Spin', () => {
  /** Battler 0 (fast) Rapid Spins battler 1; the hazards sit on the attacker's own side 0. */
  function spin(hazards: Hazards, damage = 20, tweak?: (s: BattleState) => void) {
    const state = battle([partyMon({ hp: 100, maxHp: 100 })], null)
    state.battlers[0]!.mon.hp = 100
    state.battlers[0]!.mon.rawStats.spe = 300
    setHazards(state, 0, hazards)
    tweak?.(state)
    const out = executeTurn(state, [rapidSpinAction(1), null], deps(fixedDamage(damage)))
    return { state, out }
  }

  it('clears every hazard on the user\'s side and zeroes the counters, then raises Speed by 1', () => {
    const { state, out } = spin({ spikes: 3, toxic: 2, rockType: TYPE_ROCK, web: true })
    const side = state.sides[0]
    expect(hasFlag(side.statuses, SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB)).toBe(false)
    expect(side.statuses & (SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB)).toBe(0)
    expect(side.timers.spikesAmount).toBe(0)
    expect(side.timers.toxicSpikesAmount).toBe(0)
    expect(side.timers.stealthRockType).toBe(0)
    expect(side.timers.stickyWebTimer).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 1 }])
    expect(act.unmodelled).not.toContain('Rapid Spin hazard/binding removal is not modelled yet')
  })

  it('leaves the opposing side\'s hazards alone', () => {
    const { state } = spin({ spikes: 1 }, 20, (s) => setHazards(s, 1, { spikes: 2, rockType: TYPE_ROCK, toxic: 1, web: true }))
    expect(state.sides[1].timers.spikesAmount).toBe(2)
    expect(state.sides[1].timers.toxicSpikesAmount).toBe(1)
    expect(state.sides[1].timers.stealthRockType).toBe(TYPE_ROCK)
    expect(state.sides[1].statuses & (SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB)).toBe(
      SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB,
    )
  })

  it('Foamy Web keeps its Sticky Web', () => {
    const { state } = spin({ web: true, foamyWeb: true, spikes: 1 })
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })

  it('frees the user of Leech Seed', () => {
    const { state } = spin({}, 20, (s) => {
      s.battlers[0]!.statuses3 |= STATUS3_LEECHSEED | 1
    })
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
    expect(state.battlers[0]!.statuses3 & 3).toBe(0)
  })

  it('removes the hazards even when Speed is already +6', () => {
    const { state } = spin({ spikes: 1 }, 20, (s) => {
      s.battlers[0]!.mon.statStages[STAT_SPEED] = 12
    })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(12)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })

  it('does nothing against an immune target (0 damage jumps straight to MoveEnd)', () => {
    const { state } = spin({ spikes: 1, rockType: TYPE_ROCK }, 0)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[0].timers.spikesAmount).toBe(1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })
})
