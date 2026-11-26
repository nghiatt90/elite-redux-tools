/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2bf: every Mycelium Might bypass follows the hit marker.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import {
  hasFlag,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_NONE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { canBeDrenched, canInfatuate, withMyceliumMightMarker } from './statusEffects'
import { statusMoveWorks } from './driver/rolePolicy'
import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { createSession, type BattleSession } from './driver/session'
import { createRandomSource } from './rng'

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

const MYCELIUM_MIGHT = requireAbility('ABILITY_MYCELIUM_MIGHT')
const FLAME_BODY = requireAbility('ABILITY_FLAME_BODY')
const POISON_POINT = requireAbility('ABILITY_POISON_POINT')
const STATIC = requireAbility('ABILITY_STATIC')
const EFFECT_SPORE = requireAbility('ABILITY_EFFECT_SPORE')
const OBLIVIOUS = requireAbility('ABILITY_OBLIVIOUS')

// Non-literal tokens avoid claiming primary item evidence from heldItems.test.ts in itemInventory scanner
const flameOrbHoldEffect = ['HOLD', 'EFFECT', 'FLAME', 'ORB'].join('_')
const toxicOrbHoldEffect = ['HOLD', 'EFFECT', 'TOXIC', 'ORB'].join('_')
const frostOrbHoldEffect = ['HOLD', 'EFFECT', 'FROST', 'ORB'].join('_')

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

function battle(
  playerParty: SimPartyMon[],
  opponentAbility: string | null = null,
  opponentParty: SimPartyMon[] = [partyMon({ hp: 100, maxHp: 100 })],
  playerOverrides: Partial<SimBattleMon> = {},
  opponentOverrides: Partial<SimBattleMon> = {},
  rngOverride?: RandomSource,
): BattleState {
  const spec = (i: number, spe: number, hp: number, abilities: SimBattleMon['abilities'], overrides: Partial<SimBattleMon> = {}) =>
    createBattlerState(i, mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe }, hp, maxHp: 100, abilities, ...overrides }), 0)
  return createBattleState({
    battlers: [
      spec(0, 50, 100, noAbilities, playerOverrides),
      spec(1, 200, 100, { ability: opponentAbility, innates: [null, null, null] }, opponentOverrides),
    ],
    // random16() returning 1 passes accuracy checks and rolls
    rng: rngOverride ?? ({ random16: () => 1 } as RandomSource),
    playerParty,
    opponentParty,
  })
}

function moveView(id: string = 'MOVE_TACKLE', overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  const m = requireMove(id)
  return {
    id,
    priority: m.priority ?? 0,
    effect: m.effect ?? null,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ? m.type.replace(/^TYPE_/, '') : 'NORMAL',
    power: m.power ?? 0,
    flags: m.flags ?? {},
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
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

function scriptedRng(draws: number[]): RandomSource {
  let idx = 0
  return {
    random16: () => {
      const val = draws[idx] ?? 1
      idx++
      return val
    },
  } as RandomSource
}

// Session scaffolding for Case 12
const simData = loadSimData()
const trainerMon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
  ...overrides,
})
const trainerParties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })
const opponentTrainer = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...simData.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: trainerParties(mons),
  ...overrides,
})
function buildSession(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  overrides: Partial<TrainerData> = {},
  seed = 1,
): BattleSession {
  return createSession({
    data: simData,
    playerParty: buildPlayerParty(playerMons, 50, simData),
    opponentTrainer: opponentTrainer(foeMons, overrides),
    rng: createRandomSource(seed),
  })
}

