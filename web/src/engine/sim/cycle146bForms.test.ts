/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applySwitchInAbilities } from './switchInAbility'
import { getAbilityStateOf, runEndTurnEffects, setAbilityStateOf, ENDTURN_ABILITY_IDS } from './endTurn'
import { WEATHER_HAIL_ANY } from './constants'
import { abilityForSpeciesSlot, changeBattlerForm } from './formChange'
import { buildOpponentParty, buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData } from './driver/loadSimData'
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

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
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

/** Per-battler end-turn ladder alone. */
function endTurn(state: BattleState) {
  return runEndTurnEffects(state, state.battlers.map((_, i) => i), DATA_CONTEXT, { grounding: GROUNDING, statStageRatios: RATIOS })
}

// ---------------------------------------------------------------------------
// Defect 1: Form change ability slot preservation and party builders
// ---------------------------------------------------------------------------

describe('Defect 1: Form change keeps the ability slot across transformations', () => {
  const MINIOR_L50_MAX_HP = 135
  // Distinct nonzero seeds so a copy-by-index remap is distinguishable from a copy-by-identity one.
  const SEEDED_METEOR_STATE = 5
  const SEEDED_SHIELDS_DOWN_STATE = 3

  it('Shields Down Meteor <-> Core preserves abilityNum 0, 1, and 2', () => {
    // SPECIES_MINIOR_METEOR_BLUE abilities: [ABILITY_REGENERATOR, ABILITY_WEAK_ARMOR, ABILITY_LOOSE_ROCKS]
    // SPECIES_MINIOR_CORE_BLUE abilities:   [ABILITY_BULLETPROOF, ABILITY_LUNAR_ECLIPSE, ABILITY_ACCELERATE]
    const meteorSpecies = requireSpecies('SPECIES_MINIOR_METEOR_BLUE')
    const coreSpecies = requireSpecies('SPECIES_MINIOR_CORE_BLUE')
    expect(meteorSpecies.abilities).toEqual(['ABILITY_REGENERATOR', 'ABILITY_WEAK_ARMOR', 'ABILITY_LOOSE_ROCKS'])
    expect(coreSpecies.abilities).toEqual(['ABILITY_BULLETPROOF', 'ABILITY_LUNAR_ECLIPSE', 'ABILITY_ACCELERATE'])

    const cases = [
      {
        abilityNum: 1,
        meteorAbility: 'ABILITY_WEAK_ARMOR',
        coreAbility: 'ABILITY_LUNAR_ECLIPSE',
      },
      {
        abilityNum: 2,
        meteorAbility: 'ABILITY_LOOSE_ROCKS',
        coreAbility: 'ABILITY_ACCELERATE',
      },
      {
        abilityNum: 0,
        meteorAbility: 'ABILITY_REGENERATOR',
        coreAbility: 'ABILITY_BULLETPROOF',
      },
    ]

    for (const c of cases) {
      // 1. Initial Meteor form at hp <= maxHp / 2 triggers transformation to Core form on entry
      const state = battle(
        [
          {
            speciesId: 'SPECIES_MINIOR_METEOR_BLUE',
            maxHp: MINIOR_L50_MAX_HP,
            hp: 67,
            abilityNum: c.abilityNum,
            abilities: {
              ability: c.meteorAbility,
              innates: ['ABILITY_SHIELDS_DOWN', 'ABILITY_SHELL_ARMOR', 'ABILITY_OVERCOAT'],
            },
          },
          {},
        ],
        scriptedRng(),
      )

      // Seed nonzero state by identity before the form change. In battler.mon.abilities order
      // (ability, innates[0..2]) slot 0 is the Meteor ability and slot 1 is Shields Down
      // (innates[0] on both forms). UpdateAbilityStateIndices (battle_util.c:8833-8862) copies
      // old slot j's abilityState when newAbilities[i] == oldAbilities[j]; with zeroed state
      // every assertion below would pass even if the remap were a plain index copy.
      state.battlers[0]!.volatiles.abilityState[0] = SEEDED_METEOR_STATE
      state.battlers[0]!.volatiles.abilityState[1] = SEEDED_SHIELDS_DOWN_STATE

      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
      expect(state.battlers[0]!.mon.abilities.ability).toBe(c.coreAbility)
      expect(state.battlers[0]!.mon.abilityNum).toBe(c.abilityNum)
      // UpdateAbilityStateIndices remaps per-slot state by ability identity: Shields Down is
      // innate slot 0 (ability index 1) in both forms, so its seeded state follows it. The
      // newly gained core ability matches nothing in the old list, so its slot starts fresh;
      // a copy-by-index remap would instead leave the outgoing Meteor state in abilityState[0].
      expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_SHIELDS_DOWN')).toBe(SEEDED_SHIELDS_DOWN_STATE)
      expect(getAbilityStateOf(state.battlers[0]!, c.meteorAbility)).toBe(0)
      expect(getAbilityStateOf(state.battlers[0]!, c.coreAbility)).toBe(0)
      expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)

      // 2. Heal above 50% HP while Shields Down's state is still set: ShouldChangeFormHpBased's
      // Core -> Meteor reversion is blocked at battle_util.c:3824-3826 (GetAbilityState != 0).
      state.battlers[0]!.mon.hp = 68
      endTurn(state)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
      expect(state.battlers[0]!.mon.abilities.ability).toBe(c.coreAbility)
      expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_SHIELDS_DOWN')).toBe(SEEDED_SHIELDS_DOWN_STATE)

      // Clearing the state lets the end-turn reversion run again.
      setAbilityStateOf(state.battlers[0]!, 'ABILITY_SHIELDS_DOWN', 0)
      endTurn(state)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')
      expect(state.battlers[0]!.mon.abilities.ability).toBe(c.meteorAbility)
      expect(state.battlers[0]!.mon.abilityNum).toBe(c.abilityNum)
      expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_SHIELDS_DOWN')).toBe(0)
      expect(getAbilityStateOf(state.battlers[0]!, c.meteorAbility)).toBe(0)

      // 3. Entry reversion from a fresh Core form entry above 50% HP
      const stateCoreEntry = battle(
        [
          {
            speciesId: 'SPECIES_MINIOR_CORE_BLUE',
            maxHp: MINIOR_L50_MAX_HP,
            hp: 68,
            abilityNum: c.abilityNum,
            abilities: {
              ability: c.coreAbility,
              innates: ['ABILITY_SHIELDS_DOWN', 'ABILITY_EQUINOX', 'ABILITY_FRISK'],
            },
          },
          {},
        ],
        scriptedRng(),
      )
      applySwitchInAbilities(stateCoreEntry, 0, testDeps(), [])
      expect(stateCoreEntry.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')
      expect(stateCoreEntry.battlers[0]!.mon.abilities.ability).toBe(c.meteorAbility)
      expect(stateCoreEntry.battlers[0]!.mon.abilityNum).toBe(c.abilityNum)
      expect(getAbilityStateOf(stateCoreEntry.battlers[0]!, 'ABILITY_SHIELDS_DOWN')).toBe(0)
      expect(getAbilityStateOf(stateCoreEntry.battlers[0]!, c.meteorAbility)).toBe(0)
    }
  })

  it('Unown with abilityNum 1 (Mystic Power) retains ABILITY_MYSTIC_POWER after changeBattlerForm to SPECIES_UNOWN_B', () => {
    // Direct call to changeBattlerForm
    const state = battle([
      {
        speciesId: 'SPECIES_UNOWN',
        abilityNum: 1,
        abilities: {
          ability: 'ABILITY_MYSTIC_POWER',
          innates: ['ABILITY_REVELATION', 'ABILITY_LEVITATE', 'ABILITY_REGENERATOR'],
        },
      },
      {},
    ])

    changeBattlerForm(state, 0, 'SPECIES_UNOWN_B', DATA_CONTEXT)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN_B')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_MYSTIC_POWER')
    expect(state.battlers[0]!.mon.abilityNum).toBe(1)
  })

  it('abilityForSpeciesSlot: out-of-range, synthetic null/NONE, and undefined fallback rules', () => {
    const species = {
      abilities: ['ABILITY_REGENERATOR', 'ABILITY_WEAK_ARMOR', 'ABILITY_LOOSE_ROCKS'],
    }

    // Out-of-range abilityNum (3, -1) falls back to abilities[0]
    expect(abilityForSpeciesSlot(species, 3)).toBe('ABILITY_REGENERATOR')
    expect(abilityForSpeciesSlot(species, -1)).toBe('ABILITY_REGENERATOR')

    // Synthetic species where abilities[1] is ABILITY_NONE or null falls back to abilities[0]
    const synthNone = { abilities: ['ABILITY_REGENERATOR', 'ABILITY_NONE', 'ABILITY_LOOSE_ROCKS'] }
    expect(abilityForSpeciesSlot(synthNone, 1)).toBe('ABILITY_REGENERATOR')

    const synthNull = { abilities: ['ABILITY_REGENERATOR', null, 'ABILITY_LOOSE_ROCKS'] }
    expect(abilityForSpeciesSlot(synthNull, 1)).toBe('ABILITY_REGENERATOR')

    // Undefined abilityNum defaults to slot 0
    expect(abilityForSpeciesSlot(species, undefined)).toBe('ABILITY_REGENERATOR')
    expect(abilityForSpeciesSlot(species)).toBe('ABILITY_REGENERATOR')

    // Empty or all-none species returns null
    expect(abilityForSpeciesSlot({ abilities: [] }, 0)).toBeNull()
    expect(abilityForSpeciesSlot({ abilities: ['ABILITY_NONE'] }, 0)).toBeNull()
  })

  it('buildOpponentParty / buildPlayerParty: slot-2 ability yields abilityNum === 2, unlisted ability yields 0', () => {
    const data = loadSimData()
    // Mudkip abilities: [ 'ABILITY_SWIFT_SWIM', 'ABILITY_MULTISCALE', 'ABILITY_REGENERATOR' ]
    const mudkipData = data.speciesById.get('SPECIES_MUDKIP')!
    expect(mudkipData.abilities).toEqual(['ABILITY_SWIFT_SWIM', 'ABILITY_MULTISCALE', 'ABILITY_REGENERATOR'])

    // 1. buildPlayerParty
    const playerSpecs: PlayerMonSpec[] = [
      {
        species: 'SPECIES_MUDKIP',
        ability: 'ABILITY_REGENERATOR', // slot 2
        moves: ['MOVE_TACKLE'],
      },
      {
        species: 'SPECIES_MUDKIP',
        ability: 'ABILITY_INTIMIDATE', // not in species list
        moves: ['MOVE_TACKLE'],
      },
      {
        species: 'SPECIES_MUDKIP',
        moves: ['MOVE_TACKLE'], // no ability specified -> default slot 0
      },
    ]
    const playerParty = buildPlayerParty(playerSpecs, 50, data)
    expect(playerParty[0]!.abilityNum).toBe(2)
    expect(playerParty[0]!.abilities.ability).toBe('ABILITY_REGENERATOR')

    expect(playerParty[1]!.abilityNum).toBe(0)
    expect(playerParty[1]!.abilities.ability).toBe('ABILITY_INTIMIDATE')

    expect(playerParty[2]!.abilityNum).toBe(0)
    expect(playerParty[2]!.abilities.ability).toBe('ABILITY_SWIFT_SWIM')

    // 2. buildOpponentParty
    const sampleTrainer = data.trainersById.values().next().value!
    const testTrainer: TrainerData = {
      ...sampleTrainer,
      parties: {
        ace: [
          {
            ...sampleTrainer.parties.ace[0]!,
            species: 'SPECIES_MUDKIP',
            ability: 'ABILITY_REGENERATOR', // slot 2
          },
          {
            ...sampleTrainer.parties.ace[0]!,
            species: 'SPECIES_MUDKIP',
            ability: 'ABILITY_INTIMIDATE', // unlisted
          },
        ],
        elite: [],
        hell: [],
      },
    }
    const oppParty = buildOpponentParty(testTrainer, 'ace', 50, data)
    expect(oppParty[0]!.abilityNum).toBe(2)
    expect(oppParty[0]!.abilities.ability).toBe('ABILITY_REGENERATOR')

    expect(oppParty[1]!.abilityNum).toBe(0)
    expect(oppParty[1]!.abilities.ability).toBe('ABILITY_INTIMIDATE')
  })

  it('gateInnates blanks the new form\'s innates after changeBattlerForm below innate gate level in elite/hell tier', () => {
    // In 'elite' tier: innate thresholds are [1, 17, 24].
    // At level 10 (10 >= 1, 10 < 17, 10 < 24), slots 1 and 2 are blanked (null).
    // Minior Core Blue innates: ['ABILITY_SHIELDS_DOWN', 'ABILITY_EQUINOX', 'ABILITY_FRISK']
    const state = battle(
      [
        {
          speciesId: 'SPECIES_MINIOR_METEOR_BLUE',
          level: 10,
          abilityNum: 0,
          abilities: {
            ability: 'ABILITY_REGENERATOR',
            innates: ['ABILITY_SHIELDS_DOWN', null, null],
          },
        },
        {},
      ],
      scriptedRng(),
      undefined,
      undefined,
      'elite',
    )
    expect(state.tier).toBe('elite')

    changeBattlerForm(state, 0, 'SPECIES_MINIOR_CORE_BLUE', DATA_CONTEXT)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
    // Slot 0 ('ABILITY_SHIELDS_DOWN') active (10 >= 1); slots 1 ('ABILITY_EQUINOX') and 2 ('ABILITY_FRISK') blanked
    expect(state.battlers[0]!.mon.abilities.innates).toEqual(['ABILITY_SHIELDS_DOWN', null, null])

    // Reverting to Meteor re-runs gateInnates for the new form, so the innate gate returns to
    // its pre-change state: Meteor's own innates at elite L10 keep only slot 0.
    changeBattlerForm(state, 0, 'SPECIES_MINIOR_METEOR_BLUE', DATA_CONTEXT)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')
    expect(state.battlers[0]!.mon.abilities.innates).toEqual(['ABILITY_SHIELDS_DOWN', null, null])

    // In 'hell' tier: thresholds are [10, 17, 24]. Level 5 is below all thresholds -> all innates blanked
    const stateHell = battle(
      [
        {
          speciesId: 'SPECIES_MINIOR_METEOR_BLUE',
          level: 5,
          abilityNum: 0,
          abilities: {
            ability: 'ABILITY_REGENERATOR',
            innates: [null, null, null],
          },
        },
        {},
      ],
      scriptedRng(),
      undefined,
      undefined,
      'hell',
    )
    changeBattlerForm(stateHell, 0, 'SPECIES_MINIOR_CORE_BLUE', DATA_CONTEXT)
    expect(stateHell.battlers[0]!.mon.abilities.innates).toEqual([null, null, null])

    // Revert at hell L5: still below every threshold, so the gate keeps all three slots blank.
    changeBattlerForm(stateHell, 0, 'SPECIES_MINIOR_METEOR_BLUE', DATA_CONTEXT)
    expect(stateHell.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')
    expect(stateHell.battlers[0]!.mon.abilities.innates).toEqual([null, null, null])
  })
})

