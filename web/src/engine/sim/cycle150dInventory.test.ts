/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  NOTE_ONLY_PAIRS,
  NOTE_ONLY_SET,
  PORTED_SWITCH_IN_ABILITIES,
  discoverNoteOnlyRaiseSites,
  extractSwitchInAbilities,
  type AbilityHookRecord,
} from './driver/abilityHookInventory'
import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { applySwitchInAbilities } from './switchInAbility'
import { runReactiveAbilityEffects } from './statBuffs'
import { runEndTurnEffects } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  SIDE_STATUS_TAILWIND,
  STATUS1_BLEED,
  STATUS2_CONFUSION,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150cFidelity.test.ts (which copied cycle149Abilities.test.ts).
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

const ABILITY_HOOKS_PATH = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta', 'abilityHooks.json')
const abilityHooks: Record<string, AbilityHookRecord> = JSON.parse(readFileSync(ABILITY_HOOKS_PATH, 'utf8'))

const SWITCH_IN_PATH = join(import.meta.dirname, 'switchInAbility.ts')
const MOVE_END_PATH = join(import.meta.dirname, 'moveEnd.ts')

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
  status1?: number
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
          status1: s.status1 ?? 0,
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
const hasAbility = (
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] => ({ ability, innates })

// ---------------------------------------------------------------------------
// Source-text mutation helpers
// ---------------------------------------------------------------------------

/** Name of the top-level declaration that a slice of source starts at. */
function findDeclarationLine(source: string, marker: string): number {
  const index = source.indexOf(marker)
  if (index === -1) throw new Error(`marker not found: ${marker}`)
  return index
}

/**
 * Removes the `if (...) { ... }` block whose header contains `marker`, leaving everything else
 * untouched. The result is not a valid program, which is fine: the extractors only read text.
 */
