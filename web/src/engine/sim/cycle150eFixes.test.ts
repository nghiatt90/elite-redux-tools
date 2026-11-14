/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150e: the five fixes the 150c review asked for, all around the move-end defender
// dispatch and its call sites.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - Impl<ABILITY_BALLOON_BOMBER>.onDefender (src/abilities.cc:7758-7763) is
//   `Aftermath.onDefender || Inflatable.onDefender`; Aftermath's own body (:1662-1669) is
//   CHECK_NOT(IsBattlerAlive(battler)), then UseOutOfTurnAttack(..., highestStat == STAT_SPATK ?
//   MOVE_OUTBURST : MOVE_EXPLOSION, 100). No damage gate anywhere, exactly like the plain
//   ABILITY_AFTERMATH branch moveEnd.ts:2931-2940.
// - Impl<ABILITY_CRISPY_CREAM>.onDefender (src/abilities.cc:10837-10842) is
//   `Random() % 2 ? FlameBody : FreezingPoint`, i.e. the %2 draw happens BEFORE either delegated
//   hook's ShouldApplyOnHitEffect check, so even a zero-damage move spends exactly one extra draw.
// - ON_EITHER(FlameBody) (src/abilities.cc:1126-1134) / ON_EITHER(FreezingPoint) (:6359-6367).
// - Impl<ABILITY_FLAMMABLE_COAT>.onDefender (src/abilities.cc:8320-8334): ShouldApplyOnHitEffect OR
//   the Flash Fire resource flag, type FIRE, species LUMBERING_SLOTH, not transformed.
// - ApeShiftHandler (src/abilities.cc:9047-9060) behind Impl<ABILITY_APE_SHIFT>.onDefender (:9063-9065).
// - ON_EITHER(SoulLinker) (src/abilities.cc:4272-4281) has CHECK(move != MOVE_PAIN_SPLIT).
// - Cmd_datahpupdate for Pain Split (data/battle_scripts_1.s:4691-4704) sets gHpDealt to the
//   target's HP loss, and gBattleMoveDamage is the same value (battle_script_commands.c:1928-1935).
// - The MOVEEND_ABILITIES call site (battle_script_commands.c:4527-4531 -> battle_util.c:4485-4489,
//   HandleDefenderAbility :9050-9084) has no damage gate; every script that reaches
//   BattleScript_MoveEnd runs it (moveendall, data/battle_scripts_1.s:2883-2885).
// - gChosenMovePos (battle_util.c:200) is the SELECTED slot; a queued extra attack overwrites
//   gCurrentMove and gChosenMove (:204) but not the position. gChosenMove stays the selected move
//   for `jumptocalledmove TRUE` (Cmd_jumptocalledmove :5906-5914).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT, setActionsAndBattlersTurnOrder } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeAction, executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  BATTLE_TYPE_TRAINER,
  DEFAULT_STAT_STAGE,
  STAT_DEF,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  setCounter,
} from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150cFidelity.test.ts.
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

function partyMon(speciesId: string | null, hp: number): SimPartyMon {
  return {
    speciesId,
    hp,
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
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
  }
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
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
    ...opts,
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

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
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

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

// ---------------------------------------------------------------------------
// Item 1 -- Balloon Bomber's Aftermath half has no damage gate.
// ---------------------------------------------------------------------------

describe('Cycle 150e 1 - Balloon Bomber Aftermath half ignores targetDamage', () => {
  // Balloon Bomber (abilities.cc:7758-7763) = `Aftermath.onDefender || Inflatable.onDefender`.
  // Aftermath.onDefender (:1662-1669) is CHECK_NOT(IsBattlerAlive(battler)) and nothing else, so a
  // zero-damage move at a fainted holder queues exactly one attack. GetHighestAttackingStatId(...,
  // TRUE) with atk 100 > spatk 80 picks MOVE_EXPLOSION (:1667).
  it('a fainted holder queues exactly one Explosion on a zero-damage status move', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 0, abilities: hasAbility('ABILITY_BALLOON_BOMBER') },
    ], scriptedRng([0]))
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: true,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.queuedExtraAttacks).toHaveLength(1)
    expect(state.queuedExtraAttacks[0]).toMatchObject({
      ability: 'ABILITY_BALLOON_BOMBER',
      move: 'MOVE_EXPLOSION',
      attacker: 1,
      target: 0,
      movePower: 100,
    })
  })

  // `highestStat == STAT_SPATK ? MOVE_OUTBURST : MOVE_EXPLOSION` (:1667); ties go to Attack
  // (battle_util.c GetHighestAttackingStatId). spatk 120 > atk 50 -> Outburst.
  it('picks Outburst when the holder\'s Sp. Atk is the higher attacking stat', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { atk: 50, spatk: 120, hp: 0, abilities: hasAbility('ABILITY_BALLOON_BOMBER') },
    ], scriptedRng([0]))
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: true,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.queuedExtraAttacks).toHaveLength(1)
    expect(state.queuedExtraAttacks[0]!.move).toBe('MOVE_OUTBURST')
  })

  // Negative: CHECK_NOT(IsBattlerAlive(battler)) -- a living holder never queues.
  it('does not queue for a living holder', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 100, abilities: hasAbility('ABILITY_BALLOON_BOMBER') },
    ], scriptedRng([0]))
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: true,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.queuedExtraAttacks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Item 2 -- tests only the move-end dispatch (turn.ts:2673) can satisfy.
// ---------------------------------------------------------------------------

