/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 109: Cryo Architect (both halves), Aftermath's onDefender half (and Balloon Bomber's
// Aftermath half), Gulp Missile's onDefender half, Soothsayer's onAfterTypeEffectiveness feed,
// Acid Reflux's onReactive half, and Talon Trap's ON_EITHER wrap half.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - Impl<ABILITY_CRYO_ARCHITECT> (src/abilities.cc:9591-9638): onEndTurn :9592-9601, onDefender
//   :9602-9633. BattleScript_AttackerAbilityStatRaiseEnd3 (:10368) -> ...NoPopup (:10346-10353).
// - Impl<ABILITY_AFTERMATH>.onDefender (src/abilities.cc:1663-1670), reached from
//   Impl<ABILITY_BALLOON_BOMBER> (:7759-7762: `Aftermath.onDefender || Inflatable.onDefender`);
//   GetHighestAttackingStatId ties prefer Attack; UseOutOfTurnAttack's two moves are
//   MOVE_OUTBURST (special) / MOVE_EXPLOSION (physical), both 250 power, power overridden to 100.
// - Impl<ABILITY_GULP_MISSILE>.onDefender (src/abilities.cc:3289-3301); scripts
//   data/battle_scripts_1.s:7799-7836 (Gorging) / :7837-7881 (Gulping), including
//   `jumpifmagicguard BS_ATTACKER` (:7802/:7842), `getbattlerfainted BS_ATTACKER`
//   (:7808-7810/:7848-7850) and `jumpifholdeffect BS_ATTACKER, HOLD_EFFECT_CLEAR_AMULET` (:7850).
// - Impl<ABILITY_SOOTHSAYER>.onAfterTypeEffectiveness (src/abilities.cc:9449-9453): state 4 is
//   armed by onEntry (:9436-9441), ticked by onEndTurn (:9442-9448); `if (*mod >= UQ_4_12(1.0))
//   *mod = UQ_4_12(0.5)`. UQ_4_12 has PRECISION 10 (engine/fixed.ts), so 1.0 == 1024 and
//   0.5 == 512.
// - Impl<ABILITY_ACID_REFLUX> (src/abilities.cc:12252-12276): onEndTurn :12253-12258 moves the
//   live state into the once-per-turn counter, onReactive :12260-12276 queues MOVE_ACID at power
//   20 against BATTLE_OPPOSITE(battler).
// - Impl<ABILITY_TALON_TRAP> (src/abilities.cc:4713-4741): ON_EITHER (:53-54) body :4713-4730;
//   `WrapDuration` is battle_script_commands.c:2300-2309 (5 + Grappler(1) + 2*Grip Claw, else
//   Random()%2 + 4).
import { describe, expect, it } from 'vitest'

import { calculateMoveDamage } from '../calculate'
import { buildBattlerBattleState, buildFieldBattleState, type BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS1_PARALYSIS,
  STATUS2_WRAPPED,
  hasFlag,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { runReactiveAbilityEffects } from './statBuffs'
import { executeTurn, type TurnLoopDeps } from './turn'

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
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: rngSource,
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

function depsWith(holdEffectOf: (battlerId: number) => string | null): TurnLoopDeps {
  return { ...LOOP_DEPS, grounding: { ...GROUNDING, holdEffectOf } }
}

/** Battler 1's ability takes the hit; attacker 0 is the move user. */
function defenderHit(
  state: BattleState,
  moveId: string,
  targetDamage: number,
  deps: TurnLoopDeps = LOOP_DEPS,
  unmodelled: string[] = [],
  fainted: number[] = [],
) {
  return dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: DATA_CONTEXT.move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps,
    unmodelled,
    fainted,
  })
}

/** Battler 0's ability takes the hit it just dealt to battler 1. */
function attackerHit(state: BattleState, moveId: string, targetDamage: number, deps: TurnLoopDeps = LOOP_DEPS) {
  return dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: DATA_CONTEXT.move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps,
    unmodelled: [],
    fainted: [],
  })
}

