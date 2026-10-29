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
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
import {
  CHECK_BURN,
  CHECK_DRENCH,
  CHECK_FLINCH,
  CHECK_FROSTBITE,
  CHECK_HEAL_BLOCK,
  CHECK_INFATUATE,
  CHECK_PARALYSIS,
  CHECK_POISON,
  CHECK_REDIRECTION,
  CHECK_SLEEP,
  REMOVES_STATUS_ON_IMMUNITY_ABILITIES,
  findCureOnImmunityAbility,
  isAbilityStatusProtected,
} from './statusEffects'
import type { StatusDeps } from './statusEffects'
import { getStatDropBlockType } from './statBuffs'
import {
  DEFAULT_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_CONFUSION,
  STATUS2_INFATUATION,
  STATUS2_TORMENT,
  WEATHER_SANDSTORM_TEMPORARY,
} from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle102Accuracy.test.ts uses.
// `requireMove` strips the TYPE_ prefix from `type` the way the production
// loader does (driver/loadSimData.ts:181).
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
const abilityHooks = snapshot<Record<string, { bitfields?: Record<string, string>; hooks?: Record<string, unknown> }>>(
  'abilityHooks.json',
)

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

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
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

function testDeps(damage: DamageResolver = fixedDamage(20)): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

/** One turn: battler 0 uses `moveId` on battler 1. Fixed damage keeps the turn
 * loop out of the damage engine's type chart, so every assertion below is about
 * the ability hook under test. */
function runTurn(specs: BattlerSpec[], moveId: string, rolls: number[] = [0, 0, 0, 0, 0, 0, 0, 0], dmg = 20) {
  const state = battle([{ moves: slot(moveId), pp: pps, ...(specs[0] ?? {}) }, specs[1] ?? {}], scriptedRng(rolls))
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, out }
}

function statStagesOf(state: BattleState, battlerId: number): number[] {
  return state.battlers[battlerId]!.mon.statStages
}

// ---------------------------------------------------------------------------
// 1. The 16 boss-union onStatusImmune abilities (battle_script_commands.c:6579-6591)
// ---------------------------------------------------------------------------

