/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 159: two C behaviours that had been gapped by name, now ported.
//
// 1. Cmd_accuracycheck's Anticipation miss branch,
//    src/battle_script_commands.c:1427-1432, as accuracyBridge.ts's
//    tryAnticipationMiss, called from each Cmd_accuracycheck else-branch site
//    in the same order the C has it (GetTotalAccuracy, then the branch, then
//    the `Random() % 100` roll). The branch is an `else if`, so a fired
//    Anticipation consumes NO Random() draw at all -- GetTotalAccuracy itself
//    draws nothing and the accuracy roll is skipped. The AI's copy at
//    battle_ai_main.c:727-730 scores the same condition -5 in aiCheckBadMove.
//
// 2. Mirror Armor stat-drop reflection, src/battle_script_commands.c:9811-9826,
//    inside ChangeStatBuffs's decrease branch, plus SetMoveEffect's
//    `flags |= STAT_BUFF_ALLOW_PTR` at :2773-2776 / :2804-2807. The reflection
//    is a recursed ChangeStatBuffs with
//    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED |
//    STAT_BUFF_ALLOW_PTR, guarded by BattleScript_MirrorArmorReflect's
//    `jumpifsubstituteblocks` (data/battle_scripts_1.s:3689-3694).
//
// Every number below is hand-derived in a comment. Attacks go through
// createBattleState + executeTurn; the single AI case calls aiCheckBadMove
// directly (this suite has no AI driver).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { MoveData } from '../calculate'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { createBridgeDamageResolver } from './damageResolver'
import { STAT_ATK, STAT_SPEED, STATUS2_SUBSTITUTE } from './constants'
import { getSingleUseAbilityCounter, setSingleUseAbilityCounter } from './switchInAbility'
import type { BridgeDeps } from './bridge'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckBadMove } from './ai/aiCheckBadMove'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures, the same shape cycle101Accuracy.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
/** natures.json is BattleConstants (natureStatTable, statStageRatios, criticalHitChance, ...). */
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never
const holdEffectIds = snapshot<Record<string, number>>('holdEffectIds.json')

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

/** The damage engine's own MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
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

type BattlerSpec = {
  spe?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
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
  })
}

/** A RandomSource that counts calls; `random16` returns values[calls-1] (0 past the end). */
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

/** A TurnLoopDeps carrying the REAL combat resolver, so tryAnticipationMiss's
 * CalcTypeEffectivenessMultiplier probe is the damage engine's own UQ_4_12 value
 * (computed with drawRandom=false: it consumes no RNG, leaving the accuracy and
 * damage draws exactly where the C expects them). */
function realDeps(rng: RandomSource): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const damage: DamageResolver = createBridgeDamageResolver({
    grounding: GROUNDING,
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
    moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    random: rng,
  })
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 20, 20]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})
const move = (id: string): SimMoveData => requireMove(id)

// Moves, with the snapshot facts each case leans on.
const CRACKLE = move('MOVE_CRACKLE_SLAM') // ELECTRIC, PHYSICAL, 70 power, accuracy 100, effect None
const AERIAL_ACE = move('MOVE_AERIAL_ACE') // FLYING, PHYSICAL, 60 power, accuracy 0 -> the 101 "cannot miss" sentinel
const SCARY_FACE = move('MOVE_SCARY_FACE') // STATUS, accuracy 100, EFFECT_SCARY_FACE (Speed -2)
const THUNDER_WAVE = move('MOVE_THUNDER_WAVE') // STATUS, accuracy 90, ELECTRIC, EFFECT_PARALYZE
const GROWL = move('MOVE_GROWL') // NORMAL, SPECIAL, 60 power, accuracy 100, EFFECT_ATTACK_DOWN_HIT (Atk -1, 100%)
const SUPERPOWER = move('MOVE_SUPERPOWER') // FIGHTING, PHYSICAL, 120 power, accuracy 100, user Atk/Def -1 (certain)
const WATER: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY'] // Electric is 2x, Fighting 1x, Normal 1x
const NORMAL_TYPES: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']
const GRASS: [string, string, string] = ['GRASS', 'MYSTERY', 'MYSTERY'] // Flying is 2x

