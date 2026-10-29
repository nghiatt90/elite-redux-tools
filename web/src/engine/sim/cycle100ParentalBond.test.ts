/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 100: the sim side of the Parental Bond family. Cycle 99 ported the calc
// side (multiHit.ts's resolveHitPlan: eligibility, trigger, per-hit multiplier);
// nothing in the turn loop ever SET multiHitCounter / parentalBondOn /
// parentalBondInitialCount, so no bonus hit could happen. This file exercises
// Cmd_attackcanceler's setup (battle_script_commands.c:1082-1091), the per-hit
// decrement (MOVEEND_MULTIHIT_MOVE, :4898-4906), AdjustFixedDamageForParentalBond
// (:10615-10624) and the Minion Control no-op on secondary effects (:3110-3112).
//
// Every expected number is hand-derived from the C in a comment next to it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, DamageResolution, DamageResolveContext, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import { runAttackCanceller } from './attackCanceller'
import { STATUS2_FLINCHED, hasFlag } from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, any>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const speciesById = new Map(snapshot<Array<SimSpeciesData>>('species.json').map((s) => [s.id, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const natures = snapshot<any>('natures.json')
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
    argumentInt: m.argument?.kind === 'int' ? (m.argument.value as number) : null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

/** The engine's MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
function engineMove(id: string): any {
  const move = movesById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: move.effect === 'EFFECT_MISC_HIT' && arg?.kind === 'misc' ? arg.misc : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
    argumentStatus: move.effect === 'EFFECT_DMG_IF_STATUS1' && arg?.kind === 'status' ? arg.status : null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id),
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

interface BattlerSpec {
  speciesId?: string
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource, playerParty?: SimPartyMon[], opponentParty?: SimPartyMon[]): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          // Speeds differ so getFastestBattler never has to break a tie: a tie
          // draw would be consumed before the accuracy roll (turnOrder.ts:565).
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
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

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
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

function bridgeDamage(random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext: DATA_CONTEXT, inverseBattle: false }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: (id) => (movesById.has(id) ? engineMove(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants: natures,
    random,
  }
  return createBridgeDamageResolver(deps)
}

/** Wraps the real resolver and records each per-hit call, so the test can assert
 * the individual hit damages and the hitIndex the loop passed. */
function recordingResolver(inner: DamageResolver): DamageResolver & { hits: Array<{ hitIndex: number | undefined; damage: number | null }> } {
  const hits: Array<{ hitIndex: number | undefined; damage: number | null }> = []
  return {
    hits,
    resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction, context?: DamageResolveContext): DamageResolution {
      const result = inner.resolve(state, attackerId, targetId, action, context)
      hits.push({ hitIndex: context?.hitIndex, damage: result.targetDamage })
      return result
    },
    confusionSelfHit: inner.confusionSelfHit?.bind(inner),
  }
}

function testDeps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    moveBehaviors,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const PARENTAL_BOND = hasAbility('ABILITY_PARENTAL_BOND')
const WATER: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']
const FIGHTING: [string, string, string] = ['FIGHTING', 'MYSTERY', 'MYSTERY']

// -----------------------------------------------------------------------------
// The damage arithmetic every expected number below comes from.
//
// CalcFinalDmg (battle_util.c:7707-7748) at level 50: the level term is
// floor(2*level/5 + 2) = 22, so with the maximum damage roll (the resolver
// indexes its ascending 85..100% table as `values[15 - roll]`, so a 0 draw from
// `Random() % 16` selects the 100% row) and a neutral type chart
//
//   base = floor( floor(22 * power * A / D) / 50 ) + 2
//
// Every multiplier is a UQ_4_12 value (fixed.ts: UQ_4_12(n) truncates n*1024,
// MulModifier rounds half up then truncates, ApplyModifier rounds half up).
//
// Mega Punch (95 BP, Atk 200 vs Def 90, WATER attacker = no STAB, Normal 1x on
// Fighting): floor(floor(22*95*200/90)/50)+2 = floor(4644/50)+2 = 94.
//   hit 0 multiplier uq(1.0)  = 1024 -> ApplyModifier(1024, 94) = 94
//   hit 1 multiplier uq(0.25) =  256 -> ApplyModifier(256, 94) = floor(24576/1024) = 24
//   hit 1 multiplier uq(0.2)  =  204 -> ApplyModifier(204, 94) = floor(19688/1024) = 19
//   hit 2 multiplier uq(0.15) =  153 -> ApplyModifier(153, 94) = floor(14894/1024) = 14
//   hit 1 multiplier uq(0.1)  =  102 -> ApplyModifier(102, 94) = floor(10100/1024) =  9
// Aura Force (70 BP Fighting, WATER attacker = no STAB, Fighting 1x on Water):
// floor(floor(22*70*200/90)/50)+2 = floor(3422/50)+2 = 70, and Dual Wield's
// uq(0.7) = 716 -> ApplyModifier(716, 70) = floor(50632/1024) = 49.
const MEGA_PUNCH = 94
const MEGA_PUNCH_Q = 24
const MEGA_PUNCH_FIFTH = 19
const MEGA_PUNCH_FIFTEENTH = 14
const MEGA_PUNCH_TENTH = 9
const AURA_FORCE_DUAL = 49

// Draw scripts. The attack script for one hit is: accuracycheck (only the
// first hit: battle_script_commands.c:1412-1420), then Cmd_critcalc's
// MakeCritRoll (`Random() % 24`, :1586) unless the hit arrives with the turn
// loop's own gCritRoll, then Cmd_damagecalc's `Random() % 16` (:7792), then
// seteffectwithchance's `Random() % 100` if the move has a secondary effect.
// MOVEEND_MULTIHIT_MOVE then stores MakeCritRoll() for the NEXT hit (:4885).
// 0 = accuracy hit (0 >= 100 is false), 5 = no crit (5 % 24 != 0), 0 = the
// maximum damage row, 99 = fail a <=30% secondary check.
const NO_CRIT_MAX_ROLL = [0, 5, 0, 5, 0, 5]
const NO_CRIT_MAX_ROLL_LONG = [0, 5, 0, 5, 0, 5, 0, 5]

describe('Cmd_attackcanceler sets up the Parental Bond family (battle_script_commands.c:1082-1091)', () => {
  it('Hyper Aggressive: 2 hits at 1.0x / 0.25x, and every counter is 0 again afterwards', () => {
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, atk: 200, moves: slot('MOVE_MEGA_PUNCH'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 300, maxHp: 300 }],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    const act = out.actions.find((a) => a.battlerId === 0)!

    expect(damage.hits.map((h) => h.hitIndex)).toEqual([0, 1])
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH, MEGA_PUNCH_Q])
    expect(act.targetDamage).toBe(MEGA_PUNCH + MEGA_PUNCH_Q) // 118
    expect(state.battlers[1]!.mon.hp).toBe(300 - 118)
    // MOVEEND_MULTIHIT_MOVE (:4898-4906) clears them once the loop ends.
    expect(state.battlers[0]!.turn.multiHitCounter).toBe(0)
    expect(state.battlers[0]!.turn.parentalBondOn).toBe(0)
    expect(state.battlers[0]!.turn.parentalBondInitialCount).toBe(0)
  })

  it('the same move without a Parental Bond ability is one unscaled hit (the control for the 94 above)', () => {
    const rng = scriptedRng([0, 5, 0])
    const state = battle([{ types: WATER, atk: 200, moves: slot('MOVE_MEGA_PUNCH'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 300, maxHp: 300 }], rng)
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH])
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(MEGA_PUNCH)
  })

  it('Dual Wield on a bullet move: BOTH hits are 0.7x (GetParentalBondMultiplier puts no REQUIRE(turn) on that case, battle_util.c:7483-7484)', () => {
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [
        { abilities: hasAbility('ABILITY_DUAL_WIELD'), types: WATER, atk: 200, moves: slot('MOVE_AURA_FORCE'), pp: pps, hp: 300, maxHp: 300 },
        { types: WATER, hp: 300, maxHp: 300 },
      ],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_AURA_FORCE')), null], testDeps(damage))
    expect(damage.hits.map((h) => h.damage)).toEqual([AURA_FORCE_DUAL, AURA_FORCE_DUAL])
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(2 * AURA_FORCE_DUAL) // 98
  })

  it('Multi Headed with a 3-head species: 3 hits at 1.0x / 0.2x / 0.15x (battle_util.c:7468-7473, GetParentalBondCount :1010-1015)', () => {
    // species.json's SPECIES_DODRIO has heads: 3, which is what
    // ABILITY_MULTI_HEADED's onParentalBond turns into THREE_HEADED.
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL_LONG])
    const state = battle(
      [
        { speciesId: 'SPECIES_DODRIO', abilities: hasAbility('ABILITY_MULTI_HEADED'), types: WATER, atk: 200, moves: slot('MOVE_MEGA_PUNCH'), pp: pps, hp: 300, maxHp: 300 },
        { types: FIGHTING, hp: 300, maxHp: 300 },
      ],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH, MEGA_PUNCH_FIFTH, MEGA_PUNCH_FIFTEENTH])
    expect(damage.hits.map((h) => h.hitIndex)).toEqual([0, 1, 2])
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(MEGA_PUNCH + MEGA_PUNCH_FIFTH + MEGA_PUNCH_FIFTEENTH) // 127
  })
})

