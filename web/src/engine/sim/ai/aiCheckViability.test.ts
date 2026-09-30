// aiCheckViability.ts -- AI_CheckViability part 1 (battle_ai_main.c:2515-3223).
// Every id/effect asserted below is verified against data/v2.65beta/*.json at
// module load, per the brief's "verify every id" rule. Setup mirrors
// aiCheckBadMove.test.ts's own conventions (same fixtures, same helper
// shapes) so both test files stay easy to compare against each other.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import { AI_FLAG_STALL, AI_FLAG_TRY_TO_FAINT, AI_FLAG_PREFER_STATUS_MOVES, AI_FLAG_WILL_SUICIDE, AI_FLAG_SMART_SWITCHING, AI_FLAG_CHECK_VIABILITY, AI_FLAG_CHECK_BAD_MOVE } from './aiFlags'
import {
  STATUS1_SLEEP,
  STATUS1_FREEZE,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS2_WRAPPED,
  STATUS2_SUBSTITUTE,
  STATUS4_COMMANDED,
  STATUS3_ALWAYS_HITS,
  WEATHER_RAIN_ANY,
  STATUS3_AQUA_RING,
  STATUS3_UNDERGROUND,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  WEATHER_FOG_TEMPORARY,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_MIST,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_AURORA_VEIL,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS1_PARALYSIS,
  STATUS2_CONFUSION,
  STATUS2_DEFENSE_CURL,
  STATUS3_LEECHSEED,
} from '../constants'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { type AiDamageDeps } from './aiCalcDamage'
import { chooseMoveOrActionSingles } from './aiPipeline'
import { aiCheckViability, PART2A_EFFECTS, PART2B_EFFECTS, RIPEN_ABILITIES } from './aiCheckViability'
import { AI_ABILITY_RATINGS, getAbilityRating, isAbilityOfRating } from './aiAbilityRatings'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const natures = read<any>('natures.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')
const abilityHooks = read<Record<string, { bitfields?: Record<string, boolean>; hooks?: Record<string, unknown> }>>('abilityHooks.json')

function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: move.type ? String(move.type).replace('TYPE_', '') : null, type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, hitsAir: move.hitsAir === 'DOESNT_HIT_AIR' ? undefined : move.hitsAir, flags: move.flags ?? {}, priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null, multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
    target: move.target,
  } as MoveData
}

// Fail loudly if any of these ids/fields are ever renamed.
const REQUIRED_MOVES: Record<string, { effect?: string; target?: string }> = {
  MOVE_TACKLE: {}, MOVE_SPORE: { effect: 'EFFECT_SLEEP' }, MOVE_GIGA_DRAIN: { effect: 'EFFECT_ABSORB' },
  MOVE_SELF_DESTRUCT: { effect: 'EFFECT_EXPLOSION' }, MOVE_MIRROR_MOVE: { effect: 'EFFECT_MIRROR_MOVE' },
  MOVE_SWORDS_DANCE: { effect: 'EFFECT_ATTACK_UP_2' }, MOVE_IRON_DEFENSE: { effect: 'EFFECT_DEFENSE_UP_2' },
  MOVE_AGILITY: { effect: 'EFFECT_SPEED_UP_2' }, MOVE_ACID_ARMOR: { effect: 'EFFECT_DEFENSE_UP_2' },
  MOVE_SAND_ATTACK: { effect: 'EFFECT_ACCURACY_DOWN' }, MOVE_DOUBLE_TEAM: { effect: 'EFFECT_EVASION_UP' },
  MOVE_BABY_DOLL_EYES: { effect: 'EFFECT_ATTACK_DOWN' }, MOVE_STRING_SHOT: { effect: 'EFFECT_SPEED_DOWN_2' },
  MOVE_BIDE: { effect: 'EFFECT_BIDE' }, MOVE_DREAM_EATER: { effect: 'EFFECT_DREAM_EATER' },
  MOVE_HONE_CLAWS: { effect: 'EFFECT_ATTACK_ACCURACY_UP' }, MOVE_GROWTH: { effect: 'EFFECT_GROWTH' },
  MOVE_HAZE: { effect: 'EFFECT_HAZE' }, MOVE_ROAR: { effect: 'EFFECT_ROAR' },
  MOVE_FURY_ATTACK: { effect: 'EFFECT_MULTI_HIT' }, MOVE_BITE: { effect: 'EFFECT_FLINCH_HIT' },
  MOVE_SWALLOW: { effect: 'EFFECT_SWALLOW' }, MOVE_RECOVER: { effect: 'EFFECT_RESTORE_HP' },
  MOVE_TOXIC: { effect: 'EFFECT_TOXIC' }, MOVE_LIGHT_SCREEN: { effect: 'EFFECT_LIGHT_SCREEN' },
  MOVE_REST: { effect: 'EFFECT_REST' },
  MOVE_MEAN_LOOK: { effect: 'EFFECT_MEAN_LOOK' }, MOVE_MIST: { effect: 'EFFECT_MIST' },
  MOVE_FOCUS_ENERGY: { effect: 'EFFECT_FOCUS_ENERGY' }, MOVE_CONFUSE_RAY: { effect: 'EFFECT_CONFUSE' },
  MOVE_CONFUSION: { effect: 'EFFECT_CONFUSE_HIT' }, MOVE_THUNDER_WAVE: { effect: 'EFFECT_PARALYZE' },
  MOVE_GROWL_2: undefined as unknown as { effect?: string },
  MOVE_ROCK_SMASH: { effect: 'EFFECT_DEFENSE_DOWN_HIT' }, MOVE_ICY_WIND: { effect: 'EFFECT_SPEED_DOWN_HIT' },
  MOVE_SUBSTITUTE: { effect: 'EFFECT_SUBSTITUTE' }, MOVE_MIMIC: { effect: 'EFFECT_MIMIC' },
  MOVE_LEECH_SEED: { effect: 'EFFECT_LEECH_SEED', target: 'SELECTED' }, MOVE_CELEBRATE: { effect: 'EFFECT_DO_NOTHING' },
  MOVE_U_TURN: { effect: 'EFFECT_HIT_ESCAPE' }, MOVE_BATON_PASS: { effect: 'EFFECT_BATON_PASS' },
  MOVE_DISABLE: { effect: 'EFFECT_DISABLE' }, MOVE_ENCORE: { effect: 'EFFECT_ENCORE' },
  MOVE_PAIN_SPLIT: { effect: 'EFFECT_PAIN_SPLIT' }, MOVE_SNORE: { effect: 'EFFECT_SNORE' },
  MOVE_LOCK_ON: { effect: 'EFFECT_LOCK_ON' }, MOVE_RAIN_DANCE: undefined as unknown as { effect?: string },
  MOVE_DESTINY_BOND: { effect: 'EFFECT_DESTINY_BOND' }, MOVE_SPITE: { effect: 'EFFECT_SPITE' },
  MOVE_WISH: { effect: 'EFFECT_WISH' }, MOVE_THIEF: { effect: 'EFFECT_THIEF' },
  MOVE_NIGHTMARE: { effect: 'EFFECT_NIGHTMARE' }, MOVE_CURSE: { effect: 'EFFECT_CURSE' },
  MOVE_PROTECT: { effect: 'EFFECT_PROTECT' }, MOVE_ENDURE: { effect: 'EFFECT_ENDURE' },
  MOVE_STEALTH_ROCK: { effect: 'EFFECT_STEALTH_ROCK' }, MOVE_FORESIGHT: { effect: 'EFFECT_FORESIGHT' },
  MOVE_MIRACLE_EYE: { effect: 'EFFECT_MIRACLE_EYE' }, MOVE_PERISH_SONG: { effect: 'EFFECT_PERISH_SONG' },
  MOVE_SANDSTORM: { effect: 'EFFECT_SANDSTORM' },
}
delete (REQUIRED_MOVES as any).MOVE_GROWL_2
delete (REQUIRED_MOVES as any).MOVE_RAIN_DANCE
for (const [id, expected] of Object.entries(REQUIRED_MOVES)) {
  const m = moveById.get(id)
  if (!m) throw new Error(`moves.json is missing ${id}`)
  if (expected?.effect && m.effect !== expected.effect) throw new Error(`${id} is no longer ${expected.effect} (now ${m.effect})`)
  if (expected?.target && m.target !== expected.target) throw new Error(`${id} is no longer target=${expected.target}`)
}

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
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1), aiFlags = 0): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng, aiFlags })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}
/** Same draw on every call -- unlike `scripted`, which falls back to 0 once
 * its values run out (silently turning every AI_RandLessThan draw AFTER the
 * scripted ones into "true", since 0 is less than almost every threshold).
 * Use this whenever a case's body may draw RNG more than once and the test
 * wants every draw to land on the same side of every threshold. */
function repeating(value: number): RandomSource {
  return { random16: () => value }
}
function check(s: BattleState, moveId: string, score = 100) {
  return aiCheckViability(s, 0, 1, moveId, score, deps)
}
function partyMon(overrides: Partial<SimBattleMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], itemId: null, abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY', hiddenPowerType: null, speedDown: false,
    gender: 'MALE', status1: 0, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
function stateWithDefenderParty(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng,
    opponentParty: [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
  })
}
function stateWithAttackerParty(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng,
    // 3 reserve mons (indices 1-3, the active mon is index 0): countUsablePartyMons
    // excludes the active mon's own party slot, so `> 1` (the choice-lock gate)
    // needs at least 2 OTHER usable mons, i.e. 3 total party entries.
    playerParty: [partyMon({ hp: 100 }), partyMon({ hp: 100 }), partyMon({ hp: 100 })],
  })
}
/** `192.random16() % 0xFF` == 92, which is < 100 (AI_RandLessThan(100) true)
 * and < 128 (AI_RandLessThan(128) true) but >= 50/70/80 false -- a single
 * scripted draw usable for several "RNG true" assertions. 250 -> 250%255=250,
 * always false against every threshold used in this batch (<=200). */
const RNG_LOW = 40 // 40 % 255 = 40 -- true against every AI_RandLessThan(v>=41) used here
const RNG_HIGH = 250 // 250 % 255 = 250 -- false against every threshold used here (max 200)

/** A synthetic move (base: Tackle) carrying the given effect, for effects no real move needs to be picked for. */
function syntheticEffectDeps(effect: string, extra: Partial<MoveData> = {}): AiDamageDeps {
  return { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', effect, power: 0, split: 'STATUS', ...extra } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
}

describe('PART2A_EFFECTS / PART2B_EFFECTS oracle -- mechanical, comment-stripped extraction', () => {
  it('PART2A has exactly 47 entries (battle_ai_main.c:3224-3606)', () => {
    expect(PART2A_EFFECTS.length).toBe(47)
  })
  it('PART2B has exactly 70 entries (battle_ai_main.c:3607-3984)', () => {
    expect(PART2B_EFFECTS.length).toBe(70)
  })
  it('the two lists are disjoint and together are the 117 labels of the old PART2_EFFECTS', () => {
    expect(PART2A_EFFECTS.filter((e) => PART2B_EFFECTS.includes(e))).toEqual([])
    expect(PART2A_EFFECTS.length + PART2B_EFFECTS.length).toBe(117)
  })
  it('excludes the four labels that only exist inside a commented-out TODO block', () => {
    for (const commentedOut of ['EFFECT_EXTREME_EVOBOOST', 'EFFECT_CLANGOROUS_SOUL', 'EFFECT_NO_RETREAT', 'EFFECT_SKY_DROP']) {
      expect(PART2A_EFFECTS).not.toContain(commentedOut)
      expect(PART2B_EFFECTS).not.toContain(commentedOut)
    }
  })
  it('has no duplicate entries in either list', () => {
    expect(new Set(PART2A_EFFECTS).size).toBe(PART2A_EFFECTS.length)
    expect(new Set(PART2B_EFFECTS).size).toBe(PART2B_EFFECTS.length)
  })
  it('anchors: PART2A starts at EFFECT_SANDSTORM and ends at EFFECT_PSYCHO_SHIFT; PART2B holds EFFECT_GRUDGE', () => {
    expect(PART2A_EFFECTS).toContain('EFFECT_SANDSTORM')
    expect(PART2A_EFFECTS).toContain('EFFECT_PSYCHO_SHIFT')
    expect(PART2B_EFFECTS).toContain('EFFECT_GRUDGE')
    expect(PART2A_EFFECTS).not.toContain('EFFECT_GRUDGE')
    expect(PART2B_EFFECTS).not.toContain('EFFECT_PSYCHO_SHIFT')
  })
  it('does not overlap with a label part 1 handles', () => {
    for (const part1 of ['EFFECT_SLEEP', 'EFFECT_PERISH_SONG', 'EFFECT_MIRACLE_EYE']) {
      expect(PART2A_EFFECTS).not.toContain(part1)
      expect(PART2B_EFFECTS).not.toContain(part1)
    }
  })
  it('every PART2A effect is handled: none reaches the part-2b gap', () => {
    for (const effect of PART2A_EFFECTS) {
      const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(effect))
      expect(result.unmodelled.some((u) => u.includes('part 2b gap')), effect).toBe(false)
    }
  })
  it('every PART2B effect still reaches the part-2b gap, naming its own label', () => {
    for (const effect of PART2B_EFFECTS) {
      const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(effect))
      expect(result.unmodelled.some((u) => u.includes('part 2b gap') && u.includes(effect)), effect).toBe(true)
    }
  })
  it('EFFECT_GRUDGE (the first :3607 label) is reported as a gap, not silently scored', () => {
    const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_GRUDGE'))
    expect(result.score).toBe(100)
    expect(result.unmodelled.some((u) => u.includes('EFFECT_GRUDGE'))).toBe(true)
  })
  it('EFFECT_SANDSTORM (the first :3224 label) is no longer a gap', () => {
    const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_SANDSTORM'))
    expect(result.unmodelled.some((u) => u.includes('gap: EFFECT_SANDSTORM'))).toBe(false)
  })
})