describe('Cycle 150e 2 - status-move defender dispatch', () => {
  // BattleScript_EffectConfuse ends in `goto BattleScript_MoveEnd` (data/battle_scripts_1.s:4219-4231);
  // MOVEEND_ABILITIES (case 5) runs on the selected target even though the move dealt nothing, and a
  // fainted Aftermath holder's onDefender queues Explosion plus Outburst/Explosion's 100 power.
  // The fixed resolver answers 40, so the attacker goes 300 -> 260 from exactly one explosion.
  it('2a: Confuse Ray at a fainted Aftermath holder deals exactly one Explosion (40) to the attacker', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 0, abilities: hasAbility('ABILITY_AFTERMATH') },
    ], scriptedRng([0, 0, 0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_CONFUSE_RAY')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(260)
    expect(state.queuedExtraAttacks).toHaveLength(0)
  })

  // Same holder state, reached through the damaging path's no-living-target exit
  // (battle_script_commands.c:1145-1149 -> BattleScript_ButItFailedAtkStringPpReduce ->
  // `goto BattleScript_MoveEnd`, data/battle_scripts_1.s:5938-5945).
  it('2a: a damaging move at the same fainted holder deals exactly one Explosion', () => {
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { hp: 0, abilities: hasAbility('ABILITY_AFTERMATH') },
    ], scriptedRng([0, 0, 0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(260)
  })

  // Crispy Cream (abilities.cc:10837-10842) spends its `Random() % 2` before either delegated hook
  // checks ShouldApplyOnHitEffect, so a status move costs exactly one draw and applies nothing.
  // Confuse Ray's own two draws are Cmd_accuracycheck (:1433) and the confusion duration
  // `(Random() % 2) + 3` (battle_script_commands.c:2660), so the turn totals exactly 3.
  it('2b: Crispy Cream spends exactly one Random() % 2 on a status move', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_CONFUSE_RAY')), null], testDeps(fixedDamage(40)))
    // accuracy + confusion duration + Crispy Cream's %2.
    expect(rng.calls).toBe(3)
    expect(state.battlers[0]!.mon.status1 & STATUS1_BURN).toBe(0)
    expect(state.battlers[0]!.mon.status1 & STATUS1_FROSTBITE).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(300)
  })

  // Branch assertion: the same %2 picks the delegated hook. Roll 0 -> Freezing Point
  // (abilities.cc:6359-6367, contact 20), roll 1 -> Flame Body (:1126-1134, contact 30); the second
  // roll 0 then lands inside the chosen hook's `Random() % 100 < chance`.
  it('2b: the %2 selects the branch -- 0 frostbites, 1 burns (Tackle is contact)', () => {
    const frostbite = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], scriptedRng([0, 0, 0, 0]))
    executeTurn(frostbite, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(frostbite.battlers[0]!.mon.status1 & STATUS1_FROSTBITE).toBe(STATUS1_FROSTBITE)

    const burn = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], scriptedRng([0, 1, 0, 0]))
    executeTurn(burn, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(burn.battlers[0]!.mon.status1 & STATUS1_BURN).toBe(STATUS1_BURN)
  })

  // Ape Shift form right after the action and BEFORE any end-of-turn hook: executeAction does not
  // call endTurn.ts's ABILITY_APE_SHIFT onEndTurn (:1456), so only turn.ts's status-move dispatch
  // (2673) can change the species here. ShouldChangeFormHpBased (battle_util.c:3812-3906; the Ape
  // Shift row is :3807) switches SLAKING_MEGA -> SLAKING_MEGA_APE_SHIFT at hp <= maxHp/2: 100 <= 150.
  it('2c: Ape Shift switches form straight after the action, before end of turn', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { speciesId: 'SPECIES_SLAKING_MEGA', hp: 100, maxHp: 300, abilities: hasAbility('ABILITY_APE_SHIFT') },
    ], scriptedRng([0, 0, 0]))
    const action = useMove(1, move('MOVE_CONFUSE_RAY'))
    const order = setActionsAndBattlersTurnOrder(state, [action, null])
    executeAction(state, 0, action, 'USE_MOVE', 0, order, testDeps(fixedDamage(0)))
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')
  })
})

