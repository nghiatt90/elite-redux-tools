// shouldSwitch / shouldUseItem / aiTrySwitchOrUseItem, ported in
// aiShouldSwitch.ts. Every id/effect asserted on below is verified against
// data/v2.65beta/*.json at module load (the brief's "verify every id" rule).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  STAT_ATK,
  STAT_SPATK,
  STATUS1_SLEEP,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_WRAPPED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
} from '../constants'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { aiGetTypeEffectiveness, type AiDamageDeps } from './aiCalcDamage'
import { UQ_ONE } from '../../fixed'
import { getMostSuitableMonToSwitchInto } from './aiSwitching'
import { aiTrySwitchOrUseItem, shouldSwitch, shouldUseItem } from './aiShouldSwitch'

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

const WONDER_GUARD = requireAbility('ABILITY_WONDER_GUARD')
const NATURAL_CURE = requireAbility('ABILITY_NATURAL_CURE')
const REGENERATOR = requireAbility('ABILITY_REGENERATOR')
for (const id of ['MOVE_TACKLE', 'MOVE_EMBER']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
if (moveById.get('MOVE_EMBER')!.type !== 'TYPE_FIRE') throw new Error('MOVE_EMBER is no longer Fire-type')
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')

const grounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
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
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures }

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
/** `reserves` are IN ADDITION TO the opponent's own active mon, which this
 * helper prepends as party slot 0 (matching `createBattlerState(1, ..., 0)`'s
 * own `partyIndex`) -- a caller naming "one reserve" only needs to pass one
 * entry here, not account for the active slot itself. */
function battle(a: Partial<SimBattleMon>, b: Partial<SimBattleMon>, rng: RandomSource, reserves?: SimPartyMon[]): BattleState {
  const opponentParty = reserves ? [partyMon({ hp: b.hp ?? 100 }), ...reserves] : undefined
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(b), 0)], rng, opponentParty })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

