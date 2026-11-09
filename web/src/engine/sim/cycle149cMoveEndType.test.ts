/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 149c: move end reads the STORED move type, not a re-resolution.
//
// Cmd_damagecalc writes `gBattleStruct->dynamicMoveType = moveType | 0x80` on EVERY damage
// calculation (battle_script_commands.c:1606-1612), and CalculateMoveDamage's type2 branch
// writes the type2 pick back into moveType (battle_util.c:7775-7785) before that. Cmd_moveend
// then reads the stored value through GET_MOVE_TYPE (battle_script_commands.c:4328,
// include/battle.h:735-741). It never re-resolves the type from post-hit state. These tests
// feed the damage step's reported type into move end (`resolvedMoveType`) and check the
// C-derived result, including the three ways a re-resolution used to read the wrong type:
// a type2 move's pick, Natural Gift's berry removed before move end, and an on-hit ability
// that changes the weather/terrain/ability slots before MOVEEND_RECOIL.
import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn, handleProtectLikeMoveEnd } from './turn'
import type { BridgeDeps } from './bridge'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import type { BattleState, RandomSource, SimBattleMon } from './state'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { ...STATS },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 300,
    maxHp: 300,
    itemId: null,
    statStages: [],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
    // Last, so an override wins AND is cloned.
    types: [...(overrides.types ?? [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'])] as [string, string, string],
  }
}

/** Slower than the attacker so battler 0 always acts (battler 1 has no action anyway). */
const defender = (overrides: Partial<SimBattleMon> = {}): SimBattleMon =>
  monFor('SPECIES_PORYGON', { rawStats: { ...STATS, spe: 50 }, ...overrides })

function scriptedRng(values: number[]): RandomSource {
  let idx = 0
  return { random16: () => values[idx++] ?? 0 }
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource = scriptedRng([])): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
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

function bridgeFor(state: BattleState): BridgeDeps {
  return {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
}

function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const bridgeDeps: BridgeDamageResolverDeps = {
    ...bridgeFor(state),
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(bridgeDeps)
}

/** Spreads the real bridge resolver and replaces only `resolve`, so every other method stays
 * real while the damage is the exact amount and the stored type the exact value under test.
 * `resolvedMoveType` is what Cmd_damagecalc would have written on that hit (:1606-1612). */
function fixedOnBridge(state: BattleState, amount: number, resolvedMoveType: string | null): DamageResolver {
  return {
    ...bridgeDamage(state, scriptedRng([])),
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
      resolvedMoveType,
    }),
  }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors: SIM.moveBehaviors,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

/** Runs one damaging move from battler 0 against `target`. */
function runWithOutcome(
  attacker: SimBattleMon,
  target: SimBattleMon,
  moveId: string,
  damage: number,
  resolvedMoveType: string | null,
  setup?: (state: BattleState) => void,
): { state: BattleState; out: ReturnType<typeof executeTurn> } {
  const state = battle(attacker, target)
  setup?.(state)
  const out = executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedOnBridge(state, damage, resolvedMoveType)))
  return { state, out }
}

/** Runs one damaging move from battler 0 against `target` and returns the post-turn state. */
function runAgainst(
  attacker: SimBattleMon,
  target: SimBattleMon,
  moveId: string,
  damage: number,
  resolvedMoveType: string | null,
  setup?: (state: BattleState) => void,
): BattleState {
  return runWithOutcome(attacker, target, moveId, damage, resolvedMoveType, setup).state
}

