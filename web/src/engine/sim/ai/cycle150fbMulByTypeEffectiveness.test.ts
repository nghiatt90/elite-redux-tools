/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150fb: the rest of MulByTypeEffectiveness (battle_util.c:7843-7884) in
// aiShouldSwitch.ts's calcPartyMonTypeEffectivenessMultiplier. The C passes
// battlerAtk = 0 and battlerDef = 0 (:8003), so every branch below reads
// state.battlers[0] -- not the AI and not the reserve mon being scored.
//
// ER redefines UQ_4_12_PRECISION to 10 (include/global.h:113), so UQ_4_12(1.0)
// is 1024, not vanilla's 4096. Every expectation below is derived with uq()
// from data/v2.65beta/types.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import { STATUS3_EMBARGO, STATUS4_FORESIGHT, STATUS_FIELD_GRAVITY, WEATHER_STRONG_WINDS } from '../constants'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { AiDamageDeps } from './aiCalcDamage'
import { calcPartyMonTypeEffectivenessMultiplier } from './aiShouldSwitch'
import { uq } from '../../fixed'
import { GAP_NOTE } from '../driver/abilityAuditNotes'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const abilityIds = new Set(read<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const natures = read<any>('natures.json')
const holdEffectIds = read<Record<string, number>>('holdEffectIds.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`moves.json is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

// Verify every fixture id/type at module load (the brief's "never guess an id" rule).
const CORROSION = requireAbility('ABILITY_CORROSION')
requireAbility('ABILITY_KLUTZ')
requireAbility('ABILITY_AIR_LOCK')
const MOVE_TYPES: Record<string, string> = {
  MOVE_TACKLE: 'NORMAL',
  MOVE_KARATE_CHOP: 'FIGHTING',
  MOVE_FAIRY_WIND: 'FAIRY',
  MOVE_DRAGON_BREATH: 'DRAGON',
  MOVE_ROCK_THROW: 'ROCK',
  MOVE_ICE_SHARD: 'ICE',
  MOVE_EARTHQUAKE: 'GROUND',
  MOVE_EMBER: 'FIRE',
  MOVE_POISON_STING: 'POISON',
}
for (const [id, type] of Object.entries(MOVE_TYPES)) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
  if (moveById.get(id)!.type !== `TYPE_${type}`) throw new Error(`${id} is no longer ${type}-type`)
}
if ((itemsById.get('ITEM_RING_TARGET') as Record<string, any> | undefined)?.resolvedHoldEffect !== 'HOLD_EFFECT_RING_TARGET')
  throw new Error('ITEM_RING_TARGET is no longer HOLD_EFFECT_RING_TARGET')
if ((itemsById.get('ITEM_IRON_BALL') as Record<string, any> | undefined)?.resolvedHoldEffect !== 'HOLD_EFFECT_IRON_BALL')
  throw new Error('ITEM_IRON_BALL is no longer HOLD_EFFECT_IRON_BALL')
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')

const defaultGrounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: (id) => {
    const m = moveById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return { id, power: m.power, type: m.type, split: m.split, effect: m.effect, priority: m.priority, flags: m.flags ?? {}, accuracy: m.accuracy, argumentInt: arg?.kind === 'int' ? (arg.value as number) : null }
  },
}
const bridge: BridgeDeps = { grounding: defaultGrounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, holdEffectIds }

/** Real grounding backed by state: holdEffectOf reads the battler's held item,
 * as the sim's own bridge does (Iron Ball / Air Balloon). */
function groundingFor(state: BattleState, overrides: Partial<GroundingContext> = {}): GroundingContext {
  return {
    holdEffectOf: (b) => {
      const itemId = state.battlers[b]?.mon.itemId
      return itemId ? ((itemsById.get(itemId) as SimItemData | undefined)?.resolvedHoldEffect ?? null) : null
    },
    monotypeChampType: null,
    isCluelessOnField: false,
    attackerHasMoldBreaker: false,
    ...overrides,
  }
}
function depsFor(state: BattleState, overrides: Partial<GroundingContext> = {}): AiDamageDeps {
  return { ...deps, grounding: groundingFor(state, overrides) }
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] }, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, gender: 'MALE', status1: 0, types: ['WATER', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}
/** battler 0 is the player's active mon -- the C's battlerAtk AND battlerDef. */
function battle(a: Partial<SimBattleMon>, b: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(b), 0)], rng: scripted() })
}
const MONO = (t: string): [string, string, string] => [t, t, 'MYSTERY']
function modifierAgainst(state: BattleState, moveId: string, types: [string, string, string], d: AiDamageDeps = deps, unmodelled: string[] = []): number {
  return calcPartyMonTypeEffectivenessMultiplier(state, partyMon({ types }), moveId, d, unmodelled)
}