// ---------------------------------------------------------------------------
// Defect 2: Cool Exit natural timeline
// ---------------------------------------------------------------------------

describe('Defect 2: Cool Exit natural timeline through executeTurn', () => {
  const COOL_EXIT = hasAbility('ABILITY_COOL_EXIT')

  it('(a) battle-start lead: Chilly Reception (hail) appears at the end of turn 2', () => {
    // Battle-start lead: createBattleState calls TurnValuesCleanUp (battle_main.c:3406 / create.ts:451),
    // decrementing isFirstTurn from 2 to 1 before Turn 1 begins.
    const state = battle(
      [
        { speciesId: 'SPECIES_MUDKIP', abilities: COOL_EXIT },
        { speciesId: 'SPECIES_MUDKIP' },
      ],
      scriptedRng(),
    )

    // Pre-turn 1 checks
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(1)
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(0)
    expect(state.field.weather & WEATHER_HAIL_ANY).toBe(0)

    // Turn 1:
    // End of turn 1: isFirstTurn is 1 (1 != 2 is true) -> state 0 -> 1.
    // roundStructsClear decrements isFirstTurn to 0.
    executeTurn(state, [null, null], testDeps())
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(1)
    expect(state.field.weather & WEATHER_HAIL_ANY).toBe(0)
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(0)

    // Turn 2:
    // End of turn 2: isFirstTurn is 0 (0 != 2 is true) -> state 1 -> 2, queues MOVE_CHILLY_RECEPTION.
    // MOVE_CHILLY_RECEPTION executes, setting hail weather.
    executeTurn(state, [null, null], testDeps())
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
    expect((state.field.weather & WEATHER_HAIL_ANY) !== 0).toBe(true)

    // Turn 3:
    // End of turn 3: state is 2, case 2 does nothing, remains 2. Hail remains active.
    executeTurn(state, [null, null], testDeps())
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
    expect((state.field.weather & WEATHER_HAIL_ANY) !== 0).toBe(true)
  })

  it('(b) mid-battle switch-in: Chilly Reception (hail) appears at the end of turn 3', () => {
    // Mid-battle switch-in: mon switches in during turn actions, receiving isFirstTurn = 2
    // (battle_main.c:2899 / switchIn.ts:133).
    // On the switch-in turn, CHECK(isFirstTurn != 2) fails, so state stays 0.
    const leadMon = partyMon({ speciesId: 'SPECIES_MUDKIP' })
    const coolExitMon = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      abilities: COOL_EXIT,
    })
    const oppMon = partyMon({ speciesId: 'SPECIES_MUDKIP' })

    const state = battle(
      [
        { speciesId: 'SPECIES_MUDKIP' },
        { speciesId: 'SPECIES_MUDKIP' },
      ],
      scriptedRng(),
      [leadMon, coolExitMon],
      [oppMon],
    )

    // Turn 1: battler 0 switches to party slot 1 (coolExitMon)
    state.battlers[0]!.monToSwitchIntoId = 1
    const switchAction: ChosenAction = { action: 'SWITCH', chosenMove: null, moveToBeUsed: null, target: null }

    executeTurn(state, [switchAction, null], testDeps())
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_COOL_EXIT')
    // After Turn 1: during endTurn, isFirstTurn was 2, so state remained 0.
    // roundStructsClear then decremented isFirstTurn 2 -> 1.
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(0)
    expect(state.field.weather & WEATHER_HAIL_ANY).toBe(0)
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(1)

    // Turn 2:
    // End of turn 2: isFirstTurn is 1 (1 != 2) -> state 0 -> 1.
    // roundStructsClear decrements isFirstTurn 1 -> 0.
    executeTurn(state, [null, null], testDeps())
    expect(getAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(1)
    expect(state.field.weather & WEATHER_HAIL_ANY).toBe(0)
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(0)

    // Turn 3:
    // End of turn 3: isFirstTurn is 0 (0 != 2) -> state 1 -> 2, queues MOVE_CHILLY_RECEPTION.
    // MOVE_CHILLY_RECEPTION executes, setting hail weather and then running
    // BattleScript_MoveSwitch (battle_scripts_1.s:5371-5390): `scheduleswitch BS_ATTACKER`.
    // The lead (party[0]) is the only live reserve for battler 0, so the replacement must
    // really switch -- without it the SWITCH action is dropped (turn.ts:1731-1734) and this
    // test would pass on a failed switch.
    let replacementCalls = 0
    const replacement: ReplacementDeps = {
      chooseReplacement: (switchState) => {
        replacementCalls++
        // The end-turn pass reached ability state 2 before BattleScript_MoveSwitch ran.
        expect(getAbilityStateOf(switchState.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
        return 0
      },
    }
    executeTurn(state, [null, null], testDeps(fixedDamage(20), GROUNDING, replacement))
    expect(replacementCalls).toBe(1)
    expect((state.field.weather & WEATHER_HAIL_ANY) !== 0).toBe(true)
    // The user was switched out to the benched lead, which has no Cool Exit.
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[0]!.mon.abilities.ability).toBeNull()
  })

  it('negative: mon without Cool Exit produces no hail across 3 turns', () => {
    const state = battle(
      [
        { speciesId: 'SPECIES_MUDKIP', abilities: hasAbility('ABILITY_TORRENT') },
        { speciesId: 'SPECIES_MUDKIP' },
      ],
      scriptedRng(),
    )

    for (let t = 1; t <= 3; t++) {
      executeTurn(state, [null, null], testDeps())
      expect(state.field.weather & WEATHER_HAIL_ANY).toBe(0)
      expect(state.queuedExtraAttacks).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// Defect 3: Fallback note branches
// ---------------------------------------------------------------------------

describe('Defect 3: Fallback note branches', () => {
  it('ENDTURN_ABILITY_IDS fallback note fires exactly once for synthetic unported ability, not for ported or outside-set', () => {
    const SYNTHETIC_ID = 'ABILITY_TEST_SYNTHETIC_ENDTURN'
    ENDTURN_ABILITY_IDS.add(SYNTHETIC_ID)

    try {
      // 1. Synthetic unported ability in ENDTURN_ABILITY_IDS produces fallback note
      const sSynthetic = battle([{ abilities: hasAbility(SYNTHETIC_ID) }, {}])
      const { unmodelled: unmodelledSynth } = endTurn(sSynthetic)
      const expectedNote = `battler 0: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${SYNTHETIC_ID}'s onEndTurn hook was not run`
      expect(unmodelledSynth).toContain(expectedNote)
      expect(unmodelledSynth.filter((n) => n === expectedNote)).toHaveLength(1)

      // 2. Ported ability (ABILITY_COOL_EXIT) does not produce the unmodelled note
      const sPorted = battle([{ abilities: hasAbility('ABILITY_COOL_EXIT') }, {}])
      const { unmodelled: unmodelledPorted } = endTurn(sPorted)
      expect(unmodelledPorted.some((n) => n.includes('ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied'))).toBe(false)

      // 3. Ability outside the set (e.g. ABILITY_TORRENT or synthetic untracked) produces no note
      const sOutside = battle([{ abilities: hasAbility('ABILITY_TEST_OUTSIDE_SET') }, {}])
      const { unmodelled: unmodelledOutside } = endTurn(sOutside)
      expect(unmodelledOutside.some((n) => n.includes('ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied'))).toBe(false)
    } finally {
      ENDTURN_ABILITY_IDS.delete(SYNTHETIC_ID)
    }
  })
})