const has = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })
const moves = (moveId: string): Pick<SimBattleMon, 'moves' | 'pp'> => ({ moves: [moveId, null, null, null], pp: [20, 0, 0, 0] })
const attacker = (ability: string | null, moveId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon =>
  monFor('SPECIES_MUDKIP', { ...moves(moveId), abilities: has(ability), ...overrides })

const WATER_TYPES: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']
const PSYCHIC_TYPES: [string, string, string] = ['PSYCHIC', 'MYSTERY', 'MYSTERY']
const GRASS_TYPES: [string, string, string] = ['GRASS', 'MYSTERY', 'MYSTERY']

describe('cycle 149c - type2 moves use the damage step pick (battle_util.c:7775-7785)', () => {
  // Saber Slashes is Fire/Electric (moves.json). Into a Water target, Fire is 0.5x and
  // Electric is 2x (types.json), both with no STAB from a Water attacker and the same base
  // power, so `dmg2 > dmg` is true and Cmd_attackcanceler/damagecalc store ELECTRIC (:1048-1056,
  // :1606-1612). Electric Burst's hook (:4337) answers ELECTRIC and divides by 20 (:605-615).
  // Two hits of 100 -> savedDmg 200 -> max(floor(200/20),1) = 10 (:4474-4475).
  it('1. Saber Slashes into Water: Electric Burst takes max(200/20,1)=10; Infernal Rage (Fire) takes 0', () => {
    const water = defender({ types: WATER_TYPES })
    const probe = battle(attacker(null, 'MOVE_SABER_SLASHES'), water)
    const real = bridgeDamage(probe, scriptedRng([])).typeEffectiveness!(probe, 0, 1, 'MOVE_SABER_SLASHES')
    expect(real.effectiveMoveType).toBe('ELECTRIC')

    const burst = runAgainst(attacker('ABILITY_ELECTRIC_BURST', 'MOVE_SABER_SLASHES'), water, 'MOVE_SABER_SLASHES', 100, 'ELECTRIC')
    expect(burst.battlers[0]!.mon.hp).toBe(290) // 300 - 10

    // Negative: Infernal Rage answers only FIRE, and the stored type is ELECTRIC.
    const rage = runAgainst(attacker('ABILITY_INFERNAL_RAGE', 'MOVE_SABER_SLASHES'), water, 'MOVE_SABER_SLASHES', 100, 'ELECTRIC')
    expect(rage.battlers[0]!.mon.hp).toBe(300)
  })

  // Aura Wheel is Electric/Dark. Into a Psychic target Dark is 2x and Electric 1x, so the
  // type2 pick is DARK and Electric Burst gets nothing; into a Water target Electric is 2x and
  // Dark 1x, so the pick is ELECTRIC and the hook takes 5.
  it('2. Aura Wheel: DARK vs Psychic -> Electric Burst 0; ELECTRIC vs Water -> 5', () => {
    const dark = runAgainst(attacker('ABILITY_ELECTRIC_BURST', 'MOVE_AURA_WHEEL'), defender({ types: PSYCHIC_TYPES }), 'MOVE_AURA_WHEEL', 100, 'DARK')
    expect(dark.battlers[0]!.mon.hp).toBe(300)

    const electric = runAgainst(attacker('ABILITY_ELECTRIC_BURST', 'MOVE_AURA_WHEEL'), defender({ types: WATER_TYPES }), 'MOVE_AURA_WHEEL', 100, 'ELECTRIC')
    expect(electric.battlers[0]!.mon.hp).toBe(295) // 300 - max(floor(100/20),1)
  })
})

describe('cycle 149c - the stored type survives state changes before move end', () => {
  // Natural Gift's type comes from the held berry (battle_main.c:5133-5145), but
  // turn.ts removes the berry right after the hit (battle_scripts_1.s:3067-3068) before
  // runMoveEnd, so a re-resolution reads NORMAL. The damage step stored FIRE.
  it('3. Natural Gift + Leppa Berry (FIRE): Infernal Rage takes 5; without a berry it takes 0', () => {
    // items.json: ITEM_LEPPA_BERRY naturalGift type TYPE_FIRE.
    expect(DATA_CONTEXT.item('ITEM_LEPPA_BERRY')?.naturalGift?.type).toBe('TYPE_FIRE')

    const berry = runAgainst(
      attacker('ABILITY_INFERNAL_RAGE', 'MOVE_NATURAL_GIFT', { itemId: 'ITEM_LEPPA_BERRY' }),
      defender(),
      'MOVE_NATURAL_GIFT',
      100,
      'FIRE',
    )
    expect(berry.battlers[0]!.mon.hp).toBe(295)
    expect(berry.battlers[0]!.mon.itemId).toBeNull() // the berry is spent before move end

    const noBerry = runAgainst(attacker('ABILITY_INFERNAL_RAGE', 'MOVE_NATURAL_GIFT'), defender(), 'MOVE_NATURAL_GIFT', 100, 'NORMAL')
    expect(noBerry.battlers[0]!.mon.hp).toBe(300)
  })

  // Daredevil's IsRecklessBoosted (abilities.cc:463-470) calls the innate Infernal Rage's
  // onRecoil(100, battler, moveType) with the stored type, so the Leppa Berry's FIRE raises
  // Attack even though the berry is already gone; without it the stored NORMAL does not.
  it('4. Daredevil + innate Infernal Rage: Natural Gift/Leppa raises Attack; no berry does not', () => {
    const berried = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_NATURAL_GIFT'),
      itemId: 'ITEM_LEPPA_BERRY',
      abilities: { ability: 'ABILITY_DAREDEVIL', innates: ['ABILITY_INFERNAL_RAGE', null, null] },
    })
    const raised = runAgainst(berried, defender(), 'MOVE_NATURAL_GIFT', 100, 'FIRE')
    expect(raised.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const plain = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_NATURAL_GIFT'),
      abilities: { ability: 'ABILITY_DAREDEVIL', innates: ['ABILITY_INFERNAL_RAGE', null, null] },
    })
    const notRaised = runAgainst(plain, defender(), 'MOVE_NATURAL_GIFT', 100, 'NORMAL')
    expect(notRaised.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  // Sand Spit is a defender move-end ability (MOVEEND_ABILITIES, case 5) that runs before
  // MOVEEND_RECOIL (case 23). It sets sandstorm (abilities.cc:3317-3337), under which a
  // re-resolved Weather Ball would be ROCK; the stored type is FIRE from the sun.
  it('5. Weather Ball in sun into Sand Spit: Infernal Rage takes 5 despite the new sandstorm', () => {
    const target = defender({ abilities: has('ABILITY_SAND_SPIT') })
    // Rock attacker: immune to the end-of-turn sandstorm damage, so the HP delta is the recoil.
    const rock = monFor('SPECIES_MUDKIP', { ...moves('MOVE_WEATHER_BALL'), types: ['ROCK', 'MYSTERY', 'MYSTERY'], abilities: has('ABILITY_INFERNAL_RAGE') })
    const sunny = runAgainst(rock, target, 'MOVE_WEATHER_BALL', 100, 'FIRE', (s) => {
      s.field.weather = WEATHER_SUN_TEMPORARY
    })
    expect(hasFlag(sunny.field.weather, WEATHER_SANDSTORM_ANY)).toBe(true)
    expect(sunny.battlers[0]!.mon.hp).toBe(295)

    // Negative: with no sun the stored type is NORMAL, so the hook answers 0.
    const plain = runAgainst(rock, target, 'MOVE_WEATHER_BALL', 100, 'NORMAL')
    expect(hasFlag(plain.field.weather, WEATHER_SANDSTORM_ANY)).toBe(true)
    expect(plain.battlers[0]!.mon.hp).toBe(300)
  })

  // Seed Sower sets Grassy Terrain before move end (abilities.cc:6859-6866); a re-resolved
  // Terrain Pulse would then be GRASS, not the ELECTRIC the Electric Terrain gave it.
  it('6. Terrain Pulse under Electric Terrain into Seed Sower: Electric Burst takes 5', () => {
    const target = defender({ abilities: has('ABILITY_SEED_SOWER') })
    // Seed Sower's Grassy Terrain heals the grounded attacker 1/16 max HP at end of turn, so
    // read the move's own attackerDamage (the recoil) rather than the final HP.
    const terrain = runWithOutcome(attacker('ABILITY_ELECTRIC_BURST', 'MOVE_TERRAIN_PULSE'), target, 'MOVE_TERRAIN_PULSE', 100, 'ELECTRIC', (s) => {
      s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    })
    expect(hasFlag(terrain.state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(true)
    expect(terrain.out.actions[0]!.attackerDamage).toBe(5)

    const noTerrain = runWithOutcome(attacker('ABILITY_ELECTRIC_BURST', 'MOVE_TERRAIN_PULSE'), target, 'MOVE_TERRAIN_PULSE', 100, 'NORMAL')
    expect(noTerrain.out.actions[0]!.attackerDamage ?? 0).toBe(0)
  })

  // Mummy / Lingering Aroma replace the attacker's slot-0 ability before move end
  // (abilities.cc:2182-2195, :5826-5828). Replacing an Immolate (FIRE -ate) with Mummy makes
  // a re-resolution read NORMAL; the stored type is FIRE. Wandering Spirit swaps slot 0 the
  // same way (:3490-3515).
  it('7. Mummy / Lingering Aroma / Wandering Spirit replace Immolate after the hit: stored FIRE still takes 5', () => {
    for (const targetAbility of ['ABILITY_MUMMY', 'ABILITY_LINGERING_AROMA', 'ABILITY_WANDERING_SPIRIT'] as const) {
      const holder = monFor('SPECIES_MUDKIP', {
        ...moves('MOVE_TACKLE'),
        abilities: { ability: 'ABILITY_IMMOLATE', innates: ['ABILITY_INFERNAL_RAGE', null, null] },
      })
      const state = runAgainst(holder, defender({ abilities: has(targetAbility) }), 'MOVE_TACKLE', 100, 'FIRE')
      // The replacement really happened -- this is why re-resolving from move-end state read NORMAL.
      expect(state.battlers[0]!.mon.abilities.ability).toBe(targetAbility)
      expect(state.battlers[0]!.mon.hp).toBe(295)
    }

    // Negative: no Immolate, a plain Normal Tackle stores NORMAL and the hook answers 0.
    const plain = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_TACKLE'),
      abilities: { ability: null, innates: ['ABILITY_INFERNAL_RAGE', null, null] },
    })
    const plainState = runAgainst(plain, defender({ abilities: has('ABILITY_MUMMY') }), 'MOVE_TACKLE', 100, 'NORMAL')
    expect(plainState.battlers[0]!.mon.hp).toBe(300)
  })
})

describe('cycle 149c - the move-end type lookup only runs when a captured type is absent', () => {
  it('8. a plain Tackle with no onRecoil ability never calls deps.damage.moveType', () => {
    const state = battle(attacker(null, 'MOVE_TACKLE'), defender())
    const base = bridgeDamage(state, scriptedRng([]))
    let moveTypeCalls = 0
    const counting: DamageResolver = {
      ...base,
      resolve: () => ({
        targetDamage: 100,
        attackerDamage: null,
        unmodelled: [],
        resolvedMoveType: 'NORMAL',
      }),
      moveType: (...args) => {
        moveTypeCalls++
        return base.moveType!(...args)
      },
    }
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, counting))
    expect(moveTypeCalls).toBe(0)
    const notes = out.actions[0]!.unmodelled
    expect(notes.some((n) => n.includes('ghastlyEcho') || n.includes('safePassage') || n.includes('abilityOn'))).toBe(false)
  })
})