describe('MulByTypeEffectiveness: Ring Target (:7854)', () => {
  it('neutralises a Normal-vs-Ghost immunity when battler 0 holds Ring Target', () => {
    const s = battle({ itemId: 'ITEM_RING_TARGET' })
    expect(modifierAgainst(s, 'MOVE_TACKLE', MONO('GHOST'))).toBe(uq(1.0))
  })

  it('stays immune when Embargo negates the held item (IsItemNegated, :6520)', () => {
    const s = battle({ itemId: 'ITEM_RING_TARGET' })
    s.battlers[0]!.statuses3 = STATUS3_EMBARGO
    expect(modifierAgainst(s, 'MOVE_TACKLE', MONO('GHOST'))).toBe(0)
  })

  it('stays immune when Klutz negates the held item', () => {
    const s = battle({ itemId: 'ITEM_RING_TARGET', abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } })
    expect(modifierAgainst(s, 'MOVE_TACKLE', MONO('GHOST'))).toBe(0)
  })

  it('stays immune with no item at all', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_TACKLE', MONO('GHOST'))).toBe(0)
  })
})

describe('MulByTypeEffectiveness: Foresight (:7857)', () => {
  it('makes Fighting hit Ghost neutrally while STATUS4_FORESIGHT is set on battler 0', () => {
    const s = battle({})
    s.battlers[0]!.statuses4 = STATUS4_FORESIGHT
    expect(modifierAgainst(s, 'MOVE_KARATE_CHOP', MONO('GHOST'))).toBe(uq(1.0))
  })

  it('leaves the Ghost immunity alone without the flag', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_KARATE_CHOP', MONO('GHOST'))).toBe(0)
  })

  it('only applies to Fighting/Normal moves -- Fire vs Ghost stays at the chart value', () => {
    const s = battle({})
    s.battlers[0]!.statuses4 = STATUS4_FORESIGHT
    expect(modifierAgainst(s, 'MOVE_EMBER', MONO('GHOST'))).toBe(uq(1.0)) // Fire -> Ghost = 1.0
  })
})

describe('MulByTypeEffectiveness: Monotype Champion (:7860-7869)', () => {
  it('FAIRY champion: Fairy vs Steel is forced super effective (chart 0.5)', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_FAIRY_WIND', MONO('STEEL'), depsFor(s, { monotypeChampType: 'FAIRY' }))).toBe(uq(2.0))
    expect(modifierAgainst(s, 'MOVE_FAIRY_WIND', MONO('STEEL'))).toBe(uq(0.5))
  })

  it('FAIRY champion: Fairy vs Poison is forced super effective (chart 0.5)', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_FAIRY_WIND', MONO('POISON'), depsFor(s, { monotypeChampType: 'FAIRY' }))).toBe(uq(2.0))
    expect(modifierAgainst(s, 'MOVE_FAIRY_WIND', MONO('POISON'))).toBe(uq(0.5))
  })

  it('DRAGON champion neutralises a 0x matchup; a non-immune pairing is unchanged', () => {
    const s = battle({})
    // Dragon -> Fairy is 0 in types.json (the branch restores it to 1.0).
    expect(modifierAgainst(s, 'MOVE_DRAGON_BREATH', MONO('FAIRY'), depsFor(s, { monotypeChampType: 'DRAGON' }))).toBe(uq(1.0))
    expect(modifierAgainst(s, 'MOVE_DRAGON_BREATH', MONO('FAIRY'))).toBe(0)
    // Dragon -> Steel is 0.5: `mod == 0` is false, so the branch must not fire.
    expect(modifierAgainst(s, 'MOVE_DRAGON_BREATH', MONO('STEEL'), depsFor(s, { monotypeChampType: 'DRAGON' }))).toBe(uq(0.5))
  })

  it('ROCK champion: Rock vs Rock is forced super effective (chart 1.0)', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_ROCK_THROW', MONO('ROCK'), depsFor(s, { monotypeChampType: 'ROCK' }))).toBe(uq(2.0))
    expect(modifierAgainst(s, 'MOVE_ROCK_THROW', MONO('ROCK'))).toBe(uq(1.0))
  })

  it('ROCK champion swallows the iceStatue arm (else-if precedence, :7865/:7870)', () => {
    const s = battle({})
    s.battlers[0]!.volatiles.iceStatue = true
    // Ice -> Ice is 0.5; under ROCK the champion arm wins and iceStatue never runs.
    expect(modifierAgainst(s, 'MOVE_ICE_SHARD', MONO('ICE'), depsFor(s, { monotypeChampType: 'ROCK' }))).toBe(uq(0.5))
    // Without a champion the same state doubles it to 1.0.
    expect(modifierAgainst(s, 'MOVE_ICE_SHARD', MONO('ICE'))).toBe(uq(1.0))
  })
})

