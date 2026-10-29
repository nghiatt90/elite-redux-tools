/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 104b -- the onModifyEffectChance and onReactive hooks.
//
// Hand-derived from the pinned upstream C:
// - GetMoveEffectChance, src/battle_script_commands.c:3071-3090: FLINCH guard, then
//   ON_ABILITY(abilityBattler, TRUE, gAbilities[ability].onModifyEffectChance != NULL, ...) over every
//   battler, then the rainbow-timer doubling (:3087-3088) and the MathMin(chance, 100) cap (:3089).
// - ON_ABILITY walks slots in reverse (include/battle_util.h:269-275), so the slot order is observable
//   through Corrupted Mind's integer `*= 1.4` truncation (abilities.cc:9469).
// - IsApplyOnFlagAppropriate (abilities.cc:190-197): `onModifyEffectChanceFor` defaults to APPLY_ON_SELF
//   (include/abilities.hh:142, 236), so the 12 non-Bad-Luck hooks only fire for the attacker; Bad Luck is
//   APPLY_ON_FOE (abilities.cc:4315). See the sim's getMoveEffectChance (statusEffects.ts).
// - AbilityBattleEffects(ABILITYEFFECT_REACTIVE, ...), src/battle_util.c:4733-4774: Mirror Herb scan and
//   the onReactive pass gated on STAT_STAGE_CHECK_NEEDED, but the `for (i = 0; i < gBattlersCount; i++)`
//   onReactive loop itself runs unconditionally (:4765-4768).
// - PoisonPuppeteerClone, src/abilities.cc:286-312: clear the armed byte before scanning targets.
// - Egoist, src/abilities.cc:7074-7092 and VARIOUS_DO_COPY_STAT_CHANGE, battle_script_commands.c:8202-8241.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ReplacementDeps } from './switchIn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  MOVE_EFFECT_SP_DEF_MINUS_1,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_PARALYSIS,
  STATUS2_FLINCHED,
  STATUS2_INFATUATION,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STAT_STAGE_CHECK_NEEDED,
  STAT_STAGE_CHECK_NOT_NEEDED,
  statusInfatuatedWith,
} from './constants'
import {
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_FROSTBITE,
  getMoveEffectChance,
} from './statusEffects'
import type { StatusDeps } from './statusEffects'
import { runReactiveAbilityEffects } from './statBuffs'
import { dispatchOnBattlerFaints } from './moveEnd'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle104Hooks.test.ts uses.
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
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
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

const STATUS_DEPS: StatusDeps = { dataContext: DATA_CONTEXT, grounding: GROUNDING }
const REACTIVE_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

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