// -----------------------------------------------------------------------------
// Minion Control: GetParentalBondCount's live party scan (battle_script_commands.c:1020-1041)
// -----------------------------------------------------------------------------

function partyMon(speciesId: string | null, hp: number, status1 = 0): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

describe('Minion Control (battle_script_commands.c:1020-1041, battle_util.c:7483-7490)', () => {
  const MINION = hasAbility('ABILITY_MINION_CONTROL')
  const minionBattle = (party: SimPartyMon[], rng: RandomSource) =>
    battle(
      [{ abilities: MINION, types: WATER, atk: 200, moves: slot('MOVE_MEGA_PUNCH'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 300, maxHp: 300 }],
      rng,
      party,
    )

  it('count = 1 + every OTHER eligible party mon: 3 hits, both bonus hits at 0.1x', () => {
    // party[1] and party[2] are eligible and counted; party[3] is fainted (hp 0)
    // and party[4] carries a status1, so both are skipped (:1031-1040).
    const party = [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 0), partyMon('SPECIES_MUDKIP', 100, 8)]
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL_LONG])
    const state = minionBattle(party, rng)
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    expect(state.battlers[0]!.turn.multiHitCounter).toBe(0) // cleared by the end of the loop
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH, MEGA_PUNCH_TENTH, MEGA_PUNCH_TENTH])
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(MEGA_PUNCH + 2 * MEGA_PUNCH_TENTH) // 112
    expect(state.battlers[1]!.mon.hp).toBe(300 - 112)
  })

  it('only ONE other eligible party mon: count 2, so exactly one 0.1x bonus hit', () => {
    const party = [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon(null, 0), partyMon('SPECIES_MUDKIP', 0)]
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = minionBattle(party, rng)
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH, MEGA_PUNCH_TENTH])
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(MEGA_PUNCH + MEGA_PUNCH_TENTH) // 103
  })
})