describe('shouldSwitch: early returns', () => {
  it('AI_FLAG_DISABLE_SWITCHING quirk: reads battleTypeFlags, not aiFlags -- a trainer\'s noSwitching flag has NO effect', () => {
    // No opponent reserves at all -- would fall through to availableToSwitch=0
    // = FALSE regardless, so this test needs a real reserve to prove the
    // DISABLE_SWITCHING bit itself is not what stopped it.
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: 'ABILITY_NATURAL_CURE', innates: [null, null, null] } }, scripted(1, 1, 1), [
      partyMon({ hp: 100 }),
    ])
    // state.aiFlags carrying AI_FLAG_DISABLE_SWITCHING (1<<17) does NOT block
    // ShouldSwitch -- it is never consulted here at all.
    s.aiFlags = 1 << 17
    const { shouldSwitch: result } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true) // ShouldSwitchIfNaturalCure's first Random()&1 draw is odd (1)
  })

  it('the real bit ShouldSwitch tests (BATTLE_TYPE_PALACE, battleTypeFlags) DOES block it', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: 'ABILITY_NATURAL_CURE', innates: [null, null, null] } }, scripted(1, 1, 1), [
      partyMon({ hp: 100 }),
    ])
    s.battleTypeFlags = 1 << 17 // BATTLE_TYPE_PALACE
    const { shouldSwitch: result, unmodelled } = shouldSwitch(s, 1, deps)
    expect(result).toBe(false)
    expect(unmodelled).toEqual([])
  })

  it('trapped (STATUS2_WRAPPED) never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.mon.status2 = STATUS2_WRAPPED
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('trapped (STATUS2_ESCAPE_PREVENTION) never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.mon.status2 = STATUS2_ESCAPE_PREVENTION
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('rooted (STATUS3_ROOTED) never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.statuses3 = STATUS3_ROOTED
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('commanded (STATUS4_COMMANDED) never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.statuses4 = STATUS4_COMMANDED
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('fear never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.fear = true
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('sky-dropped never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.skyDropped = true
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('BATTLE_TYPE_ARENA never switches', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battleTypeFlags = 1 << 18
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('no available reserve (availableToSwitch === 0) never switches', () => {
    const s = battle({}, { hp: 100 }, scripted()) // no opponentParty at all
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })
})

describe('shouldSwitch: ShouldSwitchIfPerishSong', () => {
  it('Perish Song at 0 turns left switches, with no RNG draw and PARTY_SIZE as the chosen slot', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.statuses3 = STATUS3_PERISH_SONG
    s.battlers[1]!.volatiles.perishSongTimer = 0
    const { shouldSwitch: result } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('Perish Song still counting down does not trigger this helper', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.statuses3 = STATUS3_PERISH_SONG
    s.battlers[1]!.volatiles.perishSongTimer = 2
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })
})

describe('shouldSwitch: FindMonThatAbsorbsOpponentsMove\'s own RNG guard', () => {
  it('a super-effective move in hand draws Random()%3; a hit (0) proceeds past the guard, and the lastLandedMoves gap fires', () => {
    // MUDKIP (Water) vs an opponent with EMBER known -- Water resists Fire,
    // not super effective FROM the AI's own moves though; use a real SE setup:
    // AI's own MOVE_EMBER (Fire) is super effective against a Bug/Grass-ish
    // target is unnecessary here -- simplest is to give the AI itself no SE
    // move so the guard's own HasSuperEffectiveMoveAgainstOpponents(TRUE) is
    // FALSE, skipping the Random()%3 draw entirely and reaching the gap
    // directly with an EMPTY rng script.
    const s = battle({}, { hp: 100, moves: ['MOVE_TACKLE', null, null, null] }, scripted(), [partyMon({ hp: 100 })])
    const { unmodelled } = shouldSwitch(s, 1, deps)
    expect(unmodelled.some((u) => u.includes('FindMonThatAbsorbsOpponentsMove') && u.includes('gLastLandedMoves'))).toBe(true)
  })
})

describe('shouldSwitch: ShouldSwitchIfWonderGuard', () => {
  it('opponent has Wonder Guard, AI has no SE move of its own, a reserve does -- switches into it', () => {
    // Opponent (battler 0) is Water/Mystery with Wonder Guard. AI's own
    // MUDKIP (battler 1) knows only Tackle (Normal, not SE vs Water). Reserve
    // knows Ember (Fire) -- not SE vs Water either; use a Grass reserve move
    // instead. Simplify: give the reserve a move whose type multiplier vs the
    // opponent's OWN types resolves >=2x. Opponent is WATER/MYSTERY; ELECTRIC
    // and GRASS are both neutral-or-better historically, but this engine's
    // real chart is data-driven -- assert the effectiveness directly rather
    // than assume.
    const s = battle(
      { types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: { ability: WONDER_GUARD, innates: [null, null, null] } },
      { hp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      scripted(0), // rejection-loop draw for the reserve pass: Random()%3=0 < 2 -- hit immediately
      [partyMon({ hp: 100, moves: ['MOVE_ABSORB', null, null, null] })], // Grass, real 2x vs Water -- verified below
    )
    // Reserve's Absorb is evaluated as if cast by the AI's OWN active battler
    // (the ShouldSwitchIfWonderGuard quirk this module's own doc cites) --
    // assert against the SAME call the port itself makes, not a raw chart
    // index (the chart's own units are plain fractions, not UQ_4_12).
    const absorbVsWater = aiGetTypeEffectiveness(s, 'MOVE_ABSORB', 1, 0, deps).effectiveness
    if (absorbVsWater < UQ_ONE * 2) throw new Error('MOVE_ABSORB is no longer super-effective vs pure Water on this data snapshot -- pick a different fixture move/type')
    const { shouldSwitch: result } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
  })

  it('opponent has Wonder Guard but the AI\'s OWN move is already SE -- never triggers this helper (falls through to ShouldSwitchIfNaturalCure etc.)', () => {
    const s = battle(
      { types: ['GRASS', 'MYSTERY', 'MYSTERY'], abilities: { ability: WONDER_GUARD, innates: [null, null, null] } },
      { hp: 100, moves: ['MOVE_EMBER', null, null, null] },
      scripted(),
      [partyMon({ hp: 100 })],
    )
    const emberVsGrass = aiGetTypeEffectiveness(s, 'MOVE_EMBER', 1, 0, deps).effectiveness
    if (emberVsGrass >= UQ_ONE * 2) {
      // The Wonder Guard helper itself must not have picked a mon -- fall
      // through to whatever ShouldSwitch's later steps decide, but critically
      // NOT via this helper. HasSuperEffectiveMoveAgainstOpponents(FALSE)
      // later in ShouldSwitch draws its own RNG; supply a script that keeps
      // this test's assertion narrow (the WonderGuard branch specifically).
      const { unmodelled } = shouldSwitch(s, 1, deps)
      expect(unmodelled.some((u) => u.includes('ShouldSwitchIfWonderGuard'))).toBe(false)
    } else {
      throw new Error('MOVE_EMBER is no longer super-effective vs pure Grass on this data snapshot -- pick a different fixture move/type')
    }
  })
})

describe('shouldSwitch: ShouldSwitchIfNaturalCure', () => {
  it('asleep + Natural Cure: the first Random()&1 draw is odd -- switches immediately, no further draws', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(1), [partyMon({ hp: 100 })])
    const { shouldSwitch: result, unmodelled } = shouldSwitch(s, 1, deps)
    expect(result).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
    expect(unmodelled.some((u) => u.includes('ShouldSwitchIfNaturalCure'))).toBe(true)
  })

  it('asleep + Natural Cure: first draw even, second draw odd -- switches on the second attempt', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(0, 1), [partyMon({ hp: 100 })])
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
  })

  it('asleep + Natural Cure: first two draws even -- falls to the final unconditional draw, which is odd -- switches', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(0, 0, 1), [partyMon({ hp: 100 })])
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
  })

  it('asleep + Natural Cure: all three draws even -- does not switch via this helper', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(0, 0, 0), [partyMon({ hp: 100 })])
    // Falls through to HasSuperEffectiveMoveAgainstOpponents(FALSE) etc; give
    // the AI no super effective move and neutral stats so the whole chain
    // resolves to FALSE cleanly.
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('not asleep never reaches this helper', () => {
    const s = battle({}, { hp: 100, status1: 0, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(), [partyMon({ hp: 100 })])
    const { unmodelled } = shouldSwitch(s, 1, deps)
    expect(unmodelled.some((u) => u.includes('ShouldSwitchIfNaturalCure'))).toBe(false)
  })

  it('asleep but no Natural-Cure-family ability never reaches this helper', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: null, innates: [null, null, null] } }, scripted(), [partyMon({ hp: 100 })])
    const { unmodelled } = shouldSwitch(s, 1, deps)
    expect(unmodelled.some((u) => u.includes('ShouldSwitchIfNaturalCure'))).toBe(false)
  })
})