// ---------------------------------------------------------------------------
// Item 3 -- the exits that skip the damage path still run the defender dispatch.
// ---------------------------------------------------------------------------

describe('Cycle 150e 3 - Crispy Cream on every non-damaging exit', () => {
  // One extra draw over the no-ability baseline per exit: the %2 only. Confuse Ray's own draws are
  // Cmd_accuracycheck (:1433) and the confusion duration (battle_script_commands.c:2660).
  it('status move: 3 draws (accuracy, confusion duration, the %2)', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_CONFUSE_RAY')), null], testDeps(fixedDamage(0)))
    expect(rng.calls).toBe(3)
  })

  it('zero-damage hit: 2 draws (accuracy, then the %2)', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(0)))
    expect(rng.calls).toBe(2)
    expect(state.battlers[0]!.mon.status1 & (STATUS1_BURN | STATUS1_FROSTBITE)).toBe(0)
  })

  // Cmd_accuracycheck (:1433): `(Random() % 100) >= accuracy` is a miss. Fire Blast is 85, so roll
  // 99 misses; BattleScript_PrintMoveMissed -> `goto BattleScript_MoveEnd` (s:3092-3101).
  it('accuracy miss: 2 draws (accuracy, then the %2)', () => {
    const rng = scriptedRng([99, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_FIRE_BLAST', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_FIRE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(2)
  })

  // Protect is checked before the accuracy check (:3563-3576), so a blocked move spends no accuracy
  // draw; its script still reaches BattleScript_MoveEnd (:2861-2885).
  it('Protect block: 1 draw (the %2, no accuracy)', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    state.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(state.battlers[1]!.mon.hp).toBe(300)
  })

  // A sleeping attacker is cancelled by Cmd_attackcanceler before any accuracy check; every cancel
  // script reaches BattleScript_MoveEnd (MoveUsedIsAsleep, data/battle_scripts_1.s:8594-8598).
  // status1 low 3 bits = the sleep counter (constants.ts:151); 3 decrements to 2 and stays asleep.
  it('attacker cannot act: 1 draw (the %2)', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], status1: 3 },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.cancelledBy).toBe('SLEEP')
    expect(rng.calls).toBe(1)
  })

  // Negative: the dispatch runs the TARGET's abilities. A Crispy Cream on the attacking side is not
  // a defender ability for its own move, so the attacking-side turn spends exactly the same two
  // draws as the no-ability baseline (accuracy + confusion duration) and not the extra %2.
  it('negative: a Crispy Cream on the attacking side never draws', () => {
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      { hp: 300 },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_CONFUSE_RAY')), null], testDeps(fixedDamage(0)))
    expect(rng.calls).toBe(2)

    const baselineRng = scriptedRng([0, 0, 0, 0])
    const baseline = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [5, 0, 0, 0] },
      { hp: 300 },
    ], baselineRng)
    executeTurn(baseline, [useMove(1, move('MOVE_CONFUSE_RAY')), null], testDeps(fixedDamage(0)))
    expect(baselineRng.calls).toBe(2)
  })
})

