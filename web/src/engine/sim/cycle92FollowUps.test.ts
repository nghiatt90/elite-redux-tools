/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import {
  ATTACKER_FOLLOWUP_ABILITIES,
  FOLLOWUP_ALLOW_FAILED,
  FOLLOWUP_ALLOW_SELF,
  FOLLOWUP_STANDARD,
  PORTED_ATTACKER_ABILITIES,
  adjustFollowupMoveTarget,
  canUseExtraMove,
  dispatchMoveEndAttackerAbilities,
  isDanceMove,
  isMegaLauncherBoostedMove,
  queueAttackerFollowUpMove,
} from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  STAT_ATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_RAIN_TEMPORARY,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    speciesId?: string
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    types?: [string, string, string]
    itemId?: string | null
    gender?: SimBattleMon['gender']
    status1?: number
    status2?: number
  }[],
  rng: RandomSource,
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
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })
const STATUS_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

interface SeenAttack {
  attacker: number
  target: number
  moveId: string
  movePower: number | undefined
  ability: string | null | undefined
}

/**
 * Drives a full turn where battler 0 uses `moveId` on `actionTarget` and records every
 * damage-resolver invocation (`seen`), including any queued extra follow-up attack.
 */
function run(
  ability: string,
  moveId: string,
  rolls: number[] = [0, 0, 0, 0],
  opts: {
    actionTarget?: number
    damageAmount?: number
    holder?: Parameters<typeof battle>[0][number]
    target?: Parameters<typeof battle>[0][number]
    setup?: (state: BattleState) => void
  } = {},
) {
  const rng = scriptedRng(rolls)
  const m = move(moveId)
  const actionTarget = opts.actionTarget ?? (m.target === 'USER' ? 0 : 1)
  const state = battle(
    [
      { moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...opts.holder },
      opts.target ?? {},
    ],
    rng,
  )
  opts.setup?.(state)

  const seen: SeenAttack[] = []
  const dmg = opts.damageAmount ?? 15
  const resolver: DamageResolver = {
    resolve: (s, atk, tgt, action) => {
      const resolvedMoveId = action.action === 'USE_MOVE' && action.moveToBeUsed ? action.moveToBeUsed.id : 'NONE'
      seen.push({
        attacker: atk,
        target: tgt,
        moveId: resolvedMoveId,
        movePower: s.currentExtraAttack?.movePower,
        ability: s.currentExtraAttack?.ability,
      })
      return {
        targetDamage: dmg,
        attackerDamage: null,
        unmodelled: [],
        isCriticalHit: false,
        berryReduced: false,
        isSuperEffective: false,
      }
    },
  }

  const out = executeTurn(state, [useMove(actionTarget, m), null], testDeps(resolver))
  return { state, rng, out, seen, holder: state.battlers[0]!, target: state.battlers[1]! }
}

/**
 * Directly invokes `dispatchMoveEndAttackerAbilities` so unit tests can inspect
 * `state.queuedExtraAttacks` before the turn loop drains the queue.
 */
function dispatch(
  ability: string,
  moveId: string,
  opts: {
    targetId?: number
    targetDamage?: number
    noEffect?: boolean
    onlyFollowupAbilities?: boolean
    holder?: Parameters<typeof battle>[0][number]
    target?: Parameters<typeof battle>[0][number]
    setup?: (state: BattleState) => void
  } = {},
) {
  const rng = scriptedRng([0, 0, 0])
  const m = move(moveId)
  const state = battle(
    [
      { moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...opts.holder },
      opts.target ?? {},
    ],
    rng,
  )
  opts.setup?.(state)
  const unmodelled: string[] = []
  const targetId = opts.targetId ?? (m.target === 'USER' ? 0 : 1)
  const isStatus = m.split === 'STATUS'
  const targetDamage = opts.targetDamage ?? (isStatus ? 0 : 20)
  dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId,
    moveId: m.id,
    moveData: m,
    targetDamage,
    hpDealt: targetDamage,
    isCriticalHit: false,
    noEffect: opts.noEffect,
    onlyFollowupAbilities: opts.onlyFollowupAbilities,
    deps: testDeps(),
    unmodelled,
    fainted: [],
  })
  return { state, unmodelled, queued: state.queuedExtraAttacks }
}