// -----------------------------------------------------------------------------
// Negative cases: the setup must NOT set a counter
// -----------------------------------------------------------------------------

describe('Parental Bond setup negatives (all of Cmd_attackcanceler, :1082-1091)', () => {
  function turnAfter(moveData: SimMoveData, attackerAbility: string, defenderAbility: string | null = null, innates: [string | null, string | null, string | null] = [null, null, null], attackerTypes: [string, string, string] = WATER) {
    const state = battle(
      [
        { abilities: { ability: attackerAbility, innates }, types: attackerTypes, moves: slot(moveData.id), pp: pps },
        { abilities: { ability: defenderAbility, innates: [null, null, null] }, hp: 200, maxHp: 200 },
      ],
      scriptedRng([0, 0, 0, 0]),
    )
    const result = runAttackCanceller(state, 0, 1, moveData.id, moveData, [])
    expect(result.cancelledBy).toBeNull()
    return state.battlers[0]!.turn
  }

  it('a STATUS move is never eligible (IsMoveAffectedByParentalBond, :13165)', () => {
    const turn = turnAfter(move('MOVE_SWORDS_DANCE'), 'ABILITY_PARENTAL_BOND')
    expect(turn.multiHitCounter).toBe(0)
    expect(turn.parentalBondTrigger).toBeNull()
  })

  it('a noParentalBond-flagged move is never eligible (:13166)', () => {
    const tackle = move('MOVE_TACKLE')
    const flagged: SimMoveData = { ...tackle, flags: { ...tackle.flags, noParentalBond: true as const } }
    const turn = turnAfter(flagged, 'ABILITY_PARENTAL_BOND')
    expect(turn.multiHitCounter).toBe(0)
    expect(turn.parentalBondTrigger).toBeNull()
  })

  it('a two-turn move without Accelerate is not eligible (:13169-13183)', () => {
    const turn = turnAfter(move('MOVE_FLY'), 'ABILITY_PARENTAL_BOND')
    expect(turn.multiHitCounter).toBe(0)
    expect(turn.parentalBondTrigger).toBeNull()
  })

  it('the same two-turn move WITH Accelerate in an innate slot IS eligible, so the counter is set', () => {
    const turn = turnAfter(move('MOVE_FLY'), 'ABILITY_PARENTAL_BOND', null, [null, null, 'ABILITY_ACCELERATE'])
    expect(turn.multiHitCounter).toBe(2)
    expect(turn.parentalBondOn).toBe(2)
    expect(turn.parentalBondInitialCount).toBe(2)
    expect(turn.parentalBondTrigger).toBe('ABILITY_HYPER_AGGRESSIVE')
  })

  it('a move that is multi-hit on its own keeps its own count and gets no bonus hit', () => {
    // The setup block only runs when multiHitCounter is still 0 (:1083), exactly
    // like the C, so CANCELLER_MULTIHIT_MOVES' own count wins.
    const doubleHit = turnAfter(move('MOVE_DOUBLE_HIT'), 'ABILITY_PARENTAL_BOND')
    expect(doubleHit.multiHitCounter).toBe(2)
    expect(doubleHit.parentalBondOn).toBe(0)

    // EFFECT_MULTI_HIT draws its 2-5 count (battle_util.c:3516-3522), so the rng
    // script above decides the number; only "a real count, no bonus hit" matters.
    const multiHit = turnAfter(move('MOVE_BULLET_SEED'), 'ABILITY_PARENTAL_BOND')
    expect(multiHit.multiHitCounter).toBeGreaterThanOrEqual(2)
    expect(multiHit.parentalBondOn).toBe(0)
  })

  it('Unrelenting resolves to TWO_TO_FIVE, which GetParentalBondCount has no case for, so the count is 1 (:1011-1043)', () => {
    const turn = turnAfter(move('MOVE_MEGA_PUNCH'), 'ABILITY_UNRELENTING')
    expect(turn.parentalBondTrigger).toBe('ABILITY_TWO_TO_FIVE')
    expect(turn.multiHitCounter).toBe(0)
  })

  it('Fort Knox stops a trigger that does not declare resistsFortKnox (:994-1002)', () => {
    // ABILITY_DUAL_WIELD has no resistsFortKnox flag; ABILITY_PARENTAL_BOND does.
    const blocked = turnAfter(move('MOVE_AURA_FORCE'), 'ABILITY_DUAL_WIELD', 'ABILITY_FORT_KNOX')
    expect(blocked.multiHitCounter).toBe(0)
    const through = turnAfter(move('MOVE_MEGA_PUNCH'), 'ABILITY_PARENTAL_BOND', 'ABILITY_FORT_KNOX')
    expect(through.multiHitCounter).toBe(2)
  })
})

