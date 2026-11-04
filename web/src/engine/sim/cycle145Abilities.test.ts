/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 145: the defender halves of Arc Flash, Blood Stain, Daybreak, Emergency Exit,
// Menacing Situation, Patchwork, Wimp Out and Woodland Curse.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - Impl<ABILITY_ARC_FLASH>.onDefender (src/abilities.cc:8090-8098): ShouldApplyOnHitEffect(attacker),
//   CanBeBurned(attacker), then `CHECK(Random() % 2)`, then AbilityStatusEffect(MOVE_EFFECT_BURN |
//   MOVE_EFFECT_AFFECTS_USER) (:263-268) -- the burn lands on the move's attacker. The draw is only
//   taken after the first two checks pass, so a burned or Fire-type attacker consumes none.
// - ON_EITHER(BloodStain) (src/abilities.cc:8372-8385, assigned to both hooks by :54). On the defender
//   path `opponent` is the move's attacker: contact + not persistent/unsuppressable + no ability
//   ignoring suppression + no Ability Shield, then UpdateAbilityStateIndicesForNewAbility / ReplaceAbility
//   / DisableSwitchInAbility (:8379-8384). No rng.
// - ON_EITHER(Daybreak) (src/abilities.cc:9193-9200): ShouldApplyOnHitEffect(opponent), CanBeBurned,
//   contact, then AbilityStatusEffectSafe(MOVE_EFFECT_BURN, battler, opponent) (:277-283) -- the Safe
//   variant points gBattlerAttacker at the holder and gBattlerTarget at the attacker, so the burn is
//   applied by the holder to the attacker. No roll.
// - ON_EITHER(MenacingSituation) (src/abilities.cc:7904-7919): ShouldApplyOnHitEffect(opponent),
//   contact, CHECK_NOT(gVolatileStructs[opponent].fear), CHECK(Random() % 100 < 30), then
//   BattleScript_AbilitySetFear (data/battle_scripts_1.s:10600-10605): gBattlerAttacker = gStackBattler1
//   = holder, gBattlerTarget = gStackBattler2 = attacker, MOVE_EFFECT_FEAR on the attacker.
// - ON_EITHER(WoodlandCurse) (src/abilities.cc:9835-9846): ShouldApplyOnHitEffect(opponent), contact,
//   CHECK_NOT(IS_BATTLER_OF_TYPE(opponent, TYPE_GRASS)), then `gBattleMons[opponent].type3 = TYPE_GRASS`
//   (:9842). BattleScript_StackAddedTheTypeRet (:9162) is the message alone.
// - Impl<ABILITY_WIMP_OUT>.onDefender (src/abilities.cc:2616-2643) and Impl<ABILITY_EMERGENCY_EXIT>
//   (:2645-2647, reusing Wimp Out's lambda): CheckHalfHpAbility (battle_util.c:9043-9048),
//   !TestSheerForceFlag(attacker, gCurrentMove), CanBattlerBeForceSwitched (abilities.cc:2608-2616),
//   then TryScheduleSwitch with switchingBattler = sourceBattler = the holder (:2632-2638).
// - Impl<ABILITY_PATCHWORK>.onDefender (src/abilities.cc:8645-8655): the once-per-turn counter minus one
//   must equal the attacker, the counter is reset, then IsBattlerAlive(attacker) / not STATUS2_CURSED,
//   then AbilityStatusEffect(MOVE_EFFECT_CURSE | MOVE_EFFECT_AFFECTS_USER) -- the curse lands on the
//   move's attacker (battle_script_commands.c:2330-2343, :2721-2726). The counter's only in-play writer
//   is onDisguise (:8638-8644); the sim has no Disguise bust hook, so the counter is never written in play and tests set it directly.
// The driver's import order initialises the stat MOVE_EFFECT_* constants before moveEffects.ts
// builds SECONDARY_MOVE_EFFECT_MAP; without it every secondary effect's number is undefined and
// Body Slam's 30% does not draw (driver/secondaryMap.test.ts pins the same requirement).
import './driver/session'
import { describe, expect, it } from 'vitest'