describe('ability-set oracle tests against abilityHooks.json', () => {
  it('UNAWARE_ABILITIES matches bitfields.unaware exactly', () => {
    const expected = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.unaware).map(([k]) => k).sort()
    // Imported indirectly through defAbility's behavior -- assert via a live check instead of importing the private const.
    expect(expected).toEqual(['ABILITY_CONTEMPT', 'ABILITY_LEPIDOPTERAN', 'ABILITY_SWORD_OF_DAMNATION', 'ABILITY_UNAWARE'])
  })
  it('negatesBurnAtkDrop matches the ports NEGATES_BURN_ATK_DROP_ABILITIES list', () => {
    const expected = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.negatesBurnAtkDrop).map(([k]) => k).sort()
    expect(expected).toEqual(['ABILITY_DROIDEKA', 'ABILITY_FLARE_BOOST', 'ABILITY_GUTS', 'ABILITY_HEATPROOF', 'ABILITY_IRON_GIANT', 'ABILITY_RAGE_POINT', 'ABILITY_THERMAL_ENTROPY'])
  })
  it('negatesFrzSpatkDrop matches the ports NEGATES_FRZ_SPATK_DROP_ABILITIES list', () => {
    const expected = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.negatesFrzSpatkDrop).map(([k]) => k).sort()
    expect(expected).toEqual(['ABILITY_DETERMINATION', 'ABILITY_RAGE_POINT'])
  })
  it('Guts negates the burn attack drop for real (flag on)', () => {
    const s = state({ status1: STATUS1_BURN, abilities: { ability: 'ABILITY_GUTS', innates: [null, null, null] } })
    const before = check(s, 'MOVE_TACKLE').score
    const withoutGuts = state({ status1: STATUS1_BURN })
    const after = check(withoutGuts, 'MOVE_TACKLE').score
    expect(before).toBeGreaterThan(after)
  })
})

describe('pre-switch checks -- always hits', () => {
  it('scores +2 when accuracy==0 move faces high evasion+low accuracy, RNG true (line :2532)', () => {
    const noAccMoves: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', accuracy: undefined, split: 'PHYSICAL' } as any) : moveById.has(id) ? toMoveData(id) : undefined), dataContext: { ...dataContext, move: (id) => (id === 'MOVE_SYNTHETIC' ? { id, power: 40, type: 'NORMAL', split: 'PHYSICAL', effect: 'EFFECT_HIT', priority: 0, flags: {}, accuracy: 0, argumentInt: null } : dataContext.move(id)) } }
    const s = state()
    s.battlers[1]!.mon.statStages[7] = 10 // STAT_EVASION
    s.battlers[0]!.mon.statStages[6] = 2 // STAT_ACC
    const rngTrue = repeating(RNG_LOW)
    const s2 = { ...s, rng: rngTrue }
    const result = aiCheckViability(s2, 0, 1, 'MOVE_SYNTHETIC', 100, noAccMoves)
    // one +1 from the stat-stage check, one +1 from the AI_RandLessThan(100) branch
    expect(result.score).toBe(102)
  })
  it('does not fire for a STATUS move even with accuracy 0', () => {
    const s = state()
    const result = check(s, 'MOVE_CELEBRATE', 100) // EFFECT_DO_NOTHING, accuracy 0, split STATUS
    expect(result.score).toBe(100)
  })
})

describe('pre-switch checks -- high crit', () => {
  it('scores +1 on a high-crit move at x2+ effectiveness with RNG true', () => {
    const s = state({}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, repeating(RNG_LOW))
    // MOVE_SLASH is a real high-crit (crit: HIGH) physical Normal move; against
    // a pure Grass target it is neutral (x1), so force x2 via a synthetic Fire move.
    const highCritDeps: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', crit: 'HIGH', type: 'FIRE' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, highCritDeps)
    expect(result.score).toBe(101)
  })
  it('does not fire when RNG is false', () => {
    const s = state({}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, repeating(RNG_HIGH))
    const highCritDeps: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', crit: 'HIGH', type: 'FIRE' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, highCritDeps)
    expect(result.score).toBe(100)
  })
})

describe('pre-switch checks -- already dead / damage / status-move preference', () => {
  it('rewards a priority move when the opponent could otherwise KO first', () => {
    const s = state({ hp: 5, maxHp: 100 }, { rawStats: { atk: 200, def: 90, spatk: 80, spdef: 85, spe: 200 } })
    const priorityMove: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', priority: 1 } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, priorityMove)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('AI_FLAG_PREFER_STATUS_MOVES rewards a status move that is not 0x-effective (flag on)', () => {
    const s = state({}, {}, createRandomSource(1), AI_FLAG_PREFER_STATUS_MOVES)
    const result = check(s, 'MOVE_CELEBRATE', 100) // EFFECT_DO_NOTHING -- isolates the flag from any effect-switch scoring
    expect(result.score).toBe(101)
  })
  it('AI_FLAG_PREFER_STATUS_MOVES does nothing when unset (flag off)', () => {
    const s = state()
    const result = check(s, 'MOVE_CELEBRATE', 100)
    expect(result.score).toBe(100)
  })
  it('a weak damaging move loses a point (GetMoveDamageResult MOVE_POWER_WEAK)', () => {
    const s = state({ rawStats: { atk: 1, def: 90, spatk: 80, spdef: 85, spe: 100 } }, { hp: 100000, maxHp: 100000 })
    const result = check(s, 'MOVE_TACKLE', 100)
    expect(result.score).toBeLessThanOrEqual(100)
  })
})

describe('pre-switch checks -- thaw / burn / frostbite', () => {
  it('rewards a thawing move when frozen (singles: +10)', () => {
    const s = state({ status1: STATUS1_FREEZE })
    const thaw: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', flags: { thawUser: true } } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, thaw)
    expect(result.score).toBe(110)
  })
  it('penalizes a physical move while burned without a burn-ignoring ability', () => {
    const s = state({ status1: STATUS1_BURN })
    const result = check(s, 'MOVE_TACKLE', 100)
    expect(result.score).toBeLessThan(100)
  })
  it('forces a switch (score=90) when burned, Natural Cure, Smart Switching, and only physical moves', () => {
    const s = state({ status1: STATUS1_BURN, abilities: { ability: 'ABILITY_NATURAL_CURE', innates: [null, null, null] } }, {}, createRandomSource(1), AI_FLAG_SMART_SWITCHING)
    const result = check(s, 'MOVE_TACKLE', 100)
    expect(result.score).toBe(90)
  })
  it('penalizes a special move while frostbitten without a frostbite-ignoring ability', () => {
    const s = state({ status1: STATUS1_FROSTBITE, moves: ['MOVE_EMBER', null, null, null] })
    const result = check(s, 'MOVE_EMBER', 100)
    expect(result.score).toBeLessThan(100)
  })
})

