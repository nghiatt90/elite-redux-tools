/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { buildAccuracyInputs, executeTurn, getTotalAccuracy } from './turn'
import type { AccuracyInputs } from './accuracy'
import { getAbilityStateOf, setAbilityStateOf } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { STATUS2_CONFUSION } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle96Abilities.test.ts and cycle146Abilities.test.ts.
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
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
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
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
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
const hasAbility = (ability: string, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

function runTurn(attackerSpec: BattlerSpec, defenderSpec: BattlerSpec, moveId: string, dmg: number, rolls: number[] = [0, 0]) {
  const state = battle([
    { moves: [moveId, null, null, null], ...attackerSpec },
    defenderSpec,
  ], scriptedRng(rolls))
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, out }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 149 - onRecoil abilities and Commander onAccuracy', () => {
  // Case 1: Electric Burst (abilities.cc:4336-4341)
  // CHECK(moveType == TYPE_ELECTRIC); return max(damage / 20, 1);
  // Damage 200 dealt with Electric move (MOVE_THUNDERBOLT): max(200 / 20, 1) = 10 recoil.
  // With Fire move (MOVE_FLAMETHROWER): CHECK fails -> 0 recoil.
  it('1. Electric Burst: Electric move with no recoil fraction deals 200 HP -> max(200/20,1) = 10 recoil; Fire move -> 0 recoil', () => {
    const electricBurst = hasAbility('ABILITY_ELECTRIC_BURST')

    // Positive case: Thunderbolt (Electric) deals 200 HP -> recoil max(floor(200 / 20), 1) = 10.
    const { state: s1 } = runTurn({ abilities: electricBurst, hp: 300 }, { hp: 300 }, 'MOVE_THUNDERBOLT', 200)
    // 300 - 10 = 290
    expect(s1.battlers[0]!.mon.hp).toBe(290)

    // Negative case: Flamethrower (Fire) deals 200 HP -> 0 recoil.
    const { state: s2 } = runTurn({ abilities: electricBurst, hp: 300 }, { hp: 300 }, 'MOVE_FLAMETHROWER', 200)
    // 300 - 0 = 300
    expect(s2.battlers[0]!.mon.hp).toBe(300)
  })

  // Case 2: Infernal Rage (abilities.cc:5473-5478) with Flare Blitz
  // moves.json verifies Flare Blitz has customBehavior.attack.recoilFraction = 3 (fraction 3).
  // Saved damage = 90 HP.
  // Move recoil fraction: max(floor(90 / 3), 1) = 30.
  // Infernal Rage onRecoil: CHECK(moveType == TYPE_FIRE) passes -> max(floor(90 / 20), 1) = max(4, 1) = 4.
  // Total recoil = 30 + 4 = 34.
  it("2. Infernal Rage with Flare Blitz dealing 90 HP -> fraction recoil max(90/3,1)=30 + hook recoil max(90/20,1)=4 = 34 total", () => {
    const flareBlitz = requireMove('MOVE_FLARE_BLITZ')
    // Verification of Flare Blitz's recoil fraction
    expect(flareBlitz.customBehavior?.attack?.recoilFraction).toBe(3)

    const infernalRage = hasAbility('ABILITY_INFERNAL_RAGE')
    const { state } = runTurn({ abilities: infernalRage, hp: 300 }, { hp: 300 }, 'MOVE_FLARE_BLITZ', 90)
    // 300 - 34 = 266
    expect(state.battlers[0]!.mon.hp).toBe(266)
  })

  // Case 3: Dual Shadow (abilities.cc:9566-9572) and Doom Blast (abilities.cc:9296-9301)
  // Dual Shadow: CHECK(moveType == TYPE_ELECTRIC || moveType == TYPE_DARK); return max(damage / 10, 1);
  // Doom Blast: CHECK(moveType == TYPE_DARK); return max(damage / 20, 1);
  it('3. Dual Shadow: Electric and Dark moves recoil max(d/10,1), Fire none; Doom Blast: Dark recoils max(d/20,1), Fire none', () => {
    const dualShadow = hasAbility('ABILITY_DUAL_SHADOW')

    // Dual Shadow + Electric (Thunderbolt), 100 HP dealt: max(floor(100 / 10), 1) = 10 recoil -> 300 - 10 = 290
    const { state: dsElec } = runTurn({ abilities: dualShadow, hp: 300 }, { hp: 300 }, 'MOVE_THUNDERBOLT', 100)
    expect(dsElec.battlers[0]!.mon.hp).toBe(290)

    // Dual Shadow + Dark (Dark Pulse), 100 HP dealt: max(floor(100 / 10), 1) = 10 recoil -> 300 - 10 = 290
    const { state: dsDark } = runTurn({ abilities: dualShadow, hp: 300 }, { hp: 300 }, 'MOVE_DARK_PULSE', 100)
    expect(dsDark.battlers[0]!.mon.hp).toBe(290)

    // Dual Shadow + Fire (Flamethrower), 100 HP dealt: 0 recoil -> 300 HP
    const { state: dsFire } = runTurn({ abilities: dualShadow, hp: 300 }, { hp: 300 }, 'MOVE_FLAMETHROWER', 100)
    expect(dsFire.battlers[0]!.mon.hp).toBe(300)

    const doomBlast = hasAbility('ABILITY_DOOM_BLAST')

    // Doom Blast + Dark (Dark Pulse), 100 HP dealt: max(floor(100 / 20), 1) = 5 recoil -> 300 - 5 = 295
    const { state: dbDark } = runTurn({ abilities: doomBlast, hp: 300 }, { hp: 300 }, 'MOVE_DARK_PULSE', 100)
    expect(dbDark.battlers[0]!.mon.hp).toBe(295)

    // Doom Blast + Fire (Flamethrower), 100 HP dealt: 0 recoil -> 300 HP
    const { state: dbFire } = runTurn({ abilities: doomBlast, hp: 300 }, { hp: 300 }, 'MOVE_FLAMETHROWER', 100)
    expect(dbFire.battlers[0]!.mon.hp).toBe(300)
  })

  // Case 4: Super Strain (abilities.cc:6316-6320)
  // return max(damage / 4, 1); no type check.
  // 30 HP dealt: max(floor(30 / 4), 1) = max(7, 1) = 7.
  // 3 HP dealt: max(floor(3 / 4), 1) = max(0, 1) = 1 (min-1 case).
  it('4. Super Strain with any damaging move: 30 HP dealt -> max(30/4,1) = 7; 3 HP dealt -> max(0,1) = 1 (min-1 floor)', () => {
    const superStrain = hasAbility('ABILITY_SUPER_STRAIN')

    // 30 HP dealt -> 7 recoil: 300 - 7 = 293
    const { state: s1 } = runTurn({ abilities: superStrain, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 30)
    expect(s1.battlers[0]!.mon.hp).toBe(293)

    // 3 HP dealt -> max(floor(3/4), 1) = 1 recoil: 300 - 1 = 299
    const { state: s2 } = runTurn({ abilities: superStrain, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 3)
    expect(s2.battlers[0]!.mon.hp).toBe(299)
  })

  // Case 5: Total interacts with halfRecoil, Magic Guard, noRecoil, and Struggle bypass (c:4467)
  // Super Strain 40 HP dealt: raw onRecoil = max(floor(40/4), 1) = 10.
  // - with halfRecoil (Limber): max(floor(10 / 2), 1) = 5 recoil.
  // - with Magic Guard: loop never runs -> 0 recoil.
  // - with noRecoil (Rock Head): loop never runs -> 0 recoil.
  // - Struggle with Rock Head + Super Strain: Struggle bypasses noRecoil gate (:4467) -> 10 recoil.
  it('5. Total interacts with halfRecoil: takes max(1, total/2); Magic Guard and noRecoil take 0; Struggle bypasses gates', () => {
    // Half recoil: Super Strain + Limber (HALF_RECOIL_ABILITIES)
    const halfRecoilMon = hasAbility('ABILITY_SUPER_STRAIN', ['ABILITY_LIMBER', null, null])
    const { state: sHalf } = runTurn({ abilities: halfRecoilMon, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 40)
    // 300 - 5 = 295
    expect(sHalf.battlers[0]!.mon.hp).toBe(295)

    // Magic Guard blocks recoil
    const magicGuardMon = hasAbility('ABILITY_SUPER_STRAIN', ['ABILITY_MAGIC_GUARD', null, null])
    const { state: sMagic } = runTurn({ abilities: magicGuardMon, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 40)
    expect(sMagic.battlers[0]!.mon.hp).toBe(300)

    // noRecoil (Rock Head) blocks recoil
    const rockHeadMon = hasAbility('ABILITY_SUPER_STRAIN', ['ABILITY_ROCK_HEAD', null, null])
    const { state: sRock } = runTurn({ abilities: rockHeadMon, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 40)
    expect(sRock.battlers[0]!.mon.hp).toBe(300)

    // Struggle bypasses Magic Guard and noRecoil (:4467):
    // Struggle deals 25% max HP self-damage (floor(300 / 4) = 75 HP).
    // Struggle bypasses the noRecoil gate, so Super Strain adds onRecoil = max(floor(40/4), 1) = 10 HP.
    // Total attacker self-damage = 75 + 10 = 85 HP -> 300 - 85 = 215 HP.
    // Compare with Rock Head alone using Struggle: takes 75 HP (300 - 75 = 225 HP).
    const rockHeadOnlyMon = hasAbility('ABILITY_ROCK_HEAD')
    const { state: sRockOnly } = runTurn({ abilities: rockHeadOnlyMon, hp: 300 }, { hp: 300 }, 'MOVE_STRUGGLE', 40)
    expect(sRockOnly.battlers[0]!.mon.hp).toBe(225)

    const { state: sStruggle } = runTurn({ abilities: rockHeadMon, hp: 300 }, { hp: 300 }, 'MOVE_STRUGGLE', 40)
    expect(sStruggle.battlers[0]!.mon.hp).toBe(215)
  })

  // Case 6: Confusion plus Cosmic Daze on the opposing side doubles total including onRecoil damage (c:4510-4511)
  // Super Strain 40 HP dealt: base onRecoil = 10.
  // Attacker confused + opposing side Cosmic Daze -> 10 * 2 = 20 recoil.
  // Rolls: [1, 1] so attacker hits (accuracy) and acts through confusion (1 % 3 !== 0).
  it('6. Confusion plus Cosmic Daze on the opposing side doubles total including onRecoil damage', () => {
    const superStrain = hasAbility('ABILITY_SUPER_STRAIN')
    const cosmicDaze = hasAbility('ABILITY_COSMIC_DAZE')

    const { state } = runTurn(
      { abilities: superStrain, hp: 300, status2: STATUS2_CONFUSION },
      { abilities: cosmicDaze, hp: 300 },
      'MOVE_TACKLE',
      40,
      [1, 1],
    )
    // 300 - 20 = 280
    expect(state.battlers[0]!.mon.hp).toBe(280)
  })

  // Case 7: No recoil when move deals 0 HP (missed/blocked) or is a status move (c:4461, 4465)
  it('7. No recoil when the move deals 0 HP (blocked, missed) or is a status move', () => {
    const superStrain = hasAbility('ABILITY_SUPER_STRAIN')

    // 0 HP dealt on damaging move
    const { state: sZeroDmg } = runTurn({ abilities: superStrain, hp: 300 }, { hp: 300 }, 'MOVE_TACKLE', 0)
    expect(sZeroDmg.battlers[0]!.mon.hp).toBe(300)

    // Status move (Swords Dance) dealing 0 HP
    const { state: sStatus } = runTurn({ abilities: superStrain, hp: 300 }, { hp: 300 }, 'MOVE_SWORDS_DANCE', 0)
    expect(sStatus.battlers[0]!.mon.hp).toBe(300)
  })

  // Case 8: Commander onAccuracy (abilities.cc:7172-7175)
  // CHECK(GetAbilityState(target, ability)); return ACCURACY_ALWAYS_MISSES;
  // With target's ability state set to 1 via setAbilityStateOf: accuracy = 0 / always misses.
  // With state 0: normal accuracy.
  // Also direct getTotalAccuracy case for both.
  it('8. Commander: target state 1 -> accuracy 0 / always misses; state 0 -> normal accuracy; direct getTotalAccuracy for both', () => {
    const commander = hasAbility('ABILITY_COMMANDER')

    // Turn test with state = 1 (COMMANDER_ACTIVE)
    const sActive = battle([
      { moves: ['MOVE_TACKLE', null, null, null], hp: 300 },
      { abilities: commander, hp: 300 },
    ])
    setAbilityStateOf(sActive.battlers[1]!, 'ABILITY_COMMANDER', 1)
    expect(getAbilityStateOf(sActive.battlers[1]!, 'ABILITY_COMMANDER')).toBe(1)

    // Tackle accuracy check inputs via buildAccuracyInputs
    const inputsActive = buildAccuracyInputs(sActive, 0, 1, 'MOVE_TACKLE', false, testDeps()).inputs
    expect(inputsActive.defenderCommanderActive).toBe(true)
    const accActive = getTotalAccuracy(inputsActive)
    expect(accActive.accuracy).toBe(0)

    // Execute turn: move misses, defender takes 0 damage
    executeTurn(sActive, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(50)))
    expect(sActive.battlers[1]!.mon.hp).toBe(300)

    // Turn test with state = 0 (COMMANDER_NOT_ACTIVE)
    const sInactive = battle([
      { moves: ['MOVE_TACKLE', null, null, null], hp: 300 },
      { abilities: commander, hp: 300 },
    ])
    setAbilityStateOf(sInactive.battlers[1]!, 'ABILITY_COMMANDER', 0)
    expect(getAbilityStateOf(sInactive.battlers[1]!, 'ABILITY_COMMANDER')).toBe(0)

    const inputsInactive = buildAccuracyInputs(sInactive, 0, 1, 'MOVE_TACKLE', false, testDeps()).inputs
    expect(inputsInactive.defenderCommanderActive).toBe(false)
    const accInactive = getTotalAccuracy(inputsInactive)
    expect(accInactive.accuracy).toBe(100)

    // Execute turn: move hits, defender takes 50 damage
    executeTurn(sInactive, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(50)))
    expect(sInactive.battlers[1]!.mon.hp).toBe(250)

    // Direct getTotalAccuracy calls with synthetic inputs
    const baseDirectInputs: AccuracyInputs = {
      moveId: 'MOVE_TACKLE',
      moveAccuracy: 100,
      moveEffect: null,
      moveType: 'NORMAL',
      moveFlagStatStagesIgnored: false,
      moveFlagDmgInAir: false,
      moveFlagDmgTwoXInAir: false,
      moveFlagDmgUnderground: false,
      moveFlagDmgUnderwater: false,
      attackerTypes: ['NORMAL'],
      attackerTrepidationNonzero: false,
      attackerHoldEffect: null,
      attackerHoldEffectParam: 0,
      attackerAccStage: 6,
      attackerAbilitySlots: { ability: null, innates: [null, null, null] },
      attackerActsAfterDefender: false,
      attackerUsedMicleBerry: false,
      myceliumMightActive: false,
      defenderHoldEffect: null,
      defenderHoldEffectParam: 0,
      defenderEvasionStage: 6,
      defenderHasForesight: false,
      defenderHasAlwaysHits: false,
      battlerWithSureHitIsAttacker: false,
      defenderHasTelekinesis: false,
      defenderIsGrounded: true,
      defenderHasPhantomForce: false,
      defenderIsOnAir: false,
      defenderIsUnderground: false,
      defenderIsUnderwater: false,
      defenderSmokescreenActive: false,
      defenderAbilitySlots: { ability: 'ABILITY_COMMANDER', innates: [null, null, null] },
      weather: 'NONE',
      gravityActive: false,
    }

    const directActive = getTotalAccuracy({ ...baseDirectInputs, defenderCommanderActive: true })
    expect(directActive.accuracy).toBe(0)
    expect(directActive.gaps).toEqual([])

    const directInactive = getTotalAccuracy({ ...baseDirectInputs, defenderCommanderActive: false })
    expect(directInactive.accuracy).toBe(100)
    expect(directInactive.gaps).toEqual([])
  })
})