describe('Cycle 150e 3 - fainted Aftermath family on a non-damaging exit', () => {
  // The miss and Protect exits send (targetDamage 0, hpDealt 0, noEffect true) at the selected
  // target. Aftermath (:1662-1669) and Balloon Bomber (:7758-7763) only read IsBattlerAlive, so the
  // same parameters still queue one attack. Tested at the dispatch seam because a dead target never
  // reaches the accuracy check (the attackcanceler's no-living-target branch fires first).
  for (const abilityId of ['ABILITY_AFTERMATH', 'ABILITY_BALLOON_BOMBER']) {
    it(`${abilityId}: the miss/block parameters queue exactly one Explosion`, () => {
      const state = battle([
        { moves: ['MOVE_FIRE_BLAST', null, null, null], pp: [5, 0, 0, 0] },
        { hp: 0, abilities: hasAbility(abilityId) },
      ], scriptedRng([0]))
      runMoveEnd({
        state,
        attackerId: 0,
        targetId: 1,
        moveId: 'MOVE_FIRE_BLAST',
        targetDamage: 0,
        hpDealt: 0,
        noEffect: true,
        deps: testDeps(fixedDamage(0)),
        unmodelled: [],
        fainted: [],
      })
      expect(state.queuedExtraAttacks).toHaveLength(1)
      expect(state.queuedExtraAttacks[0]).toMatchObject({ ability: abilityId, attacker: 1, target: 0 })
    })
  }

  // The reachable exit for a dead holder is the attackcanceler's own fail branch: it runs BEFORE the
  // liveness check (:2320-2326, battle_scripts_1.s:8594-8598), so a sleeping attacker still triggers
  // the fainted holder's Explosion, which the turn loop then drains (40 off the attacker).
  it('a cancelled action at a fainted Aftermath holder still fires one Explosion', () => {
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], status1: 3 },
      { hp: 0, abilities: hasAbility('ABILITY_AFTERMATH') },
    ], scriptedRng([0, 0, 0, 0]))
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(40)))
    expect(out.actions[0]!.cancelledBy).toBe('SLEEP')
    expect(state.battlers[0]!.mon.hp).toBe(260)
  })
})