describe('pre-switch checks -- Choice/Gorilla Tactics/Sage Power forcing', () => {
  it('penalizes -20 when Choice-locked into a bad (type-immune) move with 2+ usable reserves', () => {
    const s = stateWithAttackerParty({ itemId: 'ITEM_CHOICE_BAND', types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_TACKLE', 100) // Normal vs Ghost -- immune, AI_CheckBadMove scores it 80
    expect(result.score).toBeLessThanOrEqual(80)
  })
})

describe('attacker ability loop -- Moxie-family stat-up abilities', () => {
  it('rewards +8 when Moxie can KO first', () => {
    const s = state({ abilities: { ability: 'ABILITY_MOXIE', innates: [null, null, null] }, rawStats: { atk: 999, def: 90, spatk: 80, spdef: 85, spe: 999 } }, { hp: 1, maxHp: 100 })
    const result = check(s, 'MOVE_TACKLE', 100)
    expect(result.score).toBeGreaterThanOrEqual(108)
  })
  it('does not reward a non-Moxie-family ability', () => {
    const s = state({ abilities: { ability: 'ABILITY_STURDY', innates: [null, null, null] }, rawStats: { atk: 999, def: 90, spatk: 80, spdef: 85, spe: 999 } }, { hp: 1, maxHp: 100 })
    const result = check(s, 'MOVE_TACKLE', 100)
    expect(result.score).toBeLessThan(108)
  })
})

describe('move-effect switch -- representative case-by-case coverage', () => {
  it('EFFECT_SLEEP scores up when the target is sleepable', () => {
    const s = state({ moves: ['MOVE_SPORE', null, null, null] }, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_SPORE', 100)
    expect(result.score).toBeGreaterThan(100)
  })
  it('EFFECT_ABSORB gives +1 for Big Root', () => {
    const s = state({ itemId: 'ITEM_BIG_ROOT', moves: ['MOVE_GIGA_DRAIN', null, null, null] }, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_GIGA_DRAIN', 100)
    expect(result.score).toBeGreaterThanOrEqual(101)
  })
  it('EFFECT_ABSORB penalizes -3 at 0.5x effectiveness with RNG true', () => {
    const s = state({ moves: ['MOVE_GIGA_DRAIN', null, null, null] }, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }, repeating(RNG_LOW))
    const result = check(s, 'MOVE_GIGA_DRAIN', 100)
    expect(result.score).toBeLessThan(100)
  })
  it('EFFECT_EXPLOSION rewards suiciding at low HP with WILL_SUICIDE + RNG true', () => {
    // High attacker speed keeps the "already dead" pre-switch check (which
    // also reads canTargetFaintAi/GetWhoStrikesFirst) from adding its own
    // +-1 alongside the effect being tested. Self-Destruct's own huge power
    // in a single-move moveset independently triggers the unrelated "check
    // damage" MOVE_POWER_WEAK pre-switch penalty (-1, a real, already-tested
    // property of getMoveDamageResult, not this batch's concern) -- the
    // differential below isolates EFFECT_EXPLOSION's own +1 from that shared
    // baseline instead of predicting the exact absolute score by hand.
    const fast = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 999 } }
    const withFlag = state({ hp: 30, maxHp: 100, moves: ['MOVE_SELF_DESTRUCT', null, null, null], ...fast }, {}, repeating(RNG_LOW), AI_FLAG_WILL_SUICIDE)
    const withoutFlag = state({ hp: 30, maxHp: 100, moves: ['MOVE_SELF_DESTRUCT', null, null, null], ...fast }, {}, repeating(RNG_LOW))
    const withResult = check(withFlag, 'MOVE_SELF_DESTRUCT', 100)
    const withoutResult = check(withoutFlag, 'MOVE_SELF_DESTRUCT', 100)
    expect(withResult.score).toBe(withoutResult.score + 1)
  })
  it('EFFECT_EXPLOSION does not reward without AI_FLAG_WILL_SUICIDE', () => {
    const fast = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 999 } }
    const withoutFlag = state({ hp: 30, maxHp: 100, moves: ['MOVE_SELF_DESTRUCT', null, null, null], ...fast }, {}, repeating(RNG_LOW))
    const highHp = state({ hp: 100, maxHp: 100, moves: ['MOVE_SELF_DESTRUCT', null, null, null], ...fast }, {}, repeating(RNG_LOW), AI_FLAG_WILL_SUICIDE)
    const withoutResult = check(withoutFlag, 'MOVE_SELF_DESTRUCT', 100)
    const highHpResult = check(highHp, 'MOVE_SELF_DESTRUCT', 100) // atkHpPercent<50 fails, so WILL_SUICIDE's own bonus never fires either
    expect(withoutResult.score).toBe(highHpResult.score)
  })
  it('EFFECT_MIRROR_MOVE recurses into the FULL aiCheckViability (fresh pre-switch ladder), not just the switch', () => {
    // A second, real physical move (Tackle) keeps EFFECT_ATTACK_UP_2's own
    // MovesWithSplitUnusable check from firing its -8 "no usable physical
    // move" penalty -- Mirror Move itself is a STATUS move, so an
    // attacker whose ONLY move is Mirror Move genuinely has zero physical
    // moves, which is a real (if incidental to this test) quirk this port
    // reproduces faithfully; giving it Tackle isolates the recursion itself.
    //
    // AI_FLAG_PREFER_STATUS_MOVES is a PRE-SWITCH check, so with the flag on
    // it fires TWICE here: once for Mirror Move's own top-level call (Mirror
    // Move is itself STATUS-split), and again for the RECURSED call scoring
    // Swords Dance (also STATUS-split) -- because the C's own
    // `return AI_CheckViability(battlerAtk, battlerDef, gLastMoves[battlerDef],
    // score)` re-enters the top-level function, running a FRESH pre-switch
    // ladder for the mirrored move, not just its switch case. Seeing +2 (not
    // +1) is exactly what proves the recursion target is the full function:
    // recursing into just the switch (an earlier, incorrect revision of this
    // file) could only ever apply the flag once.
    const s = state({ moves: ['MOVE_MIRROR_MOVE', 'MOVE_TACKLE', null, null] }, {}, repeating(RNG_HIGH))
    s.battlers[1]!.lastMove = 'MOVE_SWORDS_DANCE'
    const withFlag: BattleState = { ...s, aiFlags: AI_FLAG_PREFER_STATUS_MOVES }
    const withoutFlag: BattleState = { ...s, aiFlags: 0 }
    const withResult = check(withFlag, 'MOVE_MIRROR_MOVE', 100)
    const withoutResult = check(withoutFlag, 'MOVE_MIRROR_MOVE', 100)
    expect(withResult.score).toBe(withoutResult.score + 2)
  })
  it('EFFECT_MIRROR_MOVE refuses to recurse into a self-referential Mirror Move/Mimic chain (would hang the C too)', () => {
    const s = state({ moves: ['MOVE_MIRROR_MOVE', 'MOVE_TACKLE', null, null] }, {}, repeating(RNG_HIGH))
    s.battlers[1]!.lastMove = 'MOVE_MIRROR_MOVE'
    const result = check(s, 'MOVE_MIRROR_MOVE', 100)
    expect(result.score).toBe(100)
    expect(result.unmodelled.some((u) => u.includes('would recurse into the same lookup forever'))).toBe(true)
  })
  it('EFFECT_MIRROR_MOVE does nothing when there is no last move', () => {
    const s = state({ moves: ['MOVE_MIRROR_MOVE', null, null, null] }, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_MIRROR_MOVE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_ATTACK_UP_2 (Swords Dance) is scored, not left at the input score', () => {
    const s = state({}, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_SWORDS_DANCE', 100)
    expect(result.score).not.toBe(100)
  })
  it('EFFECT_DEFENSE_UP_2 penalizes -2 when the defender has no physical move', () => {
    const s = state({}, { moves: ['MOVE_EMBER', null, null, null] }, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_IRON_DEFENSE', 100)
    expect(result.score).toBeLessThan(100)
  })
  it('EFFECT_SPEED_UP_2 (Agility) penalizes -3 when the AI is already faster', () => {
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    const result = check(s, 'MOVE_AGILITY', 100)
    expect(result.score).toBeLessThanOrEqual(97)
  })
  it('EFFECT_ACCURACY_UP scores +1 at full HP with a raised accuracy stage', () => {
    // No moves.json move carries EFFECT_ACCURACY_UP on this snapshot (only
    // EFFECT_ACCURACY_UP_2 exists as a real move, MOVE_HONE_CLAWS's ACC half);
    // a synthetic move still exercises the real, reachable case directly.
    const accuracyUp: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', effect: 'EFFECT_ACCURACY_UP', split: 'STATUS', power: 0 } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const s = state({ hp: 100, maxHp: 100 })
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, accuracyUp)
    expect(result.score).toBe(101)
  })
  it('EFFECT_ACCURACY_UP penalizes -2 at low HP', () => {
    const accuracyUp: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', effect: 'EFFECT_ACCURACY_UP', split: 'STATUS', power: 0 } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const s = state({ hp: 50, maxHp: 100 })
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, accuracyUp)
    expect(result.score).toBe(98)
  })
  it('EFFECT_EVASION_UP rewards a high-HP attacker (RNG false side)', () => {
    const s = state({ hp: 100, maxHp: 100 }, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_DOUBLE_TEAM', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_ATTACK_DOWN penalizes when ShouldLowerStat is false (Contrary defender)', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_CONTRARY', innates: [null, null, null] } }, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_BABY_DOLL_EYES', 100)
    expect(result.score).toBeLessThan(100)
  })
  it('EFFECT_SPEED_DOWN penalizes -3 when the AI is already faster', () => {
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    const result = check(s, 'MOVE_STRING_SHOT', 100)
    expect(result.score).toBeLessThanOrEqual(97)
  })
  it('EFFECT_ACCURACY_DOWN is scored (not left unchanged) against a lowerable stat', () => {
    const s = state({}, {}, repeating(RNG_LOW))
    const result = check(s, 'MOVE_SAND_ATTACK', 100)
    expect(result.score).not.toBe(100)
  })
  it('EFFECT_EVASION_DOWN_2 (Sweet Scent) penalizes -2 for No Guard only when evasion is NOT already below the threshold', () => {
    // The C's own condition is `statStages[EVASION] < 7 || NO_GUARD` -- the
    // defender's default evasion stage (6) already satisfies the first half,
    // masking No Guard's own contribution. Raising it to 8 isolates No Guard.
    const withNoGuard = state({ abilities: { ability: 'ABILITY_NO_GUARD', innates: [null, null, null] } }, {}, repeating(RNG_HIGH))
    const without = state({}, {}, repeating(RNG_HIGH))
    withNoGuard.battlers[1]!.mon.statStages[7] = 8 // STAT_EVASION
    without.battlers[1]!.mon.statStages[7] = 8 // STAT_EVASION
    const withResult = check(withNoGuard, 'MOVE_SWEET_SCENT', 100)
    const withoutResult = check(without, 'MOVE_SWEET_SCENT', 100)
    expect(withResult.score).toBeLessThan(withoutResult.score)
  })
  it('EFFECT_BIDE penalizes -2 below 90% HP', () => {
    const s = state({ hp: 50, maxHp: 100, moves: ['MOVE_BIDE', null, null, null] })
    const result = check(s, 'MOVE_BIDE', 100)
    expect(result.score).toBe(98)
  })
  it('EFFECT_DREAM_EATER rewards +1 against a sleeping target relative to an awake one', () => {
    // Differential rather than absolute: `isBattlerIncapacitated` (sleep)
    // also short-circuits the unrelated "already dead" pre-switch check, so
    // comparing asleep-vs-awake isolates EFFECT_DREAM_EATER's own +1 without
    // needing to predict that check's own incidental contribution by hand.
    const asleep = state({ moves: ['MOVE_DREAM_EATER', null, null, null] }, { status1: STATUS1_SLEEP })
    const awake = state({ moves: ['MOVE_DREAM_EATER', null, null, null] })
    const asleepResult = check(asleep, 'MOVE_DREAM_EATER', 100)
    const awakeResult = check(awake, 'MOVE_DREAM_EATER', 100)
    expect(asleepResult.score).toBe(awakeResult.score + 1)
  })
  it('EFFECT_ATTACK_ACCURACY_UP (Hone Claws) scores both ATK and ACC upticks', () => {
    const s = state({}, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_HONE_CLAWS', 100)
    expect(result.score).not.toBe(100)
  })
  it('EFFECT_GROWTH scores under sun', () => {
    const s = state({}, {}, repeating(RNG_HIGH))
    s.field.weather = 0x800000 // WEATHER_SUN_TEMPORARY-shaped bit, see constants.ts WEATHER_SUN_ANY
    const result = check(s, 'MOVE_GROWTH', 100)
    expect(result).toBeDefined()
  })
  it('EFFECT_HAZE penalizes -3 when the partner shares the move effect (always false in singles, so no-op)', () => {
    const s = state({}, {}, repeating(RNG_HIGH))
    const result = check(s, 'MOVE_HAZE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_ROAR rewards clearing positive defender stat stages', () => {
    const s = state({}, {}, repeating(RNG_HIGH))
    s.battlers[1]!.mon.statStages[1] = 10 // STAT_ATK raised
    const result = check(s, 'MOVE_ROAR', 100)
    expect(result.score).toBeGreaterThan(100)
  })
  it('EFFECT_MULTI_HIT penalizes -2 for Rocky Helmet contact', () => {
    const s = state({ moves: ['MOVE_FURY_ATTACK', null, null, null] }, { itemId: 'ITEM_ROCKY_HELMET' })
    const result = check(s, 'MOVE_FURY_ATTACK', 100)
    expect(result.score).toBeLessThanOrEqual(100)
  })
  it('EFFECT_FLINCH_HIT adds ShouldTryToFlinch\'s score when the AI goes first', () => {
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    const result = check(s, 'MOVE_BITE', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_SWALLOW does nothing at stockpile 0', () => {
    const s = state({ moves: ['MOVE_SWALLOW', null, null, null] })
    const result = check(s, 'MOVE_SWALLOW', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_RESTORE_HP gives +1 for Big Root regardless of ShouldRecover', () => {
    const s = state({ itemId: 'ITEM_BIG_ROOT', hp: 100, maxHp: 100 })
    const result = check(s, 'MOVE_RECOVER', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_REST\'s Hydration/rain wakeup bonus is denied when rain ends next turn (weatherDuration == 1)', () => {
    // `gWishFutureKnock.weatherDuration != 1` -- rain ending NEXT turn
    // shouldn't count as a reliable Hydration cure. Both scenarios share
    // Hydration + rain + a ShouldRecover-triggering low-HP fast attacker;
    // only weatherDuration differs, isolating that one term's own +1
    // ("hasWakeupHelp" 2 vs the bare 1).
    const fast = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 999 }, abilities: { ability: 'ABILITY_HYDRATION', innates: [null, null, null] as [string | null, string | null, string | null] } }
    const weak = { rawStats: { atk: 1, def: 90, spatk: 1, spdef: 85, spe: 1 } }
    const endingNextTurn = state({ hp: 50, maxHp: 100, ...fast }, weak, repeating(1))
    endingNextTurn.field.weather = WEATHER_RAIN_ANY
    endingNextTurn.field.weatherDuration = 1
    const stillGoing = state({ hp: 50, maxHp: 100, ...fast }, weak, repeating(1))
    stillGoing.field.weather = WEATHER_RAIN_ANY
    stillGoing.field.weatherDuration = 2
    const endingResult = check(endingNextTurn, 'MOVE_REST', 100)
    const stillGoingResult = check(stillGoing, 'MOVE_REST', 100)
    expect(stillGoingResult.score).toBe(endingResult.score + 1)
  })
  it('EFFECT_TOXIC/POISON is scored through IncreasePoisonScore', () => {
    const s = state({ moves: ['MOVE_TOXIC', null, null, null] })
    const result = check(s, 'MOVE_TOXIC', 100)
    expect(result.score).toBeGreaterThan(100)
  })
  it('EFFECT_LIGHT_SCREEN rewards +5 when the defender has a special move and no screen up', () => {
    const s = state({}, { moves: ['MOVE_EMBER', null, null, null] })
    const result = check(s, 'MOVE_LIGHT_SCREEN', 100)
    expect(result.score).toBeGreaterThanOrEqual(105)
  })
  it('EFFECT_OHKO rewards +5 under STATUS3_ALWAYS_HITS', () => {
    // No moves.json move carries EFFECT_OHKO on this snapshot (Elite Redux
    // removed OHKO moves entirely) -- a synthetic move still exercises the
    // real, reachable case directly.
    const ohko: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', effect: 'EFFECT_OHKO' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const s = state()
    s.battlers[0]!.statuses3 = STATUS3_ALWAYS_HITS
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, ohko)
    expect(result.score).toBe(105)
  })
  it('EFFECT_MEAN_LOOK (trap) is scored without exception', () => {
    const s = state({}, {}, createRandomSource(1), 0)
    const result = check(s, 'MOVE_MEAN_LOOK', 100)
    expect(result).toBeDefined()
  })
  it('EFFECT_MEAN_LOOK never scores against a Ghost-type target (B_GHOSTS_ESCAPE >= GEN_6 on this build)', () => {
    // AI_FLAG_STALL + a defender that cannot faint the AI is ShouldTrap's own
    // TRUE branch; the Ghost-type target must still score 0 (break) despite
    // that, since the Ghost-type escape-immunity check runs BEFORE ShouldTrap
    // is ever consulted.
    const stallFlag = 1 << 13 // AI_FLAG_STALL
    const normal = state({ rawStats: { atk: 100, def: 999, spatk: 80, spdef: 999, spe: 100 }, hp: 100, maxHp: 100 }, { rawStats: { atk: 1, def: 90, spatk: 1, spdef: 85, spe: 100 }, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, createRandomSource(1), stallFlag)
    const ghost = state({ rawStats: { atk: 100, def: 999, spatk: 80, spdef: 999, spe: 100 }, hp: 100, maxHp: 100 }, { rawStats: { atk: 1, def: 90, spatk: 1, spdef: 85, spe: 100 }, types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, createRandomSource(1), stallFlag)
    const normalResult = check(normal, 'MOVE_MEAN_LOOK', 100)
    const ghostResult = check(ghost, 'MOVE_MEAN_LOOK', 100)
    expect(normalResult.score).toBe(105) // ShouldTrap fires: +5
    expect(ghostResult.score).toBe(100) // Ghost-type immunity: no bonus regardless
  })
  it('EFFECT_MIST rewards +2 under AI_FLAG_SCREENER', () => {
    const s = state({}, {}, createRandomSource(1), 1 << 14) // AI_FLAG_SCREENER
    const result = check(s, 'MOVE_MIST', 100)
    expect(result.score).toBe(102)
  })
  it('EFFECT_FOCUS_ENERGY rewards Super Luck', () => {
    const s = state({ abilities: { ability: 'ABILITY_SUPER_LUCK', innates: [null, null, null] } })
    const result = check(s, 'MOVE_FOCUS_ENERGY', 100)
    expect(result.score).toBe(102)
  })
  it('EFFECT_CONFUSE_HIT gives Serene Grace a free point before scoring the confusion itself', () => {
    const withSGState = state({ abilities: { ability: 'ABILITY_SERENE_GRACE', innates: [null, null, null] } })
    const withoutSGState = state()
    const withSG = check(withSGState, 'MOVE_CONFUSION', 100)
    const without = check(withoutSGState, 'MOVE_CONFUSION', 100)
    expect(withSG.score).toBeGreaterThan(without.score)
  })
  it('EFFECT_PARALYZE is scored through IncreaseParalyzeScore', () => {
    const s = state()
    const result = check(s, 'MOVE_THUNDER_WAVE', 100)
    expect(result.score).toBeGreaterThan(100)
  })
  it('EFFECT_ATTACK_DOWN_HIT rewards Serene Grace vs a non-Contrary target', () => {
    const s = state({ abilities: { ability: 'ABILITY_SERENE_GRACE', innates: [null, null, null] } })
    const result = check(s, 'MOVE_ROCK_SMASH', 100)
    expect(result.score).toBe(102)
  })
  it('EFFECT_SPEED_DOWN_HIT penalizes -2 when the AI is already faster', () => {
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    const result = check(s, 'MOVE_ICY_WIND', 100)
    expect(result.score).toBeLessThanOrEqual(98)
  })
  it('EFFECT_SUBSTITUTE penalizes -10 when already substituted', () => {
    const withSub = state({ status2: STATUS2_SUBSTITUTE, moves: ['MOVE_SUBSTITUTE', null, null, null] })
    const withoutSub = state({ moves: ['MOVE_SUBSTITUTE', null, null, null] })
    const withResult = check(withSub, 'MOVE_SUBSTITUTE', 100)
    const withoutResult = check(withoutSub, 'MOVE_SUBSTITUTE', 100)
    expect(withResult.score).toBe(withoutResult.score - 10)
  })
  it('EFFECT_SUBSTITUTE does not penalize without an existing substitute', () => {
    const s = state({ moves: ['MOVE_SUBSTITUTE', null, null, null] })
    const result = check(s, 'MOVE_SUBSTITUTE', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_SUBSTITUTE still grants +1 when wrapped but NOT Commanded (only wrapped+Commanded together deny it)', () => {
    // `(!(status2 & (WRAPPED|ESCAPE_PREVENTION)) || !commanded) && HP > 70` --
    // this is a disjunction, so the +1 is denied ONLY when BOTH wrapped AND
    // Commanded are true at once (e.g. Dondozo commanding Tatsugiri while
    // also wrapped by something else); wrapped alone (the ordinary Wrap/Bind/
    // Fire Spin case, ~Commanded) still grants it via the restored `||
    // !commanded` term. An earlier revision of this file checked only
    // `!wrapped`, which denied the +1 for EVERY wrapped defender regardless
    // of Commanded.
    const wrappedNotCommanded = state({ hp: 100, maxHp: 100, moves: ['MOVE_SUBSTITUTE', null, null, null] }, { status2: STATUS2_WRAPPED })
    const wrappedAndCommanded = state({ hp: 100, maxHp: 100, moves: ['MOVE_SUBSTITUTE', null, null, null] }, { status2: STATUS2_WRAPPED })
    wrappedAndCommanded.battlers[1]!.statuses4 = STATUS4_COMMANDED
    const notCommandedResult = check(wrappedNotCommanded, 'MOVE_SUBSTITUTE', 100)
    const commandedResult = check(wrappedAndCommanded, 'MOVE_SUBSTITUTE', 100)
    expect(notCommandedResult.score).toBe(commandedResult.score + 1)
  })
  it('EFFECT_LEECH_SEED does not score against a Grass-type target', () => {
    const s = state({}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_LEECH_SEED', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_LEECH_SEED scores +3 (or more) against a non-Grass target with no damaging move', () => {
    const s = state({}, { moves: ['MOVE_BABY_DOLL_EYES', null, null, null] })
    const result = check(s, 'MOVE_LEECH_SEED', 100)
    expect(result.score).toBeGreaterThanOrEqual(105)
  })
  it('EFFECT_LEECH_SEED does not score against a Liquid Ooze holder', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_LIQUID_OOZE', innates: [null, null, null] } })
    const result = check(s, 'MOVE_LEECH_SEED', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_LEECH_SEED does not score against a Magic-Guard-protected target', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } })
    const result = check(s, 'MOVE_LEECH_SEED', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_LEECH_SEED scores +2 for an already-trapped target even with a damaging move', () => {
    // `!HasDamagingMove(battlerDef) || IsBattlerTrapped(battlerDef, FALSE)` --
    // a damaging moveset alone would skip the +2, but STATUS2_WRAPPED (checked
    // via isBattlerTrapped) should still grant it.
    const notTrapped = state({}, { moves: ['MOVE_TACKLE', null, null, null] })
    const trapped = state({}, { moves: ['MOVE_TACKLE', null, null, null], status2: STATUS2_WRAPPED })
    const notTrappedResult = check(notTrapped, 'MOVE_LEECH_SEED', 100)
    const trappedResult = check(trapped, 'MOVE_LEECH_SEED', 100)
    expect(notTrappedResult.score).toBe(103) // +3 only, no +2 (has a damaging move, not trapped)
    expect(trappedResult.score).toBe(105) // +3 and +2 (trapped)
  })
  it('EFFECT_DO_NOTHING never changes the score', () => {
    const s = state()
    const result = check(s, 'MOVE_CELEBRATE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_SWITCH_ARGUMENT is always a no-op for the AI (never B_SIDE_PLAYER)', () => {
    const s = state()
    const result = check(s, 'MOVE_U_TURN', 100)
    // EFFECT_HIT_ESCAPE and EFFECT_PARTING_SHOT share the same case label as
    // EFFECT_SWITCH_ARGUMENT's fallthrough target; U-Turn's own effect is
    // EFFECT_HIT_ESCAPE, so this exercises that case directly instead.
    expect(result).toBeDefined()
  })
  it('EFFECT_BATON_PASS rewards +5 when Aqua Ring/Magnet Rise/Power Trick is set, even with no raised stat', () => {
    // `shouldSwitchIfEncored` (aiShouldSwitch.ts) returns TRUE deterministically
    // when `volatiles.encoredMove` is set and the RNG's low bit is 1 -- the one
    // ShouldSwitch path this fixture set could reliably force true (Fix pass:
    // an earlier session's own EFFECT_BATON_PASS test gave up on isolating the
    // `+5` branch at all; encoredMove unblocks it). No stat is raised here, so
    // seeing +5 proves the STATUS3_AQUA_RING/MAGNET_RISE/POWER_TRICK terms this
    // fix restores are actually being read (an earlier revision of this file
    // checked only STATUS3_ROOTED, matching none of these three).
    const base = () => stateWithAttackerParty({ hp: 100, maxHp: 100 }, {}, { random16: () => 1 })
    const withAquaRing = base()
    withAquaRing.battlers[0]!.volatiles.encoredMove = 'MOVE_TACKLE'
    withAquaRing.battlers[0]!.statuses3 = STATUS3_AQUA_RING
    const withoutAnyFlag = base()
    withoutAnyFlag.battlers[0]!.volatiles.encoredMove = 'MOVE_TACKLE'
    const withResult = check(withAquaRing, 'MOVE_BATON_PASS', 100)
    const withoutResult = check(withoutAnyFlag, 'MOVE_BATON_PASS', 100)
    expect(withResult.score).toBe(105)
    expect(withoutResult.score).toBe(100)
  })
  it('EFFECT_DISABLE rewards +2 when the defender\'s last move can faint the AI', () => {
    // Both scenarios share the same moveset/HP/speed (so the unrelated
    // "player can KO a status move user" -20 pre-switch penalty, driven by
    // the defender's WHOLE moveset rather than just its last move, fires
    // identically in both) -- only `lastMove` differs, isolating EFFECT_DISABLE's
    // own +2 for "the specific move being disabled would have KO'd us".
    const canFaint = state({ hp: 1, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    canFaint.battlers[1]!.lastMove = 'MOVE_TACKLE'
    const cannotFaint = state({ hp: 1, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    cannotFaint.battlers[1]!.lastMove = null
    const canFaintResult = check(canFaint, 'MOVE_DISABLE', 100)
    const cannotFaintResult = check(cannotFaint, 'MOVE_DISABLE', 100)
    expect(canFaintResult.score).toBe(cannotFaintResult.score + 2)
  })
  it('EFFECT_ENCORE rewards +3 for an encore-encouraged last move', () => {
    const s = state()
    s.battlers[1]!.lastMove = 'MOVE_TOXIC' // EFFECT_TOXIC is encore-encouraged
    const result = check(s, 'MOVE_ENCORE', 100)
    expect(result.score).toBe(103)
  })
  it('EFFECT_ENCORE does not reward a non-encouraged last move', () => {
    const s = state()
    s.battlers[1]!.lastMove = 'MOVE_TACKLE' // EFFECT_HIT is not in the table
    const result = check(s, 'MOVE_ENCORE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_ENCORE does not reward when the defender holds Mental Herb (B_MENTAL_HERB >= GEN_5 on this build)', () => {
    const s = state({}, { itemId: 'ITEM_MENTAL_HERB' })
    s.battlers[1]!.lastMove = 'MOVE_TOXIC'
    const result = check(s, 'MOVE_ENCORE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_DISABLE does not reward when the defender holds Mental Herb', () => {
    const s = state({ hp: 1, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 1 }, itemId: 'ITEM_MENTAL_HERB' })
    s.battlers[1]!.lastMove = 'MOVE_TACKLE'
    const result = check(s, 'MOVE_DISABLE', 100)
    const control = state({ hp: 1, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 } }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    control.battlers[1]!.lastMove = 'MOVE_TACKLE'
    const controlResult = check(control, 'MOVE_DISABLE', 100)
    expect(result.score).toBe(controlResult.score - 2) // loses Disable's own +2, keeps the shared -20 baseline
  })
  it('EFFECT_PAIN_SPLIT is scored without exception', () => {
    const s = state({ hp: 100, maxHp: 100 }, { hp: 10, maxHp: 100 })
    const result = check(s, 'MOVE_PAIN_SPLIT', 100)
    expect(result).toBeDefined()
  })
  it('EFFECT_SNORE rewards +10 while asleep', () => {
    const s = state({ status1: STATUS1_SLEEP, moves: ['MOVE_SNORE', null, null, null] })
    const result = check(s, 'MOVE_SNORE', 100)
    expect(result.score).toBe(110)
  })
  it('EFFECT_LOCK_ON rewards OHKO-move synergy', () => {
    // No real EFFECT_OHKO move exists on this snapshot (see the EFFECT_OHKO
    // test above); a synthetic moveset entry exercises HasMoveEffect(EFFECT_OHKO)
    // directly.
    const withOhko: AiDamageDeps = { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC_OHKO' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC_OHKO', effect: 'EFFECT_OHKO' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
    const s = state({ moves: ['MOVE_LOCK_ON', 'MOVE_SYNTHETIC_OHKO', null, null] })
    const result = aiCheckViability(s, 0, 1, 'MOVE_LOCK_ON', 100, withOhko)
    expect(result.score).toBe(103)
  })
  it('EFFECT_DESTINY_BOND rewards +3 when the AI goes first and would otherwise faint', () => {
    // Destiny Bond's own condition (`GetWhoStrikesFirst==0 && CanTargetFaintAi`)
    // shares its second half with the pre-switch "player can KO a status move
    // user" -20 penalty, so BOTH scenarios below carry that -20; only speed
    // (who goes first) differs, isolating Destiny Bond's own +3.
    const aiFirst = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 500 }, hp: 1, maxHp: 100 }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 1 } })
    const aiSecond = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 1 }, hp: 1, maxHp: 100 }, { rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 500 } })
    const firstResult = check(aiFirst, 'MOVE_DESTINY_BOND', 100)
    const secondResult = check(aiSecond, 'MOVE_DESTINY_BOND', 100)
    expect(firstResult.score).toBe(secondResult.score + 3)
  })
  it('EFFECT_SPITE is a documented no-op (matches the C\'s own unimplemented TODO)', () => {
    const s = state()
    const result = check(s, 'MOVE_SPITE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_WISH rewards +7 when a party mon needs healing', () => {
    const s = stateWithDefenderParty()
    s.sides[1].party[0]!.hp = 10
    s.sides[1].party[0]!.maxHp = 100
    const result = check(s, 'MOVE_WISH', 100)
    expect(result.score).toBe(107)
  })
  it('EFFECT_THIEF scores +2 for a Choice item target -- canSteal is TRUE on this build (B_TRAINERS_KNOCK_OFF_ITEMS)', () => {
    // Regression test for the canSteal bug: an earlier revision of this file
    // derived canSteal from an inverted battler-side check that happened to
    // also land on `true`, then a fix attempt that set it to `false`
    // unconditionally (matching vanilla's B_TRAINERS_KNOCK_OFF_ITEMS default)
    // would ALSO be wrong for this specific pinned build, where
    // B_TRAINERS_KNOCK_OFF_ITEMS is TRUE (battle_config.h:103) and makes
    // canSteal always true regardless of battler side. Choice Band -> +2.
    const s = state({ itemId: null }, { itemId: 'ITEM_CHOICE_BAND' })
    const result = check(s, 'MOVE_THIEF', 100)
    expect(result.score).toBe(102)
  })
  it('EFFECT_THIEF does not score when the attacker already holds an item', () => {
    const s = state({ itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_CHOICE_BAND' })
    const result = check(s, 'MOVE_THIEF', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_NIGHTMARE rewards +5 against a sleeping target', () => {
    const s = state({}, { status1: STATUS1_SLEEP })
    const result = check(s, 'MOVE_NIGHTMARE', 100)
    expect(result.score).toBeGreaterThanOrEqual(105)
  })
  it('EFFECT_CURSE (Ghost) rewards a stat boost when the defender is not trapped', () => {
    const s = state({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_CURSE', 100)
    expect(result.score).toBe(101)
  })
  it('EFFECT_CURSE (non-Ghost) raises Attack by the stage deficit', () => {
    const s = state({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_CURSE', 100)
    expect(result.score).toBeGreaterThan(100)
  })
  it('EFFECT_CURSE (non-Ghost, Magic-Guard DEFENDER) is a no-op quirk, reproduced not fixed', () => {
    const s = state({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } })
    const result = check(s, 'MOVE_CURSE', 100)
    expect(result.score).toBe(100)
  })
  it('EFFECT_PROTECT is scored through ProtectChecks (RNG-driven when uses==0)', () => {
    const s = state({}, {}, repeating(RNG_LOW))
    const result = check(s, 'MOVE_PROTECT', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_PROTECT penalizes repeated uses', () => {
    const s = state()
    s.battlers[0]!.volatiles.protectUses = 3
    const result = check(s, 'MOVE_PROTECT', 100)
    expect(result.score).toBeLessThan(100)
  })
  it('EFFECT_ENDURE rewards +3 with a pinch berry when the target could KO', () => {
    const s = state({ hp: 100, maxHp: 100, itemId: 'ITEM_LIECHI_BERRY', rawStats: { atk: 100, def: 1, spatk: 80, spdef: 1, spe: 1 } }, { rawStats: { atk: 999, def: 90, spatk: 80, spdef: 85, spe: 999 } })
    const result = check(s, 'MOVE_ENDURE', 100)
    expect(result).toBeDefined()
  })
  it('EFFECT_STEALTH_ROCK rewards +2 on the AI\'s own first turn', () => {
    const s = stateWithDefenderParty()
    const result = check(s, 'MOVE_STEALTH_ROCK', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_FORESIGHT rewards +2 against a raised-evasion Ghost target hittable by Normal/Fighting', () => {
    const s = state({ moves: ['MOVE_FORESIGHT', null, null, null] }, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_FORESIGHT', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_MIRACLE_EYE rewards +2 against a raised-evasion Dark target hittable by Psychic', () => {
    const s = state({ moves: ['MOVE_PSYCHIC', 'MOVE_MIRACLE_EYE', null, null] }, { types: ['DARK', 'MYSTERY', 'MYSTERY'] })
    const result = check(s, 'MOVE_MIRACLE_EYE', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
  it('EFFECT_PERISH_SONG rewards +3 when the target is trapped', () => {
    const s = state({}, { status2: STATUS2_WRAPPED })
    const result = check(s, 'MOVE_PERISH_SONG', 100)
    expect(result.score).toBeGreaterThanOrEqual(100)
  })
})

describe('RNG order -- scripted draws land in the correct sequence', () => {
  it('draws the always-hits AI_RandLessThan(100) before the high-crit AI_RandLessThan(128) when both branches are live', () => {
    // First draw feeds the always-hits check (line :2532); second feeds the
    // high-crit check (line :2536). Scripting [false, true] proves the ORDER,
    // not just that both fire -- swapping them would flip which one scores.
    // High attacker speed keeps the unrelated "already dead" pre-switch check
    // (itself gated on GetWhoStrikesFirst) from adding its own +-1 alongside
    // the two draws under test here.
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 999 } }, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, scripted(RNG_HIGH, RNG_LOW))
    s.battlers[1]!.mon.statStages[7] = 10 // STAT_EVASION >= 10 -- satisfies the unconditional (non-RNG) always-hits stat gate
    const noAccHighCrit: AiDamageDeps = {
      ...deps,
      moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC', crit: 'HIGH', type: 'WATER' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined),
      dataContext: { ...dataContext, move: (id) => (id === 'MOVE_SYNTHETIC' ? { id, power: 40, type: 'WATER', split: 'PHYSICAL', effect: 'EFFECT_HIT', priority: 0, flags: {}, accuracy: 0, argumentInt: null } : dataContext.move(id)) },
    }
    const result = aiCheckViability(s, 0, 1, 'MOVE_SYNTHETIC', 100, noAccHighCrit)
    // always-hits stat gate alone gives +1 unconditionally; RNG_HIGH means the
    // always-hits AI_RandLessThan(100) branch is FALSE (no second +1), and
    // RNG_LOW means the high-crit AI_RandLessThan(128) branch is TRUE (+1).
    expect(result.score).toBe(102)
  })
})

describe('AI_CheckViability wired into chooseAiAction/chooseMoveOrActionSingles', () => {
  it('prefers a move that CheckViability boosts over a neutral one', () => {
    const s = state({ moves: ['MOVE_TACKLE', 'MOVE_TOXIC', null, null], pp: [35, 15, 0, 0] }, {}, createRandomSource(1), AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_BAD_MOVE)
    const scores: [number, number, number, number] = [100, 130, 0, 0] // MOVE_TOXIC pre-boosted to simulate CheckViability's own IncreasePoisonScore result
    const { choice } = chooseMoveOrActionSingles(s, 0, scores, deps)
    expect(choice).toEqual({ kind: 'move', moveIndex: 1 })
  })
})

// ---------------------------------------------------------------------------
// Part 2a (battle_ai_main.c:3224-3606)
// ---------------------------------------------------------------------------

/** Verify every id/effect the part-2a tests lean on, at module load. */
const REQUIRED_2A_MOVES: Record<string, string> = {
  MOVE_SANDSTORM: 'EFFECT_SANDSTORM', MOVE_HAIL: 'EFFECT_HAIL', MOVE_RAIN_DANCE: 'EFFECT_RAIN_DANCE', MOVE_SUNNY_DAY: 'EFFECT_SUNNY_DAY',
  MOVE_EERIE_FOG: 'EFFECT_EERIE_FOG', MOVE_SYNTHESIS: 'EFFECT_SYNTHESIS', MOVE_MORNING_SUN: 'EFFECT_MORNING_SUN', MOVE_MOONLIGHT: 'EFFECT_MOONLIGHT',
  MOVE_SHORE_UP: 'EFFECT_SHORE_UP', MOVE_WEATHER_BALL: 'EFFECT_WEATHER_BALL', MOVE_AURORA_VEIL: 'EFFECT_AURORA_VEIL', MOVE_THUNDER: 'EFFECT_THUNDER',
  MOVE_HURRICANE: 'EFFECT_HURRICANE', MOVE_SOLAR_BEAM: 'EFFECT_SOLARBEAM', MOVE_GROWTH: 'EFFECT_GROWTH',
}
for (const [id, effect] of Object.entries(REQUIRED_2A_MOVES)) {
  if (moveById.get(id)?.effect !== effect) throw new Error(`${id} is no longer ${effect}`)
}
for (const id of ['MOVE_BLIZZARD', 'MOVE_OMINOUS_WIND', 'MOVE_EMBER', 'MOVE_WATER_GUN', 'MOVE_SURF']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
for (const id of ['ITEM_SAFETY_GOGGLES', 'ITEM_SMOOTH_ROCK', 'ITEM_ICY_ROCK', 'ITEM_DAMP_ROCK', 'ITEM_HEAT_ROCK']) {
  if (!itemsById.has(id)) throw new Error(`items.json is missing ${id}`)
}
for (const id of ['ABILITY_CLOUD_NINE', 'ABILITY_AIR_LOCK', 'ABILITY_CLUELESS', 'ABILITY_MAGIC_GUARD', 'ABILITY_CHLOROPLAST', 'ABILITY_AURORA_BOREALIS', 'ABILITY_SAND_VEIL']) {
  if (!abilityHooks[id]) throw new Error(`abilityHooks.json is missing ${id}`)
}

const ab = (id: string | null, innates: [string | null, string | null, string | null] = [null, null, null]) => ({ ability: id, innates })
const setWeather = (s: BattleState, w: number) => {
  s.field.weather = w
  return s
}

describe('AI ability rating table (sAiAbilityRatings, battle_ai_util.c:30-300)', () => {
  it('has 268 designated entries, every one an ability id in abilities.json', () => {
    const ids = new Set(read<Array<{ id: string }>>('abilities.json').map((a) => a.id))
    const keys = Object.keys(AI_ABILITY_RATINGS)
    expect(keys.length).toBe(268)
    expect(keys.filter((k) => !ids.has(k))).toEqual([])
  })
  it('spot values incl. negatives and the commented-out ABILITY_PORTAL_POWER (absent -> 0)', () => {
    expect(getAbilityRating('ABILITY_ADAPTABILITY')).toBe(8)
    expect(getAbilityRating('ABILITY_DEFEATIST')).toBe(-1)
    expect(getAbilityRating('ABILITY_DELTA_STREAM')).toBe(10)
    expect(getAbilityRating('ABILITY_PORTAL_POWER')).toBe(0)
    expect(getAbilityRating(null)).toBe(0)
  })
  it('IsAbilityOfRating is >=, not >', () => {
    expect(isAbilityOfRating('ABILITY_ANALYTIC', 5)).toBe(true) // exactly 5
    expect(isAbilityOfRating('ABILITY_ANGER_POINT', 5)).toBe(false) // 4
  })
  it('RIPEN_ABILITIES matches bitfields.ripen exactly', () => {
    const expected = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.ripen).map(([k]) => k).sort()
    expect([...RIPEN_ABILITIES].sort()).toEqual(expected)
  })
})

describe('EFFECT_SANDSTORM (:3224-3231)', () => {
  const sand = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, weather = 0) => check(setWeather(state(a, d), weather), 'MOVE_SANDSTORM')
  it('scores 0 when the attacker takes sandstorm damage and has no reason to want it', () => {
    expect(sand().score).toBe(100)
  })
  it.each(['ROCK', 'GROUND', 'STEEL'])('scores +1 for a %s-type attacker (IsSandImmune type clause)', (type) => {
    expect(sand({ types: [type, 'MYSTERY', 'MYSTERY'] }).score).toBe(101)
  })
  it('scores +1 for Safety Goggles, Magic Guard, and being underground', () => {
    expect(sand({ itemId: 'ITEM_SAFETY_GOGGLES' }).score).toBe(101)
    expect(sand({ abilities: ab('ABILITY_MAGIC_GUARD') }).score).toBe(101)
    const s = state()
    s.battlers[0]!.statuses3 |= STATUS3_UNDERGROUND
    expect(check(s, 'MOVE_SANDSTORM').score).toBe(101)
  })
  it('every ability with bitfields.sandImmune makes the attacker want sand; a non-listed ability does not', () => {
    const list = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.sandImmune).map(([k]) => k)
    expect(list.length).toBe(14)
    for (const id of list) expect(sand({ abilities: ab(id) }).score, id).toBe(101)
    expect(sand({ abilities: ab('ABILITY_BLAZE') }).score).toBe(100)
  })
  it('Shore Up and Weather Ball each make it +1; Chloroplast or Aurora Borealis cancels only Weather Ball', () => {
    expect(sand({ moves: ['MOVE_SHORE_UP', null, null, null] }).score).toBe(101)
    expect(sand({ moves: ['MOVE_WEATHER_BALL', null, null, null] }).score).toBe(101)
    expect(sand({ moves: ['MOVE_WEATHER_BALL', null, null, null], abilities: ab('ABILITY_CHLOROPLAST') }).score).toBe(100)
    expect(sand({ moves: ['MOVE_WEATHER_BALL', null, null, null], abilities: ab('ABILITY_AURORA_BOREALIS') }).score).toBe(100)
    expect(sand({ moves: ['MOVE_SHORE_UP', null, null, null], abilities: ab('ABILITY_CHLOROPLAST') }).score).toBe(101)
  })
  it('scores 0 when sandstorm or a primal weather is already up, or weather has no effect', () => {
    const rock = { types: ['ROCK', 'MYSTERY', 'MYSTERY'] as [string, string, string] }
    expect(sand(rock, {}, WEATHER_SANDSTORM_TEMPORARY).score).toBe(100)
    expect(sand(rock, {}, WEATHER_RAIN_PRIMAL).score).toBe(100)
    expect(sand(rock, { abilities: ab('ABILITY_CLOUD_NINE') }).score).toBe(100)
    expect(sand(rock, { abilities: ab('ABILITY_AIR_LOCK') }).score).toBe(100)
    // Clueless is a caller-supplied fact on the grounding context (weatherHasEffect), not an ability scan.
    const clueless: AiDamageDeps = { ...deps, grounding: { ...grounding, isCluelessOnField: true } }
    expect(aiCheckViability(state(rock), 0, 1, 'MOVE_SANDSTORM', 100, clueless).score).toBe(100)
    const s = state(rock)
    s.field.timers.clearSkiesTimer = 3
    expect(check(s, 'MOVE_SANDSTORM').score).toBe(100)
  })
  it('Smooth Rock adds +1 only inside the branch, and reports the holdEffects[] quirk', () => {
    const rock = { types: ['ROCK', 'MYSTERY', 'MYSTERY'] as [string, string, string] }
    const withRock = check(state({ ...rock, itemId: 'ITEM_SMOOTH_ROCK' }), 'MOVE_SANDSTORM')
    expect(withRock.score).toBe(102)
    expect(withRock.unmodelled.some((u) => u.includes('ItemId_GetHoldEffectParam'))).toBe(true)
    expect(sand({ itemId: 'ITEM_SMOOTH_ROCK' }).score).toBe(100)
  })
  it.each(['MOVE_SYNTHESIS', 'MOVE_MORNING_SUN', 'MOVE_MOONLIGHT'])('a defender with %s adds +2 inside the branch only', (heal) => {
    const rock = { types: ['ROCK', 'MYSTERY', 'MYSTERY'] as [string, string, string] }
    expect(sand(rock, { moves: [heal, null, null, null] }).score).toBe(103)
    expect(sand({}, { moves: [heal, null, null, null] }).score).toBe(100)
  })
})

describe('EFFECT_HAIL (:3232-3243)', () => {
  const hail = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, weather = 0) => check(setWeather(state(a, d), weather), 'MOVE_HAIL')
  const ice = { types: ['ICE', 'MYSTERY', 'MYSTERY'] as [string, string, string] }
  it('scores 0 for a non-immune attacker with no hail synergy', () => {
    expect(hail().score).toBe(100)
  })
  it('scores +1 for an Ice-type attacker, and Icy Rock adds +1 only inside the branch', () => {
    expect(hail(ice).score).toBe(101)
    expect(hail({ ...ice, itemId: 'ITEM_ICY_ROCK' }).score).toBe(102)
    expect(hail({ itemId: 'ITEM_ICY_ROCK' }).score).toBe(100)
  })
  it('every ability with bitfields.hailImmune makes the attacker want hail; a non-listed ability does not', () => {
    const list = Object.entries(abilityHooks).filter(([, v]) => v.bitfields?.hailImmune).map(([k]) => k)
    expect(list.length).toBe(17)
    for (const id of list) expect(hail({ abilities: ab(id) }).score >= 101, id).toBe(true)
    expect(hail({ abilities: ab('ABILITY_BLAZE') }).score).toBe(100)
  })
  it('Blizzard and Aurora Veil make it +1; Weather Ball too unless Chloroplast', () => {
    expect(hail({ moves: ['MOVE_BLIZZARD', null, null, null] }).score).toBe(101)
    expect(hail({ moves: ['MOVE_AURORA_VEIL', null, null, null] }).score).toBe(101)
    expect(hail({ moves: ['MOVE_WEATHER_BALL', null, null, null] }).score).toBe(101)
    expect(hail({ moves: ['MOVE_WEATHER_BALL', null, null, null], abilities: ab('ABILITY_CHLOROPLAST') }).score).toBe(100)
  })
  it('Aurora Veil earns the extra +3 only when ShouldSetScreen(AURORA_VEIL) holds (Aurora Borealis, no screen up)', () => {
    const veil = { moves: ['MOVE_AURORA_VEIL', null, null, null] as SimBattleMon['moves'] }
    expect(hail({ ...veil, abilities: ab('ABILITY_AURORA_BOREALIS') }).score).toBe(104)
    const withReflect = state({ ...veil, abilities: ab('ABILITY_AURORA_BOREALIS') })
    withReflect.sides[0].statuses |= SIDE_STATUS_REFLECT
    expect(check(withReflect, 'MOVE_HAIL').score).toBe(101)
  })
  it('scores 0 when hail or a primal weather is up, or weather has no effect', () => {
    expect(hail(ice, {}, WEATHER_HAIL_TEMPORARY).score).toBe(100)
    expect(hail(ice, {}, WEATHER_RAIN_PRIMAL).score).toBe(100)
    expect(hail(ice, { abilities: ab('ABILITY_CLOUD_NINE') }).score).toBe(100)
  })
  it.each(['MOVE_SYNTHESIS', 'MOVE_MORNING_SUN', 'MOVE_MOONLIGHT'])('a defender with %s adds +2 inside the branch only', (heal) => {
    expect(hail(ice, { moves: [heal, null, null, null] }).score).toBe(103)
    expect(hail({}, { moves: [heal, null, null, null] }).score).toBe(100)
  })
})

describe('EFFECT_RAIN_DANCE (:3244-3252)', () => {
  const rain = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, weather = 0) => check(setWeather(state(a, d), weather), 'MOVE_RAIN_DANCE')
  it('scores 0 with nothing that wants rain', () => {
    expect(rain().score).toBe(100)
  })
  it.each(['ABILITY_SWIFT_SWIM', 'ABILITY_FORECAST', 'ABILITY_HYDRATION', 'ABILITY_RAIN_DISH', 'ABILITY_DRY_SKIN'])('%s wants rain (+1)', (id) => {
    expect(rain({ abilities: ab(id) }).score).toBe(101)
  })
  it('Thunder, Hurricane, a Water move, and Weather Ball each want rain (+1)', () => {
    expect(rain({ moves: ['MOVE_THUNDER', null, null, null] }).score).toBe(101)
    expect(rain({ moves: ['MOVE_HURRICANE', null, null, null] }).score).toBe(101)
    expect(rain({ moves: ['MOVE_WATER_GUN', null, null, null] }).score).toBe(101)
    expect(rain({ moves: ['MOVE_WEATHER_BALL', null, null, null] }).score).toBe(101)
    expect(rain({ moves: ['MOVE_WEATHER_BALL', null, null, null], abilities: ab('ABILITY_AURORA_BOREALIS') }).score).toBe(100)
  })
  it('Damp Rock (+1), a defender Fire move (+1) and defender healing (+2) stack inside the branch only', () => {
    const wet = { abilities: ab('ABILITY_SWIFT_SWIM') }
    expect(rain({ ...wet, itemId: 'ITEM_DAMP_ROCK' }).score).toBe(102)
    expect(rain(wet, { moves: ['MOVE_EMBER', null, null, null] }).score).toBe(102)
    expect(rain(wet, { moves: ['MOVE_SYNTHESIS', null, null, null] }).score).toBe(103)
    expect(rain({}, { moves: ['MOVE_EMBER', null, null, null] }).score).toBe(100)
    expect(rain({ itemId: 'ITEM_DAMP_ROCK' }).score).toBe(100)
  })
  it('scores 0 when rain or a primal weather is already up', () => {
    expect(rain({ abilities: ab('ABILITY_SWIFT_SWIM') }, {}, WEATHER_RAIN_TEMPORARY).score).toBe(100)
    expect(rain({ abilities: ab('ABILITY_SWIFT_SWIM') }, {}, WEATHER_RAIN_PRIMAL).score).toBe(100)
  })
})

describe('EFFECT_SUNNY_DAY (:3253-3260)', () => {
  const sun = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, weather = 0) => check(setWeather(state(a, d), weather), 'MOVE_SUNNY_DAY')
  it('scores 0 with nothing that wants sun', () => {
    expect(sun().score).toBe(100)
  })
  it.each(['ABILITY_CHLOROPHYLL', 'ABILITY_FLOWER_GIFT', 'ABILITY_FORECAST', 'ABILITY_LEAF_GUARD', 'ABILITY_SOLAR_POWER', 'ABILITY_HARVEST'])('%s wants sun (+1)', (id) => {
    expect(sun({ abilities: ab(id) }).score).toBe(101)
  })
  it('a Fire move, Weather Ball, and each sun-dependent move want sun (+1)', () => {
    expect(sun({ moves: ['MOVE_EMBER', null, null, null] }).score).toBe(101)
    expect(sun({ moves: ['MOVE_WEATHER_BALL', null, null, null] }).score).toBe(101)
    for (const m of ['MOVE_SOLAR_BEAM', 'MOVE_MORNING_SUN', 'MOVE_SYNTHESIS', 'MOVE_MOONLIGHT', 'MOVE_GROWTH']) {
      expect(sun({ moves: [m, null, null, null] }).score, m).toBe(101)
    }
  })
  it('Chloroplast-family abilities cancel the sun-dependent-move clause but not a Fire move', () => {
    for (const id of ['ABILITY_BIG_LEAVES', 'ABILITY_CHLOROPLAST', 'ABILITY_SOLAR_FLARE']) {
      expect(sun({ moves: ['MOVE_SOLAR_BEAM', null, null, null], abilities: ab(id) }).score, id).toBe(100)
      expect(sun({ moves: ['MOVE_EMBER', null, null, null], abilities: ab(id) }).score, id).toBe(101)
    }
  })
  it('Heat Rock (+1), defender Water move (+1) and defender Thunder (+1) stack inside the branch only', () => {
    const bright = { abilities: ab('ABILITY_CHLOROPHYLL') }
    expect(sun({ ...bright, itemId: 'ITEM_HEAT_ROCK' }).score).toBe(102)
    expect(sun(bright, { moves: ['MOVE_WATER_GUN', null, null, null] }).score).toBe(102)
    expect(sun(bright, { moves: ['MOVE_THUNDER', null, null, null] }).score).toBe(102)
    expect(sun({}, { moves: ['MOVE_WATER_GUN', null, null, null] }).score).toBe(100)
    expect(sun({ itemId: 'ITEM_HEAT_ROCK' }).score).toBe(100)
  })
  it('scores 0 when sun is already up', () => {
    expect(sun({ abilities: ab('ABILITY_CHLOROPHYLL') }, {}, WEATHER_SUN_TEMPORARY).score).toBe(100)
  })
})

describe('EFFECT_EERIE_FOG (:3261-3265)', () => {
  const fog = (a: Partial<SimBattleMon> = {}, weather = 0) => check(setWeather(state(a), weather), 'MOVE_EERIE_FOG')
  const ghost = { types: ['GHOST', 'MYSTERY', 'MYSTERY'] as [string, string, string] }
  it('scores 0 with nothing that wants fog', () => {
    expect(fog().score).toBe(100)
  })
  it('a Ghost-type attacker wants fog, unless it is Trick-or-Treated', () => {
    expect(fog(ghost).score).toBe(101)
    const s = state(ghost)
    s.battlers[0]!.volatiles.trickOrTreat = true
    expect(check(s, 'MOVE_EERIE_FOG').score).toBe(100)
  })
  it('Ominous Wind and each of the five fog abilities want fog (+1)', () => {
    expect(fog({ moves: ['MOVE_OMINOUS_WIND', null, null, null] }).score).toBe(101)
    for (const id of ['ABILITY_ECTOPLASM', 'ABILITY_ETHEREAL_RUSH', 'ABILITY_WHITE_NOISE', 'ABILITY_PEACEFUL_REST', 'ABILITY_SURPRISE']) {
      expect(fog({ abilities: ab(id) }).score, id).toBe(101)
    }
  })
  it('scores 0 when fog is already up', () => {
    expect(fog(ghost, WEATHER_FOG_TEMPORARY).score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Part 2a -- stat-boost / status / field-condition cases (differential tests)
// ---------------------------------------------------------------------------

/** Deps in which `id` keeps its real data except for the given overrides. */
function depsOverride(id: string, over: Partial<MoveData>): AiDamageDeps {
  return { ...deps, moveData: (m) => (m === id ? ({ ...toMoveData(id), ...over } as MoveData) : moveById.has(m) ? toMoveData(m) : undefined) }
}
/** What the case body itself contributes for a REAL move: the real score minus the score of the very same move with its effect replaced by EFFECT_HIT, on an identically built state. Pre-switch terms cancel. */
function effectDelta(mk: () => BattleState, moveId: string): number {
  const real = aiCheckViability(mk(), 0, 1, moveId, 100, deps).score
  const plain = aiCheckViability(mk(), 0, 1, moveId, 100, depsOverride(moveId, { effect: 'EFFECT_HIT' })).score
  return real - plain
}
/** Same, for an effect no real move carries: a synthetic move, with EFFECT_HIT as the baseline. */
function synDelta(mk: () => BattleState, effect: string, extra: Partial<MoveData> = {}): number {
  const real = aiCheckViability(mk(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(effect, extra)).score
  const plain = aiCheckViability(mk(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_HIT', extra)).score
  return real - plain
}
const mkState = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, tweak: (s: BattleState) => void = () => {}, aiFlags = 0) => () => {
  const s = state(a, d, repeating(RNG_HIGH), aiFlags)
  tweak(s)
  return s
}
const FAST = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } }
const SLOW = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 } }
const moves = (...m: string[]) => ({ moves: [m[0] ?? null, m[1] ?? null, m[2] ?? null, m[3] ?? null] as SimBattleMon['moves'] })
const stage = (s: BattleState, battler: number, statIdx: number, value: number) => {
  s.battlers[battler]!.mon.statStages[statIdx] = value
}

for (const id of ['MOVE_FELL_STINGER', 'MOVE_BELLY_DRUM', 'MOVE_PSYCH_UP', 'MOVE_SPECTRAL_THIEF', 'MOVE_DIG', 'MOVE_DEFENSE_CURL', 'MOVE_FAKE_OUT', 'MOVE_STOCKPILE', 'MOVE_ROLLOUT', 'MOVE_SWAGGER', 'MOVE_FLATTER', 'MOVE_ATTRACT', 'MOVE_SAFEGUARD', 'MOVE_PURSUIT', 'MOVE_RAPID_SPIN', 'MOVE_DEFOG', 'MOVE_SQUALL_HAMMER', 'MOVE_TORMENT', 'MOVE_WILL_O_WISP', 'MOVE_FOLLOW_ME', 'MOVE_CHARGE', 'MOVE_TAUNT', 'MOVE_FIRST_IMPRESSION', 'MOVE_ASTONISH', 'MOVE_HEX', 'MOVE_THUNDER_WAVE', 'MOVE_SWORDS_DANCE']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}

describe('EFFECT_ATTACK_UP_HIT (:3266-3268)', () => {
  it('scores the Attack raise only for a Serene Grace attacker (+2: Physical move, HP > 40%, stage < 8)', () => {
    expect(synDelta(mkState({ abilities: ab('ABILITY_SERENE_GRACE') }), 'EFFECT_ATTACK_UP_HIT')).toBe(2)
    expect(synDelta(mkState(), 'EFFECT_ATTACK_UP_HIT')).toBe(0)
  })
  it('Foul Play adds +1; Contrary or a Special-only moveset removes it', () => {
    expect(synDelta(mkState({ abilities: ab('ABILITY_SERENE_GRACE'), ...moves('MOVE_TACKLE', 'MOVE_FOUL_PLAY') }), 'EFFECT_ATTACK_UP_HIT')).toBe(3)
    expect(synDelta(mkState({ abilities: ab('ABILITY_SERENE_GRACE'), ...moves('MOVE_WATER_GUN') }), 'EFFECT_ATTACK_UP_HIT')).toBe(0)
    expect(synDelta(mkState({ abilities: ab('ABILITY_SERENE_GRACE', ['ABILITY_CONTRARY', null, null]) }), 'EFFECT_ATTACK_UP_HIT')).toBe(0)
  })
})

describe('EFFECT_FELL_STINGER (:3269-3277)', () => {
  const kill = (d: Partial<SimBattleMon> = {}) => ({ hp: 1, ...d })
  it('scores +9 when the attacker goes first and the move KOs, +3 when the target goes first', () => {
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_FELL_STINGER') }, kill()), 'MOVE_FELL_STINGER')).toBe(9)
    expect(effectDelta(mkState({ ...SLOW, ...moves('MOVE_FELL_STINGER') }, kill()), 'MOVE_FELL_STINGER')).toBe(3)
  })
  it('scores 0 without a KO, at max Attack, or with Contrary', () => {
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_FELL_STINGER') }), 'MOVE_FELL_STINGER')).toBe(0)
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_FELL_STINGER') }, kill(), (s) => stage(s, 0, 1, 12)), 'MOVE_FELL_STINGER')).toBe(0)
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_FELL_STINGER'), abilities: ab('ABILITY_CONTRARY') }, kill()), 'MOVE_FELL_STINGER')).toBe(0)
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_FELL_STINGER') }, kill(), (s) => stage(s, 0, 1, 11)), 'MOVE_FELL_STINGER')).toBe(9)
  })
})

describe('EFFECT_BELLY_DRUM (:3278-3282)', () => {
  it('scores MAX_STAT_STAGE minus the current Attack stage', () => {
    expect(effectDelta(mkState(), 'MOVE_BELLY_DRUM')).toBe(6)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 0, 1, 9)), 'MOVE_BELLY_DRUM')).toBe(3)
  })
  it('scores 0 with Contrary, with no Physical move, or when the target can KO the attacker', () => {
    expect(effectDelta(mkState({ abilities: ab('ABILITY_CONTRARY') }), 'MOVE_BELLY_DRUM')).toBe(0)
    expect(effectDelta(mkState(moves('MOVE_WATER_GUN')), 'MOVE_BELLY_DRUM')).toBe(0)
    expect(effectDelta(mkState({ hp: 1 }), 'MOVE_BELLY_DRUM')).toBe(0)
  })
})

describe('EFFECT_PSYCH_UP / EFFECT_SPECTRAL_THIEF (:3283-3307)', () => {
  const raised = (statIdx: number, a: Partial<SimBattleMon> = {}, aiFlags = 0) => mkState(a, {}, (s) => stage(s, 1, statIdx, 7), aiFlags)
  for (const id of ['MOVE_PSYCH_UP', 'MOVE_SPECTRAL_THIEF']) {
    it(`${id}: Attack counts with a Physical move, Sp.Atk with a Special move`, () => {
      expect(effectDelta(raised(1), id)).toBe(1)
      expect(effectDelta(raised(1, moves('MOVE_WATER_GUN')), id)).toBe(0)
      expect(effectDelta(raised(4, moves('MOVE_WATER_GUN')), id)).toBe(1)
      expect(effectDelta(raised(4), id)).toBe(0)
    })
    it(`${id}: Speed, Accuracy and Evasion always count`, () => {
      for (const idx of [3, 6, 7]) expect(effectDelta(raised(idx), id), `stat ${idx}`).toBe(1)
    })
    it(`${id}: Defense and Sp.Def count only under AI_FLAG_STALL (inline read)`, () => {
      for (const idx of [2, 5]) {
        expect(effectDelta(raised(idx), id), `stat ${idx} flag off`).toBe(0)
        expect(effectDelta(raised(idx, {}, AI_FLAG_STALL), id), `stat ${idx} flag on`).toBe(1)
      }
    })
    it(`${id}: a stat the target has NOT raised above the attacker's own does not count`, () => {
      const mk = mkState({}, {}, (s) => { stage(s, 1, 3, 7); stage(s, 0, 3, 7) })
      expect(effectDelta(mk, id)).toBe(0)
    })
    it(`${id}: stats stack`, () => {
      const mk = mkState({}, {}, (s) => { stage(s, 1, 1, 7); stage(s, 1, 3, 7); stage(s, 1, 7, 7) })
      expect(effectDelta(mk, id)).toBe(3)
    })
  }
})

describe('EFFECT_SEMI_INVULNERABLE (:3308-3318)', () => {
  const dig = (a: Partial<SimBattleMon>, lastMove: string | null, tweak: (s: BattleState) => void = () => {}) => mkState(a, {}, (s) => { s.battlers[1]!.lastMove = lastMove; tweak(s) })
  it('always scores +1', () => {
    expect(effectDelta(dig(FAST, null), 'MOVE_DIG')).toBe(1)
  })
  it('attacker first: +3 more if the predicted move is an Explosion or Protect effect, not otherwise', () => {
    expect(effectDelta(dig(FAST, 'MOVE_EXPLOSION'), 'MOVE_DIG')).toBe(4)
    expect(effectDelta(dig(FAST, 'MOVE_PROTECT'), 'MOVE_DIG')).toBe(4)
    expect(effectDelta(dig(FAST, 'MOVE_TACKLE'), 'MOVE_DIG')).toBe(1)
  })
  it('attacker second: +3 more if the predicted move is semi-invulnerable and the target is not already semi-invulnerable', () => {
    expect(effectDelta(dig(SLOW, 'MOVE_DIG'), 'MOVE_DIG')).toBe(4)
    expect(effectDelta(dig(SLOW, 'MOVE_DIG', (s) => { s.battlers[1]!.statuses3 |= STATUS3_UNDERGROUND }), 'MOVE_DIG')).toBe(1)
    expect(effectDelta(dig(SLOW, 'MOVE_EXPLOSION'), 'MOVE_DIG')).toBe(1) // the "attacker first" list does not apply when second
  })
})

describe('EFFECT_DEFENSE_CURL (:3319-3322)', () => {
  it('scores +1 for Rollout in the moveset (no curl yet) plus the Defense raise (+2 vs a Physical foe)', () => {
    expect(effectDelta(mkState(moves('MOVE_ROLLOUT')), 'MOVE_DEFENSE_CURL')).toBe(3)
    expect(effectDelta(mkState(), 'MOVE_DEFENSE_CURL')).toBe(2)
  })
  it('the Rollout bonus needs the curl NOT already set; the Defense raise needs a Physical foe', () => {
    expect(effectDelta(mkState({ ...moves('MOVE_ROLLOUT'), status2: STATUS2_DEFENSE_CURL }), 'MOVE_DEFENSE_CURL')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_ROLLOUT'), moves('MOVE_WATER_GUN')), 'MOVE_DEFENSE_CURL')).toBe(1)
  })
})

describe('EFFECT_FAKE_OUT (:3323-3327)', () => {
  const fo = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, tweak: (s: BattleState) => void = () => {}) => mkState({ ...FAST, ...a }, d, tweak)
  it('scores +16 on the first turn out when the target cannot be pre-empted', () => {
    expect(effectDelta(fo(), 'MOVE_FAKE_OUT')).toBe(16)
  })
  it('scores 0 for First Impression and Astonish, which share the effect (the `move == MOVE_FAKE_OUT` filter)', () => {
    expect(effectDelta(fo(), 'MOVE_FIRST_IMPRESSION')).toBe(0)
    expect(effectDelta(fo(), 'MOVE_ASTONISH')).toBe(0)
  })
  it('scores 0 after the first turn (isFirstTurn == 0)', () => {
    expect(effectDelta(fo({}, {}, (s) => { s.battlers[0]!.volatiles.isFirstTurn = 0 }), 'MOVE_FAKE_OUT')).toBe(0)
  })
  it('scores 0 when the target moves first (ShouldTryToFlinch: opponent goes first)', () => {
    expect(effectDelta(mkState({ ...SLOW }), 'MOVE_FAKE_OUT'), 'slow attacker').toBe(0)
  })
  it('scores 0 into a Substitute, and against a sleeper without Snore or Sleep Talk', () => {
    expect(effectDelta(fo({}, { status2: STATUS2_SUBSTITUTE }), 'MOVE_FAKE_OUT')).toBe(0)
    expect(effectDelta(fo({}, { status1: 3 }), 'MOVE_FAKE_OUT')).toBe(0)
  })
  it('a Choice Band holder with nothing to switch to does not lock itself into Fake Out', () => {
    expect(effectDelta(fo({ itemId: 'ITEM_CHOICE_BAND' }), 'MOVE_FAKE_OUT')).toBe(0)
    const withParty = () => {
      const s = stateWithAttackerParty({ ...FAST, itemId: 'ITEM_CHOICE_BAND' }, {}, repeating(RNG_HIGH))
      return s
    }
    expect(effectDelta(withParty, 'MOVE_FAKE_OUT')).toBe(16)
  })
})

describe('EFFECT_STOCKPILE / EFFECT_ROLLOUT (:3328-3337)', () => {
  it('Stockpile: Defense (+2 vs a Physical foe) and Sp.Def (+2 vs a Special foe), +2 for Swallow/Spit Up', () => {
    expect(effectDelta(mkState(), 'MOVE_STOCKPILE')).toBe(2)
    expect(effectDelta(mkState({}, moves('MOVE_TACKLE', 'MOVE_WATER_GUN')), 'MOVE_STOCKPILE')).toBe(4)
    expect(effectDelta(mkState(moves('MOVE_SWALLOW'), moves('MOVE_TACKLE', 'MOVE_WATER_GUN')), 'MOVE_STOCKPILE')).toBe(6)
    expect(effectDelta(mkState(moves('MOVE_SPIT_UP')), 'MOVE_STOCKPILE')).toBe(4)
  })
  it('Stockpile scores nothing for a Contrary attacker, even with Swallow', () => {
    expect(effectDelta(mkState({ abilities: ab('ABILITY_CONTRARY'), ...moves('MOVE_SWALLOW') }), 'MOVE_STOCKPILE')).toBe(0)
  })
  it('Rollout scores +8 only with Defense Curl already set', () => {
    expect(effectDelta(mkState({ status2: STATUS2_DEFENSE_CURL }), 'MOVE_ROLLOUT')).toBe(8)
    expect(effectDelta(mkState(), 'MOVE_ROLLOUT')).toBe(0)
  })
})

describe('EFFECT_SWAGGER / EFFECT_FLATTER (:3338-3352)', () => {
  it('Swagger: +2 for the confusion, +1 for Foul Play / Psych Up / Spectral Thief, +2 for a Contrary target', () => {
    expect(effectDelta(mkState(), 'MOVE_SWAGGER')).toBe(2)
    for (const m of ['MOVE_FOUL_PLAY', 'MOVE_PSYCH_UP', 'MOVE_SPECTRAL_THIEF']) expect(effectDelta(mkState(moves(m)), 'MOVE_SWAGGER'), m).toBe(3)
    expect(effectDelta(mkState({}, { abilities: ab('ABILITY_CONTRARY') }), 'MOVE_SWAGGER')).toBe(4)
  })
  it('Swagger: a Mold Breaker attacker sees through Contrary (breakable), so no +2 for it', () => {
    const molded: AiDamageDeps = { ...deps, grounding: { ...grounding, attackerHasMoldBreaker: true } }
    const mk = mkState({}, { abilities: ab('ABILITY_CONTRARY') })
    const real = aiCheckViability(mk(), 0, 1, 'MOVE_SWAGGER', 100, molded).score
    const plain = aiCheckViability(mk(), 0, 1, 'MOVE_SWAGGER', 100, { ...molded, moveData: (m) => (m === 'MOVE_SWAGGER' ? ({ ...toMoveData(m), effect: 'EFFECT_HIT' } as MoveData) : toMoveData(m)) }).score
    expect(real - plain).toBe(2)
  })
  it('Flatter: +2 for Psych Up / Spectral Thief (not Foul Play), +2 Contrary target, +2 confusion', () => {
    expect(effectDelta(mkState(), 'MOVE_FLATTER')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_PSYCH_UP')), 'MOVE_FLATTER')).toBe(4)
    expect(effectDelta(mkState(moves('MOVE_SPECTRAL_THIEF')), 'MOVE_FLATTER')).toBe(4)
    expect(effectDelta(mkState(moves('MOVE_FOUL_PLAY')), 'MOVE_FLATTER')).toBe(2)
    expect(effectDelta(mkState({}, { abilities: ab('ABILITY_CONTRARY') }), 'MOVE_FLATTER')).toBe(4)
  })
  it('the confusion term scores +3 vs a paralyzed target and 0 vs an already-confused or cure-item holder', () => {
    expect(effectDelta(mkState({}, { status1: STATUS1_PARALYSIS }), 'MOVE_SWAGGER')).toBe(3)
    expect(effectDelta(mkState({}, { status2: STATUS2_CONFUSION & 1 }), 'MOVE_SWAGGER')).toBe(0)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_LUM_BERRY' }), 'MOVE_SWAGGER')).toBe(0)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_PERSIM_BERRY' }), 'MOVE_SWAGGER')).toBe(0)
  })
  it('the confusion term is skipped when AI_FLAG_TRY_TO_FAINT and the attacker already KOs', () => {
    expect(effectDelta(mkState({ ...moves('MOVE_TACKLE') }, { hp: 1 }, () => {}, AI_FLAG_TRY_TO_FAINT), 'MOVE_SWAGGER')).toBe(0)
  })
})

describe('EFFECT_ATTRACT (:3353-3362)', () => {
  it('scores +1 for a healthy free target, +2 if it has a status, is confused, or is trapped', () => {
    expect(effectDelta(mkState(), 'MOVE_ATTRACT')).toBe(1)
    expect(effectDelta(mkState({}, { status1: STATUS1_BURN }), 'MOVE_ATTRACT')).toBe(2)
    expect(effectDelta(mkState({}, { status2: STATUS2_CONFUSION & 1 }), 'MOVE_ATTRACT')).toBe(2)
    expect(effectDelta(mkState({}, { status2: STATUS2_WRAPPED }), 'MOVE_ATTRACT')).toBe(2)
  })
  it('names the BattlerWillFaintFromSecondaryDamage gap', () => {
    expect(check(state(), 'MOVE_ATTRACT').unmodelled.some((u) => u.includes('BattlerWillFaintFromSecondaryDamage'))).toBe(true)
  })
})

describe('EFFECT_SAFEGUARD / EFFECT_PURSUIT / EFFECT_TORMENT / EFFECT_FOLLOW_ME', () => {
  const ungrounded: AiDamageDeps = { ...deps, turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: () => false } }
  const misty = (s: BattleState) => { s.field.statuses |= STATUS_FIELD_MISTY_TERRAIN }
  it('Safeguard scores +1 unless Misty Terrain is up and the attacker is grounded', () => {
    expect(effectDelta(mkState(), 'MOVE_SAFEGUARD')).toBe(1)
    expect(effectDelta(mkState({}, {}, misty), 'MOVE_SAFEGUARD')).toBe(0)
    const s = mkState({}, {}, misty)
    const real = aiCheckViability(s(), 0, 1, 'MOVE_SAFEGUARD', 100, ungrounded).score
    const plain = aiCheckViability(s(), 0, 1, 'MOVE_SAFEGUARD', 100, { ...ungrounded, moveData: (m) => (m === 'MOVE_SAFEGUARD' ? ({ ...toMoveData(m), effect: 'EFFECT_HIT' } as MoveData) : toMoveData(m)) }).score
    expect(real - plain).toBe(1)
    expect(effectDelta(mkState({}, {}, (st) => { st.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN }), 'MOVE_SAFEGUARD')).toBe(1) // another terrain: still +1
  })
  it('Pursuit (a /*TODO*/ block in the C), Torment and Follow Me (doubles-only) score nothing and are not gaps', () => {
    for (const id of ['MOVE_PURSUIT', 'MOVE_TORMENT', 'MOVE_FOLLOW_ME']) {
      expect(effectDelta(mkState(), id), id).toBe(0)
      expect(check(state(), id).unmodelled.some((u) => u.includes('gap')), id).toBe(false)
    }
  })
})

describe('EFFECT_RAPID_SPIN / EFFECT_DEFOG (:3375-3410)', () => {
  const hazards = (bit: number) => (s: BattleState) => { s.sides[0].statuses |= bit }
  const partyState = (a: Partial<SimBattleMon>, tweak: (s: BattleState) => void) => () => {
    const s = stateWithAttackerParty(a, {}, repeating(RNG_HIGH))
    tweak(s)
    return s
  }
  it('Rapid Spin: Speed raise (+2) only when the attacker is the slower one', () => {
    expect(effectDelta(mkState(SLOW), 'MOVE_RAPID_SPIN')).toBe(2)
    expect(effectDelta(mkState(FAST), 'MOVE_RAPID_SPIN')).toBe(0)
  })
  it('Rapid Spin: +3 to clear your own hazards with a party to switch to (early exit), and only with the party', () => {
    expect(effectDelta(partyState(FAST, hazards(SIDE_STATUS_STEALTH_ROCK)), 'MOVE_RAPID_SPIN')).toBe(3)
    expect(effectDelta(mkState(FAST, {}, hazards(SIDE_STATUS_STEALTH_ROCK)), 'MOVE_RAPID_SPIN')).toBe(0)
    expect(effectDelta(partyState(SLOW, hazards(SIDE_STATUS_SPIKES)), 'MOVE_RAPID_SPIN')).toBe(5)
  })
  it('Rapid Spin: +3 for Leech Seed or being wrapped when there are no hazards', () => {
    expect(effectDelta(mkState(FAST, {}, (s) => { s.battlers[0]!.statuses3 |= STATUS3_LEECHSEED }), 'MOVE_RAPID_SPIN')).toBe(3)
    expect(effectDelta(mkState({ ...FAST, status2: STATUS2_WRAPPED }), 'MOVE_RAPID_SPIN')).toBe(3)
  })
  it('Defog: +3 for clearing own hazards with a party; other-move Defog-effect (Squall Hammer) shares it', () => {
    expect(effectDelta(partyState({}, hazards(SIDE_STATUS_STEALTH_ROCK)), 'MOVE_DEFOG')).toBe(3)
    expect(effectDelta(partyState({}, hazards(SIDE_STATUS_STEALTH_ROCK)), 'MOVE_SQUALL_HAMMER')).toBe(3)
  })
  it('Defog: +3 for removing the target side screens / Safeguard / Mist', () => {
    for (const bit of [SIDE_STATUS_REFLECT, SIDE_STATUS_LIGHTSCREEN, SIDE_STATUS_AURORA_VEIL, SIDE_STATUS_SAFEGUARD, SIDE_STATUS_MIST]) {
      expect(effectDelta(mkState({}, {}, (s) => { s.sides[1].statuses |= bit }), 'MOVE_DEFOG'), `bit ${bit}`).toBe(3)
    }
  })
  it('Defog evasion branch: +1 baseline, +2 vs raised evasion (>7) or with an accuracy<=90 move; none when the target has Spikes', () => {
    expect(effectDelta(mkState(), 'MOVE_DEFOG')).toBe(1)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 1, 7, 8)), 'MOVE_DEFOG')).toBe(2)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 1, 7, 7)), 'MOVE_DEFOG')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_THUNDER')), 'MOVE_DEFOG')).toBe(2)
    expect(effectDelta(mkState({}, {}, (s) => { s.sides[1].statuses |= SIDE_STATUS_SPIKES }), 'MOVE_DEFOG')).toBe(0)
    // QUIRK: only the Spikes bit (1<<4) blocks it; Stealth Rock on the target side does not.
    expect(effectDelta(mkState({}, {}, (s) => { s.sides[1].statuses |= SIDE_STATUS_STEALTH_ROCK }), 'MOVE_DEFOG')).toBe(1)
  })
  it('Squall Hammer (Defog effect, but neither MOVE_DEFOG nor MOVE_RAPID_SPIN) has no inner-switch scoring', () => {
    expect(effectDelta(mkState(), 'MOVE_SQUALL_HAMMER')).toBe(0)
  })
})

describe('EFFECT_WILL_O_WISP (:3413-3415)', () => {
  it('scores +1 for a burnable target, +2 more when the target has a Physical move and could KO the attacker, +1 for Hex', () => {
    expect(effectDelta(mkState(), 'MOVE_WILL_O_WISP')).toBe(1)
    expect(effectDelta(mkState({ hp: 1 }), 'MOVE_WILL_O_WISP')).toBe(3)
    expect(effectDelta(mkState({ hp: 1 }, moves('MOVE_WATER_GUN')), 'MOVE_WILL_O_WISP')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_HEX')), 'MOVE_WILL_O_WISP')).toBe(2)
  })
  it('scores 0 vs a Fire type or an already-statused target, and under TRY_TO_FAINT when the attacker KOs anyway', () => {
    expect(effectDelta(mkState({}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), 'MOVE_WILL_O_WISP')).toBe(0)
    expect(effectDelta(mkState({}, { status1: STATUS1_PARALYSIS }), 'MOVE_WILL_O_WISP')).toBe(0)
    expect(effectDelta(mkState({}, { hp: 1 }, () => {}, AI_FLAG_TRY_TO_FAINT), 'MOVE_WILL_O_WISP')).toBe(0)
  })
})

describe('EFFECT_NATURE_POWER (:3424-3425)', () => {
  const np = (tweak: (s: BattleState) => void = () => {}, a: Partial<SimBattleMon> = {}) => mkState(a, {}, tweak)
  it('with no terrain, recurses into Tri Attack (the C fallback) and names the map-terrain gap', () => {
    const r = aiCheckViability(np()(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_NATURE_POWER'))
    expect(r.unmodelled.some((u) => u.includes('GetNaturePowerMove'))).toBe(true)
    const direct = aiCheckViability(np()(), 0, 1, 'MOVE_TRI_ATTACK', 100, deps)
    expect(r.score).toBe(direct.score)
  })
  it('Electric Terrain -> Thunderbolt, and the recursion is the TOP-LEVEL function (Frostbite penalizes the recursed Special move)', () => {
    const tweak = (s: BattleState) => { s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN }
    const frostbitten = { status1: STATUS1_FROSTBITE }
    const r = aiCheckViability(np(tweak, frostbitten)(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_NATURE_POWER'))
    const direct = aiCheckViability(np(tweak, frostbitten)(), 0, 1, 'MOVE_THUNDERBOLT', 100, deps)
    expect(r.score).toBe(direct.score)
    const healthy = aiCheckViability(np(tweak)(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_NATURE_POWER'))
    expect(r.score).toBeLessThan(healthy.score)
  })
})

describe('EFFECT_CHARGE / EFFECT_TAUNT (:3426-3436)', () => {
  it('Charge: +2 for a damaging Electric move (a status Electric move does not count), plus the Sp.Def raise', () => {
    expect(effectDelta(mkState(moves('MOVE_THUNDERBOLT'), moves('MOVE_WATER_GUN')), 'MOVE_CHARGE')).toBe(4)
    expect(effectDelta(mkState(moves('MOVE_THUNDERBOLT')), 'MOVE_CHARGE')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_THUNDER_WAVE'), moves('MOVE_WATER_GUN')), 'MOVE_CHARGE')).toBe(2)
    expect(effectDelta(mkState(), 'MOVE_CHARGE')).toBe(0)
  })
  it('Taunt: +10 if the target last used a status move, else +2 if it knows one, else 0', () => {
    expect(effectDelta(mkState({}, {}, (s) => { s.battlers[1]!.lastMove = 'MOVE_SWORDS_DANCE' }), 'MOVE_TAUNT')).toBe(10)
    expect(effectDelta(mkState({}, moves('MOVE_TACKLE', 'MOVE_SWORDS_DANCE'), (s) => { s.battlers[1]!.lastMove = 'MOVE_TACKLE' }), 'MOVE_TAUNT')).toBe(2)
    expect(effectDelta(mkState({}, {}, (s) => { s.battlers[1]!.lastMove = 'MOVE_TACKLE' }), 'MOVE_TAUNT')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_TAUNT')).toBe(0)
  })
})
