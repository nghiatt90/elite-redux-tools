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
import { applySwitchInAbilities, getSingleUseAbilityCounter } from './switchInAbility'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPEED,
  STATUS1_SLEEP,
  STATUS2_WRAPPED,
  STATUS3_YAWN,
  SIDE_STATUS_FUTUREATTACK,
  SIDE_STATUS_SPIKES,
  hasFlag,
  getCounter,
} from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { MoveData } from '../calculate'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle148EntryMoves.test.ts.
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
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
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
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
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
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 100,
            spatk: s.spatk ?? 100,
            spdef: s.spdef ?? 100,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
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
      isCriticalHit,
      effectiveness: 'NORMAL',
      rolls: [amount],
      unmodelled: [],
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
  return { action: 'USE_MOVE', chosenMove: view, moveToBeUsed: view, target }
}

const EXPECTED_PORTED_12: Array<{ ability: string; move: string }> = [
  { ability: 'ABILITY_DOOMBRINGER', move: 'MOVE_DOOM_DESIRE' },
  { ability: 'ABILITY_WISHMAKER', move: 'MOVE_WISH' },
  { ability: 'ABILITY_CHANGE_OF_HEART', move: 'MOVE_HEART_SWAP' },
  { ability: 'ABILITY_WEB_SPINNER', move: 'MOVE_STRING_SHOT' },
  { ability: 'ABILITY_DRACO_MORALE', move: 'MOVE_DRAGON_CHEER' },
  { ability: 'ABILITY_DREAM_WHIMSY', move: 'MOVE_YAWN' },
  { ability: 'ABILITY_WILDFIRE', move: 'MOVE_FIRE_SPIN' },
  { ability: 'ABILITY_JUMP_SCARE', move: 'MOVE_ASTONISH' },
  { ability: 'ABILITY_TAR_TOSS', move: 'MOVE_TAR_SHOT' },
  { ability: 'ABILITY_WIND_RAGE', move: 'MOVE_DEFOG' },
  { ability: 'ABILITY_POSEIDONS_DOMINION', move: 'MOVE_WHIRLPOOL' },
  { ability: 'ABILITY_WOODLAND_CURSE', move: 'MOVE_FORESTS_CURSE' },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 148b - UseEntryMove abilities (next 12)', () => {
  describe('applySwitchInAbilities: queueing for each of the 12 ported abilities', () => {
    for (const { ability, move } of EXPECTED_PORTED_12) {
      it(`holder at battler 0 queues ${move} with movePower 0 targeting battler 1`, () => {
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
            movePower: 0,
            target: 1,
            falseSwipe: true,
          },
        ])
        expect(unmodelled.filter((n) => n.includes('UseEntryMove'))).toHaveLength(0)
      })

      it(`holder at battler 1 queues ${move} with movePower 0 targeting battler 0`, () => {
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
            movePower: 0,
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
        [{ abilities: { ability: 'ABILITY_DOOMBRINGER', innates: [null, null, null] } }, { hp: 0 }],
        scriptedRng(),
      )
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toEqual([])
    })

    it('holder attackCancelled queues nothing and raises no note', () => {
      const unmodelled: string[] = []
      const state = battle(
        [{ abilities: { ability: 'ABILITY_DOOMBRINGER', innates: [null, null, null] } }, {}],
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

  describe('counter rules: Jump Scare and Wishmaker', () => {
    it('Jump Scare queues Astonish first time, sets counter to 1, queues nothing second time', () => {
      const state = battle(
        [{ abilities: { ability: 'ABILITY_JUMP_SCARE', innates: [null, null, null] } }, {}],
        scriptedRng(),
      )
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(0)

      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)
      expect(state.queuedExtraAttacks[0]?.move).toBe('MOVE_ASTONISH')
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(1)

      // Second entry
      state.queuedExtraAttacks = []
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(1)
    })

    it('Jump Scare with NO alive foe sets counter to 1 and queues nothing; later entry with alive foe queues nothing', () => {
      const state = battle(
        [{ abilities: { ability: 'ABILITY_JUMP_SCARE', innates: [null, null, null] } }, { hp: 0 }],
        scriptedRng(),
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(1)

      // Foe revived/switched in, holder enters again
      state.battlers[1]!.mon.hp = 100
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(1)
    })

    it('Wishmaker queues Wish on 4 consecutive entries (counter remains 0, C increment unreachable)', () => {
      const state = battle(
        [{ abilities: { ability: 'ABILITY_WISHMAKER', innates: [null, null, null] } }, {}],
        scriptedRng(),
      )
      for (let i = 0; i < 4; i++) {
        state.queuedExtraAttacks = []
        state.battlers[0]!.volatiles.switchInAbilityDone.fill(false)
        applySwitchInAbilities(state, 0, testDeps(), [])
        expect(state.queuedExtraAttacks).toHaveLength(1)
        expect(state.queuedExtraAttacks[0]?.move).toBe('MOVE_WISH')
        expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_WISHMAKER', DATA_CONTEXT)).toBe(0)
      }
    })
  })

  describe('execution through executeTurn for all 12 abilities', () => {
    it('Doombringer: sets futureSight state on foe slot and lands hit at end of turn 3', () => {
      // Doom Desire base power is 140, special.
      // Attacker level 50, spatk 100 vs defender spdef 100.
      // floor(2 * 50 / 5 + 2) = 22.
      // floor(22 * 140 * 100 / 100 / 50) + 2 = 61 + 2 = 63 base damage.
      // Roll index 0 (15 - 0 = values[15], 100% max roll): 63 damage. 100 - 63 = 37 HP.
      // Accuracy 100: roll 0 < 100 hits.
      const rng = scriptedRng([
        0, // accuracy roll on turn 3 hit (0 < 100)
        0, // damage roll index on turn 3 hit (0 -> values[15] 100% max roll)
      ])
      const state = battle(
        [
          { spatk: 100, abilities: { ability: 'ABILITY_DOOMBRINGER', innates: [null, null, null] } },
          { spdef: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)

      const deps = realTestDeps(rng)
      // Turn 1: drainQueuedExtraAttacks runs Doom Desire, setting counter 3, then turn-end decrements to 2
      executeTurn(state, [null, null], deps)
      expect(state.field.futureSightCounter[1]).toBe(2)
      expect(state.field.futureSightMove[1]).toBe('MOVE_DOOM_DESIRE')
      expect(state.field.futureSightPower[1]).toBe(140)
      expect(state.field.futureSightAttacker[1]).toBe(0)
      expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
      expect(state.battlers[1]!.mon.hp).toBe(100)

      // Turn 2: countdown 2 -> 1, no hit yet
      executeTurn(state, [null, null], deps)
      expect(state.field.futureSightCounter[1]).toBe(1)
      expect(state.battlers[1]!.mon.hp).toBe(100)

      // Turn 3: countdown 1 -> 0, hit lands!
      executeTurn(state, [null, null], deps)
      expect(state.field.futureSightCounter[1]).toBe(0)
      expect(state.battlers[1]!.mon.hp).toBe(37) // 100 - 63
      expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(false)
    })

    it('Wishmaker: sets wishCounter on holder and heals half max HP at end of turn 2', () => {
      const rng = scriptedRng([])
      const playerMon = partyMon({
        hp: 40,
        maxHp: 100,
        abilities: { ability: 'ABILITY_WISHMAKER', innates: [null, null, null] },
      })
      const foeMon = partyMon({ hp: 100, maxHp: 100 })
      const state = battle(
        [
          { hp: 40, maxHp: 100, abilities: { ability: 'ABILITY_WISHMAKER', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
        [playerMon],
        [foeMon],
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)

      const deps = realTestDeps(rng)
      // Turn 1: Wish executed, setting wishCounter to 2, then turn-end decrements 2 -> 1
      executeTurn(state, [null, null], deps)
      expect(state.field.wishCounter[0]).toBe(1)
      expect(state.field.wishPartyId[0]).toBe(0)
      expect(state.battlers[0]!.mon.hp).toBe(40) // No heal yet

      // Turn 2: turn-end decrements 1 -> 0, healing half max HP (50 HP)
      executeTurn(state, [null, null], deps)
      expect(state.field.wishCounter[0]).toBe(0)
      expect(state.battlers[0]!.mon.hp).toBe(90) // 40 + 50
    })

    it('Change of Heart: Heart Swap swaps stat stages between holder and foe', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_CHANGE_OF_HEART', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      // Give holder and foe different stat stages
      state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
      state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE - 1
      state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE - 1
      state.battlers[1]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 3

      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      // Swapped!
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 3)
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('Dream Whimsy: Yawn applies STATUS3_YAWN volatile on foe, causing sleep next turn', () => {
      const rng = scriptedRng([
        0, // sleep turns roll: (0 & 3) + 2 = 2 turns
      ])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_DREAM_WHIMSY', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)

      // Turn 1: Yawn sets counter 2, then turn-end decrements to 1
      executeTurn(state, [null, null], deps)
      expect(getCounter(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(1)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(false)

      // Turn 2: turn-end decrements 1 -> 0, falling asleep!
      executeTurn(state, [null, null], deps)
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(true)
    })

    it('Wildfire: Fire Spin deals damage with base power 50 and wraps foe with STATUS2_WRAPPED', () => {
      // Level 50, spatk 100 vs spdef 100.
      // floor(2 * 50 / 5 + 2) = 22.
      // floor(22 * 50 * 100 / 100 / 50) + 2 = 22 + 2 = 24 base damage.
      // Hit damage: 24 (100% roll). Turn-end wrap damage: floor(100 / 8) = 12.
      // Total damage: 24 + 12 = 36. 100 - 36 = 64 HP.
      // Fire Spin accuracy 90 -> roll 0 < 90 hits.
      // Effect chance 100 -> roll 0 < 100 applies wrap.
      // Wrap duration -> roll 0: 4 + (0 % 2) = 4 turns. End of turn decrements to 3.
      const rng = scriptedRng([
        0, // accuracy roll (0 < 90)
        1, // crit roll (1 % 24 != 0 -> no crit)
        0, // damage roll index (0 -> values[15] 100% max roll)
        0, // effect chance (0 < 100)
        0, // wrap duration (4 turns)
      ])
      const state = battle(
        [
          { spatk: 100, abilities: { ability: 'ABILITY_WILDFIRE', innates: [null, null, null] } },
          { spdef: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.hp).toBe(64)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
      expect(state.wrappedMove[1]).toBe('MOVE_FIRE_SPIN')
      expect(state.wrappedBy[1]).toBe(0)
      expect(state.battlers[1]!.volatiles.wrapTurns).toBe(3)
    })

    it('Jump Scare: Astonish deals 40 power damage and flinches foe, cancelling their turn 1 move', () => {
      // Level 50, atk 100 vs def 100. Defender is Water type (not Normal) so Ghost move hits.
      // floor(2 * 50 / 5 + 2) = 22.
      // floor(22 * 40 * 100 / 100 / 50) + 2 = 17 + 2 = 19 base damage.
      // Roll index 0 (100% max roll): 19 damage. 100 - 19 = 81 HP.
      // Astonish accuracy 100 -> roll 0 < 100.
      // EFFECT_FAKE_OUT flinch chance 100 -> roll 0 < 100.
      // Foe's move Tackle is cancelled by FLINCH in attackCanceller.
      const rng = scriptedRng([
        0, // accuracy roll (0 < 100)
        1, // crit roll (no crit)
        0, // damage roll (0 -> values[15] 100% roll)
        0, // flinch effect chance (0 < 100)
      ])
      const state = battle(
        [
          { atk: 100, abilities: { ability: 'ABILITY_JUMP_SCARE', innates: [null, null, null] } },
          { def: 100, hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      const res = executeTurn(state, [null, useMove(0, 'MOVE_TACKLE')], deps)

      expect(state.battlers[1]!.mon.hp).toBe(81)
      expect(res.actions[2]?.cancelledBy).toBe('FLINCH')
      expect(state.battlers[0]!.mon.hp).toBe(100) // Tackle did not execute
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_JUMP_SCARE', DATA_CONTEXT)).toBe(1)
    })

    it('Tar Toss: Tar Shot drops foe Speed by 1 stage and sets tarShot volatile', () => {
      // Tar Shot accuracy 100: roll 0 < 100.
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_TAR_TOSS', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[1]!.volatiles.tarShot).toBe(true)
    })

    it('Wind Rage: Defog lowers foe Evasion by 1 stage and clears side hazards', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_WIND_RAGE', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      // Set hazards on holder's side
      state.sides[0]!.statuses |= SIDE_STATUS_SPIKES
      state.sides[0]!.timers.spikesAmount = 2

      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
      expect(state.sides[0]!.timers.spikesAmount).toBe(0) // Cleared by Defog
    })

    it('Poseidons Dominion: Whirlpool deals 50 power damage and wraps foe', () => {
      // Whirlpool base power 50, special, accuracy 90.
      // Level 50, spatk 100 vs spdef 100: 24 damage with 100% roll.
      // Hit damage: 24. Turn-end wrap damage: floor(100 / 8) = 12. Total damage: 24 + 12 = 36. 100 - 36 = 64 HP.
      // Secondary effects: MOVE_EFFECT_WRAP (chance 100) and MOVE_EFFECT_DRENCH (chance 30).
      const rng = scriptedRng([
        0, // accuracy roll (0 < 90)
        1, // crit roll (1 % 24 != 0 -> no crit)
        0, // damage roll index (0 -> values[15] 100% roll)
        0, // wrap effect chance (0 < 100)
        0, // wrap duration (4 turns)
        99, // drench effect chance (99 >= 30, does not drench)
      ])
      const state = battle(
        [
          { spatk: 100, abilities: { ability: 'ABILITY_POSEIDONS_DOMINION', innates: [null, null, null] } },
          { spdef: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.hp).toBe(64)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
      expect(state.wrappedMove[1]).toBe('MOVE_WHIRLPOOL')
      expect(state.wrappedBy[1]).toBe(0)
      expect(state.battlers[1]!.volatiles.wrapTurns).toBe(3)
    })

    it('Woodland Curse: Forests Curse adds Grass type to foe (types[2])', () => {
      // Forests Curse accuracy 100: roll 0 < 100.
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_WOODLAND_CURSE', innates: [null, null, null] } },
          { hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.types[2]).toBe('GRASS')
    })

    it('Draco Morale: Dragon Cheer (target USER) boosts holder crit stage, leaves foe untouched', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          {
            abilities: { ability: 'ABILITY_DRACO_MORALE', innates: [null, null, null] },
            types: ['DRAGON', 'MYSTERY', 'MYSTERY'],
          },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      // Dragon type user gets +2 critBoost
      expect(state.battlers[0]!.volatiles.critBoost).toBe(2)
      // Foe is unaffected
      expect(state.battlers[1]!.volatiles.critBoost).toBe(0)
    })

    it('Web Spinner: String Shot (target BOTH) drops foe Speed by 2 stages in singles', () => {
      // String Shot accuracy 100: roll 0 < 100.
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_WEB_SPINNER', innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 2)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })

    it('falseSwipe: foe at 5 HP hit by Jump Scare Astonish (19 damage) stays at 1 HP', () => {
      const rng = scriptedRng([
        0, // accuracy roll (0 < 100)
        1, // crit roll (no crit)
        0, // damage roll (0 -> values[15] 100% roll)
        0, // flinch effect chance
      ])
      const state = battle(
        [
          { atk: 100, abilities: { ability: 'ABILITY_JUMP_SCARE', innates: [null, null, null] } },
          { def: 100, hp: 5, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const deps = realTestDeps(rng)
      executeTurn(state, [null, null], deps)

      expect(state.battlers[1]!.mon.hp).toBe(1)
    })

    it('no PP deducted from any holder real moves by queued entry move (HITMARKER_NO_PPDEDUCT)', () => {
      const rng = scriptedRng([0, 0, 15, 0, 0])
      const state = battle(
        [
          {
            moves: ['MOVE_TACKLE', null, null, null],
            pp: [35, 0, 0, 0],
            abilities: { ability: 'ABILITY_WILDFIRE', innates: [null, null, null] },
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
  })
})