// ---------------------------------------------------------------------------
// Cryo Architect (src/abilities.cc:9591-9638)
// ---------------------------------------------------------------------------
describe('Cycle 109 - Cryo Architect (abilities.cc:9591-9638)', () => {
  function cryoMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
    return monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_CRYO_ARCHITECT'), ...overrides })
  }

  /** Cryo Architect sits on the DEFENDER (battler 1); battler 0 is the move user. */
  function cryoBattle(overrides: Partial<SimBattleMon> = {}): BattleState {
    return battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), cryoMon(overrides))
  }

  it('an Ice hit raises Def and Atk by one stage immediately (:9617-9628)', () => {
    const state = cryoBattle()
    const result = defenderHit(state, 'MOVE_ICE_BEAM', 10)

    // SetStatChanger(STAT_DEF, 1) (:9618) and SetStatChanger(STAT_ATK, 1) (:9625), both through
    // BattleScript_TargetAbilityStatRaiseOnMoveEnd == ChangeStatBuffs.
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(result.statChanges).toEqual([
      { battlerId: 1, stat: STAT_DEF, change: 1 },
      { battlerId: 1, stat: STAT_ATK, change: 1 },
    ])
    // No state is armed: only the WATER branch writes the bit (:9612-9615).
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
  })

  it('a Water hit only arms bit 1 (state = 2) and raises Atk now; Def comes two end turns later', () => {
    const state = cryoBattle()
    defenderHit(state, 'MOVE_WATER_GUN', 10)

    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(2) // 1 << 1 (:9614)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    // onEndTurn (:9594-9598): 2 & 1 == 0 -> state becomes 2 >> 1 == 1, nothing raises.
    executeTurn(state, [null, null], LOOP_DEPS)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)

    // Next end turn: 1 & 1 == 1 -> state becomes 0, Def +1.
    executeTurn(state, [null, null], LOOP_DEPS)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('a maxed Def skips only the Def branch: Atk still rises, and a Water hit arms nothing', () => {
    // createBattlerState resets statStages to the neutral set (create.ts:370), so the stage is
    // written on the live battler.
    const ice = cryoBattle()
    ice.battlers[1]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    defenderHit(ice, 'MOVE_ICE_BEAM', 10)
    expect(ice.battlers[1]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(ice.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const water = cryoBattle()
    water.battlers[1]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    defenderHit(water, 'MOVE_WATER_GUN', 10)
    expect(water.battlers[1]!.volatiles.abilityState[0]).toBe(0) // :9611 gate failed, no arm
    expect(water.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('the end-turn state is consumed before the Def check, so a maxed Def still spends the armed bit', () => {
    const state = cryoBattle()
    state.battlers[1]!.volatiles.abilityState[0] = 1
    state.battlers[1]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    executeTurn(state, [null, null], LOOP_DEPS)
    // SetAbilityState(abilityState >> 1) (:9597) runs before CHECK(CompareStat(...)) (:9599).
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
  })

  it('ignores a non-Water/Ice move, a miss/zero damage, and a fainted holder', () => {
    const other = cryoBattle()
    defenderHit(other, 'MOVE_TACKLE', 10)
    expect(other.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(other.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(other.battlers[1]!.volatiles.abilityState[0]).toBe(0)

    const zero = cryoBattle()
    defenderHit(zero, 'MOVE_ICE_BEAM', 0)
    expect(zero.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)

    const fainted = cryoBattle()
    fainted.battlers[1]!.mon.hp = 0
    defenderHit(fainted, 'MOVE_ICE_BEAM', 10)
    expect(fainted.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(fainted.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// Aftermath (src/abilities.cc:1663-1670) and Balloon Bomber (:7759-7762)
// ---------------------------------------------------------------------------
describe('Cycle 109 - Aftermath (abilities.cc:1663-1670)', () => {
  /** Aftermath sits on the DEFENDER (battler 1); battler 0 is the move user. */
  function aftermathBattle(overrides: Partial<SimBattleMon> = {}): BattleState {
    return battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_AFTERMATH'), ...overrides }))
  }

  it('queues Explosion at power 100 when the fainted holder attacks with a higher Attack', () => {
    const state = aftermathBattle()
    state.battlers[1]!.mon.hp = 0
    defenderHit(state, 'MOVE_TACKLE', 10)

    // GetHighestAttackingStatId ties prefer Attack (`>` at statBuffs.ts:419) and UseOutOfTurnAttack
    // receives attackPower 100. Both moves exist at 250 power; the 100 override is the queued power.
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_AFTERMATH', move: 'MOVE_EXPLOSION', attacker: 1, target: 0, movePower: 100 },
    ])
  })

  it('uses Outburst when Sp. Atk is higher', () => {
    const state = aftermathBattle({ rawStats: { atk: 50, def: 100, spatk: 150, spdef: 100, spe: 100 } })
    state.battlers[1]!.mon.hp = 0
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.queuedExtraAttacks[0]!.move).toBe('MOVE_OUTBURST')
  })

  it('does nothing while the holder is alive or the move dealt no damage', () => {
    const alive = aftermathBattle()
    defenderHit(alive, 'MOVE_TACKLE', 10)
    expect(alive.queuedExtraAttacks).toHaveLength(0)

    const noDamage = aftermathBattle()
    noDamage.battlers[1]!.mon.hp = 0
    defenderHit(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.queuedExtraAttacks).toHaveLength(0)
  })

  it("Balloon Bomber's `||` runs the same Aftermath body, tagged with its own id", () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BALLOON_BOMBER') }),
    )
    state.battlers[1]!.mon.hp = 0
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_BALLOON_BOMBER', move: 'MOVE_EXPLOSION', attacker: 1, target: 0, movePower: 100 },
    ])
  })
})

// ---------------------------------------------------------------------------
// Gulp Missile (src/abilities.cc:3289-3301, battle_scripts_1.s:7799-7881)
// ---------------------------------------------------------------------------
describe('Cycle 109 - Gulp Missile onDefender (abilities.cc:3289-3301)', () => {
  function gulpMon(form: 'SPECIES_CRAMORANT_GORGING' | 'SPECIES_CRAMORANT_GULPING'): SimBattleMon {
    // GULP_MISSILE is innate[0] on all three forms (species.json), so it survives the revert to
    // SPECIES_CRAMORANT that changeBattlerForm performs.
    return monFor(form)
  }

  it('Gulping reverts the holder and drops the attacker Def by one', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), gulpMon('SPECIES_CRAMORANT_GULPING'))
    const result = defenderHit(state, 'MOVE_TACKLE', 10)

    // gBattleMoveDamage = attacker.maxHP / 4 = 100 / 4 = 25 (:3294-3295).
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(result.attackerDamage).toBe(25)
    // The form write after the script (:3292-3293, :3296).
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
    // BattleScript_GulpMissileDoDefense (bs1:7852-7869): STAT_DEF, -1, STAT_BUFF_NOT_PROTECT_AFFECTED.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).toBe(0)
  })

  it('Gorging reverts the holder and paralyses the attacker', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), gulpMon('SPECIES_CRAMORANT_GORGING'))
    const result = defenderHit(state, 'MOVE_TACKLE', 10)

    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
    // BattleScript_GulpMissileDoParalyze (bs1:7821-7835).
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('damage floors at 1 when maxHP / 4 truncates to zero', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, maxHp: 2, hp: 2 }),
      gulpMon('SPECIES_CRAMORANT_GULPING'),
    )
    const result = defenderHit(state, 'MOVE_TACKLE', 10)
    // max(1, floor(2 / 4)) == 1.
    expect(state.battlers[0]!.mon.hp).toBe(1)
    expect(result.attackerDamage).toBe(1)
  })

  it('Magic Guard (jumpifmagicguard BS_ATTACKER) skips the damage but not the revert or the effect', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_MAGIC_GUARD') }),
      gulpMon('SPECIES_CRAMORANT_GULPING'),
    )
    const result = defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(result.attackerDamage).toBe(0)
    // The script's jump lands AFTER the form change (bs1:7819/7833), so the revert still happens.
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('Clear Amulet blocks the Gulping Def drop (bs1:7850) but not the damage', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), gulpMon('SPECIES_CRAMORANT_GULPING'))
    defenderHit(state, 'MOVE_TACKLE', 10, depsWith((id) => (id === 0 ? 'HOLD_EFFECT_CLEAR_AMULET' : null)))
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('a fainted attacker takes the damage but gets no paralysis (getbattlerfainted jump, bs1:7808-7810)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, hp: 20 }),
      gulpMon('SPECIES_CRAMORANT_GORGING'),
    )
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
  })

  it('does nothing for a base Cramorant, a zero-damage hit, or a fainted attacker at entry', () => {
    const base = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), monFor('SPECIES_CRAMORANT'))
    defenderHit(base, 'MOVE_TACKLE', 10)
    expect(base.battlers[0]!.mon.hp).toBe(100)
    expect(base.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')

    const zero = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), gulpMon('SPECIES_CRAMORANT_GULPING'))
    zero.battlers[0]!.mon.hp = 0
    defenderHit(zero, 'MOVE_TACKLE', 0)
    expect(zero.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
  })
})

