/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applySwitchInAbilities } from './switchInAbility'
import {
  DEFAULT_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STATUS2_TORMENT,
  STATUS2_WRAPPED,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { MoveData } from '../calculate'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle146Abilities.test.ts.
// ---------------------------------------------------------------------------

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
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
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
  }
}

function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: String(m.type).replace('TYPE_', ''),
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    split: m.split as MoveData['split'],
    effectChance: m.effectChance as number,
    splitFlag: m.splitFlag as string | undefined,
    effect: m.effect as string | null,
    customBehavior: m.customBehavior,
    crit: m.crit as MoveData['crit'],
    flags: (m.flags as Record<string, true>) ?? {},
    priority: m.priority as number,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
  }
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

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  replacement?: ReplacementDeps,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

const realBridge: BridgeDeps = {
  grounding: GROUNDING,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
}

function realResolverDeps(random: RandomSource): BridgeDamageResolverDeps {
  return {
    ...realBridge,
    moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
    typeChart: typeChart as never,
    inverseTypeChart: inverseTypeChart as never,
    moveBehaviors,
    battleConstants,
    random,
  }
}

function realTestDeps(random: RandomSource, replacement?: ReplacementDeps): TurnLoopDeps {
  return testDeps(createBridgeDamageResolver(realResolverDeps(random)), GROUNDING, replacement)
}

function useMove(target: number, moveId: string): ChosenAction {
  const moveData = requireMove(moveId)
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: (moveData.type ?? 'NORMAL').replace(/^TYPE_/, ''),
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return {
    action: 'USE_MOVE',
    moveToBeUsed: view,
    chosenMove: view,
    target,
  }
}

const EXPECTED_PORTED_12: Array<{ ability: string; move: string; movePower: number }> = [
  { ability: 'ABILITY_LOW_BLOW', move: 'MOVE_FEINT_ATTACK', movePower: 40 },
  { ability: 'ABILITY_CHEAP_TACTICS', move: 'MOVE_SCRATCH', movePower: 40 },
  { ability: 'ABILITY_MONKEY_BUSINESS', move: 'MOVE_TICKLE', movePower: 0 },
  { ability: 'ABILITY_DUST_CLOUD', move: 'MOVE_SAND_ATTACK', movePower: 0 },
  { ability: 'ABILITY_TRICKSTER', move: 'MOVE_DISABLE', movePower: 0 },
  { ability: 'ABILITY_SUPPRESS', move: 'MOVE_TORMENT', movePower: 0 },
  { ability: 'ABILITY_TELEKINETIC', move: 'MOVE_TELEKINESIS', movePower: 0 },
  { ability: 'ABILITY_POWDER_BURST', move: 'MOVE_POWDER', movePower: 0 },
  { ability: 'ABILITY_MONSTER_MASH', move: 'MOVE_TRICK_OR_TREAT', movePower: 0 },
  { ability: 'ABILITY_PHANTOM_THIEF', move: 'MOVE_SPECTRAL_THIEF', movePower: 40 },
  { ability: 'ABILITY_SAND_PIT', move: 'MOVE_SAND_TOMB', movePower: 20 },
  { ability: 'ABILITY_CHILLING_PRESENCE', move: 'MOVE_ICY_WIND', movePower: 10 },
]

