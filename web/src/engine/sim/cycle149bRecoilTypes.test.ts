/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 149b: MOVEEND_RECOIL and Daredevil read GET_MOVE_TYPE's RESOLVED move type.
//
// Cmd_moveend sets `moveType` with GET_MOVE_TYPE(gCurrentMove, moveType)
// (battle_script_commands.c:4328), and GET_MOVE_TYPE returns
// gBattleStruct->dynamicMoveType (include/battle.h:735-741) -- the type written by
// SetTypeBeforeUsingMove from GetMoveTypeInternal's full switch (battle_main.c:5093-5204,
// :5231-5253). The damage resolver's `moveType` is that same resolution, so these tests
// run every dynamic-type case through the bridge resolver. `fixedOnBridge` below spreads
// it and only replaces `resolve`, so `moveType` stays the real one and the damage is exact:
//     recoil = max(floor(D / N), 1), N from the ability's C source.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyPair, type AbilityHookRecord } from './driver/abilityHookInventory'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STATUS3_GASTRO_ACID,
  STATUS4_ELECTRIFIED,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_ION_DELUGE,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { BridgeDeps } from './bridge'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { getRecoilFraction, ON_RECOIL_ABILITIES } from './moveEnd'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
// `customBehavior` is `unknown` on MoveData but a plain JSON object here; the snapshot
// holds the MoveBehaviorEntry shape the sim's getRecoilFraction takes (as aiCheckBadMove.test.ts).
const rawMoves = snapshot<Array<Record<string, any>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityHooks = snapshot<Record<string, AbilityHookRecord>>('abilityHooks.json')

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

/** Spreads the real bridge resolver and replaces only `resolve`, so `moveType` is the
 * full GetMoveTypeInternal answer while the damage is the exact amount under test. */
function fixedOnBridge(state: BattleState, amount: number): DamageResolver {
  return {
    ...bridgeDamage(state, scriptedRng([])),
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

/** Runs one damaging move from battler 0 and returns the post-turn state. */
function run(attacker: SimBattleMon, moveId: string, damage: number, setup?: (state: BattleState) => void): BattleState {
  const state = battle(attacker, defender())
  setup?.(state)
  executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedOnBridge(state, damage)))
  return state
}