function battle(
  specs: BattlerSpec[],
  rng: RandomSource,
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

function scripted(...values: number[]): RandomSource & { calls: number } {
  let i = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[i++] ?? 0
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

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function deps(damage: DamageResolver = fixedDamage(0), replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

const stageOf = (state: BattleState, battlerId: number, stat: number): number =>
  state.battlers[battlerId]?.mon.statStages[stat] ?? DEFAULT_STAT_STAGE

// ---------------------------------------------------------------------------
// A. onModifyEffectChance (GetMoveEffectChance, battle_script_commands.c:3071-3090)
// ---------------------------------------------------------------------------

describe('cycle 104b - onModifyEffectChance (battle_script_commands.c:3071-3090)', () => {
  it('Serene Grace doubles the chance and the final value is capped at 100', () => {
    // :3071-3090 -- `effectChance *= 2` (abilities.cc:892, Lucky Wings aliases it), then
    // `MathMin(effectChance, 100)` (:3089).
    const base10 = battle([{ abilities: ability('ABILITY_SERENE_GRACE') }, {}], scripted())
    expect(getMoveEffectChance(base10, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(20)
    const base30 = battle([{ abilities: ability('ABILITY_SERENE_GRACE') }, {}], scripted())
    expect(getMoveEffectChance(base30, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 30, STATUS_DEPS)).toBe(60)
    const base60 = battle([{ abilities: ability('ABILITY_SERENE_GRACE') }, {}], scripted())
    expect(getMoveEffectChance(base60, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 60, STATUS_DEPS)).toBe(100)
  })

  it('Pyromancy multiplies burn by 5 and leaves a flinch chance alone', () => {
    // abilities.cc:3666 -- Pyromancy (Chandelier aliases it) only touches MOVE_EFFECT_BURN.
    const state = battle([{ abilities: ability('ABILITY_PYROMANCY') }, {}], scripted())
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(50)
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_FLINCH, 10, STATUS_DEPS)).toBe(10)
  })

  it('Thermomancy multiplies burn and frostbite by 5 and leaves a flinch chance alone', () => {
    // abilities.cc:10433-10438 -- delegates to Cryomancy for frostbite then Pyromancy for burn,
    // so exactly one branch can fire per effect.
    const state = battle([{ abilities: ability('ABILITY_THERMOMANCY') }, {}], scripted())
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(50)
    expect(getMoveEffectChance(state, 0, 'MOVE_ICE_PUNCH', MOVE_EFFECT_FROSTBITE, 10, STATUS_DEPS)).toBe(50)
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_FLINCH, 10, STATUS_DEPS)).toBe(10)
  })

  it('Precise Fist and Way of Precision multiply a punch move by 5 only', () => {
    // abilities.cc:4762 -- `IsIronFistBoosted(move) ? effectChance * 5 : effectChance`; the sim reads
    // flags.punchBased (see the unmodelled note in statusEffects.ts).
    const fist = battle([{ abilities: ability('ABILITY_PRECISE_FIST') }, {}], scripted())
    expect(getMoveEffectChance(fist, 0, 'MOVE_FIRE_PUNCH', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(50)
    expect(getMoveEffectChance(fist, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(10)
    const wop = battle([{ abilities: ability('ABILITY_WAY_OF_PRECISION') }, {}], scripted())
    expect(getMoveEffectChance(wop, 0, 'MOVE_FIRE_PUNCH', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(50)
    expect(getMoveEffectChance(wop, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(10)
  })

  it('a target-held Serene Grace does not apply (onModifyEffectChanceFor defaults to APPLY_ON_SELF)', () => {
    // abilities.hh:236 `onModifyEffectChanceFor` defaults to 0 = APPLY_ON_SELF; IsApplyOnFlagAppropriate
    // (abilities.cc:190-197) then requires context == source, so the hook never runs for the target.
    const state = battle([{}, { abilities: ability('ABILITY_SERENE_GRACE') }], scripted())
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(10)
  })

  it('Serene Grace as an innate stacks with a Pyromancy ability: 10 -> 50 -> 100', () => {
    const state = battle([{ abilities: ability('ABILITY_SERENE_GRACE', 'ABILITY_PYROMANCY') }, {}], scripted())
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, STATUS_DEPS)).toBe(100)
  })

  it('uses ON_ABILITY slot order (reverse: innate 3 -> ability) before the rainbow doubling', () => {
    // Reverse order: Serene Grace (innate slot 1) doubles 2 to 4, then Corrupted Mind rounds 4 * 1.4 down
    // to 5. Forward order would give floor(2 * 1.4) = 2 then * 2 = 4, so 5 proves the C's order.
    const reverse = battle([{ abilities: ability('ABILITY_CORRUPTED_MIND', 'ABILITY_SERENE_GRACE') }, {}], scripted())
    expect(getMoveEffectChance(reverse, 0, 'MOVE_PSYCHIC', MOVE_EFFECT_SP_DEF_MINUS_1, 2, STATUS_DEPS)).toBe(5)
  })

  it('applies the rainbow timer after the ability multiplications (Bad Luck sees the boosted value)', () => {
    // :3082-3088 -- the ON_ABILITY loop runs first; the rainbow doubling (:3087-3088) is afterwards, so
    // Bad Luck's `if (effectChance < 100) effectChance = 0` (abilities.cc:4315) reads the undoubled 50.
    const state = battle([{}, { abilities: ability('ABILITY_BAD_LUCK') }], scripted())
    state.sides[0]!.timers.rainbowTimer = 2
    expect(getMoveEffectChance(state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 50, STATUS_DEPS)).toBe(0)
    // Control: the same 50 without Bad Luck is doubled to 100.
    const control = battle([{}, {}], scripted())
    control.sides[0]!.timers.rainbowTimer = 2
    expect(getMoveEffectChance(control, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 50, STATUS_DEPS)).toBe(100)
  })

  it('a real turn: Serene Grace lifts Body Slam paralysis from 30 to 60 (roll 45 lands, roll 70 does not)', () => {
    // Draw order per damaging move: accuracy (:419) then the chance draw (:11900). Body Slam is
    // EFFECT_PARALYZE_HIT with effectChance 30 (moves.json).
    const hit = battle(
      [{ spe: 200, abilities: ability('ABILITY_SERENE_GRACE'), moves: slot('MOVE_BODY_SLAM'), pp: pps }, { spe: 50 }],
      scripted(0, 45, 0),
    )
    executeTurn(hit, [useMove(1, move('MOVE_BODY_SLAM')), useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(10)))
    expect(hit.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)

    const miss = battle(
      [{ spe: 200, abilities: ability('ABILITY_SERENE_GRACE'), moves: slot('MOVE_BODY_SLAM'), pp: pps }, { spe: 50 }],
      scripted(0, 70, 0),
    )
    executeTurn(miss, [useMove(1, move('MOVE_BODY_SLAM')), useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(10)))
    expect(miss.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B1. Egoist (onReactive, abilities.cc:7074-7092 -> VARIOUS_DO_COPY_STAT_CHANGE,
//     battle_script_commands.c:8202-8241)
// ---------------------------------------------------------------------------

describe('cycle 104b - Egoist copies positive foe stat changes (abilities.cc:7074-7092)', () => {
  it('copies a foe Work Up: the holder gains +1 Atk and +1 SpAtk', () => {
    // :8209-8240 -- `s8 change = 0` accumulates every opponent's positive value per stat, then
    // ChangeStatBuffs(change, stat, MOVE_EFFECT_AFFECTS_USER). Work Up raises Atk and SpAtk by 1.
    const state = battle(
      [{ abilities: ability('ABILITY_EGOIST'), spe: 50 }, { moves: slot('MOVE_WORK_UP'), pp: pps, spe: 100 }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(1, move('MOVE_WORK_UP'))], deps(fixedDamage(5)))

    expect(stageOf(state, 1, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stageOf(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE + 1)
    // The recorded changes were consumed and the state machine is back to rest (:8306-8307).
    expect(state.statStageCheckState).toBe(STAT_STAGE_CHECK_NOT_NEEDED)
  })

  it('does not copy its own side or a negative change', () => {
    const ownSide = battle([{ abilities: ability('ABILITY_EGOIST') }, {}], scripted())
    ownSide.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    ownSide.statChangesToCheck[0]![STAT_ATK - 1] = 2
    expect(runReactiveAbilityEffects(ownSide, REACTIVE_DEPS, [])).toBe(false)
    expect(stageOf(ownSide, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)

    const drop = battle([{ abilities: ability('ABILITY_EGOIST') }, {}], scripted())
    drop.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    drop.statChangesToCheck[1]![STAT_ATK - 1] = -1
    expect(runReactiveAbilityEffects(drop, REACTIVE_DEPS, [])).toBe(false)
    expect(stageOf(drop, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)
  })

  it('detection ignores the Evasion slot (ARRAY_COUNT(statChangesToCheck[opponent]) = 7)', () => {
    // abilities.cc:7080 scans `stat < 7` (include/battle.h:727), so a positive Evasion change at
    // statChangesToCheck[opp][6] does not arm Egoist; the copy pass (:8209) would have included it.
    const state = battle([{ abilities: ability('ABILITY_EGOIST') }, {}], scripted())
    state.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    state.statChangesToCheck[1]![STAT_EVASION - 1] = 1
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(stageOf(state, 0, STAT_EVASION)).toBe(DEFAULT_STAT_STAGE)
  })

  it('a copy refused at +6 carries over to the next stat (s8 change is only reset on success)', () => {
    // battle_script_commands.c:8209 declares `s8 change` outside the stat loop and resets it only in the
    // branch that actually changed the stage, so a refused Atk copy leaves the +1 to be applied to Def.
    const state = battle([{ abilities: ability('ABILITY_EGOIST') }, {}], scripted())
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    state.statChangesToCheck[1]![STAT_ATK - 1] = 1

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(true)
    expect(stageOf(state, 0, STAT_ATK)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_DEF)).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

// ---------------------------------------------------------------------------
// B2. PoisonPuppeteerClone (abilities.cc:286-312) for the setStateOnEffect abilities
// ---------------------------------------------------------------------------

describe('cycle 104b - PoisonPuppeteerClone (abilities.cc:286-312)', () => {
  it('Chokehold paralyzes the wrapped foe on the next onReactive pass, then clears its byte', () => {
    // End to end: Wrap arms the bit through SetOnMoveEffectReactionFlags (battle_script_commands.c:2735),
    // and the onReactive pass at the end of the same action consumes it (battle_util.c:4765-4768).
    const state = battle(
      [{ abilities: ability('ABILITY_CHOKEHOLD'), moves: slot('MOVE_WRAP'), pp: pps, spe: 200 }, { spe: 50 }],
      scripted(0, 0, 0, 0),
    )
    executeTurn(state, [useMove(1, move('MOVE_WRAP')), useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(3)))

    expect(state.battlers[1]!.mon.status2 & STATUS2_WRAPPED).toBe(STATUS2_WRAPPED)
    expect(state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Chokehold does nothing when CanBeParalyzed fails, but still consumes the byte', () => {
    // The predicate is CanBeParalyzed(battler, target) (abilities.cc:12090); SetAbilityState(battler, 0)
    // runs before the target loop, so a failed predicate still clears the armed bit (:291-293).
    const state = battle(
      [{ abilities: ability('ABILITY_CHOKEHOLD') }, { types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'] }],
      scripted(),
    )
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Chokehold skips a fainted target', () => {
    // FILTER(IsBattlerAlive(target)) (:297).
    const state = battle([{ abilities: ability('ABILITY_CHOKEHOLD') }, { hp: 0 }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Chokehold skips a Substitute target (SetMoveEffect -> DoesSubstituteBlockMove)', () => {
    // BattleScript_Chokehold -> setmoveeffect MOVE_EFFECT_PARALYSIS -> SetMoveEffect(FALSE, 0) reaches
    // DoesSubstituteBlockMove (battle_script_commands.c:12252-12260), which ignores
    // HITMARKER_IGNORE_SUBSTITUTE and blocks a non-sound arming move. The arming move is not threaded
    // into the sim's clone, so the target is skipped and a note is left.
    const state = battle([{ abilities: ability('ABILITY_CHOKEHOLD') }, { status2: STATUS2_SUBSTITUTE }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    const notes: string[] = []

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, notes)).toBe(false)
    expect(state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(0)
    expect(notes.some((n) => n.includes('blocked by a Substitute'))).toBe(true)
    // The armed byte is cleared before the target loop regardless (abilities.cc:291-293).
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Entrance infatuates the foe with the holder', () => {
    // BattleScript_Entrance -> MOVE_EFFECT_ATTRACT (battle_scripts_1.s:10524) -> CanInfatuate (:2727-2732).
    const state = battle([{ abilities: ability('ABILITY_ENTRANCE') }, {}], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(true)
    expect(state.battlers[1]!.mon.status2 & STATUS2_INFATUATION).toBe(statusInfatuatedWith(0))
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Entrance does nothing against an Oblivious foe', () => {
    const state = battle([{ abilities: ability('ABILITY_ENTRANCE') }, { abilities: ability('ABILITY_OBLIVIOUS') }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.battlers[1]!.mon.status2 & STATUS2_INFATUATION).toBe(0)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Cryostasis flinches through a Substitute (its predicate has no callback)', () => {
    // abilities.cc:11612-11620 -- the predicate itself does
    // `gBattleMons[target].status2 |= STATUS2_FLINCHED; return FALSE;` with a nullptr callback, so it
    // never reaches SetMoveEffect / DoesSubstituteBlockMove. A Substitute target must still flinch.
    const state = battle([{ abilities: ability('ABILITY_CRYOSTASIS') }, { status2: STATUS2_SUBSTITUTE }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    const notes: string[] = []

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, notes)).toBe(false)
    expect(state.battlers[1]!.mon.status2 & STATUS2_FLINCHED).toBe(STATUS2_FLINCHED)
    expect(notes.some((n) => n.includes('blocked by a Substitute'))).toBe(false)
    // The predicate returns FALSE (:11618), so the clone never runs BattleScript_AbilityPopUpStack and
    // the armed byte is still consumed before the target loop.
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Neurotoxin lowers Atk, SpAtk and Speed by one stage each', () => {
    // BattleScript_Neurotoxin (battle_scripts_1.s:6842-6866): ATK, STAT_SPATK, STAT_SPEED, each
    // ChangeStatBuffsImplicit(-1, stat, 0, jumpPtr) = ChangeStatBuffs(target, -1, stat, 0).
    const state = battle([{ abilities: ability('ABILITY_NEUROTOXIN') }, {}], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    const fired = runReactiveAbilityEffects(state, REACTIVE_DEPS, [])
    expect(stageOf(state, 1, STAT_ATK)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(fired).toBe(true)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_DEF)).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Neurotoxin is a no-op when every listed stat is already at -6', () => {
    // NeurotoxinCondition (abilities.cc:9224-9226) is the OR of CanLowerStat over ATK/SPATK/SPEED.
    const state = battle([{ abilities: ability('ABILITY_NEUROTOXIN') }, {}], scripted())
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(stageOf(state, 1, STAT_ATK)).toBe(MIN_STAT_STAGE)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(MIN_STAT_STAGE)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(MIN_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('Neurotoxin still lowers a maxed Atk by one stage (+6 -> +5)', () => {
    // ChangeStatBuffs only refuses at MIN_STAT_STAGE (`statValue = max(statValue, -currentStage)`,
    // battle_script_commands.c:9810), so a -1 against +6 still applies.
    const state = battle([{ abilities: ability('ABILITY_NEUROTOXIN') }, {}], scripted())
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(true)
    expect(stageOf(state, 1, STAT_ATK)).toBe(MAX_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('Neurotoxin still stat-drops a Substitute target (no DoesSubstituteBlockMove)', () => {
    // BattleScript_Neurotoxin (data/battle_scripts_1.s:6842-6866) is setstatchanger / `statbuffchange 0`,
    // i.e. Cmd_statbuffchange -> ChangeStatBuffs (battle_script_commands.c:9713-9946). That function has
    // no STATUS2_SUBSTITUTE read (grep finds the flag only at :1777, :4716, :10547, :12207, :12253), so
    // the drops land on the substituted battler.
    const state = battle([{ abilities: ability('ABILITY_NEUROTOXIN') }, { status2: STATUS2_SUBSTITUTE }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
    const notes: string[] = []

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, notes)).toBe(true)
    expect(stageOf(state, 1, STAT_ATK)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(notes.some((n) => n.includes('blocked by a Substitute'))).toBe(false)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('the fainted battler\'s armed bit is cleared from every other holder (abilities.cc:7722-7726)', () => {
    // `int state = GetAbilityState(battler, ability); if (state & (1 << fainted))
    //  SetAbilityState(battler, ability, state ^ (1 << fainted));` -- only the fainted battler's bit.
    const state = battle([{ abilities: ability('ABILITY_CHOKEHOLD') }, { hp: 0 }], scripted())
    state.battlers[0]!.volatiles.abilityState[0] = (1 << 0) | (1 << 1)

    dispatchOnBattlerFaints({
      state,
      faintedId: 1,
      attackerId: 0,
      targetId: 1,
      byAttacker: true,
      moveId: 'MOVE_TACKLE',
      moveData: move('MOVE_TACKLE'),
      targetDamage: 10,
      deps: deps(fixedDamage(10)),
      unmodelled: [],
    })

    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1 << 0)
  })
})
