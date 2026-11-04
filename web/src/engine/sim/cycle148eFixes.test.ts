/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction, type TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applySwitchInAbilities } from './switchInAbility'
import {
  DEFAULT_STAT_STAGE,
  STAT_SPEED,
  STATUS1_PARALYSIS,
  STATUS2_FLINCHED,
  STATUS3_YAWN,
  getCounter,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { MoveData, DamageCalcScenario } from '../calculate'
import { calculateMoveDamage } from '../calculate'
import { createSession, stepTurn, buildMoveAction } from './driver/session'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import type { BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import { calcStat } from '../stats'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle148cEntryMoves.test.ts.
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

function useMove(target: number, moveId: string): ChosenAction {
  const m = requireMove(moveId)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return {
    action: 'USE_MOVE',
    target,
    chosenMove: view,
    moveToBeUsed: view,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 148e Fixes', () => {
  describe('Item 2: Clean-up after the battle-start pass', () => {
    it('Jump Scare lead Astonish flinch is cleared so foe turn-1 Tackle is not cancelled', () => {
      const data = loadSimData()
      const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
      const party = buildPlayerParty(
        [
          {
            species: 'SPECIES_TYRANITAR',
            level: 50,
            nature: 'NATURE_ADAMANT',
            evs: { hp: 252, atk: 252 },
            ability: 'ABILITY_JUMP_SCARE',
            item: null,
            moves: ['MOVE_TACKLE', null, null, null],
          },
        ],
        50,
        data,
      )
      // Astonish accuracy 100, no crit, damage roll 0
      const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainer,
        rng,
      })

      // Jump Scare queued Astonish and flinched foe during battle-start pass,
      // but post-pass cleanup cleared STATUS2_FLINCHED (:3422)
      expect(hasFlag(session.state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)

      // Turn 1: foe acts and is not cancelled by flinch
      const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'))
      const foeAction = step.outcome.actions.find((a) => a.battlerId === 1)
      expect(foeAction).toBeDefined()
      expect(foeAction!.cancelledBy).not.toBe('FLINCH')
    })

    it('after Low Blow lead the foe round.physicalDmg is 0 at turn 1 so Counter does not reflect stale 19', () => {
      const data = loadSimData()
      const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
      const party = buildPlayerParty(
        [
          {
            species: 'SPECIES_TYRANITAR',
            level: 50,
            nature: 'NATURE_ADAMANT',
            evs: { hp: 252, atk: 252 },
            ability: 'ABILITY_LOW_BLOW',
            item: null,
            moves: ['MOVE_TACKLE', null, null, null],
          },
        ],
        50,
        data,
      )
      // Accuracy 0 -> 101 hits, crit roll 1 -> no crit, damage roll 0 -> 100%
      const rng = scriptedRng([0, 1, 0, 0, 1, 0])
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainer,
        rng,
      })

      // TurnValuesCleanUp(FALSE) zeroes gRoundStructs (:3406 / :4490), so physicalDmg is 0 at turn 1
      expect(session.state.battlers[1]!.round.physicalDmg).toBe(0)
    })

    it('Stakeout with a Low Blow entry attack doubles (damage 19 -> 38)', () => {
      // Attacker Level 50, Atk 100, Defender Level 50, Def 100, Max HP 100.
      // MOVE_FEINT_ATTACK power override 40 from Low Blow:
      // floor(2 * 50 / 5 + 2) = 22; floor(22 * 40 * 100 / 100 / 50) + 2 = 17 + 2 = 19.
      // During battle start, isFirstTurn is 2 (battle_main.c:2899, not decremented yet).
      // Stakeout (abilities.cc:2726, bridge.ts:566-568) checks isFirstTurn === 2 and doubles: 19 * 2 = 38.
      // Roll 0 (100% roll, no crit) deals 38 damage -> 100 - 38 = 62 HP.
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [
          {
            atk: 100,
            spe: 100,
            abilities: { ability: 'ABILITY_LOW_BLOW', innates: ['ABILITY_STAKEOUT', null, null] },
            types: ['WATER', 'MYSTERY', 'MYSTERY'],
          },
          { def: 100, spe: 50, hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      // State is freshly created; session sets isFirstTurn = 2 before the battle-start pass
      state.battlers[0]!.volatiles.isFirstTurn = 2
      state.battlers[1]!.volatiles.isFirstTurn = 2
      expect(state.battlers[1]!.volatiles.isFirstTurn).toBe(2)

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(62)
    })

    it('Stakeout negative: with a non-first-turn battler (isFirstTurn != 2) the 2x is absent (deals 19)', () => {
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [
          {
            atk: 100,
            spe: 100,
            abilities: { ability: 'ABILITY_LOW_BLOW', innates: ['ABILITY_STAKEOUT', null, null] },
            types: ['WATER', 'MYSTERY', 'MYSTERY'],
          },
          { def: 100, spe: 50, hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      // Manually set isFirstTurn to 1 (simulating post-cleanup or non-first-turn)
      state.battlers[1]!.volatiles.isFirstTurn = 1

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // Without Stakeout 2x: deals 19 damage -> 100 - 19 = 81 HP
      expect(state.battlers[1]!.mon.hp).toBe(81)
    })
  })

  describe('Item 3: Battle-start entry-move notes are collected into session.startUnmodelled', () => {
    it('Low Blow lead produces its notes in session.startUnmodelled', () => {
      const data = loadSimData()
      const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
      const party = buildPlayerParty(
        [
          {
            species: 'SPECIES_TYRANITAR',
            level: 50,
            nature: 'NATURE_ADAMANT',
            evs: { hp: 252, atk: 252 },
            ability: 'ABILITY_LOW_BLOW',
            item: null,
            moves: ['MOVE_TACKLE', null, null, null],
          },
        ],
        50,
        data,
      )
      const rng = scriptedRng([0, 1, 0])
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainer,
        rng,
      })

      // The queued extra attack's notes reach startUnmodelled
      expect(session.startUnmodelled.length).toBeGreaterThan(0)
      expect(session.startUnmodelled.some((n) => n.includes('ABILITY_LOW_BLOW'))).toBe(true)
    })
  })

  describe('Item 4: Technician sees pre-modifier declaredBasePower', () => {
    function condition(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
      return {
        speciesId: 'SPECIES_SCYTHER',
        baseSpeciesId: 'SPECIES_SCYTHER',
        heads: 1,
        isMegaEvolved: false,
        itemId: null,
        resolvedHoldEffect: null,
        itemNegated: false,
        status1: new Set(),
        hasComatose: false,
        hasBloodStainEffect: false,
        isInfatuated: false,
        isConfused: false,
        isEnraged: false,
        wasDamagedThisTurnBy: 'none',
        recentlyFainted: false,
        hp: 100,
        maxHp: 100,
        weight: 560,
        speed: 100,
        positiveStatStageCount: 0,
        negativeStatStageCount: 0,
        usedMovePpRemaining: null,
        helpingHand: false,
        ghastlyEcho: false,
        chargedUp: false,
        meFirst: false,
        fear: false,
        safePassage: false,
        itemResolvedHoldEffectStrength: null,
        lastMoveFailed: false,
        ...overrides,
      }
    }

    function calcBattler(speciesId: string, overrides: Partial<BattlerBattleState> = {}): BattlerBattleState {
      const s = speciesById.get(speciesId) as Record<string, unknown>
      const baseStats = s.baseStats as { atk: number; def: number; spatk: number; spdef: number; spe: number }
      const level = 50
      const nature = 'NATURE_HARDY'
      const rawStats = {
        atk: calcStat(baseStats.atk, 31, 0, level, nature, 'atk', (battleConstants as any).natureStatTable),
        def: calcStat(baseStats.def, 31, 0, level, nature, 'def', (battleConstants as any).natureStatTable),
        spatk: calcStat(baseStats.spatk, 31, 0, level, nature, 'spatk', (battleConstants as any).natureStatTable),
        spdef: calcStat(baseStats.spdef, 31, 0, level, nature, 'spdef', (battleConstants as any).natureStatTable),
        spe: calcStat(baseStats.spe, 31, 0, level, nature, 'spe', (battleConstants as any).natureStatTable),
      }
      return {
        condition: condition({ speciesId, baseSpeciesId: speciesId, hp: 100, maxHp: 100 }),
        types: (s.types as string[]).map((t) => t.replace('TYPE_', '')),
        isGrounded: true,
        semiInvulnerable: 'NONE',
        abilityOn: false,
        gender: 'MALE',
        boostedStat: null,
        alliesFainted: 0,
        slowStartTimer: 5,
        level,
        nature,
        rawStats,
        statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
        extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
        holdEffectStrength: null,
        holdEffectType: null,
        naturalGift: null,
        hiddenPowerType: null,
        isTransformed: false,
        canEvolveStrict: false,
        isInfatuatedWithOpponent: false,
        moveSlotPp: {},
        abilitySlots: { ability: null, innates: [null, null, null] },
        hasMiracleEye: false,
        ...overrides,
      }
    }

    function fieldState(): FieldBattleState {
      return {
        gravityActive: false,
        terrain: null,
        weather: 'NONE',
        sides: {
          attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
          defender: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
        },
        isDoubleBattle: false,
        isInverseRoomActive: false,
        isInverseBattleFlagSet: false,
        isWonderRoomActive: false,
      }
    }

    it('Technician boosts 60-power Aerial Ace with and without Muscle Band', () => {
      const move = toMoveData('MOVE_AERIAL_ACE') // power 60, physical, Flying
      const attacker = calcBattler('SPECIES_SCYTHER', {
        abilitySlots: { ability: 'ABILITY_TECHNICIAN', innates: [null, null, null] },
      })
      const defender = calcBattler('SPECIES_MUDKIP')

      // Without Muscle Band:
      // Scyther (Bug/Flying) has STAB on Aerial Ace (1.5x) and Technician (1.5x).
      const resNoItem = calculateMoveDamage({
        move,
        attacker,
        defender,
        field: fieldState(),
        typeChart: typeChart as never,
        inverseTypeChart: inverseTypeChart as never,
        moveBehaviors,
        battleConstants,
        attackerActsFirst: true,
        sameMoveTurnsInARow: 0,
        hitCount: 1,
        defenderIsSwitching: false,
        magnitudeTier: null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: false,
        beatUpBaseAttack: 80,
        beatUpHitCount: 5,
        defenderUsedGlaiveRush: false,
      })

      // With Muscle Band:
      const attackerWithBand = calcBattler('SPECIES_SCYTHER', {
        abilitySlots: { ability: 'ABILITY_TECHNICIAN', innates: [null, null, null] },
        holdEffectStrength: 10,
        condition: condition({
          speciesId: 'SPECIES_SCYTHER',
          itemId: 'ITEM_MUSCLE_BAND',
          resolvedHoldEffect: 'HOLD_EFFECT_MUSCLE_BAND',
          itemResolvedHoldEffectStrength: 10,
        }),
      })

      const resWithBand = calculateMoveDamage({
        move,
        attacker: attackerWithBand,
        defender,
        field: fieldState(),
        typeChart: typeChart as never,
        inverseTypeChart: inverseTypeChart as never,
        moveBehaviors,
        battleConstants,
        attackerActsFirst: true,
        sameMoveTurnsInARow: 0,
        hitCount: 1,
        defenderIsSwitching: false,
        magnitudeTier: null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: false,
        beatUpBaseAttack: 80,
        beatUpHitCount: 5,
        defenderUsedGlaiveRush: false,
      })

      // Both must receive Technician boost: Muscle Band damage must exceed no-item damage
      // Max damage roll for Level 50 Scyther (130 Atk) vs Mudkip (70 Def) with STAB + Technician: 115
      expect(resNoItem.rolls[15]).toBe(115)
      // Prior to fix, Muscle Band modified power to 66, causing Technician to fail (damage dropped to 84).
      // With fix, Technician boost is preserved on top of Muscle Band's 10% boost (damage is 124).
      expect(resWithBand.rolls[15]).toBeGreaterThan(resNoItem.rolls[15])
      expect(resWithBand.rolls[15]).toBe(124)
    })

    it('negative: a 61-power move gets no Technician boost either way', () => {
      const move61: MoveData = {
        ...toMoveData('MOVE_AERIAL_ACE'),
        power: 61,
      }
      const attacker = calcBattler('SPECIES_SCYTHER', {
        abilitySlots: { ability: 'ABILITY_TECHNICIAN', innates: [null, null, null] },
      })
      const attackerNoTech = calcBattler('SPECIES_SCYTHER', {
        abilitySlots: { ability: null, innates: [null, null, null] },
      })
      const defender = calcBattler('SPECIES_MUDKIP')

      const scn = (atk: BattlerBattleState): DamageCalcScenario => ({
        move: move61,
        attacker: atk,
        defender,
        field: fieldState(),
        typeChart: typeChart as never,
        inverseTypeChart: inverseTypeChart as never,
        moveBehaviors,
        battleConstants,
        attackerActsFirst: true,
        sameMoveTurnsInARow: 0,
        hitCount: 1,
        defenderIsSwitching: false,
        magnitudeTier: null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: false,
        beatUpBaseAttack: 80,
        beatUpHitCount: 5,
        defenderUsedGlaiveRush: false,
      })

      const resTech = calculateMoveDamage(scn(attacker))
      const resNoTech = calculateMoveDamage(scn(attackerNoTech))

      expect(resTech.rolls[15]).toBe(resNoTech.rolls[15])
    })
  })

  describe('Item 6: Per-ability failure and edge tests', () => {
    it('Doom Desire with future-sight counter already set fails', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          { moves: ['MOVE_DOOM_DESIRE', null, null, null], pp: [5, 0, 0, 0] },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      // Pre-set target futureSightCounter
      state.field.futureSightCounter[1] = 2

      const out = executeTurn(state, [useMove(1, 'MOVE_DOOM_DESIRE'), null], testDeps())
      const action = out.actions.find((a) => a.battlerId === 0)!
      expect(action.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(4) // ppreduce still runs
    })

    it('Wish with wish pending fails', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0] },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      // Pre-set wishCounter
      state.field.wishCounter[0] = 2

      const out = executeTurn(state, [useMove(1, 'MOVE_WISH'), null], testDeps())
      const action = out.actions.find((a) => a.battlerId === 0)!
      expect(action.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(9) // ppreduce still runs
    })

    it('Woodland Curse / Forest Curse on a Grass foe fails', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          {
            abilities: { ability: 'ABILITY_WOODLAND_CURSE', innates: [null, null, null] },
          },
          { hp: 100, maxHp: 100, types: ['GRASS', 'POISON', 'MYSTERY'] },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // Foe third type is not set
      expect(state.battlers[1]!.mon.types[2]).toBe('MYSTERY')
    })

    it('Tar Shot used twice: second use fails', () => {
      const rng = scriptedRng([0, 0])
      const state = battle(
        [
          { moves: ['MOVE_TAR_SHOT', null, null, null], pp: [15, 0, 0, 0] },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )

      // First use succeeds
      const out1 = executeTurn(state, [useMove(1, 'MOVE_TAR_SHOT'), null], testDeps())
      const act1 = out1.actions.find((a) => a.battlerId === 0)!
      expect(act1.missed).toBe(false)
      expect(state.battlers[1]!.volatiles.tarShot).toBe(true)

      // Second use fails (cantarshotwork fails because target.volatiles.tarShot is true)
      const out2 = executeTurn(state, [useMove(1, 'MOVE_TAR_SHOT'), null], testDeps())
      const act2 = out2.actions.find((a) => a.battlerId === 0)!
      expect(act2.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(13) // PP was deducted both times
    })

    it('Magic Bounce reflecting Yawn onto the user', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_DREAM_WHIMSY', innates: [null, null, null] } },
          { abilities: { ability: 'ABILITY_MAGIC_BOUNCE', innates: [null, null, null] }, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // Yawn was bounced back to holder (battler 0)
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_YAWN)).toBe(true)
      expect(getCounter(state.battlers[0]!.statuses3, STATUS3_YAWN)).toBe(1)
      // Target (battler 1) has no yawn
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
    })

    it('Magic Bounce reflecting String Shot onto the user', () => {
      // String Shot accuracy 100
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_WEB_SPINNER', innates: [null, null, null] } },
          { abilities: { ability: 'ABILITY_MAGIC_BOUNCE', innates: [null, null, null] }, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // String Shot speed drop bounced back to holder
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 2)
      // Target speed unaffected
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })

    it('Magic Bounce reflecting Glare onto the user', () => {
      // Glare accuracy 100
      const rng = scriptedRng([0])
      const state = battle(
        [
          { abilities: { ability: 'ABILITY_ROYAL_DECREE', innates: [null, null, null] } },
          { abilities: { ability: 'ABILITY_MAGIC_BOUNCE', innates: [null, null, null] }, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // Glare paralysis bounced back to holder
      expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(false)
    })

    it('Draco Morale on a non-Dragon target gives +1 crit stage, not +2', () => {
      const rng = scriptedRng([])
      const state = battle(
        [
          {
            abilities: { ability: 'ABILITY_DRACO_MORALE', innates: [null, null, null] },
            types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
          },
          { hp: 100, maxHp: 100 },
        ],
        rng,
      )
      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      // Non-Dragon user gets +1 critBoost (Dragon user gets +2)
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
      expect(state.battlers[1]!.volatiles.critBoost).toBe(0)
    })
  })
})