describe('cycle 149c - Camouflage stacks the type2 pick (battle_script_commands.c:1048-1056)', () => {
  // Cmd_attackcanceler runs BEFORE the protect check. For a type2 move with no
  // dynamicMoveType it calls CalculateMoveDamageAndEffectiveness and stores the higher-damage
  // type (battle_util.c:7775-7785). Camouflage's MOVEEND_PROTECT_LIKE_EFFECT case (:4415-4427)
  // reads that stored type through GET_MOVE_TYPE, not the declared Fire type.
  function camouflage(moveId: string, protectorTypes: [string, string, string]) {
    const state = battle(
      monFor('SPECIES_MUDKIP', { ...moves(moveId), rawStats: { ...STATS, spe: 50 } }),
      monFor('SPECIES_PORYGON', { types: protectorTypes, rawStats: { ...STATS, spe: 100 } }),
    )
    const target = state.battlers[1]!
    target.round.protectMove = 'MOVE_CAMOUFLAGE'
    state.battlers[0]!.round.touchedProtectLike = true
    const notes: string[] = []
    const deps = loopDeps(state, bridgeDamage(state, scriptedRng([])))
    handleProtectLikeMoveEnd(state, 0, 1, moveId, deps, notes)
    return { state, target, deps, notes }
  }

  it('9. Saber Slashes (Fire/Electric) into Water stacks ELECTRIC, not the declared FIRE', () => {
    expect(DATA_CONTEXT.move('MOVE_SABER_SLASHES')?.type).toBe('FIRE')
    expect(DATA_CONTEXT.move('MOVE_SABER_SLASHES')?.type2).toBe('ELECTRIC')

    const { state, target, deps } = camouflage('MOVE_SABER_SLASHES', WATER_TYPES)
    // Ground the hand derivation: the resolver's GetMoveTypeInternal answer alone is FIRE
    // (:5231-5253); the type2 pick is ELECTRIC because Electric is 2x and Fire 0.5x on Water.
    expect(deps.damage.moveType!(state, 0, 1, 'MOVE_SABER_SLASHES').moveType).toBe('FIRE')
    expect(target.mon.types[2]).toBe('ELECTRIC')
  })

  it('10. the rule is damage-based: into Grass, Fire is 2x and Electric 0.5x, so FIRE stays', () => {
    const { target } = camouflage('MOVE_SABER_SLASHES', GRASS_TYPES)
    expect(target.mon.types[2]).toBe('FIRE')
  })
})