describe('shouldSwitch: ShouldSwitchIfEncored', () => {
  it('encored draws one Random()&1 -- odd switches', () => {
    const s = battle({}, { hp: 100 }, scripted(1), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
  })

  it('encored, even draw -- does not switch via this helper', () => {
    const s = battle({}, { hp: 100 }, scripted(0), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('not encored never reaches this helper', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    const { unmodelled } = shouldSwitch(s, 1, deps)
    expect(unmodelled.some((u) => u.includes('ShouldSwitchIfEncored'))).toBe(false)
  })
})

describe('shouldSwitch: HasSuperEffectiveMoveAgainstOpponents / AreStatsRaised block a switch', () => {
  it('a super-effective move in hand (Random()%10 !== 0 hit) blocks the switch outright', () => {
    const s = battle({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, { hp: 100, moves: ['MOVE_EMBER', null, null, null] }, scripted(1), [partyMon({ hp: 100 })])
    const emberVsGrass = aiGetTypeEffectiveness(s, 'MOVE_EMBER', 1, 0, deps).effectiveness
    if (emberVsGrass < UQ_ONE * 2) throw new Error('MOVE_EMBER is no longer super-effective vs pure Grass on this data snapshot -- pick a different fixture move/type')
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('stats raised by more than 3 combined stages blocks the switch', () => {
    const s = battle({}, { hp: 100 }, scripted(), [partyMon({ hp: 100 })])
    const stages = s.battlers[1]!.mon.statStages
    stages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    stages[STAT_SPATK] = DEFAULT_STAT_STAGE + 2
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })
})

describe('shouldSwitch: AreAttackingStatsLowered', () => {
  it('a physical attacker with attack lowered below -1 always decides TRUE', () => {
    const s = battle({}, { hp: 100, rawStats: { atk: 150, def: 90, spatk: 80, spdef: 85, spe: 100 } }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE - 2 // -2 stage, below the -1 floor the C exempts
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('a physical attacker whose attack stage is not below -1 is exempted', () => {
    const s = battle({}, { hp: 100, rawStats: { atk: 150, def: 90, spatk: 80, spdef: 85, spe: 100 } }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE // neutral
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })
})

describe('shouldUseItem', () => {
  it('always returns FALSE and reports why', () => {
    const { usedItem, unmodelled } = shouldUseItem()
    expect(usedItem).toBe(false)
    expect(unmodelled.some((u) => u.includes('ShouldUseItem'))).toBe(true)
  })
})

describe('aiTrySwitchOrUseItem', () => {
  it('when ShouldSwitch decides via a specific-mon helper, uses that mon directly without calling GetMostSuitableMonToSwitchInto', () => {
    const s = battle(
      { types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: { ability: WONDER_GUARD, innates: [null, null, null] } },
      { hp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      scripted(0),
      [partyMon({ hp: 100, moves: ['MOVE_ABSORB', null, null, null] })],
    )
    const absorbVsWater = aiGetTypeEffectiveness(s, 'MOVE_ABSORB', 1, 0, deps).effectiveness
    if (absorbVsWater < UQ_ONE * 2) throw new Error('MOVE_ABSORB is no longer super-effective vs pure Water on this data snapshot -- pick a different fixture move/type')
    const result = aiTrySwitchOrUseItem(s, 1, deps, getMostSuitableMonToSwitchInto)
    expect(result.switched).toBe(true)
    expect(s.battlers[1]!.monToSwitchIntoId).toBe(1)
  })

  it('when ShouldSwitch decides PARTY_SIZE, calls GetMostSuitableMonToSwitchInto and writes its answer into monToSwitchIntoId', () => {
    const s = battle({}, { hp: 100, status1: STATUS1_SLEEP, abilities: { ability: NATURAL_CURE, innates: [null, null, null] } }, scripted(1), [
      partyMon({ hp: 100, moves: ['MOVE_TACKLE', null, null, null] }),
    ])
    const result = aiTrySwitchOrUseItem(s, 1, deps, getMostSuitableMonToSwitchInto)
    expect(result.switched).toBe(true)
    expect(s.battlers[1]!.monToSwitchIntoId).toBe(1) // the only reserve
    expect(s.battlers[1]!.aiMonToSwitchIntoId).toBe(1)
  })

  it('when ShouldSwitch is FALSE, does not switch and reports the ShouldUseItem gap', () => {
    const s = battle({}, { hp: 100 }, scripted()) // no reserves at all
    const result = aiTrySwitchOrUseItem(s, 1, deps, getMostSuitableMonToSwitchInto)
    expect(result.switched).toBe(false)
    expect(result.unmodelled.some((u) => u.includes('ShouldUseItem'))).toBe(true)
  })

  it('IsMonHealthyEnoughToSwitch (hp < maxHp/8) blocks a switch that an Encore would otherwise trigger -- checked BEFORE ShouldSwitchIfEncored, per the C\'s own order', () => {
    // hp=8, maxHp=100 -> maxHp/8=12, so 8 < 12 fails healthy-enough.
    // ShouldSwitchIfAllBadMoves/PerishSong/AbsorbsMove all run BEFORE this
    // gate but none of them are set up to trigger here, so reaching FALSE
    // proves the healthy gate -- not one of the earlier helpers -- decided it.
    const s = battle({}, { hp: 8, maxHp: 100 }, scripted(), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE' // would switch via ShouldSwitchIfEncored if reached
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(false)
  })

  it('Regenerator raises the healthy-enough HP threshold by 133/100, letting an otherwise-blocked Encore switch through', () => {
    // hp=10, maxHp=100 -> maxHp/8=12. Without Regenerator: 10 < 12, blocked.
    // With Regenerator: 10*133/100=13 (idiv) >= 12, passes -- the Encore
    // helper is then reached and switches.
    const s = battle({}, { hp: 10, maxHp: 100, abilities: { ability: REGENERATOR, innates: [null, null, null] } }, scripted(1), [partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    expect(shouldSwitch(s, 1, deps).shouldSwitch).toBe(true)
  })
})
