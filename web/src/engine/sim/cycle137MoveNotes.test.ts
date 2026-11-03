/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 137: the four remaining move notes.
//   (a) MOVE_SEISMIC_TOSS: the engine's `${moveId}: not modelled` note (basePower.ts
//       UNMODELLED_BASE_POWER_MOVE_IDS) is answered by turn.ts's fixed-damage block, so the
//       turn-level note must not survive. BattleScript_EffectSkyDrop's second-turn branch
//       (data/battle_scripts_1.s:5822-5827) skips `damagecalc` and runs `calculatesetdamage`,
//       which Cmd_calculatesetdamage turns into the user's level (battle_script_commands.c:10632-10635).
//   (b) HealConfuseBerry's flavor check (battle_util.c:5181-5186) is now ported from
//       gPokeblockFlavorCompatibilityTable (src/pokeblock.c:141-167) via GetFlavorRelationByNature
//       (src/pokemon.c:4185-4188), both in Concoction's consumeberry (moveEffects.ts) and in the
//       MOVEEND item pass (moveEnd.ts, the ITEMEFFECT_MOVE_END block at battle_util.c:5874-5906).
//   (c) Camouflage reads GET_MOVE_TYPE's RESOLVED dynamic type (battle_script_commands.c:4415-4427)
//       through the same resolution the damage formula uses, instead of the old -ate-only shortcut.
//   (d) The AI's Pursuit estimate never doubles: gActionsByTurnOrder cannot hold this turn's switch
//       while the AI is choosing an action (battle_util.c:6835-6836; battle_main.c:4400-4470 writes
//       that array only after ACTIONS_CONFIRMED_COUNT == gBattlersCount, :4117-4122).
//
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2`, divisions truncating.
// Every target below is Normal-typed unless a test says otherwise, and the user's Mudkip (Water)
// gives no STAB to any tested move, so the type chart contributes nothing outside the Camouflage
// cases, which assert the type itself rather than damage.
//
// Draw order, where a test asserts it: accuracycheck first (Cmd_accuracycheck,
// battle_script_commands.c:1398-1447), then the damage resolver's crit roll (Cmd_critcalc, :1568-1585),
// then its 85..100% damage roll (:1589-1611), then the move's own secondary / berry draws
// (Concoction's setrandomtempberry, data/battle_scripts_1.s:2925-2929, abilities.cc:7226-7236), then
// the confusion duration draw SetMoveEffect makes ((Random() % 2) + 3, battle_script_commands.c:2660).
import { describe, expect, it } from 'vitest'

import { UNMODELLED_BASE_POWER_EFFECTS, UNMODELLED_BASE_POWER_MOVE_IDS } from '../basePower'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState, buildFieldBattleState } from './bridge'
import type { DamageCalcScenario } from '../calculate'
import { calculateMoveDamage } from '../calculate'
import {
  getCounter,
  STATUS2_CONFUSION,
  STATUS2_MULTIPLETURNS,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_ION_DELUGE,
  WEATHER_RAIN_TEMPORARY,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import {
  CONFUSE_BERRY_FLAVORS,
  FLAVOR_COUNT,
  NATURE_ORDER,
  POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE,
  flavorRelationByNature,
} from './dataContext'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { consumeBerryWithOverride } from './moveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn, handleProtectLikeMoveEnd } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCalcDamage } from './ai/aiCalcDamage'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

/** 200 Speed against a slower foe keeps the speed-tie coin flip (turnOrder.ts:583) out of the
 * scripted draw arrays and makes the Camouflage user move first without help from its priority 4. */
const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }
const SLOW_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 }
const NORMAL_TYPES: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: freshAbilities(),
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
    // Last, so an override wins AND is cloned: a Camouflage test mutates mon.types[2], which
    // must not write through to the shared NORMAL_TYPES literal.
    types: [...(overrides.types ?? [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'])] as [
      string,
      string,
      string,
    ],
  }
}

function partyMon(speciesId: string, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    itemId: null,
    abilities: freshAbilities(),
    rawStats: { ...FAST_STATS },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    ...overrides,
    types: [...(overrides.types ?? NORMAL_TYPES)] as [string, string, string],
  }
}

/** Draws the scripted values in order (0 once they run out); `calls` counts draws. */
function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      const value = values[idx] ?? 0
      idx++
      return value
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon,
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[] } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
    ...(opts.playerParty ? { playerParty: opts.playerParty } : {}),
    ...(opts.opponentParty ? { opponentParty: opts.opponentParty } : {}),
  })
}

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
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
}

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** Same action with a forged view effect. Only the synthetic negative Seismic Toss test uses it:
 * the real data always gives MOVE_SEISMIC_TOSS EFFECT_SKY_DROP, which the fixed-damage block
 * answers, so the only way to observe the note filter's guard is to drive the same move id down
 * the ordinary damage path. */
function useMoveWithEffect(target: number, moveId: string, effect: string): ChosenAction {
  const view = { ...viewOf(moveId), effect }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** The real bridge resolver, needed wherever a number depends on the damage formula. */
function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

function aiDeps(state: BattleState): AiDamageDeps {
  const bridge: BridgeDeps = {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
  return {
    ...bridge,
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    holdEffectIds: SIM.holdEffectIds,
  }
}

const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)

// ---------------------------------------------------------------------------
// (a) MOVE_SEISMIC_TOSS
// BattleScript_EffectSkyDrop (data/battle_scripts_1.s:5792-5835),
// Cmd_calculatesetdamage (battle_script_commands.c:10626-10659),
// Cmd_calculatesetdamage's level branch (:10632-10635).
// ---------------------------------------------------------------------------
describe('Cycle 137 (a) Seismic Toss does not carry the not-modelled note', () => {
  // Seismic Toss's fixed damage is the USER'S LEVEL: attacker.mon.level = 50 (turn.ts's
  // fixedDamageFor, EFFECT_SKY_DROP branch, from battle_script_commands.c:10632-10635).
  const LEVEL_DAMAGE = 50

  function tossBattle(rng: RandomSource) {
    return battle(
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...SLOW_STATS },
        moves: ['MOVE_SEISMIC_TOSS', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, rawStats: { ...SLOW_STATS } }),
      rng,
    )
  }

  it('positive: the second turn deals exactly the user level and no "not modelled" note survives', () => {
    // Turn 1 (s:5794-5810): one draw, the accuracycheck (:5797). Turn 2 (s:5811-5827): no
    // accuracycheck (scriptHasNoAccuracyCheck); the resolver still draws its crit roll and its
    // damage roll before turn.ts replaces the value with the level.
    const rng = scriptedRng([0, 1, 0])
    const state = tossBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const charge = executeTurn(state, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps)
    expect(actionOf(charge, 0)?.targetDamage).toBeNull() // the charge turn deals nothing
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).not.toBe(0)

    const hit = executeTurn(state, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps)
    expect(actionOf(hit, 0)?.missed).toBe(false)
    expect(actionOf(hit, 0)?.targetDamage).toBe(LEVEL_DAMAGE)
    expect(state.battlers[1]!.mon.hp).toBe(100 - LEVEL_DAMAGE)
    // The engine's move-id-keyed note (basePower.ts UNMODELLED_BASE_POWER_MOVE_IDS) is answered.
    expect(actionOf(hit, 0)?.unmodelled.filter((n) => n.startsWith('MOVE_SEISMIC_TOSS:'))).toEqual([])
    expect(effectOf('MOVE_SEISMIC_TOSS')).toBe('EFFECT_SKY_DROP')
  })

  it('negative control: the same move id on a non-fixed effect keeps its note', () => {
    // No real data reaches this state: Seismic Toss's own effect is EFFECT_SKY_DROP, so
    // isFixedDamage is true for it, and every other UNMODELLED_BASE_POWER_EFFECTS move's script
    // either IS in FIXED_DAMAGE_EFFECTS or never reaches damagecalc (Bide: s:3734-3743 sets
    // STATUS2_BIDE and returns; its attack turn uses takenDmg * 2). The forged EFFECT_HIT view
    // therefore only exercises the filter's guard: with isFixedDamage false the note stays.
    const rng = scriptedRng([0, 1, 0])
    const state = tossBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMoveWithEffect(1, 'MOVE_SEISMIC_TOSS', 'EFFECT_HIT'), null], deps)

    expect(UNMODELLED_BASE_POWER_MOVE_IDS.has('MOVE_SEISMIC_TOSS')).toBe(true)
    expect(actionOf(out, 0)?.unmodelled).toContain('MOVE_SEISMIC_TOSS: not modelled')
    expect(actionOf(out, 0)?.targetDamage).not.toBe(LEVEL_DAMAGE)
  })

  it('negative control: Bide keeps its effect-keyed note when it does not take the ordinary path', () => {
    // EFFECT_BIDE is in UNMODELLED_BASE_POWER_EFFECTS (basePower.ts:600) but not in
    // FIXED_DAMAGE_EFFECTS (turn.ts:1927-1936), so the filter never removes its note. The real
    // Bide turn takes the dedicated branch at turn.ts:2695-2715, which never calls the resolver
    // at all; the forged EFFECT_HIT view is again only a control for the guard.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...SLOW_STATS },
        moves: ['MOVE_BIDE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, rawStats: { ...SLOW_STATS } }),
      rng,
    )
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMoveWithEffect(1, 'MOVE_BIDE', 'EFFECT_HIT'), null], deps)

    expect(UNMODELLED_BASE_POWER_EFFECTS.has('EFFECT_BIDE')).toBe(true)
    expect(actionOf(out, 0)?.unmodelled).toContain('EFFECT_BIDE: not modelled')
  })
})

// ---------------------------------------------------------------------------
// (b) HealConfuseBerry flavor check
// gPokeblockFlavorCompatibilityTable (src/pokeblock.c:141-167),
// GetFlavorRelationByNature (src/pokemon.c:4185-4188),
// HealConfuseBerry (battle_util.c:5167-5193),
// BattleScript_BerryConfuseHealRet (data/battle_scripts_1.s:10986-11003).
// ---------------------------------------------------------------------------
describe('Cycle 137 (b) Pokeblock flavor table', () => {
  it('is 25 natures x 5 flavors, with NATURE_ORDER holding the enum order', () => {
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE).toHaveLength(25)
    for (const row of POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE) expect(row).toHaveLength(FLAVOR_COUNT)
    expect(NATURE_ORDER).toHaveLength(25)
    // include/constants/pokemon.h:77-102: Hardy is 0, Lonely 1, Bold 5, Relaxed 7, Impish 8,
    // Quirky 24 (the last row).
    expect(NATURE_ORDER[0]).toBe('NATURE_HARDY')
    expect(NATURE_ORDER[1]).toBe('NATURE_LONELY')
    expect(NATURE_ORDER[5]).toBe('NATURE_BOLD')
    expect(NATURE_ORDER[7]).toBe('NATURE_RELAXED')
    expect(NATURE_ORDER[8]).toBe('NATURE_IMPISH')
    expect(NATURE_ORDER[24]).toBe('NATURE_QUIRKY')
  })

  it('matches six rows hand-copied from src/pokeblock.c:141-167 (Spicy, Dry, Sweet, Bitter, Sour)', () => {
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[0]).toEqual([0, 0, 0, 0, 0]) // Hardy   :141
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[1]).toEqual([1, 0, 0, 0, -1]) // Lonely  :142
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[5]).toEqual([-1, 0, 0, 0, 1]) // Bold    :146
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[7]).toEqual([0, 0, -1, 0, 1]) // Relaxed :148
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[8]).toEqual([0, -1, 0, 0, 1]) // Impish  :149
    expect(POKEBLOCK_FLAVOR_COMPATIBILITY_TABLE[24]).toEqual([0, 0, 0, 0, 0]) // Quirky :165
    // FLAVOR_SPICY = 0 .. FLAVOR_SOUR = 4 (include/constants/berry.h:13-18).
    expect(FLAVOR_COUNT).toBe(5)
  })

  it('GetFlavorRelationByNature throws instead of returning a neutral 0', () => {
    expect(flavorRelationByNature('NATURE_BOLD', 0)).toBe(-1)
    expect(flavorRelationByNature('NATURE_LONELY', 0)).toBe(1)
    expect(flavorRelationByNature('NATURE_HARDY', 0)).toBe(0)
    expect(() => flavorRelationByNature('NATURE_NOT_A_NATURE', 0)).toThrow()
    expect(() => flavorRelationByNature('NATURE_HARDY', 5)).toThrow()
    expect(() => flavorRelationByNature('NATURE_HARDY', -1)).toThrow()
  })

  it('CONFUSE_BERRY_FLAVORS maps the five HOLD_EFFECT_CONFUSE_* ids to berry.h flavor ids', () => {
    // HealConfuseBerry's callers pass FLAVOR_SPICY..FLAVOR_SOUR by name (battle_util.c:5442-5456).
    expect(CONFUSE_BERRY_FLAVORS.HOLD_EFFECT_CONFUSE_SPICY).toBe(0)
    expect(CONFUSE_BERRY_FLAVORS.HOLD_EFFECT_CONFUSE_DRY).toBe(1)
    expect(CONFUSE_BERRY_FLAVORS.HOLD_EFFECT_CONFUSE_SWEET).toBe(2)
    expect(CONFUSE_BERRY_FLAVORS.HOLD_EFFECT_CONFUSE_BITTER).toBe(3)
    expect(CONFUSE_BERRY_FLAVORS.HOLD_EFFECT_CONFUSE_SOUR).toBe(4)
  })
})

describe('Cycle 137 (b) Concoction berry heal + flavor confusion', () => {
  // Confuse berries heal maxHp / holdEffectParam (battle_util.c:5174-5176). items.json gives
  // every confuse berry holdEffectStrength 2, so 100 / 2 = 50. The eater starts at 40 HP -> 90.
  const HEAL = 50
  const START_HP = 40

  function consume(nature: string, values: number[], itemId = 'ITEM_FIGY_BERRY') {
    const rng = scriptedRng(values)
    const state = battle(
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, nature, hp: START_HP, maxHp: 100, itemId }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES }),
      rng,
    )
    const deps = loopDeps(state, bridgeDamage(state, state.rng))
    const notes: string[] = []
    consumeBerryWithOverride(state, 0, 0, 'MOVE_CONCOCTION', deps, notes, [])
    return { state, deps, notes, rng, eater: state.battlers[0]! }
  }

  it('Spicy (Figy) with Lonely is liked (+1): heal, no confusion, no duration draw', () => {
    const { notes, rng, eater } = consume('NATURE_LONELY', [])
    expect(eater.mon.hp).toBe(START_HP + HEAL) // 40 -> 90
    expect(getCounter(eater.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(eater.mon.itemId).toBeNull() // removeitem (:11002)
    expect(eater.usedHeldItem).toBe('ITEM_FIGY_BERRY')
    expect(rng.calls).toBe(0)
    expect(notes.some((n) => n.includes('flavor'))).toBe(false)
  })

  it('Spicy (Figy) with Bold is disliked (-1): heal, then confusion for (0 % 2) + 3 turns', () => {
    // BattleScript_BerryConfuseHealRet order (s:10992-11002): healthbarupdate (:10996-10997),
    // setmoveeffect MOVE_EFFECT_CONFUSION | MOVE_EFFECT_CERTAIN (:11000), seteffectprimary
    // (:11001), removeitem (:11002). Cmd_seteffectprimary is SetMoveEffect(TRUE, 0)
    // (battle_script_commands.c:3124-3126) -- primary TRUE is why Shield Dust/Cover Cloak
    // (:2348-2350) and Safeguard (:2352-2354), both gated on !primary, do not block it.
    const { deps, notes, rng, eater } = consume('NATURE_BOLD', [0])
    expect(eater.mon.hp).toBe(START_HP + HEAL)
    expect(getCounter(eater.mon.status2, STATUS2_CONFUSION)).toBe(3) // (0 % 2) + 3 (:2660)
    expect(eater.mon.itemId).toBeNull()
    expect(rng.calls).toBe(1) // the confusion duration draw
    expect(notes).toEqual([])
    void deps
  })

  it('Spicy (Figy) with Hardy is neutral (0): heal, no confusion', () => {
    const { rng, eater } = consume('NATURE_HARDY', [])
    expect(eater.mon.hp).toBe(START_HP + HEAL)
    expect(getCounter(eater.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('Sour (Iapapa) with Relaxed is liked (+1): heal, no confusion', () => {
    // Row Relaxed [0,0,-1,0,1] (pokeblock.c:148), flavor Sour = index 4.
    const { rng, eater } = consume('NATURE_RELAXED', [], 'ITEM_IAPAPA_BERRY')
    expect(eater.mon.hp).toBe(START_HP + HEAL)
    expect(getCounter(eater.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('Sour with Gentle is disliked (-1): heal then confusion. Impish is ALSO +1 for Sour', () => {
    // Row Gentle [0,0,0,1,-1] (pokeblock.c:162), flavor Sour = index 4. Note that the brief's
    // suggested "Impish vs Relaxed" pair is not a sign change: Impish is [0,-1,0,0,1]
    // (pokeblock.c:149), i.e. Sour +1 too, so Gentle is used for the disliked side.
    const { rng, eater } = consume('NATURE_GENTLE', [1], 'ITEM_IAPAPA_BERRY')
    expect(eater.mon.hp).toBe(START_HP + HEAL)
    expect(getCounter(eater.mon.status2, STATUS2_CONFUSION)).toBe(4) // (1 % 2) + 3
    expect(rng.calls).toBe(1)
  })

  it('end-to-end Concoction: a disliked dry berry confuses the eater and the parked item returns', () => {
    // Attacker Impish dislikes Dry ([0,-1,0,0,1], pokeblock.c:149). Concoction's
    // SetRandomTempBerry (abilities.cc:7226-7236) draws table index 2 = Figy, then
    // figyAlternatives index 1 = Wiki (Dry). Draws: accuracy 0, crit 1 (no crit), roll 0 (max),
    // table 2, alternatives 1, confusion duration 0.
    const rng = scriptedRng([0, 1, 0, 2, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...FAST_STATS },
        nature: 'NATURE_IMPISH',
        hp: START_HP,
        maxHp: 100,
        itemId: 'ITEM_BIG_NUGGET',
        moves: ['MOVE_CONCOCTION', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES }),
      rng,
    )
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    const attacker = state.battlers[0]!
    expect(actionOf(out, 0)?.targetDamage).toBe(15) // 22*30/50 + 2 = 15
    expect(attacker.mon.hp).toBe(START_HP + HEAL) // 40 -> 90
    expect(attacker.usedHeldItem).toBe('ITEM_WIKI_BERRY')
    expect(getCounter(attacker.mon.status2, STATUS2_CONFUSION)).toBe(3) // (0 % 2) + 3
    expect(attacker.mon.itemId).toBe('ITEM_BIG_NUGGET') // MOVEEND_CHANGED_ITEMS restores it
    expect(rng.calls).toBe(6)
    expect(actionOf(out, 0)?.unmodelled.some((n) => n.includes('HealConfuseBerry'))).toBe(false)
  })

  it('end-to-end Concoction: a liked spicy berry heals without confusing', () => {
    // Attacker Lonely likes Spicy (pokeblock.c:142). Table index 2 = Figy, then alternatives 0 =
    // Figy, so the berry is Spicy; no confusion draw follows.
    const rng = scriptedRng([0, 1, 0, 2, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...FAST_STATS },
        nature: 'NATURE_LONELY',
        hp: START_HP,
        maxHp: 100,
        itemId: 'ITEM_BIG_NUGGET',
        moves: ['MOVE_CONCOCTION', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES }),
      rng,
    )
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    const attacker = state.battlers[0]!
    expect(attacker.mon.hp).toBe(START_HP + HEAL)
    expect(attacker.usedHeldItem).toBe('ITEM_FIGY_BERRY')
    expect(getCounter(attacker.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(rng.calls).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// (c) Camouflage's resolved type
// battle_script_commands.c:4415-4427 (GET_MOVE_TYPE + IS_BATTLER_OF_TYPE + type3 write),
// GetMoveTypeInternal (battle_main.c:5040-5211),
// SetTypeBeforeUsingMove/ApplyTypeOverrideInformation (:5215-5260).
// ---------------------------------------------------------------------------
describe('Cycle 137 (c) Camouflage adds the resolved dynamic type', () => {
  /** MOVEEND_PROTECT_LIKE_EFFECT (battle_script_commands.c:4342-4427) only runs after a blocked
   * attack, and `touchedProtectLike` is set (:1200-1201) only when the blocked move makes contact
   * (or carries PROTECT_BLOCK_ALWAYS_TOUCH). None of Judgment, Weather Ball, Hidden Power, Natural
   * Gift, Revelation Dance or Terrain Pulse is a contact move (moves.json has no `contact` flag for
   * them), so this helper sets the flag by hand, exactly as that gate would for a contact move.
   * Type resolution reads no RNG, so nothing here draws. */
  function camouflage(
    moveId: string,
    opts: {
      attacker?: Partial<SimBattleMon>
      protectorTypes?: [string, string, string]
      weather?: number
      fieldStatuses?: number
    } = {},
  ) {
    const rng = scriptedRng([])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { ...SLOW_STATS },
        moves: [moveId, null, null, null],
        pp: [20, 0, 0, 0],
        ...opts.attacker,
      }),
      monFor('SPECIES_MUDKIP', {
        types: opts.protectorTypes ?? NORMAL_TYPES,
        rawStats: { ...FAST_STATS },
        moves: ['MOVE_CAMOUFLAGE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      rng,
    )
    if (opts.weather !== undefined) state.field.weather = opts.weather
    if (opts.fieldStatuses !== undefined) state.field.statuses = opts.fieldStatuses
    const protector = state.battlers[1]!
    protector.round.protectMove = 'MOVE_CAMOUFLAGE'
    state.battlers[0]!.round.touchedProtectLike = true
    const notes: string[] = []
    const deps = loopDeps(state, bridgeDamage(state, state.rng))
    handleProtectLikeMoveEnd(state, 0, 1, moveId, deps, notes)
    return { state, protector, notes, rng }
  }

  it('Judgment with a Dread Plate adds DARK (GetMoveTypeInternal, battle_main.c:5047-5049)', () => {
    const { protector, notes, rng } = camouflage('MOVE_JUDGMENT', { attacker: { itemId: 'ITEM_DREAD_PLATE' } })
    expect(protector.mon.types[2]).toBe('DARK')
    // No leftover note about the type resolution itself (the bridge's own scenario gaps are
    // unrelated and are not gated on this change).
    expect(notes.some((n) => n.includes('Camouflage'))).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('Weather Ball in rain adds WATER (battle_main.c:5124-5133)', () => {
    const { protector } = camouflage('MOVE_WEATHER_BALL', { weather: WEATHER_RAIN_TEMPORARY })
    expect(protector.mon.types[2]).toBe('WATER')
  })

  it('Hidden Power adds the attacker hidden-power type (battle_main.c:5148-5150)', () => {
    const { protector } = camouflage('MOVE_HIDDEN_POWER', { attacker: { hiddenPowerType: 'FIRE' } })
    expect(protector.mon.types[2]).toBe('FIRE')
  })

  it('Natural Gift adds the held berry natural-gift type (battle_main.c:5133-5145)', () => {
    // ITEM_FIGY_BERRY's naturalGift is TYPE_FIRE (items.json), and it is a berry
    // (POCKET_BERRIES), which is what the C's REQUIRE tests.
    const { protector } = camouflage('MOVE_NATURAL_GIFT', { attacker: { itemId: 'ITEM_FIGY_BERRY' } })
    expect(protector.mon.types[2]).toBe('FIRE')
  })

  it('Revelation Dance adds the user first real type (battle_main.c:5156-5166)', () => {
    const { protector } = camouflage('MOVE_REVELATION_DANCE', {
      attacker: { speciesId: 'SPECIES_CHARIZARD', types: ['FIRE', 'FLYING', 'MYSTERY'] },
    })
    expect(protector.mon.types[2]).toBe('FIRE')
  })

  it('Ion Deluge turns a Normal move ELECTRIC (battle_main.c:5194-5197)', () => {
    const { protector } = camouflage('MOVE_TACKLE', { fieldStatuses: STATUS_FIELD_ION_DELUGE })
    expect(protector.mon.types[2]).toBe('ELECTRIC')
  })

  it('Terrain Pulse adds the terrain type only while a terrain is up (battle_main.c:5173-5190)', () => {
    // IsBattlerTerrainAffected (battle_util.c:4901-4928): terrain active, target not
    // semi-invulnerable, and grounded. Electricity first, then the no-terrain control below.
    const grassy = camouflage('MOVE_TERRAIN_PULSE', { fieldStatuses: STATUS_FIELD_GRASSY_TERRAIN })
    expect(grassy.protector.mon.types[2]).toBe('GRASS')

    // Fire-typed protector so the declared NORMAL is genuinely new (the guard below skips a
    // target that already has the resolved type).
    const none = camouflage('MOVE_TERRAIN_PULSE', { protectorTypes: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(none.protector.mon.types[2]).toBe('NORMAL') // declared type (moves.json)
  })

  it('negative: a target that already has the resolved type gets no type3 change', () => {
    // IS_BATTLER_OF_TYPE(gBattlerTarget, moveType) (:4418) sees WATER already in type1.
    const { protector } = camouflage('MOVE_WEATHER_BALL', {
      weather: WEATHER_RAIN_TEMPORARY,
      protectorTypes: ['WATER', 'MYSTERY', 'MYSTERY'],
    })
    expect(protector.mon.types[2]).toBe('MYSTERY')
  })

  it('negative: a plain move adds its declared type (Tackle -> NORMAL)', () => {
    // The protector is Fire-typed so NORMAL is genuinely new.
    const { protector, notes } = camouflage('MOVE_TACKLE', { protectorTypes: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(protector.mon.types[2]).toBe('NORMAL')
    expect(notes.some((n) => n.includes('Camouflage'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) Pursuit in the AI damage estimate
// CalcMoveBasePower's Pursuit case (battle_util.c:6835-6836),
// SetActionsAndBattlersTurnOrder (battle_main.c:4400-4470),
// AI_CalcDamage (battle_ai_util.c:650-765).
// ---------------------------------------------------------------------------
describe('Cycle 137 (d) AI Pursuit estimate is never doubled', () => {
  // Pursuit, Dark, power 50. Level 50, Atk 100 vs Def 100:
  //   floor(floor(22 * 50 * 100 / 100) / 50) + 2 = 22 + 2 = 24.
  // No STAB (Mudkip is Water), the target is Normal-typed, so Dark is neutral: 24.
  const PURSUIT_PLAIN_DAMAGE = 24
  // The doubled number the pre-switch hit deals (power 100): 22*100/50 + 2 = 46.
  const PURSUIT_SWITCH_DAMAGE = 46

  function pursuitState(rng: RandomSource) {
    const state = battle(
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, rawStats: { ...SLOW_STATS } }),
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...SLOW_STATS },
        moves: ['MOVE_PURSUIT', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      rng,
      { playerParty: [partyMon('SPECIES_MUDKIP', { types: NORMAL_TYPES }), partyMon('SPECIES_TREECKO')] },
    )
    // The player (battler 0) has a valid switch queued: this is exactly the state the C's
    // gChosenActionByBattler holds while the AI is scoring. It is deliberately NOT what the
    // doubled calc reads -- see the next paragraph's citation.
    state.battlers[0]!.monToSwitchIntoId = 1
    return state
  }

  it('the AI estimates power 50 even when the target has a switch queued', () => {
    // gActionsByTurnOrder is written only by SetActionsAndBattlersTurnOrder
    // (battle_main.c:4400-4470, the B_ACTION_SWITCH write at :4459-4462), which runs once
    // ACTIONS_CONFIRMED_COUNT == gBattlersCount (:4117-4122) -- i.e. after every action is
    // chosen, so never during AI scoring. All AI_CalcDamage call sites
    // (battle_ai_main.c:260, battle_ai_util.c:998, :2438) are inside selection. On turn 1 the
    // array is the initial all-B_ACTION_FINISHED value (:174); a switch turn resets the slot to
    // B_ACTION_TRY_FINISH in SwitchInClearSetData (:2803). The comparison at battle_util.c:6835-6836
    // therefore cannot see this turn's switch, and 24 is the C's own answer.
    const rng = scriptedRng([])
    const state = pursuitState(rng)
    const out = aiCalcDamage(state, 'MOVE_PURSUIT', 1, 0, aiDeps(state))

    expect(out.dmg).toBe(PURSUIT_PLAIN_DAMAGE)
    expect(out.unmodelled.some((n) => n.includes('Pursuit'))).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('negative: calculateMoveDamage with defenderIsSwitching: true still doubles it', () => {
    // Same scenario builder as AI_CalcDamage's own (buildBattlerBattleState/buildFieldBattleState),
    // read directly, so the doubling itself is proven to exist and to be what the AI path declines
    // to apply.
    const state = pursuitState(scriptedRng([]))
    const bridge: BridgeDeps = {
      grounding: groundingFor(SIM, state),
      turnOrder: TURN_ORDER,
      statStageRatios: RATIOS,
      dataContext: DATA_CONTEXT,
      inverseBattle: false,
    }
    const roles = { attackerId: 1, defenderId: 0 }
    const move = SIM.moveData('MOVE_PURSUIT')!
    const base: DamageCalcScenario = {
      move,
      attacker: buildBattlerBattleState(state, 1, roles, bridge).battler,
      defender: buildBattlerBattleState(state, 0, roles, bridge).battler,
      field: buildFieldBattleState(state, roles, bridge).field,
      typeChart: SIM.typeChart,
      inverseTypeChart: SIM.inverseTypeChart,
      moveBehaviors: SIM.moveBehaviors,
      battleConstants: SIM.battleConstants,
      attackerActsFirst: true,
      sameMoveTurnsInARow: 0,
      hitCount: 0,
      defenderIsSwitching: false,
      magnitudeTier: null,
      attackerRolloutCounter: 0,
      attackerHasDefenseCurl: false,
      attackerWasHitThisTurn: false,
      attackerTimesDamaged: 0,
      beatUpBaseAttack: 100,
      beatUpHitCount: 1,
      defenderUsedGlaiveRush: false,
    }

    expect(calculateMoveDamage(base).rolls?.[15]).toBe(PURSUIT_PLAIN_DAMAGE)
    expect(calculateMoveDamage({ ...base, defenderIsSwitching: true }).rolls?.[15]).toBe(PURSUIT_SWITCH_DAMAGE)
  })
})