describe('cycle 103 - onStatusImmune abilities block their own status (battle_script_commands.c:6579-6591)', () => {
  const CASES: [string, number, boolean?][] = [
    ['ABILITY_AMPHIBIOUS', CHECK_DRENCH],
    ['ABILITY_AROMA_VEIL', CHECK_INFATUATE],
    ['ABILITY_DESERT_CLOAK', CHECK_POISON, true],
    ['ABILITY_DUNE_VEIL', CHECK_POISON, true],
    ['ABILITY_IMMUNITY', CHECK_POISON],
    ['ABILITY_INNER_FOCUS', CHECK_FLINCH],
    ['ABILITY_JUGGERNAUT', CHECK_PARALYSIS],
    ['ABILITY_LIMBER', CHECK_PARALYSIS],
    ['ABILITY_MAGMA_ARMOR', CHECK_FROSTBITE],
    ['ABILITY_OBLIVIOUS', CHECK_INFATUATE],
    ['ABILITY_PROPELLER_TAIL', CHECK_REDIRECTION],
    ['ABILITY_PURIFYING_WATERS', CHECK_BURN],
    ['ABILITY_VITAL_SPIRIT', CHECK_SLEEP],
    ['ABILITY_WATER_BUBBLE', CHECK_BURN],
    ['ABILITY_WATER_VEIL', CHECK_BURN],
    ['ABILITY_WAY_OF_PRECISION', CHECK_FLINCH],
  ]

  for (const [abilityId, status, needsSand] of CASES) {
    it(`${abilityId} protects against its status`, () => {
      const state = battle([{}, { abilities: ability(abilityId) }], scriptedRng([]))
      if (needsSand) state.field.weather = WEATHER_SANDSTORM_TEMPORARY
      expect(isAbilityStatusProtected(state, 1, status, 0, STATUS_DEPS)).toBe(abilityId)
    })
  }

  it('reads the ability from an innate slot too (ON_ABILITY scans all four slots)', () => {
    // battle_util.h:269-275: the macro walks innates[2], innates[1], innates[0],
    // then the chosen ability, so a boss-union innate must still be found.
    const state = battle([{}, { abilities: ability(null as unknown as string, null, null, 'ABILITY_LIMBER') }], scriptedRng([]))
    expect(isAbilityStatusProtected(state, 1, CHECK_PARALYSIS, 0, STATUS_DEPS)).toBe('ABILITY_LIMBER')
  })

  it('does not protect against a status outside the hook', () => {
    const state = battle([{}, { abilities: ability('ABILITY_WATER_VEIL') }], scriptedRng([]))
    expect(isAbilityStatusProtected(state, 1, CHECK_PARALYSIS, 0, STATUS_DEPS)).toBeNull()
  })

  it('Desert Cloak needs sandstorm: no weather means no protection', () => {
    const state = battle([{}, { abilities: ability('ABILITY_DESERT_CLOAK') }], scriptedRng([]))
    expect(isAbilityStatusProtected(state, 1, CHECK_POISON, 0, STATUS_DEPS)).toBeNull()
  })

  it('Aroma Veil also covers heal block, but Inner Focus does not cover redirection', () => {
    const aroma = battle([{}, { abilities: ability('ABILITY_AROMA_VEIL') }], scriptedRng([]))
    expect(isAbilityStatusProtected(aroma, 1, CHECK_HEAL_BLOCK, 0, STATUS_DEPS)).toBe('ABILITY_AROMA_VEIL')
    const inner = battle([{}, { abilities: ability('ABILITY_INNER_FOCUS') }], scriptedRng([]))
    expect(isAbilityStatusProtected(inner, 1, CHECK_REDIRECTION, 0, STATUS_DEPS)).toBeNull()
  })

  it('a Mold Breaker attacker suppresses a breakable immunity (so a status can land)', () => {
    const state = battle(
      [{ abilities: ability('ABILITY_MOLD_BREAKER') }, { abilities: ability('ABILITY_LIMBER') }],
      scriptedRng([]),
    )
    expect(isAbilityStatusProtected(state, 1, CHECK_PARALYSIS, 0, STATUS_DEPS)).toBeNull()
    // The move-end re-check runs with checkMoldBreaker FALSE (battle_util.c:4560-4609):
    // the same ability is still the cure source.
    expect(findCureOnImmunityAbility(state, 1, CHECK_PARALYSIS, STATUS_DEPS)).toBe('ABILITY_LIMBER')
  })
})

// ---------------------------------------------------------------------------
// 2. MOVEEND_STATUS_IMMUNITY_ABILITIES (battle_script_commands.c:4537-4542,
//    battle_util.c:4505-4609)
// ---------------------------------------------------------------------------

