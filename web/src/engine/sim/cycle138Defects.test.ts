/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 138: defects found by review of cycle 137 (part 1 of 2).
//   (1) Seismic Toss's "not modelled" notes leaked on three paths besides the hit turn
//       (charge-turn typecalc, aiGetTypeEffectiveness, aiCalcDamage). Fixed by
//       basePower.ts's shared isUnmodelledBasePowerNote predicate.
//   (2) HealConfuseBerry's confuse branch in MOVEEND_ITEM_EFFECTS_ALL landed on the eater;
//       the C's BattleScript_BerryConfuseHealRet runs `seteffectprimary` and
//       `removeitem BS_TARGET` against gBattlerTarget (the move's target), not the eater.
//   (4) Two cycle-137 weakenings: the Camouflage fallback gap note and the cycle 109b
//       assertion that pinned it.
//
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2`, divisions truncating.
// Every target below is Normal-typed unless a test says otherwise.
//
// Draw order, where a test asserts it: accuracycheck first (Cmd_accuracycheck,
// battle_script_commands.c:1398-1447), then the damage resolver's crit roll (Cmd_critcalc,
// :1568-1585), then its 85..100% damage roll (:1589-1611), then SetMoveEffect's confusion
// duration draw ((Random() % 2) + 3, battle_script_commands.c:2660).
import { describe, expect, it } from 'vitest'

import { isUnmodelledBasePowerNote, UNMODELLED_BASE_POWER_EFFECTS, UNMODELLED_BASE_POWER_MOVE_IDS } from '../basePower'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState, buildFieldBattleState } from './bridge'
import type { DamageCalcScenario } from '../calculate'
import { calculateMoveDamage } from '../calculate'
import { getCounter, STATUS2_CONFUSION, STATUS2_MULTIPLETURNS } from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn, handleProtectLikeMoveEnd } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCalcDamage, aiGetTypeEffectiveness } from './ai/aiCalcDamage'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

/** 200 Speed against a slower foe keeps the speed-tie coin flip out of the scripted arrays. */
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
    // Last, so an override wins AND is cloned (a Camouflage test mutates mon.types[2]).
    types: [...(overrides.types ?? [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'])] as [
      string,
      string,
      string,
    ],
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

/** Same action with a forged view effect (negative controls for the fixed-damage note guard). */
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

const NO_ENGINE: DamageResolver = {
  resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }),
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
// (1) Seismic Toss's notes
// ---------------------------------------------------------------------------
describe('Cycle 138 (1) Seismic Toss does not carry the not-modelled note on any path', () => {
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

  it('hit turn: the level-based damage is computed and no note survives', () => {
    // Turn 1: one accuracy draw (:5797). Turn 2: no accuracycheck
    // (scriptHasNoAccuracyCheck); the resolver still draws its crit roll and damage roll
    // before turn.ts replaces the value with the user level (battle_script_commands.c:10632-10635).
    const rng = scriptedRng([0, 1, 0])
    const state = tossBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps)
    const hit = executeTurn(state, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps)

    expect(actionOf(hit, 0)?.targetDamage).toBe(LEVEL_DAMAGE)
    expect(actionOf(hit, 0)?.unmodelled.filter((n) => n.startsWith('MOVE_SEISMIC_TOSS:'))).toEqual([])
  })

  it('negative control: the same move id on a non-fixed effect still keeps its note', () => {
    // Seismic Toss's real effect is EFFECT_SKY_DROP, which isFixedDamage covers, so the forgery
    // is the only way to observe the hit-turn guard: with isFixedDamage false the note stays.
    const rng = scriptedRng([0, 1, 0])
    const state = tossBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMoveWithEffect(1, 'MOVE_SEISMIC_TOSS', 'EFFECT_HIT'), null], deps)

    expect(UNMODELLED_BASE_POWER_MOVE_IDS.has('MOVE_SEISMIC_TOSS')).toBe(true)
    expect(actionOf(out, 0)?.unmodelled).toContain('MOVE_SEISMIC_TOSS: not modelled')
    expect(actionOf(out, 0)?.targetDamage).not.toBe(LEVEL_DAMAGE)
  })

  it('charge-turn typecalc: no note survives, because only the type multiplier is read', () => {
    // Turn 1 of Sky Drop runs typecalc (data/battle_scripts_1.s:5795-5798) through
    // DamageResolver.typeEffectiveness; only the type multiplier is read there.
    const rng = scriptedRng([0])
    const state = tossBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))
    const charge = executeTurn(state, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps)
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).not.toBe(0)
    expect(actionOf(charge, 0)?.unmodelled.filter((n) => n.startsWith('MOVE_SEISMIC_TOSS:'))).toEqual([])

    const direct = deps.damage.typeEffectiveness!(state, 0, 1, 'MOVE_SEISMIC_TOSS')
    expect(direct.unmodelled).not.toContain('MOVE_SEISMIC_TOSS: not modelled')

    // The type stage answers every move the same way: it never asks the damage question, so
    // Bide's effect-keyed note is filtered here too. The hit path is where the sim genuinely
    // leaves it unanswered -- the negative control below.
    const bide = deps.damage.typeEffectiveness!(state, 0, 1, 'MOVE_BIDE')
    expect(UNMODELLED_BASE_POWER_EFFECTS.has('EFFECT_BIDE')).toBe(true)
    expect(bide.unmodelled).not.toContain('EFFECT_BIDE: not modelled')
  })

  it('negative control: Bide keeps its effect-keyed note on the hit path', () => {
    // EFFECT_BIDE is not in FIXED_DAMAGE_EFFECTS, so the hit-turn block never removes it; the
    // forged EFFECT_HIT only drives the move down that path to observe the guard.
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
    expect(actionOf(out, 0)?.unmodelled).toContain('EFFECT_BIDE: not modelled')
  })

  it('AI: aiGetTypeEffectiveness and aiCalcDamage drop the note, calculateMoveDamage keeps it', () => {
    const state = tossBattle(scriptedRng([]))
    const deps = aiDeps(state)

    const eff = aiGetTypeEffectiveness(state, 'MOVE_SEISMIC_TOSS', 0, 1, deps)
    expect(eff.unmodelled).not.toContain('MOVE_SEISMIC_TOSS: not modelled')

    const dmg = aiCalcDamage(state, 'MOVE_SEISMIC_TOSS', 0, 1, deps)
    expect(dmg.unmodelled).not.toContain('MOVE_SEISMIC_TOSS: not modelled')

    // The engine itself is unchanged: the ordinary calculateMoveDamage still reports the gap.
    const bridge: BridgeDeps = {
      grounding: groundingFor(SIM, state),
      turnOrder: TURN_ORDER,
      statStageRatios: RATIOS,
      dataContext: DATA_CONTEXT,
      inverseBattle: false,
    }
    const roles = { attackerId: 0, defenderId: 1 }
    const move = SIM.moveData('MOVE_SEISMIC_TOSS')!
    const plain: DamageCalcScenario = {
      move,
      attacker: buildBattlerBattleState(state, 0, roles, bridge).battler,
      defender: buildBattlerBattleState(state, 1, roles, bridge).battler,
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
    expect(calculateMoveDamage(plain).unmodelled).toContain('MOVE_SEISMIC_TOSS: not modelled')
    expect(effectOf('MOVE_SEISMIC_TOSS')).toBe('EFFECT_SKY_DROP')
  })

  it('predicate: both shapes match only for the move being asked about', () => {
    expect(isUnmodelledBasePowerNote('EFFECT_BIDE: not modelled', 'MOVE_BIDE', 'EFFECT_BIDE')).toBe(true)
    expect(isUnmodelledBasePowerNote('MOVE_SEISMIC_TOSS: not modelled', 'MOVE_SEISMIC_TOSS', 'EFFECT_SKY_DROP')).toBe(true)
    // A note for another effect / another move never matches.
    expect(isUnmodelledBasePowerNote('EFFECT_BIDE: not modelled', 'MOVE_SEISMIC_TOSS', 'EFFECT_SKY_DROP')).toBe(false)
    expect(isUnmodelledBasePowerNote('MOVE_SEISMIC_TOSS: not modelled', 'MOVE_BIDE', 'EFFECT_BIDE')).toBe(false)
    expect(isUnmodelledBasePowerNote('MOVE_SEISMIC_TOSS: not modelled', 'MOVE_TACKLE', null)).toBe(false)
    // The move-id shape is not keyed on any effect; the effect shape needs a set member.
    expect(isUnmodelledBasePowerNote('EFFECT_SKY_DROP: not modelled', 'MOVE_SEISMIC_TOSS', 'EFFECT_SKY_DROP')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (2) HealConfuseBerry's confuse branch targets gBattlerTarget
// ---------------------------------------------------------------------------
describe('Cycle 138 (2) confuse-berry confusion lands on the move target', () => {
  // HealConfuseBerry (battle_util.c:5172-5174): maxHp / GetBattlerHoldEffectParam = 100 / 2 = 50.
  const HEAL = 50
  const START_HP = 30
  // Rough Skin (abilities.cc:784-793): floor(maxHp / 8) = floor(100 / 8) = 12, so 30 -> 18 (<= 25).
  const ATTACKER_AFTER_RECOIL = START_HP - 12

  function figyBattle(nature: string, rng: RandomSource, targetAbilities: SimBattleMon['abilities']) {
    return battle(
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...FAST_STATS },
        nature,
        hp: START_HP,
        maxHp: 100,
        itemId: 'ITEM_FIGY_BERRY',
        moves: ['MOVE_TACKLE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', {
        types: NORMAL_TYPES,
        rawStats: { ...SLOW_STATS },
        itemId: 'ITEM_BIG_NUGGET',
        abilities: targetAbilities,
      }),
      rng,
    )
  }

  it('Bold (Spicy disliked) heals the eater but confuses the TARGET and strips the TARGET item', () => {
    // Draws: accuracy 0, crit 1 (no crit), damage roll 0 (max), confusion duration 0 -> 3 turns.
    const rng = scriptedRng([0, 1, 0, 0])
    const state = figyBattle('NATURE_BOLD', rng, { ability: 'ABILITY_ROUGH_SKIN', innates: [null, null, null] })
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps)

    const attacker = state.battlers[0]!
    const target = state.battlers[1]!
    expect(attacker.mon.hp).toBe(ATTACKER_AFTER_RECOIL + HEAL) // 18 -> 68
    expect(getCounter(attacker.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(getCounter(target.mon.status2, STATUS2_CONFUSION)).toBe(3) // (0 % 2) + 3 (:2660)
    expect(target.mon.itemId).toBeNull() // removeitem BS_TARGET (s:11002)
    expect(attacker.mon.itemId).toBe('ITEM_FIGY_BERRY') // this script never removes BS_SCRIPTING
    expect(rng.calls).toBe(4)
  })

  it('negative control: Hardy (neutral) heals and consumes its own berry with nobody confused', () => {
    // BattleScript_ItemHealHP_RemoveItemRet's `removeitem BS_SCRIPTING` (s:10870) is the eater.
    const rng = scriptedRng([0, 1, 0])
    const state = figyBattle('NATURE_HARDY', rng, { ability: 'ABILITY_ROUGH_SKIN', innates: [null, null, null] })
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps)

    const attacker = state.battlers[0]!
    const target = state.battlers[1]!
    expect(attacker.mon.hp).toBe(ATTACKER_AFTER_RECOIL + HEAL)
    expect(attacker.mon.itemId).toBeNull()
    expect(target.mon.itemId).toBe('ITEM_BIG_NUGGET')
    expect(getCounter(attacker.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(getCounter(target.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(rng.calls).toBe(3)
  })

  it('negative control 2: Shield Dust does NOT stop it -- the primary path skips the !primary gate', () => {
    // SetMoveEffect's Shield Dust / Covert Cloak gate (battle_script_commands.c:2348-2350) is
    // `!primary`, and Cmd_seteffectprimary (:3127-3130) calls SetMoveEffect(TRUE, 0). So the
    // confusion STILL lands, on the target, even with Shield Dust.
    const rng = scriptedRng([0, 1, 0, 0])
    const state = figyBattle('NATURE_BOLD', rng, {
      ability: 'ABILITY_ROUGH_SKIN',
      innates: ['ABILITY_SHIELD_DUST', null, null],
    })
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps)

    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(3)
    expect(getCounter(state.battlers[0]!.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (4) Camouflage fallback gap note
// ---------------------------------------------------------------------------
describe('Cycle 138 (4) Camouflage fallback note is restored and kept off the real resolver', () => {
  /** MOVEEND_PROTECT_LIKE_EFFECT (battle_script_commands.c:4415-4427) runs after a blocked attack;
   * none of these moves make contact, so `touchedProtectLike` is set by hand. Pixilate turns the
   * declared NORMAL Tackle FAIRY, which is what both resolvers must report. */
  function camouflage(makeDeps: (state: BattleState, rng: RandomSource) => TurnLoopDeps) {
    const rng = scriptedRng([])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { ...SLOW_STATS },
        abilities: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] },
        moves: ['MOVE_TACKLE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', {
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        rawStats: { ...FAST_STATS },
        moves: ['MOVE_CAMOUFLAGE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      rng,
    )
    const protector = state.battlers[1]!
    protector.round.protectMove = 'MOVE_CAMOUFLAGE'
    state.battlers[0]!.round.touchedProtectLike = true
    const notes: string[] = []
    handleProtectLikeMoveEnd(state, 0, 1, 'MOVE_TACKLE', makeDeps(state, rng), notes)
    return { protector, notes, rng }
  }

  it('the real bridge resolver answers the type and pushes no gap note', () => {
    const { protector, notes, rng } = camouflage((state, random) => loopDeps(state, bridgeDamage(state, random)))
    expect(protector.mon.types[2]).toBe('FAIRY')
    expect(notes.some((n) => n.includes('Camouflage'))).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('negative control: the stub resolver without moveType keeps the fallback note', () => {
    const { protector, notes } = camouflage((state) => loopDeps(state, NO_ENGINE))
    expect(protector.mon.types[2]).toBe('FAIRY') // onMoveType still answers the type itself
    expect(notes.some((n) => n.includes('Natural Gift'))).toBe(true)
  })
})