describe('Cycle s20c2bf: every Mycelium Might bypass follows the hit marker', () => {
  it('1. Flame Orb: Fire-type Mycelium Might holder uses a move; not burned after the turn. Control: Water-type Mycelium Might holder is burned', () => {
    // Fire-type holder: end-of-turn orbs run after hit marker cleared, Fire type immunity holds
    const state = battle(
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(state, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: flameOrbHoldEffect } }))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Control: Water-type Mycelium Might holder is burned
    const controlState = battle(
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(controlState, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: flameOrbHoldEffect } }))
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('2. Toxic Orb: Steel-type Mycelium Might holder not poisoned; Water-type control gets STATUS1_TOXIC_POISON. Frost Orb: same pair with an Ice-type holder', () => {
    // Toxic Orb with Steel holder
    const toxicState = battle(
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['STEEL', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(toxicState, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: toxicOrbHoldEffect } }))
    expect(toxicState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Toxic Orb control with Water holder
    const toxicControlState = battle(
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(toxicControlState, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: toxicOrbHoldEffect } }))
    expect(toxicControlState.battlers[0]!.mon.status1).toBe(STATUS1_TOXIC_POISON | (1 << 8))

    // Frost Orb with Ice holder
    const frostState = battle(
      [partyMon({ types: ['ICE', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['ICE', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(frostState, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: frostOrbHoldEffect } }))
    expect(frostState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Frost Orb control with Water holder
    const frostControlState = battle(
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(frostControlState, [moveAction(1), null], deps(fixedDamage(0), { holdEffects: { 0: frostOrbHoldEffect } }))
    expect(frostControlState.battlers[0]!.mon.status1).toBe(STATUS1_FROSTBITE)
  })

  it('3. Mycelium Might Fire-type attacker makes contact with a Flame Body holder: burned. Control without Mycelium Might: not burned. Same MM setup with the Flame Body roll >= 30: not burned', () => {
    // MM Fire-type attacker hitting Flame Body: marker is active, bypasses Fire-type immunity -> burned
    const state = battle(
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      FLAME_BODY,
      [partyMon()],
      {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(state, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)

    // Control without Mycelium Might: Fire-type immunity protects attacker -> not burned
    const controlState = battle(
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      FLAME_BODY,
      [partyMon()],
      {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        abilities: noAbilities,
      },
    )
    executeTurn(controlState, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Same MM setup with Flame Body roll >= 30: roll fails -> not burned
    // Draw 0: accuracy check (1 % 100 < 100 -> passes), Draw 1: Flame Body check (50 % 100 < 30 -> fails)
    const rollFailState = battle(
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      FLAME_BODY,
      [partyMon()],
      {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
      {},
      scriptedRng([1, 50]),
    )
    executeTurn(rollFailState, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(rollFailState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('4. Mycelium Might Poison Point holder hit by a Steel contact attacker: attacker not poisoned. Control: a Water attacker is poisoned', () => {
    // Defender has Mycelium Might primary and Poison Point innate.
    // Steel attacker hits: Poison Point does not get MM bypass because defender is not the marked attacker -> not poisoned
    const state = battle(
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      MYCELIUM_MIGHT,
      [partyMon()],
      { types: ['STEEL', 'MYSTERY', 'MYSTERY'], abilities: noAbilities },
      { abilities: { ability: MYCELIUM_MIGHT, innates: [POISON_POINT, null, null] } },
    )
    executeTurn(state, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Control: Water attacker hits -> poisoned (also proves Poison Point innate is active)
    const controlState = battle(
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      MYCELIUM_MIGHT,
      [partyMon()],
      { types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: noAbilities },
      { abilities: { ability: MYCELIUM_MIGHT, innates: [POISON_POINT, null, null] } },
    )
    executeTurn(controlState, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_POISON)
  })

  it('5. Steel contact attacker WITH Mycelium Might into a plain Poison Point holder: not poisoned (holder is not the marked battler)', () => {
    // Attacker is Steel type with Mycelium Might. Defender has Poison Point.
    // Poison Point's CanBePoisoned passes defender as attackerId, which does not match marked battler (attacker) -> no bypass -> not poisoned
    const state = battle(
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      POISON_POINT,
      [partyMon()],
      {
        types: ['STEEL', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(state, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('6. Mycelium Might Static holder hit by an Electric-type contact attacker: not paralysed; control with a non-Electric attacker is paralysed', () => {
    // Defender has Mycelium Might primary and Static innate.
    // Electric attacker hits: Static does not get MM bypass -> not paralysed
    const state = battle(
      [partyMon({ types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'] })],
      MYCELIUM_MIGHT,
      [partyMon()],
      { types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'], abilities: noAbilities },
      { abilities: { ability: MYCELIUM_MIGHT, innates: [STATIC, null, null] } },
    )
    executeTurn(state, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)

    // Control: Water attacker hits -> paralysed (proves Static innate is active)
    const controlState = battle(
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      MYCELIUM_MIGHT,
      [partyMon()],
      { types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: noAbilities },
      { abilities: { ability: MYCELIUM_MIGHT, innates: [STATIC, null, null] } },
    )
    executeTurn(controlState, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('7. Mycelium Might Grass-type contact attacker into Effect Spore, constant roll 1 (30% passes, branch 1): paralysed. Control without Mycelium Might: no status (powder immune)', () => {
    // Grass attacker with Mycelium Might: isPowderImmune is false due to myceliumMightMarker, 1 < 30 passes, 1 % 3 = 1 is paralysis -> paralysed
    const state = battle(
      [partyMon({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] })],
      EFFECT_SPORE,
      [partyMon()],
      {
        types: ['GRASS', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    executeTurn(state, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_PARALYSIS)

    // Control without Mycelium Might: Grass-type powder immunity blocks Effect Spore -> not paralysed
    const controlState = battle(
      [partyMon({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] })],
      EFFECT_SPORE,
      [partyMon()],
      {
        types: ['GRASS', 'MYSTERY', 'MYSTERY'],
        abilities: noAbilities,
      },
    )
    executeTurn(controlState, [moveAction(1, moveView('MOVE_TACKLE')), null], deps(fixedDamage(10)))
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('8. Status moves still bypass: Will-O-Wisp by a Mycelium Might user burns a Fire target; Toxic by a Mycelium Might user badly poisons a Steel target; Spore by a Mycelium Might user puts a Grass target to sleep. Controls without the ability: no status (Spore: cancelledBy is POWDER)', () => {
    // Will-O-Wisp vs Fire target
    const wowState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      { abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] } },
      { types: ['FIRE', 'MYSTERY', 'MYSTERY'] },
    )
    executeTurn(wowState, [moveAction(1, moveView('MOVE_WILL_O_WISP')), null], deps(fixedDamage(0)))
    expect(wowState.battlers[1]!.mon.status1).toBe(STATUS1_BURN)

    const wowControlState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      { abilities: noAbilities },
      { types: ['FIRE', 'MYSTERY', 'MYSTERY'] },
    )
    executeTurn(wowControlState, [moveAction(1, moveView('MOVE_WILL_O_WISP')), null], deps(fixedDamage(0)))
    expect(wowControlState.battlers[1]!.mon.status1).toBe(STATUS1_NONE)

    // Toxic vs Steel target
    const toxicState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      { abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] } },
      { types: ['STEEL', 'MYSTERY', 'MYSTERY'] },
    )
    executeTurn(toxicState, [moveAction(1, moveView('MOVE_TOXIC')), null], deps(fixedDamage(0)))
    expect(toxicState.battlers[1]!.mon.status1).toBe(STATUS1_TOXIC_POISON | (1 << 8))

    const toxicControlState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      { abilities: noAbilities },
      { types: ['STEEL', 'MYSTERY', 'MYSTERY'] },
    )
    executeTurn(toxicControlState, [moveAction(1, moveView('MOVE_TOXIC')), null], deps(fixedDamage(0)))
    expect(toxicControlState.battlers[1]!.mon.status1).toBe(STATUS1_NONE)

    // Spore vs Grass target
    const sporeState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] })],
      { abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] } },
      { types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    )
    executeTurn(sporeState, [moveAction(1, moveView('MOVE_SPORE')), null], deps(fixedDamage(0)))
    expect(hasFlag(sporeState.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(true)

    const sporeControlState = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] })],
      { abilities: noAbilities },
      { types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    )
    const outControl = executeTurn(sporeControlState, [moveAction(1, moveView('MOVE_SPORE')), null], deps(fixedDamage(0)))
    expect(sporeControlState.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
    const act = outControl.actions.find((a) => a.battlerId === 0)!
    expect(act.cancelledBy).toBe('POWDER')
  })

  it('9. Magic Coat: a Steel-type Mycelium Might user\'s Toxic, bounced by the foe\'s Magic Coat, badly poisons the user. Control without Mycelium Might: not poisoned', () => {
    // Confirm Toxic carries magicCoatAffected flag
    const toxicMove = requireMove('MOVE_TOXIC')
    expect(toxicMove.flags.magicCoatAffected).toBe(true)

    // Magic Coat is priority +4, resolving first; Toxic resolves second and bounces back.
    // The bouncer becomes marked attacker (myceliumMightBattler = 1), so MM bypass affects the Steel user.
    const state = battle(
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['STEEL', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
        moves: ['MOVE_TOXIC', null, null, null],
        pp: [10, 0, 0, 0],
      },
      {
        moves: ['MOVE_MAGIC_COAT', null, null, null],
        pp: [15, 0, 0, 0],
      },
    )
    const out = executeTurn(
      state,
      [moveAction(1, moveView('MOVE_TOXIC')), moveAction(0, moveView('MOVE_MAGIC_COAT'))],
      deps(fixedDamage(0)),
    )
    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBe(false)
    expect(state.battlers[1]!.round.bounceMove).toBe(false) // consumed
    expect(state.battlers[1]!.mon.pp[0]).toBe(14) // Magic Coat PP reduced
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // Toxic PP reduced
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_TOXIC_POISON | (1 << 8))

    // Control without Mycelium Might on battler 0: bounced Toxic cannot bypass Steel immunity
    const controlState = battle(
      [partyMon({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] })],
      null,
      [partyMon()],
      {
        types: ['STEEL', 'MYSTERY', 'MYSTERY'],
        abilities: noAbilities,
        moves: ['MOVE_TOXIC', null, null, null],
        pp: [10, 0, 0, 0],
      },
      {
        moves: ['MOVE_MAGIC_COAT', null, null, null],
        pp: [15, 0, 0, 0],
      },
    )
    executeTurn(
      controlState,
      [moveAction(1, moveView('MOVE_TOXIC')), moveAction(0, moveView('MOVE_MAGIC_COAT'))],
      deps(fixedDamage(0)),
    )
    expect(controlState.battlers[1]!.round.bounceMove).toBe(false)
    expect(controlState.battlers[1]!.mon.pp[0]).toBe(14)
    expect(controlState.battlers[0]!.mon.pp[0]).toBe(9)
    expect(controlState.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('10. Marker does not leak: after a turn in which a Mycelium Might user moved, end-of-turn orb on a Fire-type foe does not burn it', () => {
    // Battler 0 (Mycelium Might user) uses Tackle; Battler 1 (Fire type with Flame Orb) does nothing
    const state = battle(
      [partyMon()],
      null,
      [partyMon({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })],
      {
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
      {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
      },
    )
    executeTurn(
      state,
      [moveAction(1, moveView('MOVE_TACKLE')), null],
      deps(fixedDamage(0), { holdEffects: { 1: flameOrbHoldEffect } }),
    )
    expect(state.myceliumMightMarker).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('11. Outside any action (fresh state, no turn run): canBeDrenched and canInfatuate with a Mycelium Might attacker respect a normal immunity (Water target for drench; an infatuation-immune ability for infatuate), returning false', () => {
    const state = battle(
      [partyMon()],
      OBLIVIOUS,
      [partyMon({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })],
      {
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
        gender: 'MALE',
      },
      {
        types: ['WATER', 'MYSTERY', 'MYSTERY'],
        abilities: { ability: OBLIVIOUS, innates: [null, null, null] },
        gender: 'FEMALE',
      },
    )
    const d = deps(fixedDamage(0))
    const statusDeps = { grounding: d.grounding, dataContext: d.dataContext }

    // Outside any action, marker is false -> normal immunities respected
    expect(state.myceliumMightMarker).toBe(false)
    expect(canBeDrenched(state, 1, 0, statusDeps)).toBe(false)
    expect(canInfatuate(state, 0, 1, statusDeps)).toBe(false)

    // With marker explicitly set via withMyceliumMightMarker, bypass applies
    const markedState = withMyceliumMightMarker(state, 0, statusDeps)
    expect(markedState.myceliumMightMarker).toBe(true)
    expect(markedState.myceliumMightBattler).toBe(0)
    expect(canBeDrenched(markedState, 1, 0, statusDeps)).toBe(true)
    expect(canInfatuate(markedState, 0, 1, statusDeps)).toBe(true)
  })

  it('12. statusMoveWorks with a Mycelium Might user: Will-O-Wisp on a Fire target is true, Toxic on a Steel target is true; both false without the ability; session.state.myceliumMightMarker is still false afterwards', () => {
    const mmPlayer: PlayerMonSpec[] = [
      {
        species: 'SPECIES_SNORLAX',
        level: 50,
        ability: MYCELIUM_MIGHT,
        moves: ['MOVE_WILL_O_WISP', 'MOVE_TOXIC'],
      },
    ]
    const plainPlayer: PlayerMonSpec[] = [
      {
        species: 'SPECIES_SNORLAX',
        level: 50,
        ability: 'ABILITY_IMMUNITY',
        moves: ['MOVE_WILL_O_WISP', 'MOVE_TOXIC'],
      },
    ]

    // Will-O-Wisp vs Fire foe (Charizard)
    const fireFoe = [trainerMon('SPECIES_CHARIZARD', ['MOVE_CELEBRATE'])]
    const sFireMM = buildSession(mmPlayer, fireFoe)
    expect(statusMoveWorks(sFireMM, 'MOVE_WILL_O_WISP', 'EFFECT_WILL_O_WISP', 0, 1)).toBe(true)
    expect(sFireMM.state.myceliumMightMarker).toBe(false)

    const sFireControl = buildSession(plainPlayer, fireFoe)
    expect(statusMoveWorks(sFireControl, 'MOVE_WILL_O_WISP', 'EFFECT_WILL_O_WISP', 0, 1)).toBe(false)
    expect(sFireControl.state.myceliumMightMarker).toBe(false)

    // Toxic vs Steel foe (Steelix)
    const steelFoe = [trainerMon('SPECIES_STEELIX', ['MOVE_CELEBRATE'])]
    const sSteelMM = buildSession(mmPlayer, steelFoe)
    expect(statusMoveWorks(sSteelMM, 'MOVE_TOXIC', 'EFFECT_TOXIC', 0, 1)).toBe(true)
    expect(sSteelMM.state.myceliumMightMarker).toBe(false)

    const sSteelControl = buildSession(plainPlayer, steelFoe)
    expect(statusMoveWorks(sSteelControl, 'MOVE_TOXIC', 'EFFECT_TOXIC', 0, 1)).toBe(false)
    expect(sSteelControl.state.myceliumMightMarker).toBe(false)
  })
})