const ANTICIPATION = ability('ABILITY_ANTICIPATION')
const MIRROR_ARMOR = ability('ABILITY_MIRROR_ARMOR')
const CRYSTALLINE = ability('ABILITY_CRYSTALLINE_ARMOR')

const stageOf = (state: BattleState, battlerId: number, stat: number): number => state.battlers[battlerId]!.mon.statStages[stat] ?? 6
const counterOf = (state: BattleState): number => getSingleUseAbilityCounter(state, 1, 'ABILITY_ANTICIPATION', DATA_CONTEXT)

// ---------------------------------------------------------------------------
// 1. Anticipation's accuracycheck branch
// ---------------------------------------------------------------------------

describe('cycle 159 - Cmd_accuracycheck Anticipation (battle_script_commands.c:1427-1432)', () => {
  it('a 2x move misses with no Random() draw at all', () => {
    // C: `if (accuracy <= 100 && BATTLER_HAS_ABILITY(target, ANTICIPATION) &&
    // !GetSingleUseAbilityCounter(target, ANTICIPATION) &&
    // CalcTypeEffectivenessMultiplier(...) >= UQ_4_12(2.0)) { set counter; MISSED; }
    // else if ((Random() % 100) >= accuracy) ...`. Accuracy is 100 (<= 100),
    // Electric vs Water is 2048 = UQ_4_12(2.0) (>= 2048), and the counter is 0,
    // so the branch fires and the `else if` roll never runs: rng.calls === 0.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: WATER, abilities: ANTICIPATION }], rng)
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, CRACKLE), null], deps)
    const action = out.actions[0]!
    expect(action.missed).toBe(true)
    expect(action.targetDamage).toBeNull()
    expect(rng.calls).toBe(0)
    expect(counterOf(state)).toBe(1) // SetSingleUseAbilityCounter(target, ANTICIPATION, TRUE)
    expect(action.unmodelled.some((u) => u.includes('Anticipation'))).toBe(false)
  })

  it('the next attack takes the ordinary roll (counter spent)', () => {
    // Turn 1: the branch fires (0 draws). Turn 2: GetSingleUseAbilityCounter is
    // 1, so the branch is skipped and the roll is drawn -- 3 draws for a hitting
    // effect-less physical move: accuracy (turn.ts) + crit + the 16-entry damage
    // roll (damageResolver.ts:203-218). Roll 0 < 100, so it hits.
    const rng = scriptedRng([0, 0, 0])
    const state = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: WATER, abilities: ANTICIPATION }], rng)
    const deps = realDeps(rng)

    const first = executeTurn(state, [useMove(1, CRACKLE), null], deps)
    expect(first.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(0)

    const second = executeTurn(state, [useMove(1, CRACKLE), null], deps)
    expect(second.actions[0]!.missed).toBe(false)
    expect(second.actions[0]!.targetDamage).not.toBeNull()
    expect(rng.calls).toBe(3)
  })

  it('does not fire on a neutral (1x) move', () => {
    // Electric vs Normal is 1024 = UQ_4_12(1.0) < 2048. The ordinary roll runs
    // (roll 0 < 100 -> hit) and the counter stays 0: 3 draws as above.
    const rng = scriptedRng([0, 0, 0])
    const state = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: NORMAL_TYPES, abilities: ANTICIPATION }], rng)
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, CRACKLE), null], deps)
    expect(out.actions[0]!.missed).toBe(false)
    expect(rng.calls).toBe(3)
    expect(counterOf(state)).toBe(0)
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('Anticipation'))).toBe(false)
  })

  it('does not fire at accuracy 101 ("cannot miss")', () => {
    // Aerial Ace's data accuracy is 0, which GetTotalAccuracy turns into the 101
    // sentinel (ACCURACY_HITS_IF_POSSIBLE). `accuracy <= 100` is false, so the
    // branch cannot fire even though Flying vs Grass is 2x, and the roll is
    // still drawn. Aerial Ace's `crit: ALWAYS` makes the damage resolver take
    // the `denominator === 1` path without a crit draw, so the draws are
    // accuracy + the 16-entry damage roll = 2; `Random() % 100` (<= 99) never
    // reaches 101, so it hits.
    const rng = scriptedRng([0, 0])
    const state = battle([{ moves: slot(AERIAL_ACE.id), pp: pps }, { types: GRASS, abilities: ANTICIPATION }], rng)
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, AERIAL_ACE), null], deps)
    expect(out.actions[0]!.missed).toBe(false)
    expect(rng.calls).toBe(2)
    expect(counterOf(state)).toBe(0)
  })

  it('never fires on a status move (CalcTypeEffectivenessMultiplier flattens to 1.0)', () => {
    // Thunder Wave is STATUS. Cmd_accuracycheck's branch does not test the
    // split, so the C reaches CalcTypeEffectivenessMultiplier, which forces
    // SPLIT_STATUS back to UQ_4_12(1.0) (battle_util.c:7992) -- under 2.0,
    // never a trigger even though Electric vs Water is otherwise 2x. The
    // accuracy roll (1 draw, paralysis itself draws nothing) lands and the
    // counter stays 0.
    const rng = scriptedRng([0])
    const state = battle([{ moves: slot(THUNDER_WAVE.id), pp: pps }, { types: WATER, abilities: ANTICIPATION }], rng)
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, THUNDER_WAVE), null], deps)
    expect(out.actions[0]!.missed).toBe(false)
    expect(rng.calls).toBe(1)
    expect(out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
    expect(counterOf(state)).toBe(0)
  })

  it('a Mold Breaker attacker ignores the defender\'s Anticipation', () => {
    // BATTLER_HAS_ABILITY is BattlerHasAbility(..., TRUE) (include/battle_util.h:73),
    // i.e. mold-breaker aware. Mold Breaker on the attacker suppresses the
    // defender's Anticipation, so the branch is false and the ordinary roll runs:
    // 3 draws, hit on roll 0, counter stays 0.
    const rng = scriptedRng([0, 0, 0])
    const state = battle(
      [{ moves: slot(CRACKLE.id), pp: pps, abilities: ability('ABILITY_MOLD_BREAKER') }, { types: WATER, abilities: ANTICIPATION }],
      rng,
    )
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, CRACKLE), null], deps)
    expect(out.actions[0]!.missed).toBe(false)
    expect(rng.calls).toBe(3)
    expect(counterOf(state)).toBe(0)
  })

  it('AI_CheckBadMove scores it -5 (battle_ai_main.c:727-730)', () => {
    // C: `if (BATTLER_HAS_ABILITY(def, ANTICIPATION) && !GetSingleUseAbilityCounter(def, ANTICIPATION) &&
    // CalcTypeEffectivenessMultiplier(...) >= UQ_4_12(2.0) && GetTotalAccuracy(...) <= 100)
    // RETURN_SCORE_MINUS(5);`
    // The AI's effectiveness enum maps 2048 to AI_EFFECTIVENESS_x2 = 5, so the
    // `>= 5` test below is the same threshold; accuracy is 100.
    const aiDeps: AiDamageDeps = {
      grounding: GROUNDING,
      turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
      statStageRatios: RATIOS,
      dataContext: DATA_CONTEXT,
      inverseBattle: false,
      moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
      typeChart,
      inverseTypeChart,
      moveBehaviors,
      battleConstants,
      holdEffectIds,
    } satisfies AiDamageDeps & BridgeDeps

    const withAnticipation = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: WATER, abilities: ANTICIPATION }], scriptedRng([]))
    const scored = aiCheckBadMove(withAnticipation, 0, 1, CRACKLE.id, 100, aiDeps)
    expect(scored.score).toBe(95) // 100 - 5
    expect(scored.unmodelled.some((u) => u.includes('Anticipation'))).toBe(false)

    // Counter already spent: no penalty.
    setSingleUseAbilityCounter(withAnticipation, 1, 'ABILITY_ANTICIPATION', 1, DATA_CONTEXT)
    expect(aiCheckBadMove(withAnticipation, 0, 1, CRACKLE.id, 100, aiDeps).score).toBe(100)

    // Neutral target: 1024 -> AI_EFFECTIVENESS_x1 = 4, below the x2 threshold.
    const neutral = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: NORMAL_TYPES, abilities: ANTICIPATION }], scriptedRng([]))
    expect(aiCheckBadMove(neutral, 0, 1, CRACKLE.id, 100, aiDeps).score).toBe(100)

    // No Anticipation at all.
    const plain = battle([{ moves: slot(CRACKLE.id), pp: pps }, { types: WATER }], scriptedRng([]))
    expect(aiCheckBadMove(plain, 0, 1, CRACKLE.id, 100, aiDeps).score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 2. Mirror Armor reflection
// ---------------------------------------------------------------------------

describe('cycle 159 - Mirror Armor stat-drop reflection (battle_script_commands.c:9811-9826)', () => {
  it('a Growl-class drop lands on the attacker instead of the holder', () => {
    // ER's Growl is a 60-power SPECIAL move whose secondary effect is
    // MOVE_EFFECT_ATK_MINUS_1 at 100% (EFFECT_ATTACK_DOWN_HIT). SetMoveEffect's
    // MINUS_1 case (:2773-2776) adds STAT_BUFF_ALLOW_PTR because the target has
    // Mirror Armor, so ChangeStatBuffs's pointer shape (:9813-9819) fires:
    // BattleScript_MirrorArmorReflect recurses with AFFECTS_USER, and the
    // ATTACKER's Attack falls 6 -> 5 while the holder's stays 6.
    // Draws: accuracy + crit + damage roll + the 100% secondary chance = 4.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([{ moves: slot(GROWL.id), pp: pps }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR }], rng)
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, GROWL), null], deps)
    const action = out.actions[0]!
    expect(rng.calls).toBe(4)
    expect(stageOf(state, 0, STAT_ATK)).toBe(5) // 6 - 1: the reflected drop
    expect(stageOf(state, 1, STAT_ATK)).toBe(6) // the holder never changes
    expect(action.statChanges).toContainEqual({ battlerId: 0, stat: STAT_ATK, change: -1 })
    expect(action.unmodelled.some((u) => u.includes('Mirror Armor'))).toBe(false)
  })

  it('Crystalline Armor reflects identically', () => {
    // HasMirrorArmor (battle_util.c:9335-9338) is RETURN_ABILITY_IF_FLAG(mirrorArmor);
    // this sim's hasMirrorArmor accepts ABILITY_CRYSTALLINE_ARMOR for the same
    // flag, and hazards.test.ts pins that list against abilitiesWithBitfield.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([{ moves: slot(GROWL.id), pp: pps }, { types: NORMAL_TYPES, abilities: CRYSTALLINE }], rng)
    const deps = realDeps(rng)

    executeTurn(state, [useMove(1, GROWL), null], deps)
    expect(stageOf(state, 0, STAT_ATK)).toBe(5)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
  })

  it('Scary Face\'s -2 is reflected in full', () => {
    // Scary Face is a STATUS move (no crit/damage/secondary draws: 1 accuracy
    // draw). Its -2 Speed drop reaches BattleScript_EffectScaryFace_Fear's
    // statbuffchange STAT_BUFF_ALLOW_PTR (:12057), so the pointer shape fires:
    // the attacker's Speed falls 6 -> 4.
    const rng = scriptedRng([0])
    const state = battle([{ moves: slot(SCARY_FACE.id), pp: pps }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR }], rng)
    const deps = realDeps(rng)

    executeTurn(state, [useMove(1, SCARY_FACE), null], deps)
    expect(rng.calls).toBe(1)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(4)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
  })

  it('a Contrary holder rises instead of reflecting', () => {
    // ChangeStatBuffs flips statValue under Contrary BEFORE the decrease branch
    // (:9749-9752), so -1 becomes +1 and the drop is an increase: the holder's
    // Attack rises 6 -> 7, the Mirror Armor branch is never reached and the
    // attacker keeps stage 6.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle(
      [{ moves: slot(GROWL.id), pp: pps }, { types: NORMAL_TYPES, abilities: ability('ABILITY_MIRROR_ARMOR', 'ABILITY_CONTRARY') }],
      rng,
    )
    const deps = realDeps(rng)

    executeTurn(state, [useMove(1, GROWL), null], deps)
    expect(stageOf(state, 1, STAT_ATK)).toBe(7) // 6 + 1
    expect(stageOf(state, 0, STAT_ATK)).toBe(6)
  })

  it('a Clear Body attacker blocks the reflected drop', () => {
    // The recursed ChangeStatBuffs runs on the attacker with affectsUser TRUE,
    // and GetStatDropBlock's Clear Body answer ('ALL') does not depend on
    // affectsUser, so the reflected -1 is blocked: nobody loses a stage.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle(
      [{ moves: slot(GROWL.id), pp: pps, abilities: ability('ABILITY_CLEAR_BODY') }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR }],
      rng,
    )
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, GROWL), null], deps)
    expect(stageOf(state, 0, STAT_ATK)).toBe(6)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(out.actions[0]!.statChanges).not.toContainEqual({ battlerId: 0, stat: STAT_ATK, change: -1 })
  })

  it('a Substitute on the holder swallows the reflection (jumpifsubstituteblocks)', () => {
    // BattleScript_MirrorArmorReflect:3689-3692 runs `jumpifsubstituteblocks`
    // before the recursed statbuffchange, so a Substitute absorbs the whole
    // reflection: neither side's Speed moves. Scary Face has no earlier
    // substitute check in its own script, so this exercises ChangeStatBuffs's
    // own guard.
    const rng = scriptedRng([0])
    const state = battle(
      [{ moves: slot(SCARY_FACE.id), pp: pps }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR, status2: STATUS2_SUBSTITUTE }],
      rng,
    )
    const deps = realDeps(rng)

    executeTurn(state, [useMove(1, SCARY_FACE), null], deps)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(6)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
  })

  it('a self-drop is never reflected', () => {
    // Superpower's script is `setmoveeffect MOVE_EFFECT_ATK_DEF_DOWN |
    // MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN`, so its -1/-1 run with
    // AFFECTS_USER: `!affectsUser` is false and battler == attacker, so
    // ChangeStatBuffs's Mirror Armor branch (:9811) cannot fire even though the
    // target holds the ability. Draws: accuracy + crit + damage (the certain
    // effect draws no chance roll) = 3. The attacker's Attack and Defence fall
    // 6 -> 5; the holder keeps 6/6.
    const rng = scriptedRng([0, 0, 0])
    const state = battle([{ moves: slot(SUPERPOWER.id), pp: pps }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR }], rng)
    const deps = realDeps(rng)

    executeTurn(state, [useMove(1, SUPERPOWER), null], deps)
    expect(rng.calls).toBe(3)
    expect(stageOf(state, 0, STAT_ATK)).toBe(5)
    expect(stageOf(state, 0, 2)).toBe(5) // STAT_DEF = 2
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
  })

  it('a reflected drop onto a minimum-stage attacker clamps to no change', () => {
    // The attacker's Attack is already 0 = MIN_STAT_STAGE. The recursed
    // ChangeStatBuffs computes max(statValue, -stage) = max(-1, 0) = 0
    // (:9843), so the chooser is B_MSG_STAT_WONT_DECREASE and delta is 0:
    // both stages stay 0 (attacker) / 6 (holder) and no -1 is reported.
    const rng = scriptedRng([0, 0, 0, 0])
    const state = battle([{ moves: slot(GROWL.id), pp: pps }, { types: NORMAL_TYPES, abilities: MIRROR_ARMOR }], rng)
    // createBattlerState always resets statStages to DEFAULT_STAT_STAGE (create.ts:375),
    // so the minimum stage is written after the state exists.
    state.battlers[0]!.mon.statStages[STAT_ATK] = 0
    const deps = realDeps(rng)

    const out = executeTurn(state, [useMove(1, GROWL), null], deps)
    expect(stageOf(state, 0, STAT_ATK)).toBe(0)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(out.actions[0]!.statChanges).not.toContainEqual({ battlerId: 0, stat: STAT_ATK, change: -1 })
  })
})