import { BATTLE_TYPE_TRAINER, STATUS1_BURN, STATUS2_CURSED, STATUS4_FEAR, hasFlag } from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { drainQueuedSwitches, executeTurn, type DamageResolver, type TurnLoopDeps } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: s.abilities[0] ?? null,
      innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function ability(id: string): SimBattleMon['abilities'] {
  return { ability: id, innates: [null, null, null] }
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
    abilities: noAbility,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
  }
}

interface CountingRng extends RandomSource {
  calls: number
}

function countingRng(): CountingRng {
  const rng: CountingRng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function scriptedRng(rolls: number[]): CountingRng {
  const rng: CountingRng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return rolls[rng.calls - 1] ?? 0
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  rngSource: RandomSource = { random16: () => 0 },
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: rngSource,
    ...opts,
  })
}

const DUMMY_DAMAGE = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
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

function turnDeps(amount: number): TurnLoopDeps {
  return { ...LOOP_DEPS, damage: fixedDamage(amount) }
}

function move(id: string) {
  const m = DATA_CONTEXT.move(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return m
}

function useMove(target: number, moveId: string): ChosenAction {
  const moveData = move(moveId)
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

/** Battler 1's ability takes the hit; attacker 0 is the move user. */
function defenderHit(
  state: BattleState,
  moveId: string,
  targetDamage: number,
  deps: TurnLoopDeps = LOOP_DEPS,
  unmodelled: string[] = [],
  fainted: number[] = [],
  hpDealt: number = targetDamage,
) {
  return dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: DATA_CONTEXT.move(moveId),
    targetDamage,
    hpDealt,
    deps,
    unmodelled,
    fainted,
  })
}

const CYCLE145_IDS = [
  'ABILITY_ARC_FLASH',
  'ABILITY_BLOOD_STAIN',
  'ABILITY_DAYBREAK',
  'ABILITY_EMERGENCY_EXIT',
  'ABILITY_MENACING_SITUATION',
  'ABILITY_PATCHWORK',
  'ABILITY_WIMP_OUT',
  'ABILITY_WOODLAND_CURSE',
]

/** None of this cycle's ids may still be reported as an unmodelled defender hook. */
function expectNoDefenderGaps(unmodelled: string[]): void {
  for (const id of CYCLE145_IDS) {
    expect(unmodelled).not.toContain(`move-end defender ability ${id} is not modelled yet`)
  }
}