describe('Cycle 148 - UseEntryMove abilities (first 12)', () => {
  describe('applySwitchInAbilities: queueing for each of the 12 ported abilities', () => {
    for (const { ability, move, movePower } of EXPECTED_PORTED_12) {
      it(`holder at battler 0 queues ${move} with movePower ${movePower} targeting battler 1`, () => {
        const unmodelled: string[] = []
        const state = battle(
          [{ abilities: { ability, innates: [null, null, null] } }, {}],
          scriptedRng(),
        )
        applySwitchInAbilities(state, 0, testDeps(), unmodelled)
        expect(state.queuedExtraAttacks).toEqual([
          {
            ability,
            attacker: 0,
            move,
            movePower,
            target: 1,
            falseSwipe: true,
          },
        ])
        expect(unmodelled.filter((n) => n.includes('UseEntryMove'))).toHaveLength(0)
      })

      it(`holder at battler 1 queues ${move} with movePower ${movePower} targeting battler 0`, () => {
        const unmodelled: string[] = []
        const state = battle(
          [{}, { abilities: { ability, innates: [null, null, null] } }],
          scriptedRng(),
        )
        applySwitchInAbilities(state, 1, testDeps(), unmodelled)
        expect(state.queuedExtraAttacks).toEqual([
          {
            ability,
            attacker: 1,
            move,
            movePower,
            target: 0,
            falseSwipe: true,
          },
        ])
        expect(unmodelled.filter((n) => n.includes('UseEntryMove'))).toHaveLength(0)
      })
    }
  })

  describe('negative cases', () => {
    it('foe fainted (hp: 0) queues nothing and raises no note for ported ability', () => {
      const unmodelled: string[] = []
      const state = battle(
        [{ abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } }, { hp: 0 }],
        scriptedRng(),
      )
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toEqual([])
    })

    it('holder attackCancelled queues nothing and raises no note', () => {
      const unmodelled: string[] = []
      const state = battle(
        [{ abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } }, {}],
        scriptedRng(),
      )
      state.battlers[0]!.round.attackCancelled = true
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toEqual([])
    })

    it('unported ability from the other 7 raises the note and queues nothing', () => {
      const unmodelled: string[] = []
      const state = battle(
        [{ abilities: { ability: 'ABILITY_ELECTRO_BOOSTER', innates: [null, null, null] } }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toContain(
        'battler 0: UseEntryMove (battle_util.c:3994-4019) is not modelled -- ABILITY_ELECTRO_BOOSTER queued MOVE_MAGNET_RISE',
      )
    })
  })

  describe('execution through executeTurn', () => {
    it('Cheap Tactics / Low Blow: damage calculation uses power override 40, not move base power 80', () => {
      // Attacker level 50, atk 100. Defender def 100.
      // MOVE_FEINT_ATTACK declared base power is 80 (in moves.json). Low Blow overrides to 40.
      // Formula: floor(2 * 50 / 5 + 2) = 22.
      // With power 40: floor(22 * 40 * 100 / 100 / 50) + 2 = 17 + 2 = 19 base damage.
      // With roll index 15 (100% roll): 19 * 100 / 100 = 19 damage.
      // If base power 80 were used: floor(22 * 80 * 100 / 100 / 50) + 2 = 35 + 2 = 37 base damage.
      // Roll 15 at 80 power would deal 37 damage.
      // RNG draw: accuracy (Feint Attack accuracy 0 -> 0 draws), crit roll (24), damage roll (16 -> draw 15 for 100%).
      const rng = scriptedRng([
        0, // hitCritRoll (0 != 0 -> no crit)
        15, // damage roll index (15 = 100% max roll)
      ])
      const state = battle(
        [
          { atk: 100, abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } },
          { def: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)

      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      // 100 - 19 = 81 HP (would be 63 HP if base power 80 was used)
      expect(state.battlers[1]!.mon.hp).toBe(81)
      expect(state.queuedExtraAttacks).toEqual([])
    })

    it('falseSwipe: a foe at 5 HP hit by Low Blow queued move stays at 1 HP', () => {
      // Damage is 19 >= 5, but falseSwipe: true prevents fainting and clips damage to hp - 1.
      const rng = scriptedRng([0, 15])
      const state = battle(
        [
          { atk: 100, abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } },
          { def: 100, hp: 5, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.hp).toBe(1)
      expect(state.queuedExtraAttacks).toEqual([])
    })

    it('Sand Pit: Sand Tomb wrap secondary effect applies after hit (status2 STATUS2_WRAPPED)', () => {
      // Sand Tomb accuracy 90 -> draw 0 hits (0 < 90). Wrap duration draw: (random16() % 2) + 4.
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { atk: 100, abilities: { ability: 'ABILITY_SAND_PIT', innates: [null, null, null] } },
          { def: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
      expect(state.wrappedMove[1]).toBe('MOVE_SAND_TOMB')
      expect(state.wrappedBy[1]).toBe(0)
    })

    it('Chilling Presence: Icy Wind guaranteed speed drop applies (stat stage -1 on foe)', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_CHILLING_PRESENCE', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('Status entry moves: Monkey Business Tickle drops Atk and Def by 1', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_MONKEY_BUSINESS', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('Status entry moves: Dust Cloud Sand Attack drops Accuracy by 1', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_DUST_CLOUD', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('Status entry moves: Suppress Torment applies STATUS2_TORMENT to foe', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_SUPPRESS', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_TORMENT)).toBe(true)
    })

    it('Status entry moves: Monster Mash Trick-or-Treat adds Ghost type to foe', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_MONSTER_MASH', innates: [null, null, null] } },
          { hp: 100, maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.types[2]).toBe('GHOST')
    })

    it('no PP deducted from any of the holder real moves by queued move (HITMARKER_NO_PPDEDUCT)', () => {
      const rng = scriptedRng([0, 15])
      const state = battle(
        [
          {
            moves: ['MOVE_TACKLE', null, null, null],
            pp: [35, 0, 0, 0],
            abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] },
          },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[0]!.mon.pp[0]).toBe(35)
    })

    it('case (a) lead-start drain: queued attack from lead drains before turn 1 action', () => {
      const rng = scriptedRng([0, 15, 0, 0])
      const state = battle(
        [
          { atk: 100, spe: 100, abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } },
          { def: 100, spe: 50, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)

      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.hp).toBe(81)
      expect(state.queuedExtraAttacks).toEqual([])
    })

    it('case (b) post-faint replacement drain: replacement entry move drains at end of turn', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const playerMon = partyMon({ hp: 100, maxHp: 100 })
      const opponentLead = partyMon({ hp: 10, maxHp: 100 })
      const opponentReserve = partyMon({
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        maxHp: 100,
        abilities: { ability: 'ABILITY_CHILLING_PRESENCE', innates: [null, null, null] },
      })
      const state = battle(
        [
          { spe: 100, atk: 100 },
          { spe: 50, hp: 10, maxHp: 100 },
        ],
        rng,
        [playerMon],
        [opponentLead, opponentReserve],
      )

      // Player uses a damaging move that KOs opponent lead (10 HP)
      const deps = testDeps(fixedDamage(20), GROUNDING, {
        chooseReplacement: () => 1,
      })

      executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps)

      // Opponent lead fainted and reserve switched in
      expect(state.battlers[1]!.mon.hp).toBe(100)
      expect(state.battlers[1]!.partyIndex).toBe(1)
      // Chilling Presence queued Icy Wind upon entry and drained at end of turn,
      // lowering player's speed stage from 6 to 5
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.queuedExtraAttacks).toEqual([])
    })

    it('case (c) voluntary switch drain: entry move of switched-in mon drains after switch', () => {
      const rng = scriptedRng([0, 0, 0, 0])
      const playerLead = partyMon({ hp: 100, maxHp: 100 })
      const playerReserve = partyMon({
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        maxHp: 100,
        abilities: { ability: 'ABILITY_DUST_CLOUD', innates: [null, null, null] },
      })
      const state = battle(
        [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }],
        rng,
        [playerLead, playerReserve],
      )

      const deps = testDeps(fixedDamage(0), GROUNDING, {
        chooseReplacement: () => 1,
      })

      const switchAction: ChosenAction = { action: 'SWITCH', target: 0, moveToBeUsed: null, chosenMove: null }
      executeTurn(state, [switchAction, null], deps)

      // Player switched to reserve with Dust Cloud; Sand Attack drained, lowering foe's accuracy
      expect(state.battlers[0]!.partyIndex).toBe(1)
      expect(state.battlers[1]!.mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.queuedExtraAttacks).toEqual([])
    })
  })
})