describe('Cycle 150e 3 - form changes on a missed Fire move', () => {
  // Ape Shift's onDefender has no damage gate (abilities.cc:9063-9065). Checked with executeAction
  // so endTurn.ts's ABILITY_APE_SHIFT onEndTurn (:1456) cannot produce the same species change.
  it('Ape Shift changes form on a missed Fire move', () => {
    const state = battle([
      { moves: ['MOVE_FIRE_BLAST', null, null, null], pp: [5, 0, 0, 0] },
      { speciesId: 'SPECIES_SLAKING_MEGA', hp: 100, maxHp: 300, abilities: hasAbility('ABILITY_APE_SHIFT') },
    ], scriptedRng([99, 0, 0]))
    const action = useMove(1, move('MOVE_FIRE_BLAST'))
    const order = setActionsAndBattlersTurnOrder(state, [action, null])
    const out = executeAction(state, 0, action, 'USE_MOVE', 0, order, testDeps(fixedDamage(20)))
    expect(out.missed).toBe(true)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')
  })

  // Flammable Coat (abilities.cc:8320-8334) accepts `ShouldApplyOnHitEffect || RESOURCE_FLAG_FLASH_FIRE`,
  // so a holder whose Flash Fire flag is already set changes form even on a missed Fire move. No
  // end-of-turn hook re-applies this form, so executeTurn is safe here.
  it('Flammable Coat + Flash Fire changes form on a missed Fire move', () => {
    const state = battle([
      { moves: ['MOVE_FIRE_BLAST', null, null, null], pp: [5, 0, 0, 0] },
      { speciesId: 'SPECIES_LUMBERING_SLOTH', hp: 300, abilities: hasAbility('ABILITY_FLAMMABLE_COAT') },
    ], scriptedRng([99, 0, 0]))
    state.battlers[1]!.volatiles.flashFire = true
    const out = executeTurn(state, [useMove(1, move('MOVE_FIRE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.missed).toBe(true)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH_ENGULFED')
  })
})

// ---------------------------------------------------------------------------
// Item 4 -- Pain Split is a hit in the C.
// ---------------------------------------------------------------------------

describe('Cycle 150e 4 - Pain Split carries the target\'s HP loss', () => {
  // handlePainSplit: hpDiff = (100 + 300) / 2 = 200. The target loses 300 - 200 = 100 and the
  // attacker gains 100. Cmd_datahpupdate (battle_script_commands.c:1928-1935) sets gHpDealt to that
  // 100 and data/battle_scripts_1.s:4698-4704 stores it in gBattleMoveDamage, so it reaches the
  // defender dispatch as targetDamage.
  it('deals 100 to the target, heals 100 on the attacker, and reports targetDamage 100', () => {
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 100, maxHp: 300 },
      { hp: 300, maxHp: 300 },
    ], scriptedRng([0, 0]))
    const out = executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], testDeps(fixedDamage(0)))
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(out.actions[0]!.targetDamage).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBeLessThan(300)
  })

  // Cursed Body (abilities.cc:1910-1924): CHECK(ShouldApplyOnHitEffect(attacker)) passes because the
  // target did lose HP, then `Random() % 100 < 30` with roll 29 disables gChosenMove. Pain Split's
  // script has no accuracycheck, so this is the move's only draw.
  it('Cursed Body roll 29 disables MOVE_PAIN_SPLIT', () => {
    const rng = scriptedRng([29, 0, 0])
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 100, maxHp: 300 },
      { hp: 300, maxHp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], testDeps(fixedDamage(0)))
    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_PAIN_SPLIT')
    // ENDTURN_DISABLE (battle_util.c:2774-2791) decrements the 4 the hook set, and the move is still
    // in the attacker's list, so the disable survives with 3.
    expect(state.battlers[0]!.volatiles.disableTimer).toBe(3)
  })

  // Stamina (abilities.cc:4550-4556 shape): targetDamage > 0 raises the holder's Def by one stage
  // (a non-critical hit is +1; isCriticalHit is false here). Internal stage 6 -> 7.
  it('Stamina raises Def by one stage on the Pain Split HP loss', () => {
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 100, maxHp: 300 },
      { hp: 300, maxHp: 300, abilities: hasAbility('ABILITY_STAMINA') },
    ], scriptedRng([0]))
    const out = executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], testDeps(fixedDamage(0)))
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(out.actions[0]!.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: 1 }])
  })

  // CheckHalfHpAbility (battle_util.c:9043-9048) + CanBattlerBeForceSwitched (abilities.cc:2608-2616).
  // hpDiff = (100 + 180) / 2 = 140, so the target loses 40: 180 -> 140 crosses half (150) exactly.
  it('Emergency Exit forces a switch when the Pain Split loss crosses half HP', () => {
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 100, maxHp: 300 },
      { hp: 180, maxHp: 300, abilities: hasAbility('ABILITY_EMERGENCY_EXIT') },
    ], scriptedRng([0]), {
      opponentParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)],
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    // BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500) draws no random number;
    // the replacement slot comes from deps.replacement.
    const deps = { ...testDeps(fixedDamage(0)), replacement: { chooseReplacement: () => 1 } }
    const out = executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], deps)
    expect(out.actions[0]!.targetDamage).toBe(40)
    expect(state.battlers[1]!.partyIndex).toBe(1)
    expect(state.queuedSwitches).toHaveLength(0)
  })

  // Negative: hpDiff = (300 + 100) / 2 = 200 -- the target GAINS 100, so the C's Cmd_datahpupdate
  // never sets gHpDealt and nothing with a targetDamage > 0 gate may fire. The attacker does lose
  // 100 (300 -> 200); that is the move's own effect, not damage the target took.
  it('negative: when the target gains HP, no defender ability fires', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 300, maxHp: 300 },
      { hp: 100, maxHp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], testDeps(fixedDamage(0)))
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(out.actions[0]!.targetDamage).toBe(0)
    expect(rng.calls).toBe(0)
    expect(state.battlers[0]!.volatiles.disabledMove).toBeNull()
  })

  // ON_EITHER(SoulLinker) (abilities.cc:4272-4281) is CHECK(move != MOVE_PAIN_SPLIT): the attacker
  // keeps the HP it gained and takes no reflected damage.
  it('Soul Linker does not reflect Pain Split', () => {
    const state = battle([
      { moves: ['MOVE_PAIN_SPLIT', null, null, null], pp: [20, 0, 0, 0], hp: 100, maxHp: 300 },
      { hp: 300, maxHp: 300, abilities: hasAbility('ABILITY_SOUL_LINKER') },
    ], scriptedRng([0]))
    const out = executeTurn(state, [useMove(1, move('MOVE_PAIN_SPLIT')), null], testDeps(fixedDamage(0)))
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(out.actions[0]!.attackerDamage ?? 0).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Item 5 -- the turn loop supplies the right gChosenMovePos / gChosenMove.
// ---------------------------------------------------------------------------

describe('Cycle 150e 5 - chosen move and PP slot through the turn loop', () => {
  // gChosenMovePos = the selected slot (battle_util.c:200). Sleep Talk queues its extra attack with
  // the rolled slot, and battle_util.c:204 then overwrites gCurrentMove and gChosenMove with that
  // extra move -- so Cursed Body reads pp[Sleep Talk slot] and disables the CALLED move (Tackle).
  // Draws: selection (random16 & 3 = 0 -> slot 0 Tackle), Tackle's accuracy, Cursed Body 29.
  it('Sleep Talk: Cursed Body checks the Sleep Talk PP slot and disables the called move', () => {
    const rng = scriptedRng([0, 0, 29, 0])
    const state = battle([
      {
        moves: ['MOVE_TACKLE', 'MOVE_SLEEP_TALK', null, null],
        pp: [20, 2, 0, 0],
        status1: STATUS1_SLEEP,
      },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_SLEEP_TALK')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[1]).toBe(1) // Sleep Talk's own ppreduce, before the ability pass
    expect(state.battlers[0]!.mon.pp[0]).toBe(20) // the extra attack is HITMARKER_NO_PPDEDUCT
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
  })

  // Negative: the same turn with the Sleep Talk slot at 1 PP. ppreduce zeroes it, and
  // CHECK(gBattleMons[attacker].pp[gChosenMovePos]) (:1916) fails even though Tackle still has 20.
  it('Sleep Talk negative: a zeroed Sleep Talk slot stops Cursed Body before its roll', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle([
      {
        moves: ['MOVE_TACKLE', 'MOVE_SLEEP_TALK', null, null],
        pp: [20, 1, 0, 0],
        status1: STATUS1_SLEEP,
      },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_SLEEP_TALK')), null], testDeps(fixedDamage(20)))
    expect(rng.calls).toBe(2)
    expect(state.battlers[0]!.mon.pp[1]).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(280)
    expect(state.battlers[0]!.volatiles.disabledMove).toBeNull()
  })

  // Cmd_metronome (battle_script_commands.c:10586-10613) queues the called move as an extra attack
  // with movePos 0, so gChosenMove becomes the called move (:204) while gChosenMovePos stays on
  // Metronome. Roll 0 -> `(0 % (MOVES_COUNT - 1)) + 1` = 1 = MOVE_POUND (metronomeMoves.ts). The
  // attacker carries Pound, because ENDTURN_DISABLE (battle_util.c:2779-2784) clears a disabled
  // move the mon no longer knows in the same end-of-turn pass.
  it('Metronome: Cursed Body disables the called move but reads the Metronome PP slot', () => {
    const rng = scriptedRng([0, 0, 29, 0])
    const state = battle([
      { moves: ['MOVE_METRONOME', 'MOVE_POUND', null, null], pp: [10, 20, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_METRONOME')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // only Metronome's own ppreduce
    expect(state.battlers[1]!.mon.hp).toBe(280) // Pound landed
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_POUND')
  })

  // Negative: with the Metronome slot at 1 PP, ppreduce zeroes it and Cursed Body never rolls,
  // although the called move's own slot (Pound, 20 PP) is still full.
  it('Metronome negative: a zeroed Metronome slot stops Cursed Body before its roll', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle([
      { moves: ['MOVE_METRONOME', 'MOVE_POUND', null, null], pp: [1, 20, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_METRONOME')), null], testDeps(fixedDamage(20)))
    expect(rng.calls).toBe(2)
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
    expect(state.battlers[0]!.volatiles.disabledMove).toBeNull()
  })

  // Copycat's `jumptocalledmove TRUE` (data/battle_scripts_1.s:1601, Cmd_jumptocalledmove
  // :5906-5914) keeps gChosenMove = Copycat, so Cursed Body disables Copycat itself, not the copied
  // move. Draws: the copied Tackle's accuracy, then Cursed Body's roll.
  it('Copycat: Cursed Body disables Copycat, not the copied move', () => {
    const rng = scriptedRng([0, 29, 0])
    const state = battle([
      { moves: ['MOVE_COPYCAT', null, null, null], pp: [20, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    state.lastUsedMove = 'MOVE_TACKLE'
    executeTurn(state, [useMove(1, move('MOVE_COPYCAT')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(19) // the copied move's script deducts the selected slot
    expect(state.battlers[1]!.mon.hp).toBe(280)
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_COPYCAT')
  })

  // Draw order for a damaging move: accuracy (battle_script_commands.c:1433), then the move's
  // secondary chance (Cmd_seteffectwithchance :3110-3113), then MOVEEND_ABILITIES' Cursed Body roll
  // (:1918). MOVE_MUD_SHOT has effectChance 10 and MOVE_EFFECT_SPD_MINUS_1.
  it('draw order: accuracy, secondary chance, then Cursed Body', () => {
    const secondaryHits = scriptedRng([0, 5, 99, 0])
    const hits = battle([
      { moves: ['MOVE_MUD_SHOT', null, null, null], pp: [15, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], secondaryHits)
    executeTurn(hits, [useMove(1, move('MOVE_MUD_SHOT')), null], testDeps(fixedDamage(20)))
    expect(secondaryHits.calls).toBe(3)
    expect(hits.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1) // 5 < 10
    expect(hits.battlers[0]!.volatiles.disabledMove).toBeNull() // 99 >= 30

    const secondaryMisses = scriptedRng([0, 50, 29, 0])
    const misses = battle([
      { moves: ['MOVE_MUD_SHOT', null, null, null], pp: [15, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], secondaryMisses)
    executeTurn(misses, [useMove(1, move('MOVE_MUD_SHOT')), null], testDeps(fixedDamage(20)))
    expect(secondaryMisses.calls).toBe(3)
    expect(misses.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE) // 50 >= 10
    expect(misses.battlers[0]!.volatiles.disabledMove).toBe('MOVE_MUD_SHOT') // 29 < 30
  })
})

// ---------------------------------------------------------------------------
// Item 6 -- a confusion self-hit skips MOVEEND_ABILITIES.
// ---------------------------------------------------------------------------

describe('Cycle 150e 6 - confusion self-hit skips the defender dispatch', () => {
  // battle_util.c:3388 sets `gRoundStructs[gBattlerAttacker].confusionSelfDmg = TRUE`, and the
  // MOVEEND_ABILITIES case (battle_script_commands.c:4529) carries
  // `REQUIRE_NOT(!gProcessingExtraAttacks && ...confusionSelfDmg)` -- `if (...) break;`
  // (include/global.h:56-57). So a self-hit runs no defender ability at all: not the selected
  // target's, and not the attacker's, even though :3386 points gBattlerTarget at the attacker.
  // Crispy Cream (abilities.cc:10837-10842) spends its `Random() % 2` before either delegated
  // hook's ShouldApplyOnHitEffect check, so a stale dispatch is visible as one extra draw.
  it('a self-hit spends only the confusion roll, even with Crispy Cream on the attacker', () => {
    const baselineRng = scriptedRng([0])
    const baseline = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], status2: setCounter(0, STATUS2_CONFUSION, 2) },
      { hp: 300 },
    ], baselineRng)
    const baselineOut = executeTurn(baseline, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(baselineOut.actions[0]!.cancelledBy).toBe('CONFUSION')
    expect(baselineRng.calls).toBe(1) // the `Random() % 3`, battle_util.c:3376

    const rng = scriptedRng([0])
    const state = battle([
      {
        moves: ['MOVE_TACKLE', null, null, null],
        pp: [35, 0, 0, 0],
        status2: setCounter(0, STATUS2_CONFUSION, 2),
        abilities: hasAbility('ABILITY_CRISPY_CREAM'),
      },
      { hp: 300 },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.cancelledBy).toBe('CONFUSION')
    expect(rng.calls).toBe(baselineRng.calls) // no extra %2 draw
    expect(out.actions[0]!.statChanges).toBeNull()
    expect(out.actions[0]!.statusApplied).toBeNull()
    expect(state.battlers[0]!.mon.status1 & (STATUS1_BURN | STATUS1_FROSTBITE)).toBe(0)
  })

  // Negative control: every other canceller leaves gBattlerTarget at the selected target and does
  // not set confusionSelfDmg, so MOVEEND_ABILITIES still runs. Full paralysis is one such cancel
  // (battle_util.c:3400-3413): one draw for `Random() % 4`, then the target's Crispy Cream %2.
  // Spe 200 keeps the attacker first even after B_PARALYSIS_SPEED halves it (turnOrder.ts:291).
  it('negative: full paralysis still dispatches the target\'s Crispy Cream', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { spe: 200, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], status1: STATUS1_PARALYSIS },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.cancelledBy).toBe('PARALYSIS')
    expect(rng.calls).toBe(2)
  })
})

