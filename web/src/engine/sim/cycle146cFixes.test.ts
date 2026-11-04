/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction, type TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applySwitchInAbilities, SWITCH_IN_ABILITY_IDS } from './switchInAbility'
import { abilityForSpeciesSlot } from './formChange'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData } from './driver/loadSimData'
import { createSession } from './driver/session'
import { createRandomSource } from './rng'
import type { InnateTier } from './innateGate'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle146Abilities.test.ts lines 1-260.
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
  abilityNum?: number
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
  tier?: InnateTier,
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
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          abilityNum: s.abilityNum,
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
    playerParty,
    opponentParty,
    tier,
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  replacement?: ReplacementDeps,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function useMove(target: number, moveId: string): ChosenAction {
  const m = requireMove(moveId)
  const view: TurnOrderMoveView = {
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
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

// ---------------------------------------------------------------------------
// Item 1: Transform copies abilityNum
// ---------------------------------------------------------------------------

describe('Item 1: Transform copies abilityNum', () => {
  it('copies the target slot onto the attacker (battle_script_commands.c:10513)', () => {
    const state = battle([
      { abilityNum: 0, moves: ['MOVE_TRANSFORM', null, null, null], pp: [10, 0, 0, 0] },
      { abilityNum: 2 },
    ])
    expect(state.battlers[0]!.mon.abilityNum).toBe(0)

    executeTurn(state, [useMove(1, 'MOVE_TRANSFORM'), null], testDeps())

    expect(state.battlers[0]!.mon.abilityNum).toBe(2)
  })

  it('a target slot 0 overwrites the attacker slot: the copy is not a no-op', () => {
    const state = battle([
      { abilityNum: 1, moves: ['MOVE_TRANSFORM', null, null, null], pp: [10, 0, 0, 0] },
      { abilityNum: 0 },
    ])
    expect(state.battlers[0]!.mon.abilityNum).toBe(1)

    executeTurn(state, [useMove(1, 'MOVE_TRANSFORM'), null], testDeps())

    // Cmd_transformdataexecution (src/battle_script_commands.c:10513) assigns unconditionally,
    // so a slot-0 target leaves the attacker at 0 rather than keeping its own 1.
    expect(state.battlers[0]!.mon.abilityNum).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Item 2: positive test for the switch-in entry fallback note
// ---------------------------------------------------------------------------

describe('Item 2: HandleSwitchInAbility fallback note', () => {
  it('fires once for a synthetic unported onEntry ability, not for a ported one or an id outside the set', () => {
    const SYNTHETIC_ID = 'ABILITY_TEST_SYNTHETIC_ENTRY'
    ;(SWITCH_IN_ABILITY_IDS as Set<string>).add(SYNTHETIC_ID)
    try {
      // 1. Synthetic unported ability in SWITCH_IN_ABILITY_IDS produces the note exactly once.
      const synthetic = battle([{ abilities: hasAbility(SYNTHETIC_ID) }, {}])
      const syntheticUnmodelled: string[] = []
      applySwitchInAbilities(synthetic, 0, testDeps(), syntheticUnmodelled)
      const note = "battler 0: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ABILITY_TEST_SYNTHETIC_ENTRY's onEntry hook was not run"
      expect(syntheticUnmodelled.filter((n) => n === note)).toHaveLength(1)

      // 2. A ported entry ability (Petal Shield, handled at switchInAbility.ts:2417) produces none.
      const ported = battle([{ abilities: hasAbility('ABILITY_PETAL_SHIELD') }, {}])
      const portedUnmodelled: string[] = []
      applySwitchInAbilities(ported, 0, testDeps(), portedUnmodelled)
      expect(portedUnmodelled.some((n) => n.includes('HandleSwitchInAbility'))).toBe(false)

      // 3. An id outside SWITCH_IN_ABILITY_IDS never reaches HandleSwitchInAbility.
      const outside = battle([{ abilities: hasAbility('ABILITY_TEST_OUTSIDE_SET') }, {}])
      const outsideUnmodelled: string[] = []
      applySwitchInAbilities(outside, 0, testDeps(), outsideUnmodelled)
      expect(outsideUnmodelled.some((n) => n.includes('HandleSwitchInAbility'))).toBe(false)
    } finally {
      ;(SWITCH_IN_ABILITY_IDS as Set<string>).delete(SYNTHETIC_ID)
    }
  })
})

// ---------------------------------------------------------------------------
// Item 4: the real Unown Revelation path through createSession
// ---------------------------------------------------------------------------

describe('Item 4: Unown Revelation through createSession', () => {
  it('TRAINER_JAIDEN hell Unown enters with abilityNum 1 and reforms on the entry pass', () => {
    const data = loadSimData()
    // BaseStatsGenerator/battle_util row: {ABILITY_REVELATION, SPECIES_UNOWN_REVELATION,
    // SPECIES_UNOWN, 4} (src/battle_util.c:3808). Slot 1 of the reformed species is Minion Control.
    expect(requireSpecies('SPECIES_UNOWN_REVELATION').abilities).toEqual([
      'ABILITY_ANTICIPATION',
      'ABILITY_MINION_CONTROL',
      'ABILITY_MAGIC_BOUNCE',
    ])

    const jaiden = data.trainersById.get('TRAINER_JAIDEN')!
    const unown = jaiden.parties.hell.find((m) => m.species === 'SPECIES_UNOWN')
    expect(unown).toBeDefined()
    expect(unown!.ability).toBe('ABILITY_MYSTIC_POWER')
    // Make the Jaiden Unown the hell lead so createSession's first entry pass runs on it.
    const trainer: TrainerData = { ...jaiden, parties: { ...jaiden.parties, hell: [unown!] } }

    const session = createSession({
      data,
      playerParty: buildPlayerParty([{ species: 'SPECIES_MUDKIP', moves: ['MOVE_TACKLE'] }], 50, data),
      opponentTrainer: trainer,
      tier: 'hell',
      rng: createRandomSource(1),
    })

    const foe = session.state.battlers[1]!
    // `ability` is a real ability id in the textproto (TrainerList.proto:248), so Mystic Power
    // is slot 1 of SPECIES_UNOWN's [Run Away, Mystic Power, Magic Guard].
    expect(session.state.sides[1].party[0]!.abilityNum).toBe(1)
    expect(foe.mon.abilityNum).toBe(1)
    // applyBattleStartPass -> Impl<ABILITY_REVELATION>.onEntry (abilities.cc:10778-10780) ->
    // TryTransformAttacker -> ShouldChangeFormHpBased's ABILITY_REVELATION row.
    expect(foe.mon.speciesId).toBe('SPECIES_UNOWN_REVELATION')
    expect(foe.mon.abilities.ability).toBe('ABILITY_MINION_CONTROL')
  })
})

// ---------------------------------------------------------------------------
// Item 6: GetAbilityBySpecies reads the C's padded ability array
// ---------------------------------------------------------------------------

describe('Item 6: abilityForSpeciesSlot pads with the last declared ability', () => {
  it('two declared abilities: slots 0/1/2 map to first/second/second; slot 3 to first', () => {
    // BaseStatsGenerator.kt:48-51 pads the C array [a0, a1] to [a0, a1, a1];
    // GetAbilityBySpecies (src/pokemon.c:2147-2157) indexes that padded array for slots 0..2
    // and falls back to abilities[0] only for a slot >= NUM_ABILITY_SLOTS.
    const species = { abilities: ['ABILITY_REGENERATOR', 'ABILITY_WEAK_ARMOR'] }
    expect(abilityForSpeciesSlot(species, 0)).toBe('ABILITY_REGENERATOR')
    expect(abilityForSpeciesSlot(species, 1)).toBe('ABILITY_WEAK_ARMOR')
    expect(abilityForSpeciesSlot(species, 2)).toBe('ABILITY_WEAK_ARMOR')
    expect(abilityForSpeciesSlot(species, 3)).toBe('ABILITY_REGENERATOR')
    expect(abilityForSpeciesSlot(species, -1)).toBe('ABILITY_REGENERATOR')
  })
})
