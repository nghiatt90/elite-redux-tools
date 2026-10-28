/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
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
import { TYPE_NAME_BY_ID } from './hazards'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_INFATUATION,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
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
) {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...holder }, target], rng)
  setup?.(state)
  executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(10)))
  return { state, rng, holder: state.battlers[0]!, target: state.battlers[1]! }
}

describe('Cycle 91a - status-on-hit attacker abilities (src/abilities.cc)', () => {
  it('Deep Cuts: Keen Edge move bleeds 50% (abilities.cc:9088-9097)', () => {
    // Behemoth Blade: sliceBased, no secondary effect, accuracy 100. Rolls: accuracy, ability.
    const hit = run('ABILITY_DEEP_CUTS', 'MOVE_BEHEMOTH_BLADE', [0, 1])
    expect(hit.target.mon.status1).toBe(STATUS1_BLEED)
    expect(hit.rng.calls).toBe(2)

    // roll % 2 === 0 -> no bleed
    expect(run('ABILITY_DEEP_CUTS', 'MOVE_BEHEMOTH_BLADE', [0, 2]).target.mon.status1).toBe(0)

    // Non-Keen-Edge move: the CHECK fails before the roll, so only the accuracy roll is drawn
    const plain = run('ABILITY_DEEP_CUTS', 'MOVE_TACKLE', [0, 1])
    expect(plain.target.mon.status1).toBe(0)
    expect(plain.rng.calls).toBe(1)

    // CanBleed fails (Rock target) -> no roll drawn, no bleed
    const rock = run('ABILITY_DEEP_CUTS', 'MOVE_BEHEMOTH_BLADE', [0, 1], {}, { types: ['ROCK', 'MYSTERY', 'MYSTERY'] })
    expect(rock.target.mon.status1).toBe(0)
    expect(rock.rng.calls).toBe(1)

    // Target already has a status -> CanBleed fails
    const burned = run('ABILITY_DEEP_CUTS', 'MOVE_BEHEMOTH_BLADE', [0, 1], {}, { status1: STATUS1_BURN })
    expect(burned.target.mon.status1).toBe(STATUS1_BURN)
  })

  it('Beautiful Music: the 50% roll precedes the sound check; sound move infatuates (abilities.cc:7838-7846)', () => {
    // Hyper Voice (sound, no secondary). Rolls: accuracy, ability (1 -> passes).
    const hit = run('ABILITY_BEAUTIFUL_MUSIC', 'MOVE_HYPER_VOICE', [0, 1])
    expect(hasFlag(hit.target.mon.status2, STATUS2_INFATUATION)).toBe(true)

    // roll % 2 === 0 -> nothing
    expect(hasFlag(run('ABILITY_BEAUTIFUL_MUSIC', 'MOVE_HYPER_VOICE', [0, 2]).target.mon.status2, STATUS2_INFATUATION)).toBe(false)

    // Non-sound move: the roll is still drawn (C order: Random() % 2 before IsSoundMove) but nothing happens
    const plain = run('ABILITY_BEAUTIFUL_MUSIC', 'MOVE_TACKLE', [0, 1])
    expect(hasFlag(plain.target.mon.status2, STATUS2_INFATUATION)).toBe(false)
    expect(plain.rng.calls).toBe(2)
  })

  it('Dead Power: contact hit curses 20% (abilities.cc:7585-7598)', () => {
    const hit = run('ABILITY_DEAD_POWER', 'MOVE_TACKLE', [0, 19])
    expect(hasFlag(hit.target.mon.status2, STATUS2_CURSED)).toBe(true)

    // roll 20 is not < 20
    expect(hasFlag(run('ABILITY_DEAD_POWER', 'MOVE_TACKLE', [0, 20]).target.mon.status2, STATUS2_CURSED)).toBe(false)

    // Non-contact move (Hyper Voice): CHECK fails before the roll
    const nonContact = run('ABILITY_DEAD_POWER', 'MOVE_HYPER_VOICE', [0, 0])
    expect(hasFlag(nonContact.target.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(nonContact.rng.calls).toBe(1)

    // Already cursed -> CHECK_NOT fails before the roll
    const already = run('ABILITY_DEAD_POWER', 'MOVE_TACKLE', [0, 0], {}, { status2: STATUS2_CURSED })
    expect(already.rng.calls).toBe(1)
  })

  it("Assassin's Tools: contact hit, Random() % 3 picks poison / paralysis / bleed (abilities.cc:8598-8621)", () => {
    // Branch 0 -> MOVE_EFFECT_POISON (plain poison, not toxic)
    expect(run('ABILITY_ASSASSINS_TOOLS', 'MOVE_TACKLE', [0, 3]).target.mon.status1).toBe(STATUS1_POISON)
    // Branch 1 -> paralysis
    expect(run('ABILITY_ASSASSINS_TOOLS', 'MOVE_TACKLE', [0, 1]).target.mon.status1).toBe(STATUS1_PARALYSIS)
    // Branch 2 -> bleed
    expect(run('ABILITY_ASSASSINS_TOOLS', 'MOVE_TACKLE', [0, 5]).target.mon.status1).toBe(STATUS1_BLEED)

    // A branch whose CanX fails does nothing and does not reroll: Poison-type target, branch 0
    const poisonImmune = run('ABILITY_ASSASSINS_TOOLS', 'MOVE_TACKLE', [0, 0], {}, { types: ['POISON', 'MYSTERY', 'MYSTERY'] })
    expect(poisonImmune.target.mon.status1).toBe(0)
    expect(poisonImmune.rng.calls).toBe(2)

    // Rock target, branch 2 (CanBleed fails)
    expect(run('ABILITY_ASSASSINS_TOOLS', 'MOVE_TACKLE', [0, 2], {}, { types: ['ROCK', 'MYSTERY', 'MYSTERY'] }).target.mon.status1).toBe(0)

    // Non-contact move: no roll drawn
    const nonContact = run('ABILITY_ASSASSINS_TOOLS', 'MOVE_HYPER_VOICE', [0, 1])
    expect(nonContact.target.mon.status1).toBe(0)
    expect(nonContact.rng.calls).toBe(1)
  })
})

describe('Cycle 91a - Defense-drop attacker abilities (src/abilities.cc)', () => {
  it('Crushing Jaw: bite move lowers Defense 50%; the roll precedes StatLowerable (abilities.cc:11597-11607)', () => {
    // Psychic Fangs: biteBased, no secondary roll. Rolls: accuracy, ability.
    const hit = run('ABILITY_CRUSHING_JAW', 'MOVE_PSYCHIC_FANGS', [0, 1])
    expect(hit.target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)

    const miss = run('ABILITY_CRUSHING_JAW', 'MOVE_PSYCHIC_FANGS', [0, 2])
    expect(miss.target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(miss.rng.calls).toBe(2)

    // Non-bite move: flag check fails before the roll
    const plain = run('ABILITY_CRUSHING_JAW', 'MOVE_TACKLE', [0, 1])
    expect(plain.target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(plain.rng.calls).toBe(1)

    // Defense already at -6: the roll is drawn (C order), StatLowerableOrMirrorArmor then fails
    const rng = scriptedRng([0, 1])
    const floored = battle([{ moves: slot('MOVE_PSYCHIC_FANGS'), pp: pps, abilities: hasAbility('ABILITY_CRUSHING_JAW') }, {}], rng)
    floored.battlers[1]!.mon.statStages[STAT_DEF] = 0
    executeTurn(floored, [useMove(1, move('MOVE_PSYCHIC_FANGS')), null], testDeps(fixedDamage(10)))
    expect(floored.battlers[1]!.mon.statStages[STAT_DEF]).toBe(0)
    expect(rng.calls).toBe(2)
  })

  it('Chainsaw: Keen Edge move lowers Defense, once per turn per target (abilities.cc:11236-11248)', () => {
    const hit = run('ABILITY_CHAINSAW', 'MOVE_BEHEMOTH_BLADE', [0])
    expect(hit.target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(hit.rng.calls).toBe(1)

    // Not a Keen Edge move
    expect(run('ABILITY_CHAINSAW', 'MOVE_TACKLE', [0]).target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)

    // Second hit in the same turn: the target's bit is already set in the once-per-turn counter
    const state = battle([{ moves: slot('MOVE_BEHEMOTH_BLADE'), pp: pps, abilities: hasAbility('ABILITY_CHAINSAW') }, {}], scriptedRng([]))
    const ctx = {
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_BEHEMOTH_BLADE',
      moveData: move('MOVE_BEHEMOTH_BLADE'),
      targetDamage: 10,
      hpDealt: 10,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [] as string[],
      fainted: [] as number[],
    }
    dispatchMoveEndAttackerAbilities(ctx)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    dispatchMoveEndAttackerAbilities(ctx)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('Denting Blows: hammer move lowers Defense, once per turn per target (abilities.cc:8045-8057)', () => {
    // Ice Hammer: hammerBased, no secondary effect
    const hit = run('ABILITY_DENTING_BLOWS', 'MOVE_ICE_HAMMER', [0])
    expect(hit.target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)

    expect(run('ABILITY_DENTING_BLOWS', 'MOVE_TACKLE', [0]).target.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)

    const state = battle([{ moves: slot('MOVE_ICE_HAMMER'), pp: pps, abilities: hasAbility('ABILITY_DENTING_BLOWS') }, {}], scriptedRng([]))
    const ctx = {
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_ICE_HAMMER',
      moveData: move('MOVE_ICE_HAMMER'),
      targetDamage: 10,
      hpDealt: 10,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [] as string[],
      fainted: [] as number[],
    }
    dispatchMoveEndAttackerAbilities(ctx)
    dispatchMoveEndAttackerAbilities(ctx)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)

    // Defense already at -6 and no Mirror Armor: StatLowerableOrMirrorArmor fails before the counter is touched
    const floored = battle([{ moves: slot('MOVE_ICE_HAMMER'), pp: pps, abilities: hasAbility('ABILITY_DENTING_BLOWS') }, {}], scriptedRng([]))
    floored.battlers[1]!.mon.statStages[STAT_DEF] = 0
    executeTurn(floored, [useMove(1, move('MOVE_ICE_HAMMER')), null], testDeps(fixedDamage(10)))
    expect(floored.battlers[1]!.mon.statStages[STAT_DEF]).toBe(0)
  })
})

describe('Cycle 91a - Daredevil (src/abilities.cc:12382-12391)', () => {
  const atk = (r: { holder: { mon: { statStages: number[] } } }) => r.holder.mon.statStages[STAT_ATK]

  it('raises Attack by 1 after a reckless-boosted damaging move', () => {
    // Double-Edge carries the reckless move flag (recoil 33)
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_DOUBLE_EDGE', [0]))).toBe(DEFAULT_STAT_STAGE + 1)
    // Plain Tackle is not reckless-boosted
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_TACKLE', [0]))).toBe(DEFAULT_STAT_STAGE)
  })

  it('IsRecklessBoosted also accepts STATUS2_ENRAGED and onRecoil abilities that answer for the move type (abilities.cc:463-470)', () => {
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_TACKLE', [0], { status2: STATUS2_ENRAGED }))).toBe(DEFAULT_STAT_STAGE + 1)

    // Infernal Rage (onRecoil for Fire, abilities.cc:5474) as an innate: Flamethrower (non-reckless Fire) qualifies, rolls: accuracy, burn (miss)
    const innate = { ability: 'ABILITY_DAREDEVIL', innates: ['ABILITY_INFERNAL_RAGE', null, null] as [string, null, null] }
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_FLAMETHROWER', [0, 99], { abilities: innate }))).toBe(DEFAULT_STAT_STAGE + 1)
    // ... but a Water move does not
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_WATER_GUN', [0, 99], { abilities: innate }))).toBe(DEFAULT_STAT_STAGE)
  })

  it('does nothing at +6 Attack, and Sheer Force blocks the effect on a Sheer Force move', () => {
    const rng = scriptedRng([0])
    const capped = battle([{ moves: slot('MOVE_DOUBLE_EDGE'), pp: pps, abilities: hasAbility('ABILITY_DAREDEVIL') }, {}], rng)
    capped.battlers[0]!.mon.statStages[STAT_ATK] = 12
    executeTurn(capped, [useMove(1, move('MOVE_DOUBLE_EDGE')), null], testDeps(fixedDamage(10)))
    expect(capped.battlers[0]!.mon.statStages[STAT_ATK]).toBe(12)

    // Sheer Force (innate) + Flamethrower (burn-hit secondary) + Infernal Rage: SetMoveEffect's TestSheerForceFlag resets the effect
    const abilities = { ability: 'ABILITY_DAREDEVIL', innates: ['ABILITY_INFERNAL_RAGE', 'ABILITY_SHEER_FORCE', null] as [string, string, null] }
    expect(atk(run('ABILITY_DAREDEVIL', 'MOVE_FLAMETHROWER', [0, 99], { abilities }))).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('Cycle 91a - Archmage (src/abilities.cc:5851-5988)', () => {
  const A = 'ABILITY_ARCHMAGE'
  const typed = (t: string): [string, string, string] => [t, 'MYSTERY', 'MYSTERY']

  it('rolls 30% after DidMoveHit for any damaging move, before the type switch', () => {
    // Bug: the C case is a TODO that does nothing, but the roll has already been drawn
    const bug = run(A, 'MOVE_ATTACK_ORDER', [0, 0])
    expect(bug.rng.calls).toBe(2)
    expect(bug.target.mon.status1).toBe(0)

    // 30 is not < 30: nothing happens (Poison move that would otherwise toxic)
    const miss = run(A, 'MOVE_FUMIGATION_BOMB', [0, 30])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('does not roll for a status move (CHECK_NOT(IS_MOVE_STATUS))', () => {
    const state = battle([{ moves: slot('MOVE_SWORDS_DANCE'), pp: pps, abilities: hasAbility(A) }, {}], scriptedRng([]))
    const rng = state.rng as ReturnType<typeof scriptedRng>
    dispatchMoveEndAttackerAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_SWORDS_DANCE',
      moveData: move('MOVE_SWORDS_DANCE'),
      targetDamage: 0,
      hpDealt: 0,
      deps: testDeps(),
      unmodelled: [],
      fainted: [],
    })
    expect(rng.calls).toBe(0)
  })

  it('Poison / Ice / Water / Fire / Dark inflict toxic / frostbite / confusion / burn / bleed', () => {
    expect(hasFlag(run(A, 'MOVE_FUMIGATION_BOMB', [0, 29]).target.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(run(A, 'MOVE_BLUE_MOON', [0, 29]).target.mon.status1).toBe(STATUS1_FROSTBITE)
    expect(hasFlag(run(A, 'MOVE_AQUA_TAIL', [0, 29, 0]).target.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(run(A, 'MOVE_FIRE_GLAIVE', [0, 29]).target.mon.status1).toBe(STATUS1_BURN)
    expect(run(A, 'MOVE_DARKEST_LARIAT', [0, 29]).target.mon.status1).toBe(STATUS1_BLEED)

    // CanX negatives: Steel is poison-immune, Fire-type target cannot burn, Ice target cannot freeze, Rock cannot bleed, already-burned target
    expect(run(A, 'MOVE_FUMIGATION_BOMB', [0, 29], {}, { types: typed('STEEL') }).target.mon.status1).toBe(0)
    expect(run(A, 'MOVE_FIRE_GLAIVE', [0, 29], {}, { types: typed('FIRE') }).target.mon.status1).toBe(0)
    expect(run(A, 'MOVE_BLUE_MOON', [0, 29], {}, { types: typed('ICE') }).target.mon.status1).toBe(0)
    expect(run(A, 'MOVE_DARKEST_LARIAT', [0, 29], {}, { types: typed('ROCK') }).target.mon.status1).toBe(0)
    expect(run(A, 'MOVE_FIRE_GLAIVE', [0, 29], {}, { status1: STATUS1_PARALYSIS }).target.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('Electric / Psychic / Fairy / Grass set a terrain; Grass sets MISTY as in the C (abilities.cc:5908-5913)', () => {
    const terrain = (id: string) => run(A, id, [0, 29]).state.field.statuses
    expect(hasFlag(terrain('MOVE_CRACKLE_SLAM'), STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
    expect(hasFlag(terrain('MOVE_ASTRAL_HAND'), STATUS_FIELD_PSYCHIC_TERRAIN)).toBe(true)
    expect(hasFlag(terrain('MOVE_FAIRY_WIND'), STATUS_FIELD_MISTY_TERRAIN)).toBe(true)
    const grass = terrain('MOVE_BRANCH_POKE')
    expect(hasFlag(grass, STATUS_FIELD_MISTY_TERRAIN)).toBe(true)
    expect(hasFlag(grass, STATUS_FIELD_GRASSY_TERRAIN)).toBe(false)

    // TryChangeBattleTerrain fails when that terrain is already up: the timer is not reset
    const already = run(A, 'MOVE_CRACKLE_SLAM', [0, 29], {}, {}, (s) => {
      s.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
      s.field.timers.terrainTimer = 3
    })
    expect(already.state.field.timers.terrainTimer).toBe(2) // 3, minus the end-of-turn tick: untouched by the ability
  })

  it('Normal sets Encore on the target (SetEncore, battle_script_commands.c:10739-10758)', () => {
    const setup = (s: BattleState) => {
      s.battlers[1]!.lastMove = 'MOVE_TACKLE'
    }
    const hit = run(A, 'MOVE_CHIP_AWAY', [0, 29], {}, {}, setup)
    expect(hit.target.volatiles.encoredMove).toBe('MOVE_TACKLE')
    expect(hit.target.volatiles.encoredMovePos).toBe(0)
    expect(hit.target.volatiles.encoreTimerStartValue).toBe(3)

    // No last move -> SetEncore fails
    expect(run(A, 'MOVE_CHIP_AWAY', [0, 29]).target.volatiles.encoredMove).toBeNull()
    // Last move is Struggle
    expect(run(A, 'MOVE_CHIP_AWAY', [0, 29], {}, {}, (s) => { s.battlers[1]!.lastMove = 'MOVE_STRUGGLE' }).target.volatiles.encoredMove).toBeNull()
    // Last move's PP is 0
    expect(run(A, 'MOVE_CHIP_AWAY', [0, 29], {}, { pp: [0, 0, 0, 0] }, setup).target.volatiles.encoredMove).toBeNull()
  })

  it('Rock lays Stealth Rock on the target side even if the target fainted; other cases need a live target', () => {
    const ctxFor = (moveId: string, targetHp: number) => {
      const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(A) }, { hp: targetHp }], scriptedRng([29, 29]))
      return {
        state,
        ctx: {
          state,
          attackerId: 0,
          targetId: 1,
          moveId,
          moveData: move(moveId),
          targetDamage: 10,
          hpDealt: 10,
          deps: testDeps(),
          unmodelled: [] as string[],
          fainted: [] as number[],
        },
      }
    }
    const rock = ctxFor('MOVE_ACCELEROCK', 0)
    dispatchMoveEndAttackerAbilities(rock.ctx)
    expect(hasFlag(rock.state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(rock.state.sides[1].timers.stealthRockType).toBe(TYPE_NAME_BY_ID.indexOf('ROCK'))
    expect(hasFlag(rock.state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)

    const dark = ctxFor('MOVE_DARKEST_LARIAT', 0)
    dispatchMoveEndAttackerAbilities(dark.ctx)
    expect(dark.state.battlers[1]!.mon.status1).toBe(0)

    // Already laid: nothing to do (CHECK_NOT)
    const again = ctxFor('MOVE_ACCELEROCK', 100)
    again.state.sides[1].statuses = SIDE_STATUS_STEALTH_ROCK
    again.state.sides[1].timers.stealthRockType = TYPE_NAME_BY_ID.indexOf('GRASS')
    dispatchMoveEndAttackerAbilities(again.ctx)
    expect(again.state.sides[1].timers.stealthRockType).toBe(TYPE_NAME_BY_ID.indexOf('GRASS'))
  })

  it('Ghost disables the target\'s last move (CanBeDisabled + DisableLastUsedMove)', () => {
    const setup = (s: BattleState) => {
      s.battlers[1]!.lastMove = 'MOVE_TACKLE'
    }
    const hit = run(A, 'MOVE_MOONGEIST_BEAM', [0, 29], {}, {}, setup)
    expect(hit.target.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(hit.target.volatiles.disableTimerStartValue).toBe(4)

    // No last move recorded -> DisableLastUsedMove fails
    expect(run(A, 'MOVE_MOONGEIST_BEAM', [0, 29]).target.volatiles.disabledMove).toBeNull()
    // Already has a disabled move -> CanBeDisabled fails
    const already = run(A, 'MOVE_MOONGEIST_BEAM', [0, 29], {}, {}, (s) => {
      setup(s)
      s.battlers[1]!.volatiles.disabledMove = 'MOVE_SPLASH'
    })
    expect(already.target.volatiles.disabledMove).toBe('MOVE_SPLASH')
  })

  it('Fighting / Flying / Steel raise the holder\'s Sp. Atk / Speed / Defense by 1', () => {
    expect(run(A, 'MOVE_AURA_FORCE', [0, 29]).holder.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(run(A, 'MOVE_AEROBLAST', [0, 29]).holder.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(run(A, 'MOVE_ROCKET_PUNCH', [0, 29]).holder.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)

    // Capped at +6: CanRaiseStat fails
    const capped = run(A, 'MOVE_ROCKET_PUNCH', [0, 29], {}, {}, (s) => { s.battlers[0]!.mon.statStages[STAT_DEF] = 12 })
    expect(capped.holder.mon.statStages[STAT_DEF]).toBe(12)
  })

  it('Dragon lowers the target\'s Attack by 1; Ground sets escape prevention', () => {
    expect(run(A, 'MOVE_DRAGON_PULSE', [0, 29]).target.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    // Floor: StatLowerableOrMirrorArmor fails
    expect(run(A, 'MOVE_DRAGON_PULSE', [0, 29], {}, {}, (s) => { s.battlers[1]!.mon.statStages[STAT_ATK] = 0 }).target.mon.statStages[STAT_ATK]).toBe(0)

    const trapped = run(A, 'MOVE_HIGH_HORSEPOWER', [0, 29])
    expect(hasFlag(trapped.target.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(trapped.target.volatiles.battlerPreventingEscape).toBe(0)
    // Already trapped: CHECK_NOT fails, battlerPreventingEscape unchanged
    const already = run(A, 'MOVE_HIGH_HORSEPOWER', [0, 29], {}, { status2: STATUS2_ESCAPE_PREVENTION }, (s) => {
      s.battlers[1]!.volatiles.battlerPreventingEscape = 1
    })
    expect(already.target.volatiles.battlerPreventingEscape).toBe(1)
  })
})

describe("Cycle 91a - Angel's Wrath (src/abilities.cc:5570-5666)", () => {
  const AW = 'ABILITY_ANGELS_WRATH'
  const direct = (
    moveId: string,
    holder: Parameters<typeof battle>[0][number] = {},
    target: Parameters<typeof battle>[0][number] = {},
    opts: { hpDealt?: number; grounding?: GroundingContext; setup?: (s: BattleState) => void } = {},
  ) => {
    const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(AW), ...holder }, target], scriptedRng([]))
    opts.setup?.(state)
    const unmodelled: string[] = []
    dispatchMoveEndAttackerAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId,
      moveData: move(moveId),
      targetDamage: opts.hpDealt ?? 10,
      hpDealt: opts.hpDealt ?? 10,
      deps: testDeps(fixedDamage(10), undefined, opts.grounding),
      unmodelled,
      fainted: [],
    })
    return { state, holder: state.battlers[0]!, target: state.battlers[1]!, unmodelled }
  }

  it('Tackle sets Encore and Disable (timer 2) on the target\'s slot-0 move', () => {
    const r = direct('MOVE_TACKLE', {}, { moves: slot('MOVE_SCRATCH', 'MOVE_TACKLE') })
    expect(r.target.volatiles.encoreTimer).toBe(2)
    expect(r.target.volatiles.encoredMove).toBe('MOVE_SCRATCH')
    expect(r.target.volatiles.disableTimer).toBe(2)
    expect(r.target.volatiles.disableTimerStartValue).toBe(2)
    expect(r.target.volatiles.disabledMove).toBe('MOVE_SCRATCH')

    // Only the missing half is set: an existing Encore (timer 3) is left alone
    const half = direct('MOVE_TACKLE', {}, {}, { setup: (s) => { s.battlers[1]!.volatiles.encoreTimer = 3; s.battlers[1]!.volatiles.encoredMove = 'MOVE_SPLASH' } })
    expect(half.target.volatiles.encoreTimer).toBe(3)
    expect(half.target.volatiles.encoredMove).toBe('MOVE_SPLASH')
    expect(half.target.volatiles.disableTimer).toBe(2)

    // Both already set -> CHECK(!encore || !disable) fails, nothing changes
    const both = direct('MOVE_TACKLE', {}, {}, {
      setup: (s) => {
        s.battlers[1]!.volatiles.encoreTimer = 3
        s.battlers[1]!.volatiles.disableTimer = 3
      },
    })
    expect(both.target.volatiles.encoreTimer).toBe(3)
    expect(both.target.volatiles.disableTimer).toBe(3)
    expect(both.target.volatiles.disabledMove).toBeNull()

    // Not Tackle, or no damage dealt
    expect(direct('MOVE_SCRATCH').target.volatiles.encoreTimer).toBe(0)
    expect(direct('MOVE_TACKLE', {}, {}, { hpDealt: 0 }).target.volatiles.encoreTimer).toBe(0)
  })

  it('Electroweb drops Speed to -6 and traps the target', () => {
    const r = direct('MOVE_ELECTROWEB')
    expect(r.target.mon.statStages[STAT_SPEED]).toBe(0)
    expect(hasFlag(r.target.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)

    // Already trapped: nothing happens
    const trapped = direct('MOVE_ELECTROWEB', {}, { status2: STATUS2_ESCAPE_PREVENTION })
    expect(trapped.target.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)

    // Speed already at -6: CHECK_NOT(statStages[SPEED] == MIN) fails, so no trap either
    const floored = direct('MOVE_ELECTROWEB', {}, {}, { setup: (s) => { s.battlers[1]!.mon.statStages[STAT_SPEED] = 0 } })
    expect(hasFlag(floored.target.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
  })

  it('Bug Bite heals the holder by the damage dealt, with Big Root / Absorbant x3/2 (GetDrainedBigRootHp)', () => {
    expect(direct('MOVE_BUG_BITE', { hp: 50 }).holder.mon.hp).toBe(60)

    const bigRoot: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => (id === 0 ? 'HOLD_EFFECT_BIG_ROOT' : null) }
    expect(direct('MOVE_BUG_BITE', { hp: 50 }, {}, { grounding: bigRoot }).holder.mon.hp).toBe(65)

    const absorbant = { ability: AW, innates: ['ABILITY_ABSORBANT', null, null] as [string, null, null] }
    expect(direct('MOVE_BUG_BITE', { hp: 50, abilities: absorbant }).holder.mon.hp).toBe(65)
    // both: trunc(trunc(10 * 3 / 2) * 3 / 2) = trunc(15 * 3 / 2) = 22
    expect(direct('MOVE_BUG_BITE', { hp: 50, abilities: absorbant }, {}, { grounding: bigRoot }).holder.mon.hp).toBe(72)

    // Full HP: BATTLER_MAX_HP check fails; no damage: ShouldApplyOnHitEffect fails
    expect(direct('MOVE_BUG_BITE', { hp: 100 }).holder.mon.hp).toBe(100)
    expect(direct('MOVE_BUG_BITE', { hp: 50 }, {}, { hpDealt: 0 }).holder.mon.hp).toBe(50)
    // Heal is capped at max HP
    expect(direct('MOVE_BUG_BITE', { hp: 95 }).holder.mon.hp).toBe(100)
  })

  it('String Shot / Harden / Iron Defense are reported as unmodelled, not silently skipped', () => {
    for (const id of ['MOVE_STRING_SHOT', 'MOVE_HARDEN', 'MOVE_IRON_DEFENSE']) {
      const r = direct(id, {}, {}, { hpDealt: 0 })
      expect(r.unmodelled.some((m) => m.includes(`Angel's Wrath's ${id} case`))).toBe(true)
    }
  })
})