function removeBranch(source: string, marker: string): string {
  const start = findDeclarationLine(source, marker)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

/** Replaces the `if (...) { ... }` block whose header contains `marker` with `replacement`. */
function replaceBranch(source: string, marker: string, replacement: string): string {
  const start = findDeclarationLine(source, marker)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + replacement + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

// ---------------------------------------------------------------------------
// (1) onEntry inference must follow branches, not argument literals.
// ---------------------------------------------------------------------------

describe('Cycle 150d (1) - the onEntry set comes from branches, not literals', () => {
  const switchInSource = readFileSync(SWITCH_IN_PATH, 'utf8')

  it('deleting the Wind Rider branch drops ABILITY_WIND_RIDER from the extraction', () => {
    expect(extractSwitchInAbilities(switchInSource)).toEqual(PORTED_SWITCH_IN_ABILITIES)
    expect(PORTED_SWITCH_IN_ABILITIES.has('ABILITY_WIND_RIDER')).toBe(true)

    const mutated = removeBranch(switchInSource, "if (abilityId === 'ABILITY_WIND_RIDER') {")
    // The Air Blower Tailwind branch still passes the id to disableSwitchInAbility. Counting that
    // argument kept Wind Rider "ported" even with its own branch gone; the extractor must not.
    expect(mutated).toContain("disableSwitchInAbility(state, battlerId, 'ABILITY_WIND_RIDER', deps.dataContext)")
    expect(extractSwitchInAbilities(mutated).has('ABILITY_WIND_RIDER')).toBe(false)
  })

  it('deleting the Screen Cleaner branch drops ABILITY_SCREEN_CLEANER despite the Aurora Veil argument', () => {
    expect(PORTED_SWITCH_IN_ABILITIES.has('ABILITY_SCREEN_CLEANER')).toBe(true)

    const mutated = removeBranch(switchInSource, "if (abilityId === 'ABILITY_SCREEN_CLEANER') {")
    // trySetAuroraVeil (called from the North Wind branch) still tests the holder's ability with a
    // bare literal argument; only the deleted `abilityId ===` comparison was branch evidence.
    expect(mutated).toContain("'ABILITY_SCREEN_CLEANER',")
    expect(extractSwitchInAbilities(mutated).has('ABILITY_SCREEN_CLEANER')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (2) Note-only raise sites are discovered from the source, in both directions.
// ---------------------------------------------------------------------------

describe('Cycle 150d (2) - note-only raise sites are computed, not hand-typed', () => {
  it('the discovered sites and NOTE_ONLY_PAIRS agree exactly, sites included', () => {
    const sites = discoverNoteOnlyRaiseSites()
    expect(sites.length).toBeGreaterThan(0)

    // Pickpocket pushes a note-only note in moveEnd.ts but has no record in abilityHooks.json (the C
    // only references it outside abilities.cc), so the inventory never classifies it. Keep it visible.
    expect(sites.some((s) => s.ability === 'ABILITY_PICKPOCKET')).toBe(true)

    const covered = sites
      .filter((s) => abilityHooks[s.ability] !== undefined)
      .map((s) => `${s.ability}>${s.file}:${s.line}`)
      .sort()
    expect(covered).toEqual(NOTE_ONLY_PAIRS.map((p) => `${p.ability}>${p.site}`).sort())

    for (const site of sites) {
      expect(site.note, `${site.ability} note text`).toContain('is not modelled')
    }
  })

  for (const ability of ['ABILITY_FROSTBIND', 'ABILITY_HEMOTOXIN']) {
    it(`${ability} raises its not-modelled note through the reactive path`, () => {
      // The branch runs when the setStateOnEffect bit is armed (GetAbilityState != 0), regardless of
      // statChangesToCheck: the onReactive loop walks every alive battler.
      const state = battle([{ abilities: hasAbility(ability) }, {}])
      state.battlers[0]!.volatiles.abilityState[0] = 1 << 1
      const notes: string[] = []

      runReactiveAbilityEffects(state, testDeps(), notes)

      expect(notes.some((n) => n.includes('PoisonPuppeteerClone') && n.includes(ability) && n.includes('not modelled'))).toBe(
        true,
      )
      // The byte is consumed before the branch, as in the C (:291-293).
      expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    })
  }

  it('control: replacing the Thundercall branch with a note-only push is discovered as a new site', () => {
    const moveEndSource = readFileSync(MOVE_END_PATH, 'utf8')
    const realSites = discoverNoteOnlyRaiseSites([{ file: 'web/src/engine/sim/moveEnd.ts', content: moveEndSource }])
    expect(realSites.some((s) => s.ability === 'ABILITY_THUNDERCALL')).toBe(false)

    const noteOnlyBranch =
      "if (abilityId === 'ABILITY_THUNDERCALL') {\n" +
      "    unmodelled.push(\"Thundercall's followup move (UseAttackerFollowUpMove MOVE_SMITE, abilities.cc:4921) is not modelled\")\n" +
      '  }'
    const withControl = replaceBranch(moveEndSource, "if (abilityId === 'ABILITY_THUNDERCALL'", noteOnlyBranch)

    const sites = discoverNoteOnlyRaiseSites([{ file: 'web/src/engine/sim/moveEnd.ts', content: withControl }])
    expect(sites.some((s) => s.ability === 'ABILITY_THUNDERCALL')).toBe(true)
    expect(NOTE_ONLY_SET.has('ABILITY_THUNDERCALL:onAttacker')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (7a) Air Lock delegates Cloud Nine's onEntry before Air Blower's.
// ---------------------------------------------------------------------------

describe('Cycle 150d (7a) - Air Lock clears weather and then sets Tailwind', () => {
  const entry = (ability: string, setWeather?: number) => {
    const state = battle([{ abilities: hasAbility(ability) }, {}])
    if (setWeather !== undefined) state.field.weather = setWeather
    applySwitchInAbilities(state, 0, testDeps(), [])
    return state
  }

  it('under rain: clears the rain and sets 3-turn Tailwind', () => {
    const state = entry('ABILITY_AIR_LOCK', WEATHER_RAIN_TEMPORARY)
    expect(state.field.weather).toBe(0)
    expect(state.field.weatherDuration).toBe(0)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)
    expect(state.sides[0]!.timers.tailwindBattlerId).toBe(0)
  })

  it('under primal sun: primal weather is not removable, but Tailwind still goes up', () => {
    const state = entry('ABILITY_AIR_LOCK', WEATHER_SUN_PRIMAL)
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)
  })

  it('control: Air Blower sets Tailwind but leaves the rain alone', () => {
    const state = entry('ABILITY_AIR_BLOWER', WEATHER_RAIN_TEMPORARY)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (7b) Harvest checks changedItems[battler] before drawing.
// ---------------------------------------------------------------------------

describe('Cycle 150d (7b) - Harvest skips a parked changedItem', () => {
  const END_TURN_DEPS = { grounding: GROUNDING, statStageRatios: RATIOS }

  it('a parked changedItem blocks the berry restore and consumes no RNG', () => {
    for (const ability of ['ABILITY_HARVEST', 'ABILITY_SUNS_BOUNTY', 'ABILITY_BIG_LEAVES']) {
      const rng = scriptedRng([1]) // odd: the 50% draw would succeed if it ran
      const state = battle([{ abilities: hasAbility(ability), hp: 100, maxHp: 100 }], rng)
      const holder = state.battlers[0]!
      holder.mon.itemId = null
      holder.usedHeldItem = 'ITEM_SITRUS_BERRY'
      holder.changedItem = 'ITEM_LEFTOVERS'

      runEndTurnEffects(state, [0, 1], DATA_CONTEXT, END_TURN_DEPS)

      expect(holder.mon.itemId, `${ability} restored with changedItems[battler] set`).toBeNull()
      expect(holder.usedHeldItem).toBe('ITEM_SITRUS_BERRY')
      expect(rng.calls, `${ability} drew a random`).toBe(0)
    }
  })

  it('control: no parked item restores the berry without a draw in sun', () => {
    const rng = scriptedRng([1])
    const state = battle([{ abilities: hasAbility('ABILITY_HARVEST'), hp: 100, maxHp: 100 }], rng)
    const holder = state.battlers[0]!
    holder.mon.itemId = null
    holder.usedHeldItem = 'ITEM_SITRUS_BERRY'
    holder.changedItem = null
    state.field.weather = WEATHER_SUN_TEMPORARY

    runEndTurnEffects(state, [0, 1], DATA_CONTEXT, END_TURN_DEPS)

    expect(holder.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(holder.usedHeldItem).toBeNull()
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (7c) Loud Bang and Resonance use IsSoundMove, not the static flag.
// ---------------------------------------------------------------------------

describe('Cycle 150d (7c) - Loud Bang and Resonance honour ability-granted sound flags', () => {
  // Tackle is a Normal-type physical move with no static sound flag, so Reverbate is what makes it
  // a sound move (battle_util.c:9379 DoesMoveMatchFlag(TYPE_NORMAL, MOVE_FLAG_SOUND)).
  // The defender has no moves, so it never acts and never draws: the only rolls are the attacker's.
  const defender: BattlerSpec = { moves: [null, null, null, null], pp: [0, 0, 0, 0] }
  const reverbate = hasAbility('ABILITY_LOUD_BANG', ['ABILITY_REVERBATE', null, null])
  const resonanceReverbate = hasAbility('ABILITY_RESONANCE', ['ABILITY_REVERBATE', null, null])

  it('Loud Bang confuses on a Normal move made sound by Reverbate', () => {
    const rng = scriptedRng([0, 1]) // accuracy, then the 50% ability roll
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], abilities: reverbate }, defender], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(rng.calls).toBe(3) // accuracy, the 50% ability roll, then the confusion duration draw
  })

  it('Loud Bang does nothing and draws nothing extra when the move is not sound', () => {
    const rng = scriptedRng([0, 1])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_LOUD_BANG') }, defender], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(1) // accuracy only: the ability roll is behind IsSoundMove
  })

  it('Resonance bleeds on a Normal move made sound by Reverbate', () => {
    const rng = scriptedRng([0, 20]) // accuracy, then 20 < 50
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], abilities: resonanceReverbate }, defender], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.status1 & STATUS1_BLEED).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(2)
  })

  it('Resonance does nothing and draws nothing extra when the move is not sound', () => {
    const rng = scriptedRng([0, 20])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_RESONANCE') }, defender], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.status1 & STATUS1_BLEED).toBe(0)
    expect(rng.calls).toBe(1)
  })
})