/** Defender-side holder with `abilityId` on battler 1. */
function holderBattle(abilityId: string, attackerOverrides: Partial<SimBattleMon> = {}, rng: RandomSource = { random16: () => 0 }, opts: { opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {}) {
  return battle(monFor('SPECIES_MUDKIP', { abilities: noAbility, ...attackerOverrides }), monFor('SPECIES_MUDKIP', { abilities: ability(abilityId) }), rng, opts)
}

// ---------------------------------------------------------------------------
// Arc Flash (src/abilities.cc:8090-8098)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Arc Flash onDefender (abilities.cc:8090-8098)', () => {
  it('a non-zero Random() % 2 burns the move attacker (MOVE_EFFECT_AFFECTS_USER)', () => {
    const rng = scriptedRng([1])
    const state = holderBattle('ABILITY_ARC_FLASH', {}, rng)
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(rng.calls).toBe(1)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'BURN' })
    expectNoDefenderGaps(unmodelled)
  })

  it('Random() % 2 == 0 does not burn and draws nothing more', () => {
    const rng = scriptedRng([0])
    const state = holderBattle('ABILITY_ARC_FLASH', {}, rng)
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('an already-burned attacker fails CanBeBurned before the draw', () => {
    const rng = scriptedRng([1])
    const state = holderBattle('ABILITY_ARC_FLASH', { status1: STATUS1_BURN }, rng)
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(0)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('a Fire-type attacker fails CanBeBurned before the draw', () => {
    const rng = scriptedRng([1])
    const state = holderBattle('ABILITY_ARC_FLASH', { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, rng)
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(0)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('in a full turn the draws are accuracy, the move secondary, then the ability roll', () => {
    // Body Slam (EFFECT_PARALYZE_HIT, 30%): 99 fails the secondary. Then Arc Flash's 1 burns.
    const rng = scriptedRng([0 /* accuracy */, 99 /* secondary */, 1 /* Arc Flash */])
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, moves: ['MOVE_BODY_SLAM', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_ARC_FLASH'), rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      rng,
    )
    executeTurn(state, [useMove(1, 'MOVE_BODY_SLAM'), null], turnDeps(10))
    // Unequal speeds keep getFastestBattler's tie-break draws out of the count.
    expect(rng.calls).toBe(3)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    // The secondary did not apply, so the holder is not paralysed.
    expect(state.battlers[1]!.mon.status1).toBe(0)

    // Same script without the ability: only accuracy + secondary are drawn.
    const baselineRng = scriptedRng([0, 99])
    const baseline = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, moves: ['MOVE_BODY_SLAM', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { abilities: noAbility, rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      baselineRng,
    )
    executeTurn(baseline, [useMove(1, 'MOVE_BODY_SLAM'), null], turnDeps(10))
    expect(baselineRng.calls).toBe(2)
    expect(rng.calls - baselineRng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Blood Stain (src/abilities.cc:8372-8385)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Blood Stain onDefender (abilities.cc:8372-8385)', () => {
  function stainBattle(attackerOverrides: Partial<SimBattleMon> = {}) {
    return battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_BLAZE', innates: [null, null, null] }, ...attackerOverrides }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
    )
  }

  it('replaces a contact attacker\'s ability and disables its switch-in', () => {
    const state = stainBattle()
    // A live ability-state array on the old ability must not follow the replacement verbatim:
    // UpdateAbilityStateIndicesForNewAbility (battle_util.c:8819-8862) only copies a matching slot.
    state.battlers[0]!.volatiles.abilityState[0] = 5
    state.battlers[0]!.turn.turnAbilityTriggers[0] = 3

    const unmodelled: string[] = []
    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLOOD_STAIN')
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    expect(state.battlers[0]!.turn.turnAbilityTriggers[0]).toBe(0)
    // DisableSwitchInAbility (:3922-3927) marks the new slot.
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[0]).toBe(true)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_BLOOD_STAIN')
    expectNoDefenderGaps(unmodelled)
  })

  it('a persistent/unsuppressable attacker ability blocks the replacement', () => {
    const state = stainBattle({ abilities: { ability: 'ABILITY_MULTITYPE', innates: [null, null, null] } })
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
  })

  it('a non-contact move does not replace anything', () => {
    const state = stainBattle()
    defenderHit(state, 'MOVE_WATER_GUN', 10)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })
})

// ---------------------------------------------------------------------------
// Daybreak (src/abilities.cc:9193-9200)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Daybreak onDefender (abilities.cc:9193-9200)', () => {
  it('burns the contact attacker with no roll (AbilityStatusEffectSafe)', () => {
    const rng = countingRng()
    const state = holderBattle('ABILITY_DAYBREAK', {}, rng)
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(rng.calls).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'BURN' })
    expectNoDefenderGaps(unmodelled)
  })

  it('a non-contact move does not burn', () => {
    const state = holderBattle('ABILITY_DAYBREAK')
    defenderHit(state, 'MOVE_WATER_GUN', 10)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('a Fire-type attacker fails CanBeBurned', () => {
    const state = holderBattle('ABILITY_DAYBREAK', { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Menacing Situation (src/abilities.cc:7904-7919)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Menacing Situation onDefender (abilities.cc:7904-7919)', () => {
  function fearBattle(rng: RandomSource, attackerOverrides: Partial<SimBattleMon> = {}) {
    return holderBattle('ABILITY_MENACING_SITUATION', attackerOverrides, rng)
  }

  it('a contact hit rolls below 30 and sets Fear on the attacker', () => {
    const rng = scriptedRng([29])
    const state = fearBattle(rng)
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'FEAR' })
    expectNoDefenderGaps(unmodelled)
  })

  it('roll 30 fails the < 30 check', () => {
    const rng = scriptedRng([30])
    const state = fearBattle(rng)
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.volatiles.fear).toBe(false)
  })

  it('an attacker already carrying Fear draws nothing', () => {
    const rng = countingRng()
    const state = fearBattle(rng)
    state.battlers[0]!.volatiles.fear = true
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(0)
  })

  it('in a full turn the ability roll is drawn after accuracy and the move secondary', () => {
    const rng = scriptedRng([0 /* accuracy */, 99 /* secondary */, 10 /* Menacing Situation */])
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, moves: ['MOVE_BODY_SLAM', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_MENACING_SITUATION'), rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      rng,
    )
    executeTurn(state, [useMove(1, 'MOVE_BODY_SLAM'), null], turnDeps(10))
    // Unequal speeds keep getFastestBattler's tie-break draws out of the count.
    expect(rng.calls).toBe(3)
    expect(state.battlers[0]!.volatiles.fear).toBe(true)
    // The 99 secondary roll failed, so the holder is not paralysed: the third draw is Menacing's.
    expect(state.battlers[1]!.mon.status1).toBe(0)

    // Same script without the ability: only accuracy + secondary are drawn.
    const baselineRng = scriptedRng([0, 99])
    const baseline = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, moves: ['MOVE_BODY_SLAM', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { abilities: noAbility, rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      baselineRng,
    )
    executeTurn(baseline, [useMove(1, 'MOVE_BODY_SLAM'), null], turnDeps(10))
    expect(baselineRng.calls).toBe(2)
    expect(rng.calls - baselineRng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Woodland Curse (src/abilities.cc:9835-9846)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Woodland Curse onDefender (abilities.cc:9835-9846)', () => {
  it('writes GRASS into the attacker\'s type3', () => {
    const state = holderBattle('ABILITY_WOODLAND_CURSE', { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    const unmodelled: string[] = []
    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'GRASS'])
    expectNoDefenderGaps(unmodelled)
  })

  it('a Grass attacker is skipped (IS_BATTLER_OF_TYPE)', () => {
    const state = holderBattle('ABILITY_WOODLAND_CURSE', { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.battlers[0]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'MYSTERY'])
  })

  it('a non-contact move is skipped', () => {
    const state = holderBattle('ABILITY_WOODLAND_CURSE', { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    defenderHit(state, 'MOVE_WATER_GUN', 10)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// Wimp Out / Emergency Exit (src/abilities.cc:2616-2647)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Wimp Out / Emergency Exit onDefender (abilities.cc:2616-2647)', () => {
  const liveParty = (): SimPartyMon[] => [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]

  /** Holder (battler 1) at 40/100 after a 60-damage hit: above half before, below after. */
  function crossedBattle(abilityId: string, rng: RandomSource, drops: Partial<SimBattleMon> = {}) {
    const state = holderBattle(abilityId, {}, rng, { opponentParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER })
    state.battlers[1]!.mon.hp = 40
    Object.assign(state.battlers[1]!.mon, drops)
    return state
  }

  it('Wimp Out schedules a self-switch with sourceBattler = switchingBattler = the holder', () => {
    // Pick 0 is the current party slot and is rejected by the shared placeholder replacement selection loop;
    // pick 1 is taken. The hook itself draws nothing.
    const rng = scriptedRng([0 /* rejected */, 1 /* accepted */])
    const state = crossedBattle('ABILITY_WIMP_OUT', rng)
    const unmodelled: string[] = []
    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, unmodelled, [], 60)
    expect(rng.calls).toBe(0)

    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_WIMP_OUT', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])
    // The hook itself burns no ability state (unlike Restraining Order).
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expectNoDefenderGaps(unmodelled)

    // The drain runs the self-switch through the ordinary SWITCH_ABILITY filters and picks a reserve.
    drainQueuedSwitches(state, turnDeps(60), [])
    expect(state.battlers[1]!.partyIndex).toBe(1)
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(2)
  })

  it('Emergency Exit reuses Wimp Out\'s lambda and queues under its own id', () => {
    const state = crossedBattle('ABILITY_EMERGENCY_EXIT', scriptedRng([]))
    const unmodelled: string[] = []
    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, unmodelled, [], 60)
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_EMERGENCY_EXIT', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])
    expectNoDefenderGaps(unmodelled)
  })

  it('above half before the hit and still above after does not schedule', () => {
    const rng = scriptedRng([])
    const state = holderBattle('ABILITY_WIMP_OUT', {}, rng, { opponentParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER })
    // 100 -> 90, half is 50: CheckHalfHpAbility fails on the "at or below half" test.
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], turnDeps(10))
    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])

    // Wimp Out draws nothing: the same turn without the ability makes the same rng calls.
    const baselineRng = scriptedRng([])
    const baseline = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), monFor('SPECIES_MUDKIP', { abilities: noAbility }), baselineRng)
    executeTurn(baseline, [useMove(1, 'MOVE_TACKLE'), null], turnDeps(10))
    expect(rng.calls).toBe(baselineRng.calls)
  })

  it('a crossing hit is blocked when the attacker has Sheer Force on a boosted move', () => {
    const rng = scriptedRng([])
    const state = holderBattle(
      'ABILITY_WIMP_OUT',
      { abilities: ability('ABILITY_SHEER_FORCE') },
      rng,
      { opponentParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    state.battlers[1]!.mon.hp = 40
    defenderHit(state, 'MOVE_BODY_SLAM', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([])
  })

  it('a crossing hit with no usable party mon does not schedule', () => {
    const state = holderBattle('ABILITY_WIMP_OUT', {}, scriptedRng([]), {
      opponentParty: [partyMon('SPECIES_MUDKIP', 100)],
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    state.battlers[1]!.mon.hp = 40
    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([])
  })

  it('outside a trainer battle CanBattlerBeForceSwitched fails', () => {
    const state = holderBattle('ABILITY_WIMP_OUT', {}, scriptedRng([]), {
      opponentParty: liveParty(),
      battleTypeFlags: 0,
    })
    state.battlers[1]!.mon.hp = 40
    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Patchwork (src/abilities.cc:8645-8655)
// ---------------------------------------------------------------------------
describe('Cycle 145 - Patchwork onDefender (abilities.cc:8645-8655)', () => {
  function patchworkBattle() {
    return holderBattle('ABILITY_PATCHWORK')
  }

  it('curses the attacker the counter names and resets the counter', () => {
    const state = patchworkBattle()
    // onDisguise (:8641) writes gBattlerAttacker + 1; attacker 0 => 1.
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 1
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'CURSE' })
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
    expectNoDefenderGaps(unmodelled)
  })

  it('counter 0 means triggeringBattler -1 and does nothing', () => {
    const state = patchworkBattle()
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
  })

  it('a counter naming the wrong attacker does nothing and is not reset', () => {
    const state = patchworkBattle()
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 2 // triggeringBattler 1 != attacker 0
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(2)
  })

  it('an already-cursed attacker still has the counter reset (C order: reset before the check)', () => {
    const state = patchworkBattle()
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 1
    state.battlers[0]!.mon.status2 = STATUS2_CURSED
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
  })

  it('a fainted attacker still has the counter reset', () => {
    const state = patchworkBattle()
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 1
    state.battlers[0]!.mon.hp = 0
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
  })

  it('an attacker with Sheer Force on a boosted move is not cursed and the counter resets', () => {
    const state = holderBattle('ABILITY_PATCHWORK', { abilities: ability('ABILITY_SHEER_FORCE') })
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 1
    defenderHit(state, 'MOVE_BODY_SLAM', 10)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
  })
})