// ---------------------------------------------------------------------------
// Soothsayer (src/abilities.cc:9449-9453) through bridge.ts's defender.abilityOn
// ---------------------------------------------------------------------------
describe('Cycle 109 - Soothsayer type-effectiveness feed (abilities.cc:9449-9453)', () => {
  const BRIDGE_DEPS: BridgeDeps = {
    grounding: GROUNDING,
    turnOrder: simData.turnOrder,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }

  function soothsayerState(defenderSpecies: string): BattleState {
    return battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor(defenderSpecies, { abilities: ability('ABILITY_SOOTHSAYER') }),
    )
  }

  function calcDamage(state: BattleState, moveId: string) {
    const roles = { attackerId: 0, defenderId: 1 }
    const attacker = buildBattlerBattleState(state, 0, roles, BRIDGE_DEPS)
    const defender = buildBattlerBattleState(state, 1, roles, BRIDGE_DEPS)
    const field = buildFieldBattleState(state, roles, BRIDGE_DEPS)
    const move = simData.moveData(moveId)
    if (!move) throw new Error(`moves.json has no ${moveId}`)
    const result = calculateMoveDamage({
      move,
      attacker: attacker.battler,
      defender: defender.battler,
      field: field.field,
      typeChart: simData.typeChart,
      inverseTypeChart: simData.inverseTypeChart,
      moveBehaviors: simData.moveBehaviors,
      battleConstants: simData.battleConstants,
      attackerActsFirst: true,
      sameMoveTurnsInARow: 0,
      hitCount: 1,
      defenderIsSwitching: false,
      magnitudeTier: null,
      attackerRolloutCounter: 0,
      attackerHasDefenseCurl: false,
      attackerWasHitThisTurn: false,
      beatUpBaseAttack: attacker.battler.rawStats.atk,
      beatUpHitCount: 1,
      defenderUsedGlaiveRush: false,
    })
    return { result, defenderAbilityOn: defender.battler.abilityOn }
  }

  it('state 4 (armed by onEntry, :9440) halves a super-effective hit from 2.0 to 0.5', () => {
    const state = soothsayerState('SPECIES_TREECKO')
    const off = calcDamage(state, 'MOVE_FLAMETHROWER') // Fire vs Grass == 2.0
    expect(off.defenderAbilityOn).toBe(false)
    expect(off.result.typeEffectiveness).toBe(2048) // uq(2.0)

    state.battlers[1]!.volatiles.abilityState[0] = 4
    const on = calcDamage(state, 'MOVE_FLAMETHROWER')
    expect(on.defenderAbilityOn).toBe(true)
    // `*mod = UQ_4_12(0.5)` (:9452) == 512.
    expect(on.result.typeEffectiveness).toBe(512)
    expect(on.result.rolls[0]).toBeLessThan(off.result.rolls[0]!)
  })

  it('neutral (1.0 >= 1.0) also becomes 0.5, while a resisted 0.5 stays untouched', () => {
    const state = soothsayerState('SPECIES_TREECKO')
    const neutral = calcDamage(state, 'MOVE_TACKLE') // Normal vs Grass == 1.0
    expect(neutral.result.typeEffectiveness).toBe(1024)
    state.battlers[1]!.volatiles.abilityState[0] = 4
    expect(calcDamage(state, 'MOVE_TACKLE').result.typeEffectiveness).toBe(512)

    // Fire vs a Water defender is 0.5 (512): the `>= 1.0` gate skips it.
    const resisted = soothsayerState('SPECIES_MUDKIP')
    resisted.battlers[1]!.volatiles.abilityState[0] = 4
    expect(calcDamage(resisted, 'MOVE_FLAMETHROWER').result.typeEffectiveness).toBe(512)
  })

  it('state 0 leaves the modifier alone', () => {
    const state = soothsayerState('SPECIES_TREECKO')
    expect(calcDamage(state, 'MOVE_FLAMETHROWER').result.typeEffectiveness).toBe(2048)
  })
})

