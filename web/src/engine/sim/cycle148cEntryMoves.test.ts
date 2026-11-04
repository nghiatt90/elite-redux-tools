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
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_MIST,
  SIDE_STATUS_TOXIC_SPIKES,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_PARALYSIS,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_ESCAPE_PREVENTION,
  STATUS3_MAGNET_RISE,
  getCounter,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { MoveData } from '../calculate'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle148bEntryMoves.test.ts.
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
  status1?: number
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
          status1: s.status1 ?? 0,
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

const holderAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

const EXPECTED_PORTED_7: Array<{ ability: string; move: string }> = [
  { ability: 'ABILITY_NEUTRALIZING_FOG', move: 'MOVE_DEFOG' },
  { ability: 'ABILITY_ROYAL_DECREE', move: 'MOVE_GLARE' },
  { ability: 'ABILITY_FROSTY_PRESCENCE', move: 'MOVE_MIST' },
  { ability: 'ABILITY_LETS_DANCE', move: 'MOVE_TEETER_DANCE' },
  { ability: 'ABILITY_I_AM_STEVE', move: 'MOVE_NO_RETREAT' },
  { ability: 'ABILITY_MASHED_POTATO', move: 'MOVE_SYRUP_BOMB' },
  { ability: 'ABILITY_ELECTRO_BOOSTER', move: 'MOVE_MAGNET_RISE' },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 148c - the last 7 UseEntryMove abilities', () => {
  describe('applySwitchInAbilities: queueing for each of the 7 ported abilities', () => {
    for (const { ability, move } of EXPECTED_PORTED_7) {
      it(`holder at battler 0 queues ${move} with movePower 0 targeting battler 1`, () => {
        const unmodelled: string[] = []
        const state = battle([{ abilities: holderAbility(ability) }, {}], scriptedRng())
        applySwitchInAbilities(state, 0, testDeps(), unmodelled)
        expect(state.queuedExtraAttacks).toEqual([
          { ability, attacker: 0, move, movePower: 0, target: 1, falseSwipe: true },
        ])
        expect(unmodelled.filter((n) => n.includes('UseEntryMove'))).toHaveLength(0)
      })

      it(`holder at battler 1 queues ${move} with movePower 0 targeting battler 0`, () => {
        const unmodelled: string[] = []
        const state = battle([{}, { abilities: holderAbility(ability) }], scriptedRng())
        applySwitchInAbilities(state, 1, testDeps(), unmodelled)
        expect(state.queuedExtraAttacks).toEqual([
          { ability, attacker: 1, move, movePower: 0, target: 0, falseSwipe: true },
        ])
        expect(unmodelled.filter((n) => n.includes('UseEntryMove'))).toHaveLength(0)
      })
    }
  })

  describe('negative cases', () => {
    it('foe fainted (hp: 0) queues nothing and raises no note', () => {
      const unmodelled: string[] = []
      const state = battle([{ abilities: holderAbility('ABILITY_NEUTRALIZING_FOG') }, { hp: 0 }], scriptedRng())
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toEqual([])
    })

    it('holder attackCancelled queues nothing and raises no note', () => {
      const unmodelled: string[] = []
      const state = battle([{ abilities: holderAbility('ABILITY_NEUTRALIZING_FOG') }, {}], scriptedRng())
      state.battlers[0]!.round.attackCancelled = true
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(unmodelled).toEqual([])
    })
  })

  describe('counter rule: Royal Decree (abilities.cc:10327-10332)', () => {
    it('queues Glare first time, sets the counter to 1, queues nothing on a second entry', () => {
      const state = battle([{ abilities: holderAbility('ABILITY_ROYAL_DECREE') }, {}], scriptedRng())
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ROYAL_DECREE', DATA_CONTEXT)).toBe(0)

      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toEqual([
        { ability: 'ABILITY_ROYAL_DECREE', attacker: 0, move: 'MOVE_GLARE', movePower: 0, target: 1, falseSwipe: true },
      ])
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ROYAL_DECREE', DATA_CONTEXT)).toBe(1)

      // Second entry: reset the per-slot switch-in latch so only the single-use counter can stop it.
      state.queuedExtraAttacks = []
      state.battlers[0]!.volatiles.switchInAbilityDone.fill(false)
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ROYAL_DECREE', DATA_CONTEXT)).toBe(1)
    })

    it('with NO alive foe the first entry still sets the counter and queues nothing; a later entry (foe alive) queues nothing', () => {
      const state = battle([{ abilities: holderAbility('ABILITY_ROYAL_DECREE') }, { hp: 0 }], scriptedRng())
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ROYAL_DECREE', DATA_CONTEXT)).toBe(1)

      // Foe revived; the holder enters again with its slot latch reset.
      state.battlers[1]!.mon.hp = 100
      state.battlers[0]!.volatiles.switchInAbilityDone.fill(false)
      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(0)
      expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ROYAL_DECREE', DATA_CONTEXT)).toBe(1)
    })
  })

  describe('execution through executeTurn', () => {
    it('Neutralizing Fog / Defog: foe Evasion -1 and both sides hazards plus the foe screens cleared', () => {
      // BattleScript_EffectDefog (data/battle_scripts_1.s:1560-1593): statbuffchange -1 Evasion, then
      // defogclear BS_ATTACKER TRUE (battle_script_commands.c:6506-6560) walks both sides -- hazards
      // everywhere, screens only on the non-attacker side.
      const rng = scriptedRng([])
      const state = battle([{ abilities: holderAbility('ABILITY_NEUTRALIZING_FOG') }, { hp: 100, maxHp: 100 }], rng)
      state.sides[0]!.statuses |= SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES
      state.sides[0]!.timers.spikesAmount = 2
      state.sides[0]!.timers.toxicSpikesAmount = 1
      state.sides[1]!.statuses |= SIDE_STATUS_SPIKES | SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN
      state.sides[1]!.timers.spikesAmount = 1
      state.sides[1]!.timers.reflectTimer = 5
      state.sides[1]!.timers.lightscreenTimer = 5

      applySwitchInAbilities(state, 0, testDeps(), [])
      const res = executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
      expect(state.sides[0]!.timers.spikesAmount).toBe(0)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
      expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
      expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_REFLECT)).toBe(false)
      expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(res.actions.flatMap((a) => a.unmodelled).filter((n) => n.includes('UseEntryMove'))).toEqual([])
    })

    it('Royal Decree / Glare: foe paralysed (accuracy 100)', () => {
      // BattleScript_EffectParalyzeIgnoreType (:4346-4360): accuracycheck (:4352) then
      // setmoveeffect MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES (:4356).
      const rng = scriptedRng([0]) // accuracy roll (0 < 100)
      const state = battle([{ abilities: holderAbility('ABILITY_ROYAL_DECREE') }, { hp: 100, maxHp: 100 }], rng)
      applySwitchInAbilities(state, 0, testDeps(), [])
      const res = executeTurn(state, [null, null], realTestDeps(rng))

      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(res.actions.flatMap((a) => a.unmodelled).filter((n) => n.includes('UseEntryMove'))).toEqual([])
    })

    it('Royal Decree / Glare paralyses a Ghost foe too (MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES)', () => {
      // canBeParalyzedIgnoreType (statusEffects.ts:1343-1353) skips CanParalyzeType entirely.
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: holderAbility('ABILITY_ROYAL_DECREE') },
          { hp: 100, maxHp: 100, types: ['GHOST', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    })

    it('Royal Decree / Glare leaves an already statused foe as is (requirecandoeffect fails before accuracy)', () => {
      const rng = scriptedRng([])
      const state = battle(
        [{ abilities: holderAbility('ABILITY_ROYAL_DECREE') }, { hp: 100, maxHp: 100, status1: STATUS1_SLEEP }],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_SLEEP)
      expect(rng.calls).toBe(0)
    })

    it('Frosty Prescence / Mist: the HOLDER side gets Mist for 5 turns, the foe side is untouched', () => {
      // BattleScript_EffectMist (:4179-4188): setmist; Cmd_setmist (battle_script_commands.c:10456-10469)
      // writes SIDE_STATUS_MIST on GetBattlerSide(gBattlerAttacker) for MIST_DURATION (5).
      const rng = scriptedRng([])
      const state = battle([{ abilities: holderAbility('ABILITY_FROSTY_PRESCENCE') }, { hp: 100, maxHp: 100 }], rng)
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_MIST)).toBe(true)
      expect(state.sides[0]!.timers.mistTimer).toBe(5)
      expect(state.sides[0]!.timers.mistBattlerId).toBe(0)
      expect(state.sides[0]!.timers.started.mist).toBe(true)
      expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_MIST)).toBe(false)
      expect(state.sides[1]!.timers.mistTimer).toBe(0)
    })

    it('Lets Dance / Teeter Dance: foe confused for 3 turns, holder not confused', () => {
      // BattleScript_EffectTeeterDance (:6544-6566) loops every battler but the user; the foe's
      // accuracycheck (:6556) draws first, then MOVE_EFFECT_CONFUSION's duration
      // (battle_script_commands.c:2657-2663) is (Random() % 2) + 3 -- two draws with the scripted rng.
      const rng = scriptedRng([0, 0])
      const state = battle([{ abilities: holderAbility('ABILITY_LETS_DANCE') }, { hp: 100, maxHp: 100 }], rng)
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(3)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
      expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
      expect(rng.calls).toBe(2)
    })

    it('I Am Steve / No Retreat: HOLDER +1 in all five stats; FOE trapped and noRetreat true', () => {
      // BattleScript_EffectNoRetreat (:338-354): trynoretreat BS_TARGET, call BattleScript_AllStatsUp
      // (BS_ATTACKER: ATK, DEF, SPEED, SPATK, SPDEF +1), setmoveeffect MOVE_EFFECT_PREVENT_ESCAPE (BS_TARGET).
      const rng = scriptedRng([])
      const state = battle([{ abilities: holderAbility('ABILITY_I_AM_STEVE') }, { hp: 100, maxHp: 100 }], rng)
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        expect(state.battlers[0]!.mon.statStages[stat]).toBe(DEFAULT_STAT_STAGE + 1)
      }
      expect(state.battlers[0]!.volatiles.noRetreat).toBe(false)
      expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)

      for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        expect(state.battlers[1]!.mon.statStages[stat] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
      }
      expect(state.battlers[1]!.volatiles.noRetreat).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
      expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
    })

    it('I Am Steve / No Retreat negative: foe already trapped (ESCAPE_PREVENTION set) causes move failure and holder gets no raises', () => {
      const rng = scriptedRng([])
      const state = battle(
        [{ abilities: holderAbility('ABILITY_I_AM_STEVE') }, { hp: 100, maxHp: 100, status2: STATUS2_ESCAPE_PREVENTION }],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        expect(state.battlers[0]!.mon.statStages[stat]).toBe(DEFAULT_STAT_STAGE)
      }
      expect(state.battlers[0]!.volatiles.noRetreat).toBe(false)
      expect(state.battlers[1]!.volatiles.noRetreat).toBe(false)
    })

    it('I Am Steve / No Retreat negative: foe with noRetreat already true causes move failure and holder gets no raises', () => {
      const rng = scriptedRng([])
      const state = battle([{ abilities: holderAbility('ABILITY_I_AM_STEVE') }, { hp: 100, maxHp: 100 }], rng)
      state.battlers[1]!.volatiles.noRetreat = true
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        expect(state.battlers[0]!.mon.statStages[stat]).toBe(DEFAULT_STAT_STAGE)
      }
      expect(state.battlers[0]!.volatiles.noRetreat).toBe(false)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    })

    it('Mashed Potato / Syrup Bomb: 60-power special damage and the syrup timer on the foe', () => {
      // Syrup Bomb power 60, special. Level 50, spatk 100 vs spdef 100:
      // floor(2 * 50 / 5 + 2) = 22; floor(22 * 60 * 100 / 100 / 50) + 2 = 26 + 2 = 28 base damage.
      // Roll index 0 is the 100% roll, so 28 damage; 100 - 28 = 72 HP.
      // Draw order: accuracy (100), crit (1 % 24 != 0), damage roll, effect chance (100).
      // MOVE_EFFECT_SYRUP (battle_script_commands.c:2971-2982) sets syrupTimer = 3; ENDTURN_SYRUP
      // (battle_util.c:2444-2450) then decrements it to 2 and drops the foe's Speed one stage.
      const rng = scriptedRng([
        0, // accuracy roll (0 < 100)
        1, // crit roll (1 % 24 != 0 -> no crit)
        0, // damage roll index (0 -> the 100% roll)
        0, // effect chance (0 < 100)
      ])
      const state = battle(
        [{ spatk: 100, abilities: holderAbility('ABILITY_MASHED_POTATO') }, { spdef: 100, hp: 100, maxHp: 100 }],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      const res = executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(72)
      expect(state.battlers[1]!.volatiles.syrupTimer).toBe(2)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(res.actions.flatMap((a) => a.unmodelled).filter((n) => n.includes('UseEntryMove'))).toEqual([])
    })

    it('Mashed Potato / Syrup Bomb falseSwipe: a 5 HP foe is left at 1 HP', () => {
      const rng = scriptedRng([0, 1, 0, 0])
      const state = battle(
        [{ spatk: 100, abilities: holderAbility('ABILITY_MASHED_POTATO') }, { spdef: 100, hp: 5, maxHp: 100 }],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(1)
    })

    it('Electro Booster / Magnet Rise: HOLDER levitates for 5 turns, foe untouched', () => {
      // BattleScript_EffectMagnetRise (:2627-2636): setuserstatus3 STATUS3_MAGNET_RISE.
      // Cmd_setuserstatus3 (battle_script_commands.c:11991-12002) writes gFieldTimers.magnetRiseTimer
      // = 5 on the USER; ENDTURN_MAGNET_RISE (battle_util.c:2875-2884) then decrements it to 4.
      const rng = scriptedRng([])
      const state = battle([{ abilities: holderAbility('ABILITY_ELECTRO_BOOSTER') }, { hp: 100, maxHp: 100 }], rng)
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)
      expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(4)
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_MAGNET_RISE)).toBe(false)
      expect(state.battlers[1]!.volatiles.magnetRiseTimer).toBe(0)
    })

    it('no PP deducted from the holder real moves by a queued entry move (HITMARKER_NO_PPDEDUCT)', () => {
      // The holder knows Syrup Bomb itself, so a wrong HITMARKER_NO_PPDEDUCT test would spend its PP.
      const rng = scriptedRng([0, 1, 0, 0])
      const state = battle(
        [
          {
            spatk: 100,
            moves: ['MOVE_SYRUP_BOMB', null, null, null],
            pp: [10, 0, 0, 0],
            abilities: holderAbility('ABILITY_MASHED_POTATO'),
          },
          { spdef: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[0]!.mon.pp[0]).toBe(10)
    })
  })
})