describe('cycle 103 - move-end cures a status the immunity ability covers (battle_util.c:4505-4609)', () => {
  it('cures a pre-existing paralysis on a Limber holder after any move', () => {
    const { state } = runTurn([{}, { abilities: ability('ABILITY_LIMBER'), status1: STATUS1_PARALYSIS }], 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.hp).toBeLessThan(100)
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('control: without the ability the same paralysis survives the move', () => {
    const { state } = runTurn([{}, { status1: STATUS1_PARALYSIS }], 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('Mold Breaker lets MOVE_EMBER land its burn, then Water Veil removes it (battle_util.c:4564-4574)', () => {
    const { state } = runTurn(
      [{ abilities: ability('ABILITY_MOLD_BREAKER') }, { abilities: ability('ABILITY_WATER_VEIL') }],
      'MOVE_EMBER',
    )
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('control: the same Mold Breaker Ember burns a target without an immunity ability', () => {
    const { state } = runTurn([{ abilities: ability('ABILITY_MOLD_BREAKER') }, {}], 'MOVE_EMBER')
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('only the highest-priority status is tested per pass: poison hides Own Tempo confusion', () => {
    // battle_util.c:4508-4531 picks exactly one status (poison first, confusion
    // seventh); Own Tempo's hook cannot answer CHECK_POISON, so nothing is cured.
    const { state } = runTurn(
      [{}, { abilities: ability('ABILITY_OWN_TEMPO'), status1: STATUS1_POISON, status2: STATUS2_CONFUSION }],
      'MOVE_TACKLE',
    )
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    expect(state.battlers[1]!.mon.status2 & STATUS2_CONFUSION).toBe(STATUS2_CONFUSION)
  })

  it('re-enters until a full pass cures nothing: burn and confusion both clear', () => {
    // Pass 1 picks CHECK_BURN (Water Veil answers), pass 2 restarts the scan and
    // picks CHECK_CONFUSION (Own Tempo answers), pass 3 finds nothing.
    const { state } = runTurn(
      [
        {},
        {
          abilities: ability('ABILITY_WATER_VEIL', null, null, 'ABILITY_OWN_TEMPO'),
          status1: STATUS1_BURN,
          status2: STATUS2_CONFUSION,
        },
      ],
      'MOVE_TACKLE',
    )
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(state.battlers[1]!.mon.status2 & STATUS2_CONFUSION).toBe(0)
  })

  it('cures infatuation and the restricting volatiles once Oblivious is on the field', () => {
    const infatuated = runTurn(
      [{}, { abilities: ability('ABILITY_OBLIVIOUS'), status2: STATUS2_INFATUATION }],
      'MOVE_TACKLE',
    )
    expect(infatuated.state.battlers[1]!.mon.status2 & STATUS2_INFATUATION).toBe(0)

    const restricting = runTurn(
      [{}, { abilities: ability('ABILITY_OBLIVIOUS'), status2: STATUS2_TORMENT }],
      'MOVE_TACKLE',
    )
    expect(restricting.state.battlers[1]!.mon.status2 & STATUS2_TORMENT).toBe(0)
  })

  it('Infatuation outranks the restricting check (battle_util.c:4527-4530)', () => {
    // Aroma Veil covers both, so the two are indistinguishable there; Oblivious
    // covers both as well. Use Water Veil (burn only) with infatuation+torment:
    // CHECK_INFATUATE is picked and nothing answers -> both survive.
    const { state } = runTurn(
      [{}, { abilities: ability('ABILITY_WATER_VEIL'), status2: STATUS2_INFATUATION | STATUS2_TORMENT }],
      'MOVE_TACKLE',
    )
    expect(state.battlers[1]!.mon.status2 & (STATUS2_INFATUATION | STATUS2_TORMENT)).not.toBe(0)
  })

  it('the pinned removesStatusOnImmunity list is exactly the snapshot bitfield + hook set', () => {
    const withBitfield = Object.entries(abilityHooks)
      .filter(([, v]) => v.bitfields?.removesStatusOnImmunity === 'TRUE')
      .map(([id]) => id)
      .sort()
    const withHook = withBitfield.filter((id) => abilityHooks[id]!.hooks?.onStatusImmune != null)
    expect(withBitfield).toHaveLength(29)
    // Bruteforce / Rock Head / Steel Barrel carry the bitfield but declare no
    // onStatusImmune hook, so ON_ABILITY's filter can never fire for them.
    expect(withBitfield.filter((id) => !withHook.includes(id))).toEqual([
      'ABILITY_BRUTEFORCE',
      'ABILITY_ROCK_HEAD',
      'ABILITY_STEEL_BARREL',
    ])
    expect([...REMOVES_STATUS_ON_IMMUNITY_ABILITIES].sort()).toEqual(withHook)
  })

  it('9 of the 16 boss-union onStatusImmune abilities carry removesStatusOnImmunity', () => {
    // Nine of the sixteen are covered here; the other seven block statuses only
    // through the ordinary application path (no removesStatusOnImmunity bit).
    const bossUnion = [
      'ABILITY_AMPHIBIOUS',
      'ABILITY_AROMA_VEIL',
      'ABILITY_DESERT_CLOAK',
      'ABILITY_DUNE_VEIL',
      'ABILITY_IMMUNITY',
      'ABILITY_INNER_FOCUS',
      'ABILITY_JUGGERNAUT',
      'ABILITY_LIMBER',
      'ABILITY_MAGMA_ARMOR',
      'ABILITY_OBLIVIOUS',
      'ABILITY_PROPELLER_TAIL',
      'ABILITY_PURIFYING_WATERS',
      'ABILITY_VITAL_SPIRIT',
      'ABILITY_WATER_BUBBLE',
      'ABILITY_WATER_VEIL',
      'ABILITY_WAY_OF_PRECISION',
    ]
    const covered = bossUnion.filter((a) => REMOVES_STATUS_ON_IMMUNITY_ABILITIES.includes(a))
    expect(covered).toEqual([
      'ABILITY_IMMUNITY',
      'ABILITY_JUGGERNAUT',
      'ABILITY_LIMBER',
      'ABILITY_MAGMA_ARMOR',
      'ABILITY_OBLIVIOUS',
      'ABILITY_PURIFYING_WATERS',
      'ABILITY_VITAL_SPIRIT',
      'ABILITY_WATER_BUBBLE',
      'ABILITY_WATER_VEIL',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. GetTotalAccuracy reads STAT_DROP_BLOCK_SPECIFIC (battle_script_commands.c:1336-1337)
// ---------------------------------------------------------------------------

describe('cycle 103 - accuracy honours a SPECIFIC-only stat-drop block (battle_script_commands.c:1336-1337)', () => {
  const EVASION_UP_2 = DEFAULT_STAT_STAGE + 2

  function accuracyWith(attacker: BattlerSpec, defenderEvasionStage: number, moveId = 'MOVE_TACKLE'): number {
    const state = battle([{ moves: slot(moveId), pp: pps, ...attacker }, {}], scriptedRng([]))
    state.battlers[1]!.mon.statStages[7] = defenderEvasionStage
    return getTotalAccuracy(buildAccuracyInputs(state, 0, 1, moveId, false, testDeps()).inputs).accuracy
  }

  it('Keen Eye turns the +2 evasion boost off: 100 instead of trunc(100 * 2 / 3) = 66', () => {
    expect(accuracyWith({}, EVASION_UP_2)).toBe(66)
    expect(accuracyWith({ abilities: ability('ABILITY_KEEN_EYE') }, EVASION_UP_2)).toBe(100)
  })

  it("Mind's Eye shares the hook body (stat == STAT_ACC, CHECK_NOT(selfStatDrop))", () => {
    expect(accuracyWith({ abilities: ability('ABILITY_MINDS_EYE') }, EVASION_UP_2)).toBe(100)
  })

  it('Hyper Cutter is not STAT_ACC, so the evasion stage still applies', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_HYPER_CUTTER') }, EVASION_UP_2)).toBe(66)
  })

  it('Clear Body returns ALL, which is not SPECIFIC: the evasion stage still applies', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_CLEAR_BODY') }, EVASION_UP_2)).toBe(66)
  })

  it('evasion DOWN is kept: min(-2 stage, neutral) is the -2 stage', () => {
    // MOVE_HYPNOSIS is accuracy 60. A lowered evasion (stage 4) gives 60 * 3 / 2 = 90,
    // so the clamp only ever removes boosts. Mind's Eye has no onAccuracy hook
    // (Keen Eye's own *accuracy *= 1.2 would mask the number).
    expect(accuracyWith({ abilities: ability('ABILITY_MINDS_EYE') }, DEFAULT_STAT_STAGE - 2, 'MOVE_HYPNOSIS')).toBe(90)
  })

  it('the dropped stages take the `else if`: SPECIFIC wins over Unaware', () => {
    // battle_script_commands.c:1336-1341: the stat-drop test is the first arm and
    // Unaware is its `else if`. With the evasion stage at -2 the two disagree:
    //   SPECIFIC -> min(4, 6) = 4 -> buff 8 -> 60 * 3 / 2 = 90
    //   Unaware  -> 6           -> buff 6 -> 60
    const specific = accuracyWith(
      { abilities: ability('ABILITY_MINDS_EYE', null, null, 'ABILITY_UNAWARE') },
      DEFAULT_STAT_STAGE - 2,
      'MOVE_HYPNOSIS',
    )
    expect(specific).toBe(90)
    // Control: Unaware alone ignores the drop and returns the neutral 60.
    expect(accuracyWith({ abilities: ability('ABILITY_UNAWARE') }, DEFAULT_STAT_STAGE - 2, 'MOVE_HYPNOSIS')).toBe(60)
  })

  it('an evasion drop is not undone by the clamp when no ability blocks the drop', () => {
    expect(accuracyWith({}, DEFAULT_STAT_STAGE - 2, 'MOVE_HYPNOSIS')).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 4. GetStatDropBlock's return type and partner scan (abilities.cc:437-461)
// ---------------------------------------------------------------------------

describe('cycle 103 - GetStatDropBlock type and partner scan (abilities.cc:437-461)', () => {
  const deps = STATUS_DEPS

  function blockType(specs: BattlerSpec[], targetId: number, statId: number, selfStatDrop = false) {
    const state = battle(specs, scriptedRng([]))
    return getStatDropBlockType(state, targetId, statId, selfStatDrop, deps, [])
  }

  it('Clear Body / Full Metal Body return ALL for any stat', () => {
    for (const statId of [STAT_ATK, STAT_DEF, STAT_ACC]) {
      expect(blockType([{}, { abilities: ability('ABILITY_CLEAR_BODY') }], 1, statId)).toBe('ALL')
    }
  })

  it('Keen Eye is SPECIFIC and only for STAT_ACC on someone else', () => {
    expect(blockType([{}, { abilities: ability('ABILITY_KEEN_EYE') }], 1, STAT_ACC)).toBe('SPECIFIC')
    expect(blockType([{}, { abilities: ability('ABILITY_KEEN_EYE') }], 1, STAT_ATK)).toBe('NONE')
    expect(blockType([{}, { abilities: ability('ABILITY_KEEN_EYE') }], 1, STAT_ACC, true)).toBe('NONE')
  })

  it('Hyper Cutter is SPECIFIC for Atk and SpAtk only', () => {
    expect(blockType([{}, { abilities: ability('ABILITY_HYPER_CUTTER') }], 1, STAT_ATK)).toBe('SPECIFIC')
    expect(blockType([{}, { abilities: ability('ABILITY_HYPER_CUTTER') }], 1, STAT_SPATK)).toBe('SPECIFIC')
    expect(blockType([{}, { abilities: ability('ABILITY_HYPER_CUTTER') }], 1, STAT_SPEED)).toBe('NONE')
  })

  it('Limber only blocks self-inflicted drops (CHECK(selfStatDrop))', () => {
    expect(blockType([{}, { abilities: ability('ABILITY_LIMBER') }], 1, STAT_SPEED, true)).toBe('ALL')
    expect(blockType([{}, { abilities: ability('ABILITY_LIMBER') }], 1, STAT_SPEED, false)).toBe('NONE')
  })

  it('Desert Cloak blocks only under sandstorm', () => {
    const state = battle([{}, { abilities: ability('ABILITY_DESERT_CLOAK') }], scriptedRng([]))
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    expect(getStatDropBlockType(state, 1, STAT_ATK, false, deps, [])).toBe('ALL')
    state.field.weather = 0
    expect(getStatDropBlockType(state, 1, STAT_ATK, false, deps, [])).toBe('NONE')
  })

  it('an APPLY_ON_ALLY partner blocks the drop, with the hook still asked about the target', () => {
    // abilities.cc:447-458: the partner's hook receives *battler (the target).
    const sand = battle(
      [{}, {}, { abilities: ability('ABILITY_DESERT_CLOAK') }, {}],
      scriptedRng([]),
    )
    sand.field.weather = WEATHER_SANDSTORM_TEMPORARY
    expect(getStatDropBlockType(sand, 0, STAT_ATK, false, deps, [])).toBe('ALL')

    // Target not Grass: Flower Veil's own condition still fails even though the
    // partner holds the ability.
    const nonGrass = battle(
      [{ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, {}, { abilities: ability('ABILITY_FLOWER_VEIL') }, {}],
      scriptedRng([]),
    )
    expect(getStatDropBlockType(nonGrass, 0, STAT_ATK, false, deps, [])).toBe('NONE')

    const grass = battle(
      [{ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, {}, { abilities: ability('ABILITY_FLOWER_VEIL') }, {}],
      scriptedRng([]),
    )
    expect(getStatDropBlockType(grass, 0, STAT_ATK, false, deps, [])).toBe('ALL')

    const grassJungle = battle(
      [{ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, {}, { abilities: ability('ABILITY_JUNGLES_GUARD') }, {}],
      scriptedRng([]),
    )
    expect(getStatDropBlockType(grassJungle, 0, STAT_ATK, false, deps, [])).toBe('ALL')
  })

  it('an APPLY_ON_SELF ability on the partner does nothing (IsApplyOnFlagAppropriate)', () => {
    const state = battle([{}, {}, { abilities: ability('ABILITY_CLEAR_BODY') }, {}], scriptedRng([]))
    expect(getStatDropBlockType(state, 0, STAT_ATK, false, deps, [])).toBe('NONE')
  })

  it('a fainted partner cannot block', () => {
    const state = battle([{}, {}, { abilities: ability('ABILITY_DESERT_CLOAK'), hp: 0 }, {}], scriptedRng([]))
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    expect(getStatDropBlockType(state, 0, STAT_ATK, false, deps, [])).toBe('NONE')
  })
})

// ---------------------------------------------------------------------------
// 5. Real stat-drop moves against the single-stat caller
//    (battle_script_commands.c:9757-9800: ANY nonzero type blocks)
// ---------------------------------------------------------------------------

describe('cycle 103 - real stat drops are blocked by both ALL and SPECIFIC results', () => {
  it('Clear Body stops Charm (Atk -2 stays at neutral)', () => {
    const { state } = runTurn([{}, { abilities: ability('ABILITY_CLEAR_BODY') }], 'MOVE_CHARM')
    expect(statStagesOf(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('control: Charm lowers Atk by 2 without the ability', () => {
    const { state } = runTurn([{}, {}], 'MOVE_CHARM')
    expect(statStagesOf(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 2)
  })

  it('Clear Body stops both halves of Tickle', () => {
    const { state } = runTurn([{}, { abilities: ability('ABILITY_CLEAR_BODY') }], 'MOVE_TICKLE')
    expect(statStagesOf(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statStagesOf(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Hyper Cutter blocks Tickle\'s Atk half but not its Def half', () => {
    const { state } = runTurn([{}, { abilities: ability('ABILITY_HYPER_CUTTER') }], 'MOVE_TICKLE')
    expect(statStagesOf(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statStagesOf(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('Keen Eye blocks Sand-Attack but not Charm', () => {
    const sand = runTurn([{}, { abilities: ability('ABILITY_KEEN_EYE') }], 'MOVE_SAND_ATTACK')
    expect(statStagesOf(sand.state, 1)[STAT_ACC]).toBe(DEFAULT_STAT_STAGE)

    const charm = runTurn([{}, { abilities: ability('ABILITY_KEEN_EYE') }], 'MOVE_CHARM')
    expect(statStagesOf(charm.state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 2)
  })

  it('Hyper Cutter does not stop a Speed drop', () => {
    const { state } = runTurn([{}, { abilities: ability('ABILITY_HYPER_CUTTER') }], 'MOVE_LOW_SWEEP')
    expect(statStagesOf(state, 1)[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })
})