// ---------------------------------------------------------------------------
// Acid Reflux (src/abilities.cc:12252-12276)
// ---------------------------------------------------------------------------
describe('Cycle 109 - Acid Reflux onReactive (abilities.cc:12260-12276)', () => {
  const REACTIVE_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

  function acidMon(): SimBattleMon {
    return monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_ACID_REFLUX') })
  }

  it('queues MOVE_ACID at power 20 against BATTLE_OPPOSITE(battler) when the holder was damaged', () => {
    const state = battle(acidMon())
    state.battlers[0]!.round.damaged = true

    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(true)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_ACID_REFLUX', move: 'MOVE_ACID', movePower: 20, attacker: 0, target: 1 },
    ])
    // SetAbilityState(TRUE) before queueing (:12265).
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)

    // CHECK_NOT(GetAbilityState) blocks a second queue in the same turn.
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.queuedExtraAttacks).toHaveLength(1)
  })

  it('does nothing when the holder was not damaged', () => {
    const state = battle(acidMon())
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.queuedExtraAttacks).toHaveLength(0)
  })

  it('the once-per-turn counter blocks a later queue and is cleared by the next turn (turnStructsClear)', () => {
    const state = battle(acidMon())
    state.battlers[0]!.round.damaged = true

    // A quiet turn runs the end-turn phase: the reactive pass queues once, then onEndTurn
    // (:12253-12258) copies the live state into the once-per-turn counter and clears it.
    executeTurn(state, [null, null], LOOP_DEPS)
    expect(state.battlers[0]!.turn.turnAbilityTriggers[0]).toBe(1)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)

    // Damage later in the end-turn phase cannot queue again: CHECK_NOT(GetOncePerTurnAbilityCounter).
    state.battlers[0]!.round.damaged = true
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(false)
    expect(state.queuedExtraAttacks).toHaveLength(0)

    // Next turn: turnStructsClear (turn.ts:669-671) rebuilds battler.turn via createTurnState, so
    // the counter is gone -- but the end turn only rewrites it from the (zero) live state.
    state.battlers[0]!.round.damaged = false
    executeTurn(state, [null, null], LOOP_DEPS)
    expect(state.battlers[0]!.turn.turnAbilityTriggers[0]).toBe(0)

    state.battlers[0]!.round.damaged = true
    expect(runReactiveAbilityEffects(state, REACTIVE_DEPS, [])).toBe(true)
    expect(state.queuedExtraAttacks).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Talon Trap (src/abilities.cc:4713-4730, 4732-4741)
// ---------------------------------------------------------------------------
describe('Cycle 109 - Talon Trap ON_EITHER wrap (abilities.cc:4713-4730)', () => {
  function trapMon(): SimBattleMon {
    return monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_TALON_TRAP') })
  }

  function trap(seed: number[] = []) {
    const rng = seed.length ? scriptedRng(seed) : countingRng()
    // Defender half: holder = battler 1, opponent = attacker 0.
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), trapMon(), rng)
    return { state, rng }
  }

  it('wraps a contact attacker: STATUS2_WRAPPED, wrappedMove/wrappedBy, wrapTurns = Random()%2 + 4', () => {
    const { state, rng } = trap([49, 1])
    // First draw: 49 % 100 < 50 passes the :4720 gate. Second draw: 1 % 2 + 4 == 5.
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(2)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(state.wrappedMove[0]).toBe('MOVE_SNAP_TRAP')
    expect(state.wrappedBy[0]).toBe(1)
    expect(state.battlers[0]!.volatiles.wrapAbility).toBe('ABILITY_TALON_TRAP')
    expect(state.battlers[0]!.volatiles.wrapTurns).toBe(5)
  })

  it('a 50% roll at or above 50 does not wrap and consumes no duration draw', () => {
    const { state, rng } = trap([50, 1])
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(1)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(state.battlers[0]!.volatiles.wrapTurns).toBe(0)
  })

  it('isFirstTurn == 2 skips the 50% draw entirely (only the duration draw remains)', () => {
    const { state, rng } = trap([1])
    state.battlers[1]!.volatiles.isFirstTurn = 2
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(1) // only WrapDuration
    expect(state.battlers[0]!.volatiles.wrapTurns).toBe(5)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
  })

  it('a set ability state skips the 50% draw too', () => {
    const { state, rng } = trap([1])
    state.battlers[1]!.volatiles.abilityState[0] = 1
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(1)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
  })

  it('needs contact, a live holder, a live opponent, and an unwrapped opponent', () => {
    // Non-contact move.
    const special = trap()
    defenderHit(special.state, 'MOVE_WATER_GUN', 10)
    expect(special.rng.calls).toBe(0)
    expect(hasFlag(special.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)

    // Fainted holder (IsBattlerAlive(battler), :4717).
    const dead = trap()
    dead.state.battlers[1]!.mon.hp = 0
    defenderHit(dead.state, 'MOVE_TACKLE', 10)
    expect(dead.rng.calls).toBe(0)

    // Fainted attacker: ShouldApplyOnHitEffect(opponent) fails (:4715).
    const deadFoe = trap()
    deadFoe.state.battlers[0]!.mon.hp = 0
    defenderHit(deadFoe.state, 'MOVE_TACKLE', 10)
    expect(deadFoe.rng.calls).toBe(0)

    // Already wrapped.
    const wrapped = trap()
    wrapped.state.battlers[0]!.mon.status2 = STATUS2_WRAPPED
    defenderHit(wrapped.state, 'MOVE_TACKLE', 10)
    expect(wrapped.rng.calls).toBe(0)
    expect(wrapped.state.battlers[0]!.volatiles.wrapTurns).toBe(0)
  })

  it('the onAttacker half wraps the target instead (holder = attacker)', () => {
    const rng = scriptedRng([49, 0])
    const state = battle(trapMon(), monFor('SPECIES_MUDKIP', { abilities: noAbility }), rng)
    attackerHit(state, 'MOVE_TACKLE', 10)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(state.wrappedBy[1]).toBe(0)
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(4)
  })

  it('Grip Claw sets WrapDuration to 5 + 2 = 7 and draws nothing', () => {
    const rng = countingRng()
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), trapMon(), rng)
    defenderHit(state, 'MOVE_TACKLE', 10, depsWith((id) => (id === 1 ? 'HOLD_EFFECT_GRIP_CLAW' : null)))
    // Only the 50% roll is drawn (the holder has no Grappler); duration is 5 + 2.
    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.volatiles.wrapTurns).toBe(7)
  })

  it('a battler without the ability is untouched', () => {
    const rng = countingRng()
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: noAbility }), monFor('SPECIES_MUDKIP', { abilities: noAbility }), rng)
    defenderHit(state, 'MOVE_TACKLE', 10)
    expect(rng.calls).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
  })
})