describe('Cycle 92 - Attacker Follow-Up Move Infrastructure & Helpers', () => {
  it('registers all 14 Cycle 92 abilities in PORTED_ATTACKER_ABILITIES and ATTACKER_FOLLOWUP_ABILITIES', () => {
    const expected = [
      'ABILITY_FORECAST',
      'ABILITY_THUNDERCALL',
      'ABILITY_CURRENT_CRASH',
      'ABILITY_PYRO_SHELLS',
      'ABILITY_FROST_BURN',
      'ABILITY_TWO_STEP',
      'ABILITY_CHUNKY_BASS_LINE',
      'ABILITY_GLACIAL_RAGE',
      'ABILITY_SLUDGE_SPIT',
      'ABILITY_LUNAR_WRATH',
      'ABILITY_BREAK_IT_DOWN',
      'ABILITY_BACKFLIP',
      'ABILITY_THUNDER_CLOUDS',
      'ABILITY_FROST_DRAGON',
    ]
    for (const id of expected) {
      expect(PORTED_ATTACKER_ABILITIES.has(id)).toBe(true)
      expect(ATTACKER_FOLLOWUP_ABILITIES.has(id)).toBe(true)
    }
  })

  it('adjustFollowupMoveTarget matches AdjustFollowupMoveTarget (src/abilities.cc:207-225)', () => {
    const rng = scriptedRng([0])
    const state = battle([{}, {}], rng)
    const deps = testDeps()

    // Standard single-target damaging move hitting opponent -> target preserved (1)
    expect(
      adjustFollowupMoveTarget(state, 0, 1, 'MOVE_TACKLE', move('MOVE_TACKLE'), FOLLOWUP_STANDARD, false, deps, STATUS_DEPS),
    ).toBe(1)

    // MOVE_RESULT_NO_EFFECT blocks unless FOLLOWUP_ALLOW_FAILED is set
    expect(
      adjustFollowupMoveTarget(state, 0, 1, 'MOVE_TACKLE', move('MOVE_TACKLE'), FOLLOWUP_STANDARD, true, deps, STATUS_DEPS),
    ).toBeNull()
    expect(
      adjustFollowupMoveTarget(state, 0, 1, 'MOVE_RAIN_DANCE', move('MOVE_RAIN_DANCE'), FOLLOWUP_ALLOW_FAILED, true, deps, STATUS_DEPS),
    ).toBe(1)

    // Self-target move without FOLLOWUP_ALLOW_SELF or spread/field target flags -> null
    expect(
      adjustFollowupMoveTarget(state, 0, 0, 'MOVE_SWORDS_DANCE', move('MOVE_SWORDS_DANCE'), FOLLOWUP_STANDARD, false, deps, STATUS_DEPS),
    ).toBeNull()

    // Self-target move with FOLLOWUP_ALLOW_SELF retargets to opponent via GetBattleMoveTarget
    expect(
      adjustFollowupMoveTarget(state, 0, 0, 'MOVE_SWORDS_DANCE', move('MOVE_SWORDS_DANCE'), FOLLOWUP_ALLOW_SELF, false, deps, STATUS_DEPS),
    ).toBe(1)

    // Dynamic spread expansion: Expanding Force in Psychic Terrain has MOVE_TARGET_BOTH
    state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
    expect(
      adjustFollowupMoveTarget(state, 0, 0, 'MOVE_EXPANDING_FORCE', move('MOVE_EXPANDING_FORCE'), FOLLOWUP_STANDARD, false, deps, STATUS_DEPS),
    ).toBe(1)

    // Dynamic spread expansion: Toxic Thread in Toxic Terrain has MOVE_TARGET_BOTH
    state.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    expect(
      adjustFollowupMoveTarget(state, 0, 0, 'MOVE_TOXIC_THREAD', move('MOVE_TOXIC_THREAD'), FOLLOWUP_STANDARD, false, deps, STATUS_DEPS),
    ).toBe(1)

    // Dynamic spread expansion: Artillery makes Mega Launcher move MOVE_TARGET_BOTH
    state.field.statuses = 0
    state.battlers[0]!.mon.abilities = hasAbility('ABILITY_ARTILLERY')
    expect(
      adjustFollowupMoveTarget(state, 0, 0, 'MOVE_WATER_PULSE', move('MOVE_WATER_PULSE'), FOLLOWUP_STANDARD, false, deps, STATUS_DEPS),
    ).toBe(1)
  })

  it('canUseExtraMove & queueAttackerFollowUpMove enforce once-per-turn, attackCancelled, and alive checks (src/battle_util.c:4021-4033, 8716-8722)', () => {
    const rng = scriptedRng([0])
    const state = battle([{ abilities: hasAbility('ABILITY_THUNDERCALL') }, {}], rng)
    const deps = testDeps()

    expect(canUseExtraMove(state, 0, 1)).toBe(true)
    // Attacker === target -> false
    expect(canUseExtraMove(state, 0, 0)).toBe(false)

    // attackCancelled -> false
    state.battlers[0]!.round.attackCancelled = true
    expect(canUseExtraMove(state, 0, 1)).toBe(false)
    state.battlers[0]!.round.attackCancelled = false

    // Dead target -> UseAttackerFollowUpMove does not queue
    state.battlers[1]!.mon.hp = 0
    expect(canUseExtraMove(state, 0, 1)).toBe(false)
    queueAttackerFollowUpMove(state, 0, 1, 'ABILITY_THUNDERCALL', 'MOVE_SMITE', 24, deps)
    expect(state.queuedExtraAttacks).toHaveLength(0)

    // Alive target -> queues once and sets turnAbilityTriggers so a second call in the same turn is blocked
    state.battlers[1]!.mon.hp = 100
    queueAttackerFollowUpMove(state, 0, 1, 'ABILITY_THUNDERCALL', 'MOVE_SMITE', 24, deps)
    expect(state.queuedExtraAttacks).toHaveLength(1)
    expect(state.queuedExtraAttacks[0]).toEqual({
      ability: 'ABILITY_THUNDERCALL',
      attacker: 0,
      target: 1,
      move: 'MOVE_SMITE',
      movePower: 24,
    })

    // Second call in same turn for same ability is blocked by CheckAndSetOncePerTurnAbility
    queueAttackerFollowUpMove(state, 0, 1, 'ABILITY_THUNDERCALL', 'MOVE_SMITE', 24, deps)
    expect(state.queuedExtraAttacks).toHaveLength(1)
  })

  it('isMegaLauncherBoostedMove and isDanceMove respect ability flag expansions (src/abilities.cc:358-388)', () => {
    const rng = scriptedRng([0])
    const state = battle([{}, {}], rng)
    const deps = testDeps()
    const attacker = state.battlers[0]!

    // Standard pulse move (`bulletBased` in moves.json)
    expect(isMegaLauncherBoostedMove(state, 0, move('MOVE_WATER_PULSE'), deps)).toBe(true)
    // Gunman grants MOVE_FLAG_MEGA_LAUNCHER to status moves (abilities.cc:9535-9540); Screech is a sound status move (split: STATUS)
    expect(isMegaLauncherBoostedMove(state, 0, move('MOVE_SCREECH'), deps)).toBe(false)
    attacker.mon.abilities = hasAbility('ABILITY_GUNMAN')
    expect(isMegaLauncherBoostedMove(state, 0, move('MOVE_SCREECH'), deps)).toBe(true)

    // Dance move checks: standard dance vs Festivities (sound) / Taekkyeon (non-status) / Backstreet Boy (kickBased)
    attacker.mon.abilities = hasAbility('ABILITY_TWO_STEP')
    expect(isDanceMove(state, 0, move('MOVE_SWORDS_DANCE'), deps)).toBe(true)
    expect(isDanceMove(state, 0, move('MOVE_HYPER_VOICE'), deps)).toBe(false)
    expect(isDanceMove(state, 0, move('MOVE_TACKLE'), deps)).toBe(false)
    expect(isDanceMove(state, 0, move('MOVE_LOW_KICK'), deps)).toBe(false)

    attacker.mon.abilities = hasAbility('ABILITY_FESTIVITIES')
    expect(isDanceMove(state, 0, move('MOVE_HYPER_VOICE'), deps)).toBe(true)
    expect(isDanceMove(state, 0, move('MOVE_SCREECH'), deps)).toBe(true)

    attacker.mon.abilities = hasAbility('ABILITY_TAEKKYEON')
    expect(isDanceMove(state, 0, move('MOVE_TACKLE'), deps)).toBe(true)
    expect(isDanceMove(state, 0, move('MOVE_SWORDS_DANCE'), deps)).toBe(true)
    expect(isDanceMove(state, 0, move('MOVE_SCREECH'), deps)).toBe(false)

    attacker.mon.abilities = hasAbility('ABILITY_BACKSTREET_BOY')
    expect(isDanceMove(state, 0, move('MOVE_LOW_KICK'), deps)).toBe(true)
  })

  it('status-move dispatch only runs ATTACKER_FOLLOWUP_ABILITIES and does not trigger non-follow-up abilities in other slots', () => {
    // Holder has ABILITY_TWO_STEP (slot 0) + ABILITY_MOXIE (innate 0) + ABILITY_VOLCANO_RAGE (innate 1)
    const d = dispatch('ABILITY_TWO_STEP', 'MOVE_SWORDS_DANCE', {
      onlyFollowupAbilities: true,
      holder: {
        abilities: {
          ability: 'ABILITY_TWO_STEP',
          innates: ['ABILITY_MOXIE', 'ABILITY_VOLCANO_RAGE', null],
        },
      },
    })
    expect(d.queued).toHaveLength(1)
    expect(d.queued[0]?.move).toBe('MOVE_REVELATION_DANCE')
    // Volcano Rage was skipped by onlyFollowupAbilities, so no unmodelled note was pushed
    expect(d.unmodelled).toHaveLength(0)
  })
})

