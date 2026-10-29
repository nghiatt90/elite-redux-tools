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
import { executeTurn } from './turn'
import { dispatchMoveEndAttackerAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
  STATUS2_SUBSTITUTE,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS4_FEAR,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
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
  species: () => undefined,
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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    speciesId?: string
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    types?: [string, string, string]
    itemId?: string | null
    gender?: SimBattleMon['gender']
    status1?: number
    status2?: number
  }[],
  rng: RandomSource,
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
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

/** One turn: holder (battler 0) uses `moveId` on battler 1 for a fixed 10 damage. */
function run(
  ability: string,
  moveId: string,
  rolls: number[],
  holder: Parameters<typeof battle>[0][number] = {},
  target: Parameters<typeof battle>[0][number] = {},
  setup?: (state: BattleState) => void,
  grounding: GroundingContext = GROUNDING,
  dmg = 10,
) {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...holder }, target], rng)
  setup?.(state)
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg), undefined, grounding))
  return { state, rng, out, holder: state.battlers[0]!, target: state.battlers[1]! }
}

describe('Cycle 91b - Energy Siphon (src/abilities.cc:9207-9218)', () => {
  const ES = 'ABILITY_ENERGY_SIPHON'

  it('heals the holder by max(1, floor(hpDealt / 4)) through GetDrainedBigRootHp (Big Root & Absorbant x3/2)', () => {
    // hpDealt = 20 -> floor(20 / 4) = 5 -> 50 + 5 = 55
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50 }, {}, undefined, GROUNDING, 20).holder.mon.hp).toBe(55)

    // hpDealt = 2 -> -2 / 4 == 0 in C, clamped to -1 -> heals 1 (50 + 1 = 51)
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50 }, {}, undefined, GROUNDING, 2).holder.mon.hp).toBe(51)

    // Big Root: trunc(5 * 3 / 2) = 7 -> 57
    const bigRoot: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => (id === 0 ? 'HOLD_EFFECT_BIG_ROOT' : null) }
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50 }, {}, undefined, bigRoot, 20).holder.mon.hp).toBe(57)

    // Absorbant innate: trunc(5 * 3 / 2) = 7 -> 57
    const absorbant = { ability: ES, innates: ['ABILITY_ABSORBANT', null, null] as [string, null, null] }
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50, abilities: absorbant }, {}, undefined, GROUNDING, 20).holder.mon.hp).toBe(57)

    // Both Big Root and Absorbant: trunc(trunc(5 * 3 / 2) * 3 / 2) = trunc(7 * 3 / 2) = 10 -> 60
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50, abilities: absorbant }, {}, undefined, bigRoot, 20).holder.mon.hp).toBe(60)

    // Capped at maxHp
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 98 }, {}, undefined, GROUNDING, 20).holder.mon.hp).toBe(100)
  })

  it('does not heal at full HP, on 0 damage, or under Heal Block', () => {
    // Already at full HP (CHECK_NOT(BATTLER_MAX_HP))
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 100 }, {}, undefined, GROUNDING, 20).holder.mon.hp).toBe(100)

    // 0 damage dealt (ShouldApplyOnHitEffect fails)
    expect(run(ES, 'MOVE_TACKLE', [0], { hp: 50 }, {}, undefined, GROUNDING, 0).holder.mon.hp).toBe(50)

    // Heal Block (CanBattlerHeal fails)
    const healBlocked = run(ES, 'MOVE_TACKLE', [0], { hp: 50 }, {}, (s) => {
      s.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    }, GROUNDING, 20)
    expect(healBlocked.holder.mon.hp).toBe(50)
  })
})