describe('MulByTypeEffectiveness: iceStatue (:7870)', () => {
  it('doubles a resisted Ice-vs-Ice component (0.5 -> 1.0)', () => {
    const s = battle({})
    s.battlers[0]!.volatiles.iceStatue = true
    expect(modifierAgainst(s, 'MOVE_ICE_SHARD', MONO('ICE'))).toBe(uq(1.0))
  })

  it('leaves it at 0.5 without the volatile', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_ICE_SHARD', MONO('ICE'))).toBe(uq(0.5))
  })

  it('does not touch a super-effective component (`mod < UQ_4_12(1)` guard)', () => {
    const s = battle({})
    s.battlers[0]!.volatiles.iceStatue = true
    expect(modifierAgainst(s, 'MOVE_ICE_SHARD', MONO('DRAGON'))).toBe(uq(2.0)) // Ice -> Dragon = 2.0
  })
})

describe('MulByTypeEffectiveness: Ground vs Flying grounding (:7874)', () => {
  it('restores a Ground-vs-Flying immunity when IsBattlerGrounded(battlerDef=0) is true', () => {
    // battler 0 is Flying, so only Gravity can ground it (checkGroundingEffects).
    const s = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    s.field.statuses = STATUS_FIELD_GRAVITY
    expect(modifierAgainst(s, 'MOVE_EARTHQUAKE', MONO('FLYING'), depsFor(s))).toBe(uq(1.0))
  })

  it('stays immune when battler 0 is not grounded', () => {
    const s = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    expect(modifierAgainst(s, 'MOVE_EARTHQUAKE', MONO('FLYING'), depsFor(s))).toBe(0)
  })

  it('reads battler 0, not the reserve: an Iron Ball on the reserve does not ground battler 0', () => {
    const s = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    const reserve = partyMon({ types: MONO('FLYING'), itemId: 'ITEM_IRON_BALL' })
    expect(calcPartyMonTypeEffectivenessMultiplier(s, reserve, 'MOVE_EARTHQUAKE', depsFor(s), [])).toBe(0)
  })

  it('grounds battler 0 through its own Iron Ball', () => {
    const s = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'], itemId: 'ITEM_IRON_BALL' })
    expect(modifierAgainst(s, 'MOVE_EARTHQUAKE', MONO('FLYING'), depsFor(s))).toBe(uq(1.0))
  })
})

describe('MulByTypeEffectiveness: tarShot (:7878)', () => {
  it('forces a Fire move to super effective after UpdateTypeModifier', () => {
    const s = battle({})
    s.battlers[0]!.volatiles.tarShot = true
    expect(modifierAgainst(s, 'MOVE_EMBER', MONO('WATER'))).toBe(uq(2.0)) // chart 0.5
  })

  it('leaves the chart value without the volatile', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_EMBER', MONO('WATER'))).toBe(uq(0.5))
  })

  it('only applies to Fire moves', () => {
    const s = battle({})
    s.battlers[0]!.volatiles.tarShot = true
    expect(modifierAgainst(s, 'MOVE_TACKLE', MONO('WATER'))).toBe(uq(1.0))
  })
})