describe('Cycle 92 - 14 Attacker Follow-Up Move Abilities (src/abilities.cc)', () => {
  it('1. ABILITY_FORECAST: weather status moves queue MOVE_WEATHER_BALL with FOLLOWUP_ALLOW_FAILED and movePower 0 (abilities.cc:1251-1266)', () => {
    for (const weatherMove of ['MOVE_SUNNY_DAY', 'MOVE_RAIN_DANCE', 'MOVE_SANDSTORM', 'MOVE_HAIL', 'MOVE_EERIE_FOG']) {
      const d = dispatch('ABILITY_FORECAST', weatherMove, { targetId: 1 })
      expect(d.queued).toHaveLength(1)
      expect(d.queued[0]).toEqual({
        ability: 'ABILITY_FORECAST',
        attacker: 0,
        target: 1,
        move: 'MOVE_WEATHER_BALL',
        movePower: 0,
      })
    }

    // End-to-end turn: Rain Dance sets rain and immediately triggers Weather Ball against opponent
    const res = run('ABILITY_FORECAST', 'MOVE_RAIN_DANCE', [0, 0, 0, 0], { actionTarget: 1 })
    expect(res.state.field.weather & WEATHER_RAIN_TEMPORARY).not.toBe(0)
    expect(res.seen).toHaveLength(1)
    expect(res.seen[0]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_WEATHER_BALL',
      movePower: 0,
      ability: 'ABILITY_FORECAST',
    })
    expect(res.target.mon.hp).toBe(85)
    expect(res.out.actions).toHaveLength(3)

    // FOLLOWUP_ALLOW_FAILED: even if weather move had noEffect=true (already raining), Forecast still queues Weather Ball
    const alreadyRaining = dispatch('ABILITY_FORECAST', 'MOVE_RAIN_DANCE', { targetId: 1, noEffect: true })
    expect(alreadyRaining.queued).toHaveLength(1)
    expect(alreadyRaining.queued[0]?.move).toBe('MOVE_WEATHER_BALL')

    // Negative: non-weather move does not trigger Forecast
    expect(dispatch('ABILITY_FORECAST', 'MOVE_TACKLE').queued).toHaveLength(0)
  })

  it('2 & 3. ABILITY_THUNDERCALL & ABILITY_CURRENT_CRASH: Electric moves queue MOVE_SMITE at 24 BP (abilities.cc:4915-4922, 12376-12379)', () => {
    for (const ability of ['ABILITY_THUNDERCALL', 'ABILITY_CURRENT_CRASH']) {
      // Positive: damaging Electric move triggers Smite at 24 BP (0.2 * 120)
      const res = run(ability, 'MOVE_THUNDER_SHOCK')
      expect(res.seen).toHaveLength(2)
      expect(res.seen[0]?.moveId).toBe('MOVE_THUNDER_SHOCK')
      expect(res.seen[1]).toEqual({
        attacker: 0,
        target: 1,
        moveId: 'MOVE_SMITE',
        movePower: 24,
        ability,
      })
      expect(res.target.mon.hp).toBe(70)

      // Positive: Electric status move targeting opponent (Thunder Wave) also triggers Smite
      const statusRes = run(ability, 'MOVE_THUNDER_WAVE')
      expect(statusRes.seen).toHaveLength(1)
      expect(statusRes.seen[0]).toEqual({
        attacker: 0,
        target: 1,
        moveId: 'MOVE_SMITE',
        movePower: 24,
        ability,
      })

      // Negative: non-Electric move does not trigger
      expect(run(ability, 'MOVE_TACKLE').seen).toHaveLength(1)

      // Negative: target protected by Protect -> no follow-up
      const prot = run(ability, 'MOVE_THUNDER_SHOCK', [0, 0], {
        setup: (s) => {
          s.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
        },
      })
      expect(prot.seen).toHaveLength(0)
    }
  })

  it('4. ABILITY_PYRO_SHELLS: Mega Launcher moves queue MOVE_OUTBURST at 50 BP (abilities.cc:5006-5013)', () => {
    // Positive: Water Pulse is a bulletBased/Mega Launcher move -> queues Outburst at 50 BP
    const res = run('ABILITY_PYRO_SHELLS', 'MOVE_WATER_PULSE')
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_OUTBURST',
      movePower: 50,
      ability: 'ABILITY_PYRO_SHELLS',
    })

    // Positive: with ABILITY_GUNMAN innate, status moves targeting opponent (Screech) count as Mega Launcher boosted
    const gunman = run('ABILITY_PYRO_SHELLS', 'MOVE_SCREECH', [0, 0, 0, 0], {
      holder: { abilities: { ability: 'ABILITY_PYRO_SHELLS', innates: ['ABILITY_GUNMAN', null, null] } },
    })
    expect(gunman.seen).toHaveLength(1)
    expect(gunman.seen[0]?.moveId).toBe('MOVE_OUTBURST')

    // Negative: non-pulse move without Gunman does not trigger
    expect(run('ABILITY_PYRO_SHELLS', 'MOVE_SCREECH').seen).toHaveLength(0)
    expect(run('ABILITY_PYRO_SHELLS', 'MOVE_TACKLE').seen).toHaveLength(1)
  })

  it('5. ABILITY_FROST_BURN: Fire moves queue MOVE_ICE_BEAM at 40 BP and can inflict Frostbite (abilities.cc:6144-6151)', () => {
    // Positive: Flamethrower (10% burn in ER moves.json; MOVE_EMBER has effectChance: 100 in ER moves.json so random16() % 100 < 100 always burns)
    // triggers Ice Beam at 40 BP (src/abilities.cc:6144-6151, src/battle_util.c:4021-4033).
    // RNG draws: [0 (Flamethrower acc, battle_script_commands.c:1433), 99 (Flamethrower 10% burn fails, :3113), 0 (Ice Beam acc, :1433), 0 (Ice Beam 10% frostbite hits, :3113 & battle_util.c:5096-5104)]
    const res = run('ABILITY_FROST_BURN', 'MOVE_FLAMETHROWER', [0, 99, 0, 0])
    expect(res.seen).toHaveLength(2)
    expect(res.seen[0]?.moveId).toBe('MOVE_FLAMETHROWER')
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_ICE_BEAM',
      movePower: 40,
      ability: 'ABILITY_FROST_BURN',
    })
    expect(res.target.mon.status1 & STATUS1_BURN).toBe(0)
    expect(res.target.mon.status1).toBe(STATUS1_FROSTBITE)

    // Negative: non-Fire move does not trigger
    expect(run('ABILITY_FROST_BURN', 'MOVE_TACKLE').seen).toHaveLength(1)

    // Negative: target fainted from the initial Fire move -> follow-up is not queued
    const ko = run('ABILITY_FROST_BURN', 'MOVE_FLAMETHROWER', [0, 99, 0, 0], {
      damageAmount: 120,
    })
    expect(ko.seen).toHaveLength(1)
    expect(ko.target.mon.hp).toBe(0)
  })

  it('6. ABILITY_TWO_STEP: Dance moves (including self-target & ability-expanded dances) queue MOVE_REVELATION_DANCE at 50 BP (abilities.cc:6600-6607)', () => {
    // Positive: self-target status dance move (Swords Dance) boosts Attack +2 and queues Revelation Dance on opponent
    const sd = run('ABILITY_TWO_STEP', 'MOVE_SWORDS_DANCE')
    expect(sd.holder.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(sd.seen).toHaveLength(1)
    expect(sd.seen[0]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_REVELATION_DANCE',
      movePower: 50,
      ability: 'ABILITY_TWO_STEP',
    })
    expect(sd.target.mon.hp).toBe(85)

    // Positive: damaging dance move (Fiery Dance) triggers Revelation Dance
    const fd = run('ABILITY_TWO_STEP', 'MOVE_FIERY_DANCE')
    expect(fd.seen).toHaveLength(2)
    expect(fd.seen[1]?.moveId).toBe('MOVE_REVELATION_DANCE')

    // Positive: Backstreet Boy innate makes kicking move count as a dance move for Two-Step
    const kick = run('ABILITY_TWO_STEP', 'MOVE_LOW_KICK', [0, 0, 0, 0], {
      holder: { abilities: { ability: 'ABILITY_TWO_STEP', innates: ['ABILITY_BACKSTREET_BOY', null, null] } },
    })
    expect(kick.seen).toHaveLength(2)
    expect(kick.seen[1]?.moveId).toBe('MOVE_REVELATION_DANCE')

    // Negative: non-dance move without expansion innate does not trigger
    expect(run('ABILITY_TWO_STEP', 'MOVE_LOW_KICK').seen).toHaveLength(1)
  })

  it('7. ABILITY_CHUNKY_BASS_LINE: Sound moves queue MOVE_EARTHQUAKE at 40 BP (abilities.cc:8027-8034)', () => {
    // Positive: Hyper Voice (sound) triggers Earthquake at 40 BP
    const res = run('ABILITY_CHUNKY_BASS_LINE', 'MOVE_HYPER_VOICE')
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_EARTHQUAKE',
      movePower: 40,
      ability: 'ABILITY_CHUNKY_BASS_LINE',
    })

    // Positive: sound status move targeting opponent (Screech) triggers Earthquake at 40 BP
    const screech = run('ABILITY_CHUNKY_BASS_LINE', 'MOVE_SCREECH')
    expect(screech.seen).toHaveLength(1)
    expect(screech.seen[0]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_EARTHQUAKE',
      movePower: 40,
      ability: 'ABILITY_CHUNKY_BASS_LINE',
    })

    // Negative: non-sound move does not trigger
    expect(run('ABILITY_CHUNKY_BASS_LINE', 'MOVE_TACKLE').seen).toHaveLength(1)
  })

  it('8. ABILITY_GLACIAL_RAGE: Ice moves queue MOVE_BLIZZARD at 50 BP (abilities.cc:9635-9642)', () => {
    // Positive: Powder Snow (Ice) triggers Blizzard at 50 BP
    const res = run('ABILITY_GLACIAL_RAGE', 'MOVE_POWDER_SNOW')
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_BLIZZARD',
      movePower: 50,
      ability: 'ABILITY_GLACIAL_RAGE',
    })

    // Negative: Dragon move does NOT trigger Glacial Rage (unlike Frost Dragon)
    expect(run('ABILITY_GLACIAL_RAGE', 'MOVE_DRAGON_CLAW').seen).toHaveLength(1)
  })

  it('9. ABILITY_SLUDGE_SPIT: damaging moves with power > 0 queue MOVE_VENOM_BOLT at 35 BP (abilities.cc:10674-10681)', () => {
    // Positive: Tackle (power 40) triggers Venom Bolt at 35 BP; rolls [0 (Tackle acc), 0 (Venom Bolt acc), 0 (Venom Bolt 20% poison)]
    const res = run('ABILITY_SLUDGE_SPIT', 'MOVE_TACKLE', [0, 0, 0])
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_VENOM_BOLT',
      movePower: 35,
      ability: 'ABILITY_SLUDGE_SPIT',
    })
    expect(res.target.mon.status1).toBe(STATUS1_POISON)

    // Negative: status move (power 0) does not trigger Sludge Spit
    expect(run('ABILITY_SLUDGE_SPIT', 'MOVE_SCREECH').seen).toHaveLength(0)

    // Negative: damaging move that dealt 0 damage does not trigger
    expect(dispatch('ABILITY_SLUDGE_SPIT', 'MOVE_TACKLE', { targetDamage: 0 }).queued).toHaveLength(0)
  })

  it('10. ABILITY_LUNAR_WRATH: Ghost moves queue MOVE_MOONGEIST_BEAM at 50 BP (abilities.cc:10862-10869)', () => {
    // Positive: Shadow Ball (Ghost) triggers Moongeist Beam at 50 BP
    const res = run('ABILITY_LUNAR_WRATH', 'MOVE_SHADOW_BALL')
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_MOONGEIST_BEAM',
      movePower: 50,
      ability: 'ABILITY_LUNAR_WRATH',
    })

    // Positive: Ghost status move targeting opponent (Confuse Ray) triggers Moongeist Beam
    const statusRes = run('ABILITY_LUNAR_WRATH', 'MOVE_CONFUSE_RAY')
    expect(statusRes.seen).toHaveLength(1)
    expect(statusRes.seen[0]?.moveId).toBe('MOVE_MOONGEIST_BEAM')

    // Negative: non-Ghost move does not trigger
    expect(run('ABILITY_LUNAR_WRATH', 'MOVE_TACKLE').seen).toHaveLength(1)
  })

  it('11. ABILITY_BREAK_IT_DOWN: damaging moves queue MOVE_RAPID_SPIN at 20 BP and apply Rapid Spin effects (abilities.cc:11558-11565)', () => {
    // Positive: Tackle triggers Rapid Spin (20 BP), which raises Speed +1 and clears hazards on user's side
    const res = run('ABILITY_BREAK_IT_DOWN', 'MOVE_TACKLE', [0, 0, 0], {
      setup: (s) => {
        s.sides[0].statuses |= SIDE_STATUS_SPIKES
        s.sides[0].timers.spikesAmount = 1
      },
    })
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_RAPID_SPIN',
      movePower: 20,
      ability: 'ABILITY_BREAK_IT_DOWN',
    })
    expect(res.holder.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(res.state.sides[0].statuses & SIDE_STATUS_SPIKES).toBe(0)

    // Negative: status move (power 0) does not trigger Break It Down
    expect(run('ABILITY_BREAK_IT_DOWN', 'MOVE_SWORDS_DANCE').seen).toHaveLength(0)
  })

  it('12. ABILITY_BACKFLIP: moves matching MOVE_FLAG_DANCE queue MOVE_CHIP_AWAY at 50 BP (abilities.cc:11587-11594)', () => {
    // Positive: Swords Dance (self-target dance) queues Chip Away at 50 BP via FOLLOWUP_ALLOW_SELF
    const sd = run('ABILITY_BACKFLIP', 'MOVE_SWORDS_DANCE')
    expect(sd.seen).toHaveLength(1)
    expect(sd.seen[0]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_CHIP_AWAY',
      movePower: 50,
      ability: 'ABILITY_BACKFLIP',
    })

    // Positive: Festivities innate makes sound move count as a dance move for Backflip
    const festivities = dispatch('ABILITY_BACKFLIP', 'MOVE_HYPER_VOICE', {
      holder: { abilities: { ability: 'ABILITY_BACKFLIP', innates: ['ABILITY_FESTIVITIES', null, null] } },
    })
    expect(festivities.queued).toHaveLength(1)
    expect(festivities.queued[0]?.move).toBe('MOVE_CHIP_AWAY')

    // Negative: non-dance move without dance-granting innate does not trigger
    expect(dispatch('ABILITY_BACKFLIP', 'MOVE_TACKLE').queued).toHaveLength(0)
  })

  it('13. ABILITY_THUNDER_CLOUDS: special moves with power > 0 queue MOVE_THUNDERBOLT at 35 BP (abilities.cc:12150-12158)', () => {
    // Positive: Swift (Special, power 60) triggers Thunderbolt at 35 BP; rolls [0 (Thunderbolt acc), 0 (10% paralysis)]
    const res = run('ABILITY_THUNDER_CLOUDS', 'MOVE_SWIFT', [0, 0])
    expect(res.seen).toHaveLength(2)
    expect(res.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_THUNDERBOLT',
      movePower: 35,
      ability: 'ABILITY_THUNDER_CLOUDS',
    })
    expect(res.target.mon.status1).toBe(STATUS1_PARALYSIS)

    // Negative: Physical move (Tackle) does not trigger Thunder Clouds
    expect(run('ABILITY_THUNDER_CLOUDS', 'MOVE_TACKLE').seen).toHaveLength(1)

    // Negative: Status move (Screech) does not trigger Thunder Clouds
    expect(run('ABILITY_THUNDER_CLOUDS', 'MOVE_SCREECH').seen).toHaveLength(0)
  })

  it('14. ABILITY_FROST_DRAGON: Ice or Dragon moves queue MOVE_BLIZZARD at 50 BP (abilities.cc:12394-12401)', () => {
    // Positive: Ice move (Powder Snow) triggers Blizzard at 50 BP
    const ice = run('ABILITY_FROST_DRAGON', 'MOVE_POWDER_SNOW')
    expect(ice.seen).toHaveLength(2)
    expect(ice.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_BLIZZARD',
      movePower: 50,
      ability: 'ABILITY_FROST_DRAGON',
    })

    // Positive: Dragon move (Dragon Claw) triggers Blizzard at 50 BP
    const dragon = run('ABILITY_FROST_DRAGON', 'MOVE_DRAGON_CLAW')
    expect(dragon.seen).toHaveLength(2)
    expect(dragon.seen[1]).toEqual({
      attacker: 0,
      target: 1,
      moveId: 'MOVE_BLIZZARD',
      movePower: 50,
      ability: 'ABILITY_FROST_DRAGON',
    })

    // Negative: Normal move (Tackle) does not trigger Frost Dragon
    expect(run('ABILITY_FROST_DRAGON', 'MOVE_TACKLE').seen).toHaveLength(1)
  })
})