describe('Cycle 91b - Fire Aspect, Fire\'s Wrath, Frostmaw, Ghost Pepper (src/abilities.cc)', () => {
  it('Fire Aspect: Fire move burns the target with no roll (abilities.cc:10500-10514)', () => {
    // Fire Glaive: Fire, no secondary effect, accuracy 100 -> only 1 RNG call (accuracy)
    const hit = run('ABILITY_FIRE_ASPECT', 'MOVE_FIRE_GLAIVE', [0])
    expect(hit.target.mon.status1).toBe(STATUS1_BURN)
    expect(hit.rng.calls).toBe(1)

    // Ate-converted Fire move (Immolate innate + Normal Tackle) also counts as moveType == TYPE_FIRE
    const immolate = { ability: 'ABILITY_FIRE_ASPECT', innates: ['ABILITY_IMMOLATE', null, null] as [string, null, null] }
    expect(run('ABILITY_FIRE_ASPECT', 'MOVE_TACKLE', [0], { abilities: immolate }).target.mon.status1).toBe(STATUS1_BURN)

    // Non-Fire move -> no burn
    expect(run('ABILITY_FIRE_ASPECT', 'MOVE_TACKLE', [0]).target.mon.status1).toBe(0)

    // Fire-type target (CanBeBurned fails) -> no burn
    expect(run('ABILITY_FIRE_ASPECT', 'MOVE_FIRE_GLAIVE', [0], {}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }).target.mon.status1).toBe(0)

    // Target already statused -> stays paralyzed
    expect(run('ABILITY_FIRE_ASPECT', 'MOVE_FIRE_GLAIVE', [0], {}, { status1: STATUS1_PARALYSIS }).target.mon.status1).toBe(STATUS1_PARALYSIS)

    // No damage dealt -> no burn
    expect(run('ABILITY_FIRE_ASPECT', 'MOVE_FIRE_GLAIVE', [0], {}, {}, undefined, GROUNDING, 0).target.mon.status1).toBe(0)
  })

  it("Fire's Wrath: non-contact move burns 10%; contact check precedes roll (abilities.cc:5186-5196)", () => {
    // Hyper Voice: non-contact, no secondary effect. Roll 9 (< 10) burns.
    const hit = run('ABILITY_FIRES_WRATH', 'MOVE_HYPER_VOICE', [0, 9])
    expect(hit.target.mon.status1).toBe(STATUS1_BURN)
    expect(hit.rng.calls).toBe(2)

    // Roll 10 is not < 10 -> no burn, 2 RNG calls
    const miss = run('ABILITY_FIRES_WRATH', 'MOVE_HYPER_VOICE', [0, 10])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)

    // Contact move (Tackle): CHECK_NOT(IsMoveMakingContact) fails before the roll -> 1 RNG call
    const contact = run('ABILITY_FIRES_WRATH', 'MOVE_TACKLE', [0, 0])
    expect(contact.target.mon.status1).toBe(0)
    expect(contact.rng.calls).toBe(1)

    // Protective Pads suppresses contact, so Tackle with Pads rolls and burns on 9
    const pads: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => (id === 0 ? 'HOLD_EFFECT_PROTECTIVE_PADS' : null) }
    expect(run('ABILITY_FIRES_WRATH', 'MOVE_TACKLE', [0, 9], {}, {}, undefined, pads).target.mon.status1).toBe(STATUS1_BURN)

    // Fire-type target: CanBeBurned fails before the roll -> 1 RNG call
    const fireTarget = run('ABILITY_FIRES_WRATH', 'MOVE_HYPER_VOICE', [0, 0], {}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(fireTarget.target.mon.status1).toBe(0)
    expect(fireTarget.rng.calls).toBe(1)

    // Already statused target -> stays poisoned, 1 RNG call
    const poisoned = run('ABILITY_FIRES_WRATH', 'MOVE_HYPER_VOICE', [0, 0], {}, { status1: STATUS1_POISON })
    expect(poisoned.target.mon.status1).toBe(STATUS1_POISON)
    expect(poisoned.rng.calls).toBe(1)

    // No damage -> no burn
    expect(run('ABILITY_FIRES_WRATH', 'MOVE_HYPER_VOICE', [0, 0], {}, {}, undefined, GROUNDING, 0).target.mon.status1).toBe(0)
  })

  it('Frostmaw: bite move inflicts Frostbite 50% (abilities.cc:8624-8633)', () => {
    // Psychic Fangs: biteBased, no secondary effect. Roll 1 (1 % 2 !== 0) -> Frostbite.
    const hit = run('ABILITY_FROSTMAW', 'MOVE_PSYCHIC_FANGS', [0, 1])
    expect(hit.target.mon.status1).toBe(STATUS1_FROSTBITE)
    expect(hit.rng.calls).toBe(2)

    // Roll 2 (2 % 2 === 0) -> no Frostbite
    const miss = run('ABILITY_FROSTMAW', 'MOVE_PSYCHIC_FANGS', [0, 2])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)

    // Non-bite move: CHECK(FLAG_STRONG_JAW_BOOST) fails before the roll -> 1 RNG call
    const nonBite = run('ABILITY_FROSTMAW', 'MOVE_TACKLE', [0, 1])
    expect(nonBite.target.mon.status1).toBe(0)
    expect(nonBite.rng.calls).toBe(1)

    // Ice-type target: CanGetFrostbite fails before the roll -> 1 RNG call
    const iceTarget = run('ABILITY_FROSTMAW', 'MOVE_PSYCHIC_FANGS', [0, 1], {}, { types: ['ICE', 'MYSTERY', 'MYSTERY'] })
    expect(iceTarget.target.mon.status1).toBe(0)
    expect(iceTarget.rng.calls).toBe(1)

    // Already statused target -> stays burned, 1 RNG call
    const burned = run('ABILITY_FROSTMAW', 'MOVE_PSYCHIC_FANGS', [0, 1], {}, { status1: STATUS1_BURN })
    expect(burned.target.mon.status1).toBe(STATUS1_BURN)
    expect(burned.rng.calls).toBe(1)

    // No damage -> no Frostbite
    expect(run('ABILITY_FROSTMAW', 'MOVE_PSYCHIC_FANGS', [0, 1], {}, {}, undefined, GROUNDING, 0).target.mon.status1).toBe(0)
  })

  it('Ghost Pepper: Grass move burns 30% (abilities.cc:12459-12468)', () => {
    // Branch Poke: Grass, no secondary effect. Roll 29 (< 30) -> burn.
    const hit = run('ABILITY_GHOST_PEPPER', 'MOVE_BRANCH_POKE', [0, 29])
    expect(hit.target.mon.status1).toBe(STATUS1_BURN)
    expect(hit.rng.calls).toBe(2)

    // Roll 30 is not < 30 -> no burn
    const miss = run('ABILITY_GHOST_PEPPER', 'MOVE_BRANCH_POKE', [0, 30])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)

    // Non-Grass move: CHECK(moveType == TYPE_GRASS) fails before the roll -> 1 RNG call
    const nonGrass = run('ABILITY_GHOST_PEPPER', 'MOVE_TACKLE', [0, 0])
    expect(nonGrass.target.mon.status1).toBe(0)
    expect(nonGrass.rng.calls).toBe(1)

    // Fire-type target: CanBeBurned fails before the roll -> 1 RNG call
    const fireTarget = run('ABILITY_GHOST_PEPPER', 'MOVE_BRANCH_POKE', [0, 0], {}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(fireTarget.target.mon.status1).toBe(0)
    expect(fireTarget.rng.calls).toBe(1)

    // Already statused target -> stays paralyzed, 1 RNG call
    const paralyzed = run('ABILITY_GHOST_PEPPER', 'MOVE_BRANCH_POKE', [0, 0], {}, { status1: STATUS1_PARALYSIS })
    expect(paralyzed.target.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(paralyzed.rng.calls).toBe(1)

    // No damage -> no burn
    expect(run('ABILITY_GHOST_PEPPER', 'MOVE_BRANCH_POKE', [0, 0], {}, {}, undefined, GROUNDING, 0).target.mon.status1).toBe(0)
  })
})