describe('MulByTypeEffectiveness: WEATHER_STRONG_WINDS (:7881-7883)', () => {
  it('caps a super-effective hit on a Flying type at neutral', () => {
    const s = battle({})
    s.field.weather = WEATHER_STRONG_WINDS
    expect(modifierAgainst(s, 'MOVE_ROCK_THROW', MONO('FLYING'), depsFor(s))).toBe(uq(1.0)) // chart 2.0
  })

  it('does not cap without the weather', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_ROCK_THROW', MONO('FLYING'), depsFor(s))).toBe(uq(2.0))
  })

  it('does not cap while Air Lock suppresses WEATHER_HAS_EFFECT', () => {
    const s = battle({ abilities: { ability: 'ABILITY_AIR_LOCK', innates: [null, null, null] } })
    s.field.weather = WEATHER_STRONG_WINDS
    expect(modifierAgainst(s, 'MOVE_ROCK_THROW', MONO('FLYING'), depsFor(s))).toBe(uq(2.0))
  })

  it('leaves a resisted Flying matchup resisted (`mod >= 2.0` guard)', () => {
    const s = battle({})
    s.field.weather = WEATHER_STRONG_WINDS
    expect(modifierAgainst(s, 'MOVE_KARATE_CHOP', MONO('FLYING'), depsFor(s))).toBe(uq(0.5))
  })

  it('caps only the Flying component of a dual type', () => {
    const windy = battle({})
    windy.field.weather = WEATHER_STRONG_WINDS
    // Rock -> Flying (2.0) capped to 1.0; Rock -> Steel 0.5; folded = 0.5.
    expect(modifierAgainst(windy, 'MOVE_ROCK_THROW', ['FLYING', 'STEEL', 'MYSTERY'], depsFor(windy))).toBe(uq(0.5))
    // Without the weather the same fold is 1.0 (2.0 * 0.5).
    const calm = battle({})
    expect(modifierAgainst(calm, 'MOVE_ROCK_THROW', ['FLYING', 'STEEL', 'MYSTERY'], depsFor(calm))).toBe(uq(1.0))
  })
})

describe('MulByTypeEffectiveness: onTypeEffectiveness gate (:7847-7853)', () => {
  it("an ability that changes the modifier wins, and the Ring Target arm does not run", () => {
    const s = battle({ itemId: 'ITEM_RING_TARGET', abilities: { ability: CORROSION, innates: [null, null, null] } })
    // Poison -> Steel is 0; Corrosion forces 2.0. Ring Target would have made 1.0.
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(2.0))
  })

  it('without a changing ability the Ring Target arm still neutralises the immunity', () => {
    const s = battle({ itemId: 'ITEM_RING_TARGET' })
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(uq(1.0))
  })

  it('without Ring Target and without the ability the immunity stands', () => {
    const s = battle({})
    expect(modifierAgainst(s, 'MOVE_POISON_STING', MONO('STEEL'))).toBe(0)
  })
})

describe('MulByTypeEffectiveness notes', () => {
  it('raises no unconditional battle_util.c:7843 note on an ordinary call, but keeps the :7998 one', () => {
    const s = battle({})
    const unmodelled: string[] = []
    modifierAgainst(s, 'MOVE_TACKLE', MONO('NORMAL'), deps, unmodelled)
    expect(unmodelled.some((n) => n.startsWith('MulByTypeEffectiveness (battle_util.c:7843):'))).toBe(false)
    expect(unmodelled.some((n) => n.startsWith('CalcPartyMonTypeEffectivenessMultiplier (battle_util.c:7998)'))).toBe(true)
  })
})

describe('GAP_NOTE widening', () => {
  it('matches the onTypeEffectiveness note that bypassed the 150f gate', () => {
    expect(
      GAP_NOTE.test("MulByTypeEffectiveness (battle_util.c:7843): battler 0's onTypeEffectiveness ability hooks (ON_ABILITY) are not dispatched here"),
    ).toBe(true)
  })

  it('still matches every phrase the regex previously counted', () => {
    const phrases = [
      'hook was not run',
      'is not modelled',
      'are not modelled',
      'not modelled',
      'not applied',
      'has no port',
      'no port',
      'not run',
      'not supported',
      'unmodelled',
    ]
    for (const phrase of phrases) expect(GAP_NOTE.test(`a gap note: ${phrase}`)).toBe(true)
  })
})