const has = (ability: string, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })
const moves = (moveId: string): Pick<SimBattleMon, 'moves' | 'pp'> => ({ moves: [moveId, null, null, null], pp: [20, 0, 0, 0] })
const attacker = (ability: string, moveId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon =>
  monFor('SPECIES_MUDKIP', { ...moves(moveId), abilities: has(ability), ...overrides })

describe('cycle 149b - MOVEEND_RECOIL reads GET_MOVE_TYPE (battle_script_commands.c:4328)', () => {
  // 1. Weather Ball (battle_main.c:5113-5122) + Infernal Rage (abilities.cc:5473-5478:
  //    CHECK(moveType == TYPE_FIRE); return max(damage / 20, 1)).
  it('1. Infernal Rage + Weather Ball in sun: FIRE, D=100 -> max(100/20,1)=5; no sun is NORMAL -> 0', () => {
    const a = attacker('ABILITY_INFERNAL_RAGE', 'MOVE_WEATHER_BALL')
    const sunny = run(a, 'MOVE_WEATHER_BALL', 100, (s) => {
      s.field.weather = WEATHER_SUN_TEMPORARY
    })
    expect(sunny.battlers[0]!.mon.hp).toBe(295) // 300 - 5

    const plain = run(a, 'MOVE_WEATHER_BALL', 100)
    expect(plain.battlers[0]!.mon.hp).toBe(300) // Normal, no hook
  })

  // 2. Hidden Power (battle_main.c:5129-5131 returns gBattleMons[battlerAtk].hpType).
  //    Doom Blast :9296-9301: DARK, damage/20. Dual Shadow :9566-9572: ELECTRIC|DARK, damage/10.
  it('2. Doom Blast + Dark Hidden Power -> 5; Dual Shadow + Electric -> 10; Fighting -> 0 for both', () => {
    const doom = attacker('ABILITY_DOOM_BLAST', 'MOVE_HIDDEN_POWER', { hiddenPowerType: 'DARK' })
    expect(run(doom, 'MOVE_HIDDEN_POWER', 100).battlers[0]!.mon.hp).toBe(295)

    const dualElectric = attacker('ABILITY_DUAL_SHADOW', 'MOVE_HIDDEN_POWER', { hiddenPowerType: 'ELECTRIC' })
    expect(run(dualElectric, 'MOVE_HIDDEN_POWER', 100).battlers[0]!.mon.hp).toBe(290) // max(100/10,1) = 10

    // Negative control: the same holders and move, Hidden Power Fighting matches neither list.
    const doomFighting = attacker('ABILITY_DOOM_BLAST', 'MOVE_HIDDEN_POWER', { hiddenPowerType: 'FIGHTING' })
    expect(run(doomFighting, 'MOVE_HIDDEN_POWER', 100).battlers[0]!.mon.hp).toBe(300)
    const dualFighting = attacker('ABILITY_DUAL_SHADOW', 'MOVE_HIDDEN_POWER', { hiddenPowerType: 'FIGHTING' })
    expect(run(dualFighting, 'MOVE_HIDDEN_POWER', 100).battlers[0]!.mon.hp).toBe(300)
  })

  // 3. Ion Deluge / Electrify (battle_main.c:5196-5198) retype before the effect switch
  //    returns; both make a Normal move ELECTRIC. Electric Burst :4336-4341: damage/20.
  it('3. Electric Burst + a Normal move under Electrify or Ion Deluge -> 5; without either -> 0', () => {
    const a = attacker('ABILITY_ELECTRIC_BURST', 'MOVE_TACKLE')

    const electrified = run(a, 'MOVE_TACKLE', 100, (s) => {
      s.battlers[0]!.statuses4 |= STATUS4_ELECTRIFIED
    })
    expect(electrified.battlers[0]!.mon.hp).toBe(295)

    const ionDeluge = run(a, 'MOVE_TACKLE', 100, (s) => {
      s.field.statuses |= STATUS_FIELD_ION_DELUGE
    })
    expect(ionDeluge.battlers[0]!.mon.hp).toBe(295)

    expect(run(a, 'MOVE_TACKLE', 100).battlers[0]!.mon.hp).toBe(300)
  })

  // 4. Terrain Pulse (battle_main.c:5173-5191) needs IsBattlerTerrainAffected:
  //    a grounded attacker under Electric Terrain becomes ELECTRIC.
  it('4. Electric Burst + Terrain Pulse under Electric Terrain on a grounded attacker -> 5; airborne or no terrain -> 0', () => {
    const grounded = attacker('ABILITY_ELECTRIC_BURST', 'MOVE_TERRAIN_PULSE')
    const terrain = run(grounded, 'MOVE_TERRAIN_PULSE', 100, (s) => {
      s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    })
    expect(terrain.battlers[0]!.mon.hp).toBe(295)

    // Flying-type attacker: REQUIRE(IsBattlerTerrainAffected) fails, declared NORMAL survives.
    const airborne = monFor('SPECIES_PIDGEY', { ...moves('MOVE_TERRAIN_PULSE'), abilities: has('ABILITY_ELECTRIC_BURST') })
    const airborneTerrain = run(airborne, 'MOVE_TERRAIN_PULSE', 100, (s) => {
      s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    })
    expect(airborneTerrain.battlers[0]!.mon.hp).toBe(300)

    // No terrain at all.
    expect(run(grounded, 'MOVE_TERRAIN_PULSE', 100).battlers[0]!.mon.hp).toBe(300)
  })

  // 5. Electrify retypes ANY move (battle_main.c:5197: `|| gStatuses4[battlerAtk] &
  //    STATUS4_ELECTRIFIED`), so an Electrified Flamethrower is ELECTRIC and Infernal
  //    Rage's CHECK(moveType == TYPE_FIRE) fails.
  it('5. Infernal Rage + an Electrified Flamethrower is ELECTRIC -> 0; the un-electrified move is FIRE -> 5', () => {
    const a = attacker('ABILITY_INFERNAL_RAGE', 'MOVE_FLAMETHROWER')
    const electrified = run(a, 'MOVE_FLAMETHROWER', 100, (s) => {
      s.battlers[0]!.statuses4 |= STATUS4_ELECTRIFIED
    })
    expect(electrified.battlers[0]!.mon.hp).toBe(300)

    expect(run(a, 'MOVE_FLAMETHROWER', 100).battlers[0]!.mon.hp).toBe(295)
  })

  // 6. Daredevil (abilities.cc:12382-12391) + IsRecklessBoosted (abilities.cc:463-470:
  //    an onRecoil ability that answers for this RESOLVED type). Super Strain is the
  //    type-agnostic control in case 8; here Infernal Rage as an innate sees Weather
  //    Ball's sun type through the same resolver.
  it('6. Daredevil + innate Infernal Rage: Weather Ball in sun raises Attack one stage; without sun it stays neutral', () => {
    const a = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_WEATHER_BALL'),
      abilities: { ability: 'ABILITY_DAREDEVIL', innates: ['ABILITY_INFERNAL_RAGE', null, null] },
    })
    const sunny = run(a, 'MOVE_WEATHER_BALL', 100, (s) => {
      s.field.weather = WEATHER_SUN_TEMPORARY
    })
    expect(sunny.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const plain = run(a, 'MOVE_WEATHER_BALL', 100)
    expect(plain.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('cycle 149b - the remaining MOVEEND_RECOIL cases', () => {
  // 7. Struggle bypasses the Magic Guard/noRecoil gate (battle_script_commands.c:4467).
  //    Struggle's own self-damage is its effect (MOVE_EFFECT_RECOIL_HP_25,
  //    battle_script_commands.c:2848-2853: maxHP / 4), which Magic Guard does not stop,
  //    and the bypass means a Super Strain innate still adds its hook on top.
  it('7. Struggle + Magic Guard still takes maxHP/4, and a Super Strain innate adds max(D/4,1)', () => {
    const magicGuard = monFor('SPECIES_MUDKIP', { ...moves('MOVE_STRUGGLE'), abilities: has('ABILITY_MAGIC_GUARD') })
    expect(run(magicGuard, 'MOVE_STRUGGLE', 40).battlers[0]!.mon.hp).toBe(225) // 300 - floor(300/4)=75

    const withStrain = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_STRUGGLE'),
      abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: ['ABILITY_SUPER_STRAIN', null, null] },
    })
    // 75 from Struggle's effect + max(floor(40/4),1)=10 from the onRecoil hook = 85.
    expect(run(withStrain, 'MOVE_STRUGGLE', 40).battlers[0]!.mon.hp).toBe(215)
  })

  // 8. Every matching onRecoil hook accumulates: `gBattleMoveDamage += damage`
  //    (battle_script_commands.c:4483-4490). Infernal Rage 100/20=5 + Super Strain 100/4=25.
  it('8. Infernal Rage (ability) + Super Strain (innate) with Flamethrower D=100 -> 5 + 25 = 30', () => {
    const a = monFor('SPECIES_MUDKIP', {
      ...moves('MOVE_FLAMETHROWER'),
      abilities: { ability: 'ABILITY_INFERNAL_RAGE', innates: ['ABILITY_SUPER_STRAIN', null, null] },
    })
    expect(run(a, 'MOVE_FLAMETHROWER', 100).battlers[0]!.mon.hp).toBe(270) // 300 - 30
  })

  // 9. IsSuppressed (battle_util.c:9254-9261) skips suppressed hooks. abilityHooks.json
  //    marks Dual Shadow `unsuppressable: TRUE` and does not mark Doom Blast.
  it('9. Gastro Acid stops Doom Blast but not the unsuppressable Dual Shadow', () => {
    expect(abilityHooks['ABILITY_DUAL_SHADOW']?.bitfields?.unsuppressable).toBe('TRUE')
    expect(abilityHooks['ABILITY_DOOM_BLAST']?.bitfields?.unsuppressable).toBeUndefined()

    const doom = attacker('ABILITY_DOOM_BLAST', 'MOVE_DARK_PULSE')
    const suppressed = run(doom, 'MOVE_DARK_PULSE', 100, (s) => {
      s.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    })
    expect(suppressed.battlers[0]!.mon.hp).toBe(300)

    const dual = attacker('ABILITY_DUAL_SHADOW', 'MOVE_THUNDERBOLT')
    const dualSuppressed = run(dual, 'MOVE_THUNDERBOLT', 100, (s) => {
      s.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    })
    expect(dualSuppressed.battlers[0]!.mon.hp).toBe(290) // max(100/10,1) = 10
  })

  // 10. Volt Tackle's recoil comes from its inline customBehavior, which the codegen
  //     makes gBattleMoves[MOVE_VOLT_TACKLE].effect (BattleMovesGenerator.kt:44).
  //     MoveList.textproto: `recoil_fraction: 4` ("25% recoil"), so D=90 -> 22.
  it('10. Volt Tackle reads customBehavior.attack.recoilFraction = 4: D=90 -> max(90/4,1) = 22', () => {
    const voltTackle = movesById.get('MOVE_VOLT_TACKLE')!
    expect((voltTackle.customBehavior as { attack: { recoilFraction: number } }).attack.recoilFraction).toBe(4)
    expect(getRecoilFraction('EFFECT_HIT', SIM.moveBehaviors, voltTackle.customBehavior)).toBe(4)

    expect(run(monFor('SPECIES_MUDKIP', moves('MOVE_VOLT_TACKLE')), 'MOVE_VOLT_TACKLE', 90).battlers[0]!.mon.hp).toBe(278)
  })

  // 11. Infernal Rage only answers Fire.
  it('11. Infernal Rage + a non-Fire move (Tackle) -> 0 hook recoil', () => {
    expect(run(attacker('ABILITY_INFERNAL_RAGE', 'MOVE_TACKLE'), 'MOVE_TACKLE', 100).battlers[0]!.mon.hp).toBe(300)
  })

  // 12. The audit/inventory is a SIM_AUDIT-gated driver run, not callable from a unit
  //     test; `classifyPair` is the exported classification the inventory uses, and
  //     cycle150bInventory.test.ts already pins it. All five onRecoil pairs are ported,
  //     so no "onRecoil is not modelled" note is raised for them.
  it('12. all five ON_RECOIL_ABILITIES classify as ported', () => {
    expect(ON_RECOIL_ABILITIES).toHaveLength(5)
    for (const id of ON_RECOIL_ABILITIES) {
      expect(classifyPair(id, 'onRecoil', abilityHooks)).toBe('ported')
    }
  })
})