describe('Cycle 91b - Fungal Infection, Grass Flute, Hardened Sheath (src/abilities.cc)', () => {
  it('Fungal Infection: contact hit seeds a non-Grass unseeded target with no roll (abilities.cc:5016-5028)', () => {
    const hit = run('ABILITY_FUNGAL_INFECTION', 'MOVE_TACKLE', [0])
    expect(hasFlag(hit.target.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(hit.target.statuses3 & 0x3).toBe(0)

    // When battler 1 is the holder, STATUS3_LEECHSEED_BY(1) records battler 1 in the low bits
    const state1 = battle([{}, { moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_FUNGAL_INFECTION') }], scriptedRng([]))
    dispatchMoveEndAttackerAbilities({
      state: state1,
      attackerId: 1,
      targetId: 0,
      moveId: 'MOVE_TACKLE',
      moveData: move('MOVE_TACKLE'),
      targetDamage: 10,
      hpDealt: 10,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [],
      fainted: [],
    })
    expect(hasFlag(state1.battlers[0]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(state1.battlers[0]!.statuses3 & 0x3).toBe(1)

    // Non-contact move (Hyper Voice) -> no Leech Seed
    expect(hasFlag(run('ABILITY_FUNGAL_INFECTION', 'MOVE_HYPER_VOICE', [0]).target.statuses3, STATUS3_LEECHSEED)).toBe(false)

    // Grass-type target -> immune (CHECK_NOT(IS_BATTLER_OF_TYPE(target, TYPE_GRASS)))
    const grass = run('ABILITY_FUNGAL_INFECTION', 'MOVE_TACKLE', [0], {}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    expect(hasFlag(grass.target.statuses3, STATUS3_LEECHSEED)).toBe(false)

    // Already seeded -> CHECK_NOT(gStatuses3[target] & STATUS3_LEECHSEED) keeps existing seeder bits
    const already = run('ABILITY_FUNGAL_INFECTION', 'MOVE_TACKLE', [0], {}, {}, (s) => {
      s.battlers[1]!.statuses3 = STATUS3_LEECHSEED | 1
    })
    expect(already.target.statuses3 & 0x3).toBe(1)

    // No damage -> no Leech Seed
    expect(hasFlag(run('ABILITY_FUNGAL_INFECTION', 'MOVE_TACKLE', [0], {}, {}, undefined, GROUNDING, 0).target.statuses3, STATUS3_LEECHSEED)).toBe(false)
  })

  it('Grass Flute: sound move inflicts Fear with no roll (abilities.cc:10070-10078)', () => {
    const hit = run('ABILITY_GRASS_FLUTE', 'MOVE_HYPER_VOICE', [0])
    expect(hit.target.volatiles.fear).toBe(true)
    expect(hasFlag(hit.target.statuses4, STATUS4_FEAR)).toBe(true)
    expect(hit.rng.calls).toBe(1)

    // Non-sound move -> no Fear
    const nonSound = run('ABILITY_GRASS_FLUTE', 'MOVE_TACKLE', [0])
    expect(nonSound.target.volatiles.fear).toBe(false)
    expect(hasFlag(nonSound.target.statuses4, STATUS4_FEAR)).toBe(false)

    // Reverbate innate makes a Normal move (Tackle) a sound move via IsSoundMove
    const reverbate = { ability: 'ABILITY_GRASS_FLUTE', innates: ['ABILITY_REVERBATE', null, null] as [string, null, null] }
    expect(run('ABILITY_GRASS_FLUTE', 'MOVE_TACKLE', [0], { abilities: reverbate }).target.volatiles.fear).toBe(true)

    // Target already in Fear -> no statusApplied outcome
    const already = run('ABILITY_GRASS_FLUTE', 'MOVE_HYPER_VOICE', [0], {}, {}, (s) => {
      s.battlers[1]!.volatiles.fear = true
      s.battlers[1]!.statuses4 |= STATUS4_FEAR
    })
    expect(already.out.actions[0]!.statusApplied).toBeNull()

    // No damage -> no Fear
    expect(run('ABILITY_GRASS_FLUTE', 'MOVE_HYPER_VOICE', [0], {}, {}, undefined, GROUNDING, 0).target.volatiles.fear).toBe(false)
  })

  it('Hardened Sheath: horn move raises holder Attack by 1 via direct ChangeStatBuffs (abilities.cc:4942-4952)', () => {
    // Fire Glaive: hornBased, no secondary effect
    const hit = run('ABILITY_HARDENED_SHEATH', 'MOVE_FIRE_GLAIVE', [0])
    expect(hit.holder.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(hit.rng.calls).toBe(1)

    // Direct ChangeStatBuffs (not SetMoveEffect) is not gated by Sheer Force on a sheerForceBoost horn move (Horn Attack)
    const sheerForce = { ability: 'ABILITY_HARDENED_SHEATH', innates: ['ABILITY_SHEER_FORCE', null, null] as [string, null, null] }
    expect(run('ABILITY_HARDENED_SHEATH', 'MOVE_HORN_ATTACK', [0, 99], { abilities: sheerForce }).holder.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    // Non-horn move -> no Attack boost
    expect(run('ABILITY_HARDENED_SHEATH', 'MOVE_TACKLE', [0]).holder.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    // Already at +6 Attack -> stays at 12
    const capped = run('ABILITY_HARDENED_SHEATH', 'MOVE_FIRE_GLAIVE', [0], {}, {}, (s) => {
      s.battlers[0]!.mon.statStages[STAT_ATK] = 12
    })
    expect(capped.holder.mon.statStages[STAT_ATK]).toBe(12)

    // No damage -> no Attack boost
    expect(run('ABILITY_HARDENED_SHEATH', 'MOVE_FIRE_GLAIVE', [0], {}, {}, undefined, GROUNDING, 0).holder.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('Cycle 91b - From the Shadows & Haunting Frenzy (src/abilities.cc)', () => {
  it('From the Shadows: before target acts, 20% flinch and unconditional trap; after target acts, does nothing (abilities.cc:8766-8781)', () => {
    const FTS = 'ABILITY_FROM_THE_SHADOWS'

    // Holder acts first (spe 100 > 50). Roll 19 (< 20): target flinches (action cancelled) AND is trapped by battler 0.
    const rngHit = scriptedRng([0, 19])
    const stateHit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(FTS), spe: 100 }, { spe: 50 }], rngHit)
    const outHit = executeTurn(stateHit, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(outHit.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('FLINCH')
    expect(hasFlag(stateHit.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(stateHit.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
    expect(rngHit.calls).toBe(2)

    // Roll 20 (not < 20): no flinch, but escape prevention still applies
    const rngNoFlinch = scriptedRng([0, 20, 0])
    const stateNoFlinch = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(FTS), spe: 100 }, { spe: 50 }], rngNoFlinch)
    const outNoFlinch = executeTurn(stateNoFlinch, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(outNoFlinch.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBeNull()
    expect(hasFlag(stateNoFlinch.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(stateNoFlinch.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)

    // Target acted first (holder spe 30 < target spe 100): CHECK(GetBattlerTurnOrderNum(target) >= gCurrentTurnActionNumber) fails before roll or trap
    const rngSlow = scriptedRng([0, 0, 0])
    const stateSlow = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(FTS), spe: 30 }, { spe: 100 }], rngSlow)
    executeTurn(stateSlow, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(hasFlag(stateSlow.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(rngSlow.calls).toBe(2) // only the two accuracy rolls

    // Move with its own flinch effect (Aqua Bash, EFFECT_FLINCH_HIT): CanMoveHaveExtraFlinchChance is false, so no ability flinch roll, but trap still lands
    const rngFlinchMove = scriptedRng([0, 99]) // accuracy 0, Aqua Bash's own 20% flinch roll 99 (misses)
    const stateFlinchMove = battle([{ moves: slot('MOVE_AQUA_BASH'), pp: pps, abilities: hasAbility(FTS), spe: 100 }, { spe: 50 }], rngFlinchMove)
    executeTurn(stateFlinchMove, [useMove(1, move('MOVE_AQUA_BASH')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(stateFlinchMove.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(rngFlinchMove.calls).toBe(2)

    // Target already trapped by battler 1: flinch still applies on roll 19, battlerPreventingEscape stays 1
    const stateAlreadyTrapped = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(FTS) }, { status2: STATUS2_ESCAPE_PREVENTION }],
      scriptedRng([19]),
    )
    stateAlreadyTrapped.battlers[1]!.volatiles.battlerPreventingEscape = 1
    dispatchMoveEndAttackerAbilities({
      state: stateAlreadyTrapped,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: move('MOVE_TACKLE'),
      targetDamage: 10,
      hpDealt: 10,
      targetHasActedThisTurn: false,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [],
      fainted: [],
    })
    expect(hasFlag(stateAlreadyTrapped.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(stateAlreadyTrapped.battlers[1]!.volatiles.battlerPreventingEscape).toBe(1)

    // No damage dealt -> neither flinch nor trap
    const noDmg = run(FTS, 'MOVE_TACKLE', [0, 0], {}, {}, undefined, GROUNDING, 0)
    expect(hasFlag(noDmg.target.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
  })

  it('Haunting Frenzy: King\'s Rock-eligible move flinches 20% via AbilityStatusEffectDirect (abilities.cc:7523-7533)', () => {
    const HF = 'ABILITY_HAUNTING_FRENZY'

    // Roll 19 (< 20) flinches slower target; AbilityStatusEffectDirect sets HITMARKER_IGNORE_SAFEGUARD so Shield Dust does not block it
    const rngHit = scriptedRng([0, 19])
    const stateHit = battle(
      [
        { moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(HF), spe: 100 },
        { spe: 50, abilities: hasAbility('ABILITY_SHIELD_DUST') },
      ],
      rngHit,
    )
    const outHit = executeTurn(stateHit, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(outHit.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('FLINCH')
    expect(rngHit.calls).toBe(2)

    // Roll 20 (not < 20) -> no flinch
    const rngMiss = scriptedRng([0, 20, 0])
    const stateMiss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(HF), spe: 100 }, { spe: 50 }], rngMiss)
    const outMiss = executeTurn(stateMiss, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(outMiss.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBeNull()

    // Move with its own flinch chance (Aqua Bash): CanMoveHaveExtraFlinchChance fails before the ability roll
    const rngAqua = scriptedRng([0, 99])
    const stateAqua = battle([{ moves: slot('MOVE_AQUA_BASH'), pp: pps, abilities: hasAbility(HF) }, {}], rngAqua)
    executeTurn(stateAqua, [useMove(1, move('MOVE_AQUA_BASH')), null], testDeps(fixedDamage(10)))
    expect(rngAqua.calls).toBe(2) // accuracy + Aqua Bash's own secondary roll only

    // Inner Focus (CHECK_FLINCH) and Substitute still block AbilityStatusEffectDirect
    for (const targetSpec of [
      { abilities: hasAbility('ABILITY_INNER_FOCUS') },
      { status2: STATUS2_SUBSTITUTE },
    ]) {
      const st = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(HF) }, targetSpec], scriptedRng([0]))
      dispatchMoveEndAttackerAbilities({
        state: st,
        attackerId: 0,
        targetId: 1,
        moveId: 'MOVE_TACKLE',
        moveData: move('MOVE_TACKLE'),
        targetDamage: 10,
        hpDealt: 10,
        deps: testDeps(fixedDamage(10)),
        unmodelled: [],
        fainted: [],
      })
      expect(hasFlag(st.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    }

    // No damage -> no roll drawn
    const stNoDmg = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(HF) }, {}], scriptedRng([0]))
    const rngNoDmg = stNoDmg.rng as ReturnType<typeof scriptedRng>
    dispatchMoveEndAttackerAbilities({
      state: stNoDmg,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: move('MOVE_TACKLE'),
      targetDamage: 0,
      hpDealt: 0,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(rngNoDmg.calls).toBe(0)
  })
})