// -----------------------------------------------------------------------------
// The loop's own per-hit consumers
// -----------------------------------------------------------------------------

describe('Per-hit consumers of parentalBondOn', () => {
  it('a target that faints on hit 0 takes no bonus hit, and the counters are cleared (c:4898-4906)', () => {
    const rng = scriptedRng([0, 5, 0, 5])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, atk: 200, moves: slot('MOVE_MEGA_PUNCH'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 60, maxHp: 60 }],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    const out = executeTurn(state, [useMove(1, move('MOVE_MEGA_PUNCH')), null], testDeps(damage))
    expect(damage.hits.map((h) => h.damage)).toEqual([MEGA_PUNCH]) // not 118
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(MEGA_PUNCH)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.turn.multiHitCounter).toBe(0)
    expect(state.battlers[0]!.turn.parentalBondOn).toBe(0)
    expect(state.battlers[0]!.turn.parentalBondInitialCount).toBe(0)
  })

  it('Night Shade (EFFECT_LEVEL_DAMAGE): the fixed damage is scaled by 0.25 on the bonus hit (c:10615-10624)', () => {
    // fixedDamageFor returns the attacker's level, 50. The bonus hit then runs
    // ApplyModifier(uq(0.25) = 256, 50) = floor((256*50+512)/1024) = 13.
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, moves: slot('MOVE_NIGHT_SHADE'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 300, maxHp: 300 }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, move('MOVE_NIGHT_SHADE')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(50 + 13) // 63
    expect(state.battlers[1]!.mon.hp).toBe(300 - 63)
  })

  it('Super Fang (EFFECT_SUPER_FANG): the half-HP damage is scaled by 0.25 on the bonus hit too', () => {
    // 300 HP target: hit 0 = 300/2 = 150, leaving 150. Hit 1 = 150/2 = 75, then
    // ApplyModifier(256, 75) = floor((19200+512)/1024) = 19 -- NOT 75.
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, moves: slot('MOVE_SUPER_FANG'), pp: pps, hp: 300, maxHp: 300 }, { types: FIGHTING, hp: 300, maxHp: 300 }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, move('MOVE_SUPER_FANG')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(150 + 19) // 169
    expect(state.battlers[1]!.mon.hp).toBe(300 - 169)
  })

  it('Endeavor is NOT scaled: Cmd_setdamagetohealthdifference never calls AdjustFixedDamageForParentalBond', () => {
    // Attacker 100 HP, target 150: hit 0 deals 150-100 = 50 and leaves the target
    // at 100, so hit 1's own difference is 0 (its script fails) and no 0.25x
    // scaling of the 50 is visible.
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, moves: slot('MOVE_ENDEAVOR'), pp: pps, hp: 100, maxHp: 100 }, { types: FIGHTING, hp: 150, maxHp: 300 }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, move('MOVE_ENDEAVOR')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(50)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('flinch is first-hit-only (GetMoveEffectChance, c:3073): the bonus hit rolls but the chance is 0', () => {
    // Bite is a 30% flinch. Draws: accuracy (0), hit-0 crit (5), hit-0 roll (0),
    // hit-0 secondary (99 -> 99 >= 30, no flinch), gCritRoll for the next hit (5),
    // hit-1 roll (0), hit-1 secondary (0 -> would flinch if the chance were still
    // 30), the gCritRoll MOVEEND stores after the last hit (5).
    const rng = scriptedRng([0, 5, 0, 99, 5, 0, 0])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, atk: 200, moves: slot('MOVE_BITE'), pp: pps, hp: 300, maxHp: 300 }, { types: WATER, hp: 300, maxHp: 300 }],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    executeTurn(state, [useMove(1, move('MOVE_BITE')), null], testDeps(damage))
    expect(damage.hits.length).toBe(2)
    expect(rng.calls).toBe(8) // the hit-1 secondary roll IS drawn (:3110 is Minion-Control-only)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
  })

  it('Rollout increments its counter once for the whole action (Cmd_handlerollout, c:11151-11167, "first hit only")', () => {
    // handlerollout runs between typecalc and damagecalc of BattleScript_EffectRollout,
    // i.e. once per ACTION, not once per hit; `parentalBondOn == parentalBondInitialCount`
    // is true only on the first hit.
    const rng = scriptedRng([...NO_CRIT_MAX_ROLL])
    const state = battle(
      [{ abilities: PARENTAL_BOND, types: WATER, atk: 200, moves: slot('MOVE_ROLLOUT'), pp: pps, hp: 300, maxHp: 300 }, { types: WATER, hp: 300, maxHp: 300 }],
      rng,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    executeTurn(state, [useMove(1, move('MOVE_ROLLOUT')), null], testDeps(damage))
    expect(damage.hits.length).toBe(2)
    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(1)
  })

  it('Minion Control skips the secondary-effect roll on bonus hits (c:3110-3112), so the RNG draw count is 9, not 11', () => {
    // Bite, 3 hits (party: active + two eligible). Draws: accuracy, hit-0 crit,
    // hit-0 roll, hit-0 secondary, gCritRoll, hit-1 roll, gCritRoll, hit-2 roll,
    // gCritRoll = 9. Without the :3110 no-op each bonus hit would also draw its
    // own `Random() % 100` (11 total).
    const party = [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]
    const rng = scriptedRng([0, 5, 0, 99, 5, 0, 5, 0, 5])
    const state = battle(
      [{ abilities: hasAbility('ABILITY_MINION_CONTROL'), types: WATER, atk: 200, moves: slot('MOVE_BITE'), pp: pps, hp: 300, maxHp: 300 }, { types: WATER, hp: 300, maxHp: 300 }],
      rng,
      party,
    )
    const damage = recordingResolver(bridgeDamage(rng))
    executeTurn(state, [useMove(1, move('MOVE_BITE')), null], testDeps(damage))
    expect(damage.hits.length).toBe(3)
    expect(rng.calls).toBe(9)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
  })
})
