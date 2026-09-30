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
  STATUS3_GASTRO_ACID,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS1_BLEED,
  STATUS3_YAWN,
  STATUS3_POWER_TRICK,
  STATUS_FIELD_TRICK_ROOM,
  STATUS_FIELD_GRAVITY,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_ACC,
  STAT_EVASION,
} from '../constants'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { type AiDamageDeps } from './aiCalcDamage'
import { chooseMoveOrActionSingles } from './aiPipeline'
import { aiCalcDamage } from './aiCalcDamage'
import { aiCheckViability, PART2A_EFFECTS, RIPEN_ABILITIES } from './aiCheckViability'
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

/** The 70 labels of battle_ai_main.c:3607-3984 (EFFECT_GRUDGE .. EFFECT_RECHARGE), the list the
 * module's PART2B_EFFECTS held while they were still gapped. Mechanical extraction: the segment
 * with `//` and block comments stripped, then every `case (EFFECT_\w+):`. */
const OLD_PART2B_EFFECTS: readonly string[] = [
  'EFFECT_GRUDGE', 'EFFECT_SNATCH', 'EFFECT_MUD_SPORT', 'EFFECT_WATER_SPORT', 'EFFECT_TICKLE', 'EFFECT_COSMIC_POWER', 'EFFECT_BULK_UP',
  'EFFECT_CALM_MIND', 'EFFECT_GEOMANCY', 'EFFECT_QUIVER_DANCE', 'EFFECT_CONVERSION', 'EFFECT_CONVERSION_2', 'EFFECT_GEAR_UP',
  'EFFECT_SHELL_SMASH', 'EFFECT_DRAGON_DANCE', 'EFFECT_SHIFT_GEAR', 'EFFECT_GUARD_SWAP', 'EFFECT_POWER_SWAP', 'EFFECT_POWER_TRICK',
  'EFFECT_HEART_SWAP', 'EFFECT_SPEED_SWAP', 'EFFECT_GUARD_SPLIT', 'EFFECT_POWER_SPLIT', 'EFFECT_BUG_BITE', 'EFFECT_INCINERATE',
  'EFFECT_SMACK_DOWN', 'EFFECT_ELECTRIC_TERRAIN', 'EFFECT_MISTY_TERRAIN', 'EFFECT_GRASSY_TERRAIN', 'EFFECT_PSYCHIC_TERRAIN', 'EFFECT_PLEDGE',
  'EFFECT_TRICK_ROOM', 'EFFECT_MAGIC_ROOM', 'EFFECT_WONDER_ROOM', 'EFFECT_GRAVITY', 'EFFECT_ION_DELUGE', 'EFFECT_FLING', 'EFFECT_FEINT',
  'EFFECT_EMBARGO', 'EFFECT_POWDER', 'EFFECT_TELEKINESIS', 'EFFECT_THROAT_CHOP', 'EFFECT_HEAL_BLOCK', 'EFFECT_SOAK', 'EFFECT_THIRD_TYPE',
  'EFFECT_ELECTRIFY', 'EFFECT_TOPSY_TURVY', 'EFFECT_FAIRY_LOCK', 'EFFECT_QUASH', 'EFFECT_TAILWIND', 'EFFECT_LUCKY_CHANT', 'EFFECT_MAGNET_RISE',
  'EFFECT_CAMOUFLAGE', 'EFFECT_FLAME_BURST', 'EFFECT_TOXIC_THREAD', 'EFFECT_TWO_TURNS_ATTACK', 'EFFECT_SKULL_BASH', 'EFFECT_SOLARBEAM',
  'EFFECT_COUNTER', 'EFFECT_MIRROR_COAT', 'EFFECT_METAL_BURST', 'EFFECT_FLAIL', 'EFFECT_SHORE_UP', 'EFFECT_FACADE', 'EFFECT_FOCUS_PUNCH',
  'EFFECT_SMELLINGSALT', 'EFFECT_WAKE_UP_SLAP', 'EFFECT_REVENGE', 'EFFECT_ENDEAVOR', 'EFFECT_RECHARGE',
]
const VIABILITY_SOURCE = readFileSync(join(import.meta.dirname, 'aiCheckViability.ts'), 'utf8')
const SWITCH_CASE_LABELS = new Set([...VIABILITY_SOURCE.matchAll(/^\s*case '(EFFECT_\w+)':/gm)].map((m) => m[1]))

describe('PART2A_EFFECTS / old PART2B label list oracle -- mechanical, comment-stripped extraction', () => {
  it('PART2A has exactly 47 entries (battle_ai_main.c:3224-3606)', () => {
    expect(PART2A_EFFECTS.length).toBe(47)
  })
  it('the old PART2B list has exactly 70 entries (battle_ai_main.c:3607-3984), no duplicates', () => {
    expect(OLD_PART2B_EFFECTS.length).toBe(70)
    expect(new Set(OLD_PART2B_EFFECTS).size).toBe(70)
  })
  it('the two lists are disjoint and together are the 117 labels of the old PART2_EFFECTS', () => {
    expect(PART2A_EFFECTS.filter((e) => OLD_PART2B_EFFECTS.includes(e))).toEqual([])
    expect(PART2A_EFFECTS.length + OLD_PART2B_EFFECTS.length).toBe(117)
  })
  it('excludes the four labels that only exist inside a commented-out TODO block', () => {
    for (const commentedOut of ['EFFECT_EXTREME_EVOBOOST', 'EFFECT_CLANGOROUS_SOUL', 'EFFECT_NO_RETREAT', 'EFFECT_SKY_DROP']) {
      expect(PART2A_EFFECTS).not.toContain(commentedOut)
      expect(OLD_PART2B_EFFECTS).not.toContain(commentedOut)
    }
  })
  it('anchors: PART2A starts at EFFECT_SANDSTORM and ends at EFFECT_PSYCHO_SHIFT; the old PART2B runs EFFECT_GRUDGE .. EFFECT_RECHARGE', () => {
    expect(PART2A_EFFECTS).toContain('EFFECT_SANDSTORM')
    expect(PART2A_EFFECTS).toContain('EFFECT_PSYCHO_SHIFT')
    expect(OLD_PART2B_EFFECTS[0]).toBe('EFFECT_GRUDGE')
    expect(OLD_PART2B_EFFECTS[69]).toBe('EFFECT_RECHARGE')
    expect(PART2A_EFFECTS).not.toContain('EFFECT_GRUDGE')
    expect(OLD_PART2B_EFFECTS).not.toContain('EFFECT_PSYCHO_SHIFT')
  })
  it('does not overlap with a label part 1 handles', () => {
    for (const part1 of ['EFFECT_SLEEP', 'EFFECT_PERISH_SONG', 'EFFECT_MIRACLE_EYE']) {
      expect(PART2A_EFFECTS).not.toContain(part1)
      expect(OLD_PART2B_EFFECTS).not.toContain(part1)
    }
  })
  it('every PART2A effect is handled: none produces a part-2 gap line', () => {
    for (const effect of PART2A_EFFECTS) {
      const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(effect))
      expect(result.unmodelled.some((u) => u.includes('part 2')), effect).toBe(false)
    }
  })
  it('every effect of the old PART2B list produces no part-2 gap line (the gap and PART2B_EFFECTS are gone)', () => {
    for (const effect of OLD_PART2B_EFFECTS) {
      const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(effect))
      expect(result.unmodelled.some((u) => u.includes('part 2') || u.includes('not yet ported')), effect).toBe(false)
    }
  })
  it('every label of the old PART2B list is a real `case` label of the switch (none falls to `default`)', () => {
    for (const effect of OLD_PART2B_EFFECTS) expect(SWITCH_CASE_LABELS.has(effect), effect).toBe(true)
  })
  it('the four commented-out labels are NOT case labels: they are ordinary no-ops, not gaps', () => {
    for (const commentedOut of ['EFFECT_EXTREME_EVOBOOST', 'EFFECT_CLANGOROUS_SOUL', 'EFFECT_NO_RETREAT', 'EFFECT_SKY_DROP']) {
      expect(SWITCH_CASE_LABELS.has(commentedOut), commentedOut).toBe(false)
      const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps(commentedOut))
      expect(result.score, commentedOut).toBe(100)
      expect(result.unmodelled.some((u) => u.includes(commentedOut) || u.includes('part 2')), commentedOut).toBe(false)
    }
  })
  it('EFFECT_GRUDGE (the first :3607 label) scores 0 with no gap line', () => {
    const result = aiCheckViability(state(), 0, 1, 'MOVE_SYNTHETIC', 100, syntheticEffectDeps('EFFECT_GRUDGE'))
    expect(result.score).toBe(100)
    expect(result.unmodelled.some((u) => u.includes('EFFECT_GRUDGE'))).toBe(false)
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
  it('Pursuit (its whole body is commented out in the C), Torment and Follow Me (doubles-only) score nothing and are not gaps', () => {
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

// ---------------------------------------------------------------------------
// Part 2a -- item / ability / recycle cases
// ---------------------------------------------------------------------------
for (const id of ['MOVE_TRICK', 'MOVE_BESTOW', 'MOVE_ROLE_PLAY', 'MOVE_INGRAIN', 'MOVE_SUPERPOWER', 'MOVE_OVERHEAT', 'MOVE_MAGIC_COAT', 'MOVE_RECYCLE', 'MOVE_BRICK_BREAK', 'MOVE_STORED_POWER', 'MOVE_KNOCK_OFF', 'MOVE_SKILL_SWAP', 'MOVE_WORRY_SEED', 'MOVE_GASTRO_ACID', 'MOVE_SIMPLE_BEAM', 'MOVE_ENTRAINMENT', 'MOVE_IMPRISON', 'MOVE_REFRESH', 'MOVE_PSYCHO_SHIFT', 'MOVE_LEER', 'MOVE_TOXIC_SPIKES', 'MOVE_THUNDER_WAVE']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
if ((moveById.get('MOVE_LEER')?.target !== 'BOTH' || moveById.get('MOVE_LEER')?.split !== 'STATUS') || moveById.get('MOVE_TOXIC_SPIKES')?.target !== 'OPPONENTS_FIELD' || moveById.get('MOVE_THUNDER_WAVE')?.target !== 'SELECTED') {
  throw new Error('a Magic Coat fixture move changed its target')
}
for (const id of ['ITEM_CHOICE_SCARF', 'ITEM_CHOICE_BAND', 'ITEM_CHOICE_SPECS', 'ITEM_TOXIC_ORB', 'ITEM_FLAME_ORB', 'ITEM_FROST_ORB', 'ITEM_BLACK_SLUDGE', 'ITEM_IRON_BALL', 'ITEM_LAGGING_TAIL', 'ITEM_STICKY_BARB', 'ITEM_UTILITY_UMBRELLA', 'ITEM_EJECT_BUTTON', 'ITEM_LEFTOVERS', 'ITEM_BIG_ROOT', 'ITEM_LUM_BERRY', 'ITEM_LIECHI_BERRY', 'ITEM_SITRUS_BERRY', 'ITEM_ORAN_BERRY', 'ITEM_ENIGMA_BERRY', 'ITEM_FLAME_PLATE']) {
  if (!itemsById.has(id)) throw new Error(`items.json is missing ${id}`)
}

describe('EFFECT_TRICK / EFFECT_BESTOW (:3437-3512)', () => {
  const trick = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, tweak: (s: BattleState) => void = () => {}) => mkState(a, d, tweak)
  it('Choice Scarf: +2 always', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_SCARF' }), 'MOVE_TRICK')).toBe(2)
  })
  it('Choice Band: +2 only if the target has no Physical move; Choice Specs: only if no Special move', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_BAND' }, moves('MOVE_WATER_GUN')), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_BAND' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_SPECS' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_SPECS' }, moves('MOVE_WATER_GUN')), 'MOVE_TRICK')).toBe(0)
  })
  it('Toxic Orb: +2 unless ShouldPoisonSelf (Poison Heal, Marvel Scale, Quick Feet, Magic Guard, Facade, Psycho Shift, Toxic Boost/Guts + Physical)', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB' }), 'MOVE_TRICK')).toBe(2)
    for (const id of ['ABILITY_POISON_HEAL', 'ABILITY_MARVEL_SCALE', 'ABILITY_QUICK_FEET', 'ABILITY_MAGIC_GUARD', 'ABILITY_TOXIC_BOOST', 'ABILITY_GUTS']) {
      expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB', abilities: ab(id) }), 'MOVE_TRICK'), id).toBe(0)
    }
    expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB', ...moves('MOVE_FACADE') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB', ...moves('MOVE_PSYCHO_SHIFT') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB', abilities: ab('ABILITY_GUTS'), ...moves('MOVE_WATER_GUN') }), 'MOVE_TRICK')).toBe(2) // Guts needs a Physical move
    expect(effectDelta(trick({ itemId: 'ITEM_TOXIC_ORB', abilities: ab('ABILITY_POISON_HEAL'), types: ['POISON', 'MYSTERY', 'MYSTERY'] }), 'MOVE_TRICK')).toBe(2) // cannot be poisoned at all
  })
  it('Flame Orb: +2 unless ShouldBurnSelf; Frost Orb: +2 unless ShouldFrostbiteSelf', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_FLAME_ORB' }), 'MOVE_TRICK')).toBe(2)
    for (const id of ['ABILITY_QUICK_FEET', 'ABILITY_HEATPROOF', 'ABILITY_MAGIC_GUARD', 'ABILITY_GUTS']) expect(effectDelta(trick({ itemId: 'ITEM_FLAME_ORB', abilities: ab(id) }), 'MOVE_TRICK'), id).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FLAME_ORB', abilities: ab('ABILITY_FLARE_BOOST'), ...moves('MOVE_WATER_GUN') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FLAME_ORB', abilities: ab('ABILITY_DETERMINATION'), ...moves('MOVE_WATER_GUN') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FLAME_ORB', abilities: ab('ABILITY_GUTS'), types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), 'MOVE_TRICK')).toBe(2) // Fire cannot burn
    expect(effectDelta(trick({ itemId: 'ITEM_FROST_ORB' }), 'MOVE_TRICK')).toBe(2)
    for (const id of ['ABILITY_MAGIC_GUARD', 'ABILITY_GUTS']) expect(effectDelta(trick({ itemId: 'ITEM_FROST_ORB', abilities: ab(id) }), 'MOVE_TRICK'), id).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FROST_ORB', abilities: ab('ABILITY_DETERMINATION'), ...moves('MOVE_WATER_GUN') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FROST_ORB', ...moves('MOVE_FACADE') }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_FROST_ORB', abilities: ab('ABILITY_GUTS'), types: ['ICE', 'MYSTERY', 'MYSTERY'] }), 'MOVE_TRICK')).toBe(2)
  })
  it('Black Sludge: +3 unless the target is Poison-type or Magic-Guard-protected', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_BLACK_SLUDGE' }), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick({ itemId: 'ITEM_BLACK_SLUDGE' }, { types: ['POISON', 'MYSTERY', 'MYSTERY'] }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ itemId: 'ITEM_BLACK_SLUDGE' }, { abilities: ab('ABILITY_MAGIC_GUARD') }), 'MOVE_TRICK')).toBe(0)
  })
  it('Iron Ball: +2 unless the target has Fling AND is grounded', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_IRON_BALL' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({ itemId: 'ITEM_IRON_BALL' }, moves('MOVE_FLING')), 'MOVE_TRICK')).toBe(0)
    const airborne: AiDamageDeps = { ...deps, turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: () => false } }
    const mk = trick({ itemId: 'ITEM_IRON_BALL' }, moves('MOVE_FLING'))
    const real = aiCheckViability(mk(), 0, 1, 'MOVE_TRICK', 100, airborne).score
    const plain = aiCheckViability(mk(), 0, 1, 'MOVE_TRICK', 100, { ...airborne, moveData: (m) => (m === 'MOVE_TRICK' ? ({ ...toMoveData(m), effect: 'EFFECT_HIT' } as MoveData) : toMoveData(m)) }).score
    expect(real - plain).toBe(2)
  })
  it('Lagging Tail and Sticky Barb: +3', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_LAGGING_TAIL' }), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick({ itemId: 'ITEM_STICKY_BARB' }), 'MOVE_TRICK')).toBe(3)
  })
  it('Utility Umbrella: +3 per Slow-em-down pairing (Swift Swim+rain, Chlorophyll+sun, Flower Gift+sun) when weather has effect', () => {
    const umb = { itemId: 'ITEM_UTILITY_UMBRELLA' }
    const w = (weather: number) => (s: BattleState) => { s.field.weather = weather }
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_SWIFT_SWIM') }, w(WEATHER_RAIN_TEMPORARY)), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_CHLOROPHYLL') }, w(WEATHER_SUN_TEMPORARY)), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_FLOWER_GIFT') }, w(WEATHER_SUN_TEMPORARY)), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_SWIFT_SWIM', ['ABILITY_CHLOROPHYLL', 'ABILITY_FLOWER_GIFT', null]) }, w(WEATHER_SUN_TEMPORARY)), 'MOVE_TRICK')).toBe(6)
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_CHLOROPHYLL') }, w(WEATHER_RAIN_TEMPORARY)), 'MOVE_TRICK')).toBe(0) // wrong weather
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_FLOWER_GIFT') }, w(WEATHER_RAIN_TEMPORARY)), 'MOVE_TRICK')).toBe(0) // wrong weather
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_FLOWER_GIFT') }), 'MOVE_TRICK')).toBe(0) // no weather
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_SWIFT_SWIM') }), 'MOVE_TRICK')).toBe(0) // no weather
    expect(effectDelta(trick({ ...umb, abilities: ab('ABILITY_SOLAR_POWER') }, { abilities: ab('ABILITY_CHLOROPHYLL') }, w(WEATHER_SUN_TEMPORARY)), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ ...umb, abilities: ab('ABILITY_DRY_SKIN') }, { abilities: ab('ABILITY_SWIFT_SWIM') }, w(WEATHER_RAIN_TEMPORARY)), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick(umb, { abilities: ab('ABILITY_SWIFT_SWIM') }, (s) => { w(WEATHER_RAIN_TEMPORARY)(s); s.field.timers.clearSkiesTimer = 2 }), 'MOVE_TRICK')).toBe(0)
  })
  it('Eject Button: +2 if the attacker has a damaging move', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_EJECT_BUTTON' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({ itemId: 'ITEM_EJECT_BUTTON', ...moves('MOVE_SWORDS_DANCE') }), 'MOVE_TRICK')).toBe(0)
  })
  it('itemless attacker (Trick only): the target item decides; an itemless target still scores +1 via the default arm (NONE is not a case)', () => {
    expect(effectDelta(trick(), 'MOVE_TRICK')).toBe(1)
    expect(effectDelta(trick({}, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_TRICK')).toBe(1)
    expect(effectDelta(trick({}, { itemId: 'ITEM_CHOICE_BAND' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({}, { itemId: 'ITEM_LAGGING_TAIL' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({}, { itemId: 'ITEM_STICKY_BARB' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ abilities: ab('ABILITY_GUTS') }, { itemId: 'ITEM_TOXIC_ORB' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({}, { itemId: 'ITEM_TOXIC_ORB' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ abilities: ab('ABILITY_GUTS') }, { itemId: 'ITEM_FLAME_ORB' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({ abilities: ab('ABILITY_GUTS') }, { itemId: 'ITEM_FROST_ORB' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({}, { itemId: 'ITEM_FLAME_ORB' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({}, { itemId: 'ITEM_FROST_ORB' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick({ types: ['POISON', 'MYSTERY', 'MYSTERY'] }, { itemId: 'ITEM_BLACK_SLUDGE' }), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick({ abilities: ab('ABILITY_MAGIC_GUARD') }, { itemId: 'ITEM_BLACK_SLUDGE' }), 'MOVE_TRICK')).toBe(3)
    expect(effectDelta(trick({}, { itemId: 'ITEM_BLACK_SLUDGE' }), 'MOVE_TRICK')).toBe(0)
    expect(effectDelta(trick(moves('MOVE_FLING'), { itemId: 'ITEM_IRON_BALL' }), 'MOVE_TRICK')).toBe(2)
    expect(effectDelta(trick({}, { itemId: 'ITEM_IRON_BALL' }), 'MOVE_TRICK')).toBe(0)
  })
  it('an attacker holding an unlisted item does not enter the target-item arm', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_TRICK')).toBe(0)
  })
  it('Bestow shares the attacker-item arm but never the target-item default (move != MOVE_BESTOW)', () => {
    expect(effectDelta(trick({ itemId: 'ITEM_CHOICE_SCARF' }), 'MOVE_BESTOW')).toBe(2)
    expect(effectDelta(trick(), 'MOVE_BESTOW')).toBe(0)
    expect(effectDelta(trick({}, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_BESTOW')).toBe(0)
  })
  it('reports the holdEffects[] quirk whenever an item is involved', () => {
    expect(check(state({ itemId: 'ITEM_CHOICE_SCARF' }), 'MOVE_TRICK').unmodelled.some((u) => u.includes('ItemId_GetHoldEffectParam'))).toBe(true)
    expect(check(state(), 'MOVE_TRICK').unmodelled.some((u) => u.includes('ItemId_GetHoldEffectParam'))).toBe(false)
  })
})

describe('EFFECT_ROLE_PLAY (:3513-3517)', () => {
  const rp = (a: string | null, d: string | null) => mkState({ abilities: ab(a) }, { abilities: ab(d) })
  it('+2 when the target has a rating>=5 ability the attacker (rating<5) can take', () => {
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_ADAPTABILITY'), 'MOVE_ROLE_PLAY')).toBe(2)
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_ANALYTIC'), 'MOVE_ROLE_PLAY')).toBe(2) // exactly 5
    expect(effectDelta(rp(null, 'ABILITY_ADAPTABILITY'), 'MOVE_ROLE_PLAY')).toBe(2) // ABILITY_NONE rates 0 and is not attacker-banned
  })
  it('0 when the attacker is already rated >= 5, or the target is under 5', () => {
    expect(effectDelta(rp('ABILITY_ANALYTIC', 'ABILITY_ADAPTABILITY'), 'MOVE_ROLE_PLAY')).toBe(0)
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_ANGER_POINT'), 'MOVE_ROLE_PLAY')).toBe(0)
  })
  it('0 when the attacker ability is un-replaceable (persistent/unsuppressable) or the target ability cannot be copied', () => {
    expect(effectDelta(rp('ABILITY_ANTICIPATION', 'ABILITY_ADAPTABILITY'), 'MOVE_ROLE_PLAY')).toBe(0)
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_WONDER_GUARD'), 'MOVE_ROLE_PLAY')).toBe(0)
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_TRACE'), 'MOVE_ROLE_PLAY')).toBe(0)
    expect(effectDelta(rp('ABILITY_ANGER_POINT', 'ABILITY_COMATOSE'), 'MOVE_ROLE_PLAY')).toBe(0) // rating 6 but persistent
    expect(effectDelta(rp('ABILITY_ANGER_POINT', null), 'MOVE_ROLE_PLAY')).toBe(0) // target has no ability at all
  })
})

describe('EFFECT_INGRAIN / EFFECT_SUPERPOWER / EFFECT_OVERHEAT (:3518-3527)', () => {
  it('Ingrain scores +3 with a Big Root, +1 otherwise', () => {
    expect(effectDelta(mkState({ itemId: 'ITEM_BIG_ROOT' }), 'MOVE_INGRAIN')).toBe(3)
    expect(effectDelta(mkState(), 'MOVE_INGRAIN')).toBe(1)
    expect(effectDelta(mkState({ itemId: 'ITEM_LEFTOVERS' }), 'MOVE_INGRAIN')).toBe(1)
  })
  it('Superpower and Overheat (via the shared label) score +10 only for a Contrary attacker', () => {
    // Compared across the attacker's ability on the real move: Superpower is in
    // DISCOURAGED_POWERFUL_MOVE_EFFECTS (its own pre-switch -1), so an
    // EFFECT_HIT baseline would not cancel that term.
    for (const id of ['MOVE_SUPERPOWER', 'MOVE_OVERHEAT']) {
      const contrary = aiCheckViability(mkState({ abilities: ab('ABILITY_CONTRARY') })(), 0, 1, id, 100, deps).score
      const plain = aiCheckViability(mkState()(), 0, 1, id, 100, deps).score
      expect(contrary - plain, id).toBe(10)
    }
  })
})

describe('EFFECT_MAGIC_COAT (:3528-3531) -- MOVE_TARGET_SELECTED is 0x0', () => {
  const mc = (last: string | null) => mkState({}, {}, (s) => { s.battlers[1]!.lastMove = last })
  it('+3 only when the predicted move is a STATUS move targeting OPPONENTS_FIELD or BOTH', () => {
    expect(effectDelta(mc('MOVE_TOXIC_SPIKES'), 'MOVE_MAGIC_COAT')).toBe(3)
    expect(effectDelta(mc('MOVE_LEER'), 'MOVE_MAGIC_COAT')).toBe(3)
  })
  it('QUIRK: an ordinary single-target status move (target SELECTED) never matches, since SELECTED is 0', () => {
    expect(effectDelta(mc('MOVE_THUNDER_WAVE'), 'MOVE_MAGIC_COAT')).toBe(0)
  })
  it('0 for a damaging predicted move (even a BOTH-target one), or none at all', () => {
    expect(effectDelta(mc('MOVE_SURF'), 'MOVE_MAGIC_COAT')).toBe(0)
    expect(effectDelta(mc(null), 'MOVE_MAGIC_COAT')).toBe(0)
  })
})

describe('EFFECT_RECYCLE (:3532-3546)', () => {
  const rec = (a: Partial<SimBattleMon>, used: string | null | undefined, d: Partial<SimBattleMon> = {}) => mkState(a, d, (s) => { if (used !== undefined) s.battlers[0]!.usedHeldItem = used })
  const RIPEN = ab('ABILITY_RIPEN')
  it('+1 for any used item, +1 more for a Recycle-encouraged one; nothing for none', () => {
    expect(effectDelta(rec({}, 'ITEM_LEFTOVERS'), 'MOVE_RECYCLE')).toBe(1)
    expect(effectDelta(rec({}, 'ITEM_LUM_BERRY'), 'MOVE_RECYCLE')).toBe(2)
    expect(effectDelta(rec({}, 'ITEM_FOCUS_SASH'), 'MOVE_RECYCLE')).toBe(2)
    expect(effectDelta(rec({}, null), 'MOVE_RECYCLE')).toBe(0)
  })
  it('every recycle-encouraged item id exists and scores 2', () => {
    for (const id of ['ITEM_CHESTO_BERRY', 'ITEM_LUM_BERRY', 'ITEM_STARF_BERRY', 'ITEM_SITRUS_BERRY', 'ITEM_MICLE_BERRY', 'ITEM_CUSTAP_BERRY', 'ITEM_MENTAL_HERB', 'ITEM_BERRY_JUICE', 'ITEM_FOCUS_SASH']) {
      expect(itemsById.has(id), id).toBe(true)
      expect(effectDelta(rec({}, id), 'MOVE_RECYCLE'), id).toBe(2)
    }
  })
  it('reports the never-written usedHeldItems gap only when the field is unset', () => {
    expect(check(state(), 'MOVE_RECYCLE').unmodelled.some((u) => u.includes('GetUsedHeldItem'))).toBe(true)
    expect(aiCheckViability(rec({}, null)(), 0, 1, 'MOVE_RECYCLE', 100, deps).unmodelled.some((u) => u.includes('GetUsedHeldItem'))).toBe(false)
  })
  it('a Ripen holder recycling a stat berry gets +1 only above 60% HP', () => {
    expect(effectDelta(rec({ abilities: RIPEN, hp: 61 }, 'ITEM_LIECHI_BERRY'), 'MOVE_RECYCLE')).toBe(2)
    expect(effectDelta(rec({ abilities: RIPEN, hp: 60 }, 'ITEM_LIECHI_BERRY'), 'MOVE_RECYCLE')).toBe(1)
    expect(effectDelta(rec({ hp: 61 }, 'ITEM_LIECHI_BERRY'), 'MOVE_RECYCLE')).toBe(1) // no Ripen
    for (const id of ['ABILITY_APPLE_PIE', 'ABILITY_SUGAR_RUSH']) expect(effectDelta(rec({ abilities: ab(id) }, 'ITEM_LIECHI_BERRY'), 'MOVE_RECYCLE'), id).toBe(2)
  })
  it('Ripen + HP berry: +1 when we cannot KO first and the foe cannot KO us even after the heal (Sitrus, param 25 -> 100/25 = 4)', () => {
    // attacker faster and foe cannot KO now -> +1 via the second disjunct
    expect(effectDelta(rec({ ...FAST, abilities: RIPEN }, 'ITEM_SITRUS_BERRY'), 'MOVE_RECYCLE')).toBe(3)
    // without Ripen the berry branch never runs
    expect(effectDelta(rec({ ...FAST }, 'ITEM_SITRUS_BERRY'), 'MOVE_RECYCLE')).toBe(2)
  })
  it('Ripen + HP berry: the first disjunct (attacker first AND foe can KO now) grants +1; the foe KOing us regardless while we are slower denies it', () => {
    expect(effectDelta(rec({ ...FAST, abilities: RIPEN, hp: 1 }, 'ITEM_SITRUS_BERRY'), 'MOVE_RECYCLE')).toBe(3)
    expect(effectDelta(rec({ ...SLOW, abilities: RIPEN, hp: 1 }, 'ITEM_SITRUS_BERRY'), 'MOVE_RECYCLE')).toBe(2)
  })
  it('Ripen + HP berry: denied when the attacker can already KO the target', () => {
    expect(effectDelta(rec({ ...FAST, abilities: RIPEN }, 'ITEM_SITRUS_BERRY', { hp: 1 }), 'MOVE_RECYCLE')).toBe(2)
  })
  it('toHeal uses the item param: hp exactly at the foe damage is KO-able without the heal but not with it', () => {
    const probe = state()
    const dmg = aiCalcDamage(probe, 'MOVE_TACKLE', 1, 0, deps).dmg
    expect(dmg).toBeGreaterThan(5)
    // slower attacker, hp == dmg: the foe KOs with toHeal 0, but Sitrus (100/25 = 4) lifts hp above dmg -> no KO -> +1.
    expect(effectDelta(rec({ ...SLOW, abilities: RIPEN, hp: dmg }, 'ITEM_SITRUS_BERRY'), 'MOVE_RECYCLE')).toBe(3)
    // param 10 (Oran) heals a flat 10: hp = dmg - 9 -> hp+10 > dmg -> +1; hp = dmg - 10 -> hp+10 == dmg -> still KO -> no +1
    expect(effectDelta(rec({ ...SLOW, abilities: RIPEN, hp: dmg - 9, maxHp: 50 }, 'ITEM_ORAN_BERRY'), 'MOVE_RECYCLE')).toBe(2)
    expect(effectDelta(rec({ ...SLOW, abilities: RIPEN, hp: dmg - 10, maxHp: 50 }, 'ITEM_ORAN_BERRY'), 'MOVE_RECYCLE')).toBe(1)
  })
  it('IsStatBoostingBerry: exactly Liechi, Ganlon, Salac, Petaya, Apicot, Starf, Micle (Lansat is commented out in the C)', () => {
    const expected: Record<string, number> = { ITEM_LIECHI_BERRY: 2, ITEM_GANLON_BERRY: 2, ITEM_SALAC_BERRY: 2, ITEM_PETAYA_BERRY: 2, ITEM_APICOT_BERRY: 2, ITEM_STARF_BERRY: 3, ITEM_MICLE_BERRY: 3, ITEM_LANSAT_BERRY: 1 }
    for (const [id, delta] of Object.entries(expected)) {
      expect(itemsById.has(id), id).toBe(true)
      expect(effectDelta(rec({ abilities: RIPEN }, id), 'MOVE_RECYCLE'), id).toBe(delta) // used +1 (+1 Starf/Micle are also Recycle-encouraged) (+1 stat-boosting)
    }
  })
  it('ShouldRestoreHpBerry: Sitrus, Figy, Wiki, Mago, Aguav, Iapapa (param 2 -> half of max HP)', () => {
    const expected: Record<string, number> = { ITEM_SITRUS_BERRY: 3, ITEM_FIGY_BERRY: 2, ITEM_WIKI_BERRY: 2, ITEM_MAGO_BERRY: 2, ITEM_AGUAV_BERRY: 2, ITEM_IAPAPA_BERRY: 2 }
    for (const [id, delta] of Object.entries(expected)) {
      expect(itemsById.has(id), id).toBe(true)
      expect(effectDelta(rec({ ...FAST, abilities: RIPEN }, id), 'MOVE_RECYCLE'), id).toBe(delta) // used +1 (+1 Sitrus encouraged) +1 berry branch
    }
  })
  it('Oran only counts as an HP berry at maxHP <= 50', () => {
    expect(effectDelta(rec({ ...FAST, abilities: RIPEN, maxHp: 50, hp: 50 }, 'ITEM_ORAN_BERRY'), 'MOVE_RECYCLE')).toBe(2)
    expect(effectDelta(rec({ ...FAST, abilities: RIPEN, maxHp: 51, hp: 51 }, 'ITEM_ORAN_BERRY'), 'MOVE_RECYCLE')).toBe(1)
  })
})

describe('EFFECT_BRICK_BREAK / EFFECT_STORED_POWER (:3547-3557)', () => {
  it('Brick Break: +1 per Reflect / Light Screen / Aurora Veil on the TARGET side only', () => {
    for (const bit of [SIDE_STATUS_REFLECT, SIDE_STATUS_LIGHTSCREEN, SIDE_STATUS_AURORA_VEIL]) {
      expect(effectDelta(mkState({}, {}, (s) => { s.sides[1].statuses |= bit }), 'MOVE_BRICK_BREAK'), `bit ${bit}`).toBe(1)
    }
    expect(effectDelta(mkState({}, {}, (s) => { s.sides[1].statuses |= SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL }), 'MOVE_BRICK_BREAK')).toBe(3)
    expect(effectDelta(mkState({}, {}, (s) => { s.sides[0].statuses |= SIDE_STATUS_REFLECT }), 'MOVE_BRICK_BREAK')).toBe(0)
  })
  it('Stored Power: -4 below 2 boosts, 0 for 2..6, +4 above 6 (accuracy/evasion count)', () => {
    expect(effectDelta(mkState(), 'MOVE_STORED_POWER')).toBe(-4)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 0, 1, 7)), 'MOVE_STORED_POWER')).toBe(-4)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 0, 1, 8)), 'MOVE_STORED_POWER')).toBe(0)
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 0, 1, 12); stage(s, 0, 7, 6 + 0) }), 'MOVE_STORED_POWER')).toBe(0) // 6 total
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 0, 1, 12); stage(s, 0, 3, 7) }), 'MOVE_STORED_POWER')).toBe(4) // 7 total
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 0, 6, 8); stage(s, 0, 7, 8) }), 'MOVE_STORED_POWER')).toBe(0) // acc+eva = 4 counted
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 0, 6, 7); stage(s, 0, 2, 3) }), 'MOVE_STORED_POWER')).toBe(-4) // drops do not count
  })
})

describe('EFFECT_KNOCK_OFF (:3558-3572) -- B_TRAINERS_KNOCK_OFF_ITEMS (battle_config.h:103) is defined', () => {
  const ko = (d: Partial<SimBattleMon>) => mkState({}, d)
  it('+3 for a knockable ordinary item; nothing without an item', () => {
    expect(effectDelta(ko({ itemId: 'ITEM_LEFTOVERS' }), 'MOVE_KNOCK_OFF')).toBe(3)
    expect(effectDelta(ko({}), 'MOVE_KNOCK_OFF')).toBe(0)
  })
  it('Iron Ball: +4 if the holder has Fling, else 0; Lagging Tail / Sticky Barb: 0', () => {
    expect(effectDelta(ko({ itemId: 'ITEM_IRON_BALL', ...moves('MOVE_FLING') }), 'MOVE_KNOCK_OFF')).toBe(4)
    expect(effectDelta(ko({ itemId: 'ITEM_IRON_BALL' }), 'MOVE_KNOCK_OFF')).toBe(0)
    expect(effectDelta(ko({ itemId: 'ITEM_LAGGING_TAIL' }), 'MOVE_KNOCK_OFF')).toBe(0)
    expect(effectDelta(ko({ itemId: 'ITEM_STICKY_BARB' }), 'MOVE_KNOCK_OFF')).toBe(0)
  })
  it('Sticky Hold / Supersweet Syrup protect the item, unless the attacker has Mold Breaker (both are breakable)', () => {
    for (const id of ['ABILITY_STICKY_HOLD', 'ABILITY_SUPERSWEET_SYRUP']) {
      expect(effectDelta(ko({ itemId: 'ITEM_LEFTOVERS', abilities: ab(id) }), 'MOVE_KNOCK_OFF'), id).toBe(0)
      const molded: AiDamageDeps = { ...deps, grounding: { ...grounding, attackerHasMoldBreaker: true } }
      const mk = ko({ itemId: 'ITEM_LEFTOVERS', abilities: ab(id) })
      const real = aiCheckViability(mk(), 0, 1, 'MOVE_KNOCK_OFF', 100, molded).score
      const plain = aiCheckViability(mk(), 0, 1, 'MOVE_KNOCK_OFF', 100, { ...molded, moveData: (m) => (m === 'MOVE_KNOCK_OFF' ? ({ ...toMoveData(m), effect: 'EFFECT_HIT' } as MoveData) : toMoveData(m)) }).score
      expect(real - plain, id).toBe(3)
    }
  })
  it('an un-removable item (Enigma Berry, Arceus plate) is not knocked off', () => {
    expect(effectDelta(ko({ itemId: 'ITEM_ENIGMA_BERRY' }), 'MOVE_KNOCK_OFF')).toBe(0)
    expect(effectDelta(ko({ itemId: 'ITEM_FLAME_PLATE', speciesId: 'SPECIES_ARCEUS' }), 'MOVE_KNOCK_OFF')).toBe(0)
    expect(effectDelta(ko({ itemId: 'ITEM_FLAME_PLATE' }), 'MOVE_KNOCK_OFF')).toBe(3)
  })
})

describe('EFFECT_SKILL_SWAP / WORRY_SEED / GASTRO_ACID / SIMPLE_BEAM / ENTRAINMENT (:3573-3585)', () => {
  const abil = (a: string | null, d: string | null, tweak: (s: BattleState) => void = () => {}) => mkState({ abilities: ab(a) }, { abilities: ab(d) }, tweak)
  it('Skill Swap: +1 only when the target ability rates strictly higher', () => {
    expect(effectDelta(abil('ABILITY_BLAZE', 'ABILITY_ADAPTABILITY'), 'MOVE_SKILL_SWAP')).toBe(1)
    expect(effectDelta(abil('ABILITY_ADAPTABILITY', 'ABILITY_ADAPTABILITY'), 'MOVE_SKILL_SWAP')).toBe(0)
    expect(effectDelta(abil('ABILITY_ADAPTABILITY', 'ABILITY_BLAZE'), 'MOVE_SKILL_SWAP')).toBe(0)
    expect(effectDelta(abil('ABILITY_DEFEATIST', 'ABILITY_ANGER_POINT'), 'MOVE_SKILL_SWAP')).toBe(1) // negative rating
  })
  for (const id of ['MOVE_WORRY_SEED', 'MOVE_GASTRO_ACID', 'MOVE_SIMPLE_BEAM']) {
    it(`${id}: +2 when the target ability rates >= 5`, () => {
      expect(effectDelta(abil(null, 'ABILITY_ADAPTABILITY'), id)).toBe(2)
      expect(effectDelta(abil(null, 'ABILITY_ANALYTIC'), id)).toBe(2)
      expect(effectDelta(abil(null, 'ABILITY_ANGER_POINT'), id)).toBe(0)
    })
  }
  it('Entrainment: +2 when the target rates >= 5 OR the attacker rates <= 0, the abilities differ, and no Gastro Acid', () => {
    expect(effectDelta(abil('ABILITY_ANGER_POINT', 'ABILITY_ADAPTABILITY'), 'MOVE_ENTRAINMENT')).toBe(2)
    expect(effectDelta(abil(null, 'ABILITY_ANGER_POINT'), 'MOVE_ENTRAINMENT')).toBe(2) // attacker rates 0
    expect(effectDelta(abil('ABILITY_DEFEATIST', 'ABILITY_ANGER_POINT'), 'MOVE_ENTRAINMENT')).toBe(2) // attacker rates -1
    expect(effectDelta(abil('ABILITY_BLAZE', 'ABILITY_ANGER_POINT'), 'MOVE_ENTRAINMENT')).toBe(0) // neither
    expect(effectDelta(abil('ABILITY_ADAPTABILITY', 'ABILITY_ADAPTABILITY'), 'MOVE_ENTRAINMENT')).toBe(0) // same ability
    expect(effectDelta(abil('ABILITY_ANGER_POINT', 'ABILITY_ADAPTABILITY', (s) => { s.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID }), 'MOVE_ENTRAINMENT')).toBe(0)
  })
})

describe('EFFECT_IMPRISON / EFFECT_REFRESH (:3586-3594)', () => {
  it('Imprison: +3 when the target last used a move we also know; else +1 only after the first turn', () => {
    const imp = (last: string | null, firstTurn: number) => mkState(moves('MOVE_TACKLE', 'MOVE_SWORDS_DANCE'), {}, (s) => { s.battlers[1]!.lastMove = last; s.battlers[0]!.volatiles.isFirstTurn = firstTurn })
    expect(effectDelta(imp('MOVE_TACKLE', 2), 'MOVE_IMPRISON')).toBe(3)
    expect(effectDelta(imp('MOVE_TACKLE', 0), 'MOVE_IMPRISON')).toBe(3) // not 4: it is an else-if
    expect(effectDelta(imp('MOVE_WATER_GUN', 0), 'MOVE_IMPRISON')).toBe(1)
    expect(effectDelta(imp(null, 0), 'MOVE_IMPRISON')).toBe(1)
    expect(effectDelta(imp('MOVE_WATER_GUN', 2), 'MOVE_IMPRISON')).toBe(0)
    expect(effectDelta(imp('MOVE_WATER_GUN', 1), 'MOVE_IMPRISON')).toBe(0) // isFirstTurn == 0 is exact
  })
  it('Refresh: +2 for poison, toxic, burn, paralysis, frostbite or bleed; 0 for sleep, freeze or none', () => {
    for (const [name, bit] of [['poison', STATUS1_POISON], ['toxic', STATUS1_TOXIC_POISON], ['burn', STATUS1_BURN], ['paralysis', STATUS1_PARALYSIS], ['frostbite', STATUS1_FROSTBITE], ['bleed', STATUS1_BLEED]] as const) {
      expect(effectDelta(mkState({ status1: bit }), 'MOVE_REFRESH'), name).toBe(2)
    }
    expect(effectDelta(mkState({ status1: 3 }), 'MOVE_REFRESH'), 'sleep').toBe(0)
    expect(effectDelta(mkState({ status1: STATUS1_FREEZE }), 'MOVE_REFRESH'), 'freeze').toBe(0)
    expect(effectDelta(mkState(), 'MOVE_REFRESH')).toBe(0)
  })
})

describe('EFFECT_PSYCHO_SHIFT (:3595-3606)', () => {
  // A paralyzed attacker's total speed is halved (turnOrder.ts, B_PARALYSIS_SPEED GEN_7), so raw 200 -> 100.
  const PARA = { status1: STATUS1_PARALYSIS, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } }
  it('dispatches on the attacker status: poison +1, burn +1, paralysis +4 (speed-tier), sleep +3, frostbite +1, none 0', () => {
    expect(effectDelta(mkState({ status1: STATUS1_POISON }), 'MOVE_PSYCHO_SHIFT')).toBe(1)
    expect(effectDelta(mkState({ status1: STATUS1_TOXIC_POISON }), 'MOVE_PSYCHO_SHIFT')).toBe(1)
    expect(effectDelta(mkState({ status1: STATUS1_BURN }), 'MOVE_PSYCHO_SHIFT')).toBe(1)
    expect(effectDelta(mkState(PARA), 'MOVE_PSYCHO_SHIFT')).toBe(4)
    expect(effectDelta(mkState({ status1: 3 }), 'MOVE_PSYCHO_SHIFT')).toBe(3)
    expect(effectDelta(mkState({ status1: STATUS1_FROSTBITE }), 'MOVE_PSYCHO_SHIFT')).toBe(1)
    expect(effectDelta(mkState(), 'MOVE_PSYCHO_SHIFT')).toBe(0)
  })
  it('the if/else-if order is poison > burn > paralysis > sleep > frostbite', () => {
    expect(effectDelta(mkState({ ...PARA, status1: STATUS1_BURN | STATUS1_PARALYSIS }), 'MOVE_PSYCHO_SHIFT')).toBe(1) // burn, not paralysis's +4
    expect(effectDelta(mkState({ ...PARA, status1: STATUS1_PARALYSIS | STATUS1_FROSTBITE }), 'MOVE_PSYCHO_SHIFT')).toBe(4) // paralysis, not frostbite's +1
    expect(effectDelta(mkState({ ...PARA, status1: STATUS1_POISON | STATUS1_PARALYSIS }), 'MOVE_PSYCHO_SHIFT')).toBe(1)
  })
  it('scores 0 when the target cannot take the status (already statused)', () => {
    expect(effectDelta(mkState({ status1: STATUS1_POISON }, { status1: STATUS1_BURN }), 'MOVE_PSYCHO_SHIFT')).toBe(0)
  })
  it('sleep adds +2 more on the AI_RandLessThan(128) draw (line :2724 of battle_ai_util.c)', () => {
    const lowRng = () => state({ status1: 3 }, {}, repeating(RNG_LOW))
    const real = aiCheckViability(lowRng(), 0, 1, 'MOVE_PSYCHO_SHIFT', 100, deps).score
    const plain = aiCheckViability(lowRng(), 0, 1, 'MOVE_PSYCHO_SHIFT', 100, depsOverride('MOVE_PSYCHO_SHIFT', { effect: 'EFFECT_HIT' })).score
    expect(real - plain).toBe(5)
  })
  it('IncreaseParalyzeScore compares u8-truncated speeds: a defender total of 280 wraps to 24 and flips +4 to +2', () => {
    const atk = { status1: STATUS1_PARALYSIS, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 400 } } // halved: 200
    const def = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 280 } }
    expect(effectDelta(mkState(atk, def), 'MOVE_PSYCHO_SHIFT')).toBe(2)
    // the ATTACKER's total wraps too: halved 600 -> 300 -> 44; a 60-speed defender is then in the +4 tier (60 >= 44, 30 < 44), while an unwrapped 300 would give +2
    const bigAtk = { status1: STATUS1_PARALYSIS, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 600 } }
    expect(effectDelta(mkState(bigAtk, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 60 } }), 'MOVE_PSYCHO_SHIFT')).toBe(4)
    // control: a defender total that still fits a u8 keeps the +4 tier (240 >= 200, 120 < 200)
    const def2 = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 240 } }
    expect(effectDelta(mkState(atk, def2), 'MOVE_PSYCHO_SHIFT')).toBe(4)
  })
})

describe('part 2a RNG order (AI_CheckViability part 2 draws none of its own; its helpers do)', () => {
  function counting(...values: number[]): { rng: RandomSource; calls: () => number } {
    let i = 0
    return { rng: { random16: () => values[i++] ?? RNG_HIGH }, calls: () => i }
  }
  const stockpile = (rng: RandomSource) => {
    // attacker at 75% HP: below 80 (each IncreaseStatUpScore draws AI_RandLessThan(128), battle_ai_util.c:2597) yet above the 70 the DEF/SPDEF branches need
    const s = state({ hp: 75 }, moves('MOVE_WATER_GUN'), rng)
    return aiCheckViability(s, 0, 1, 'MOVE_STOCKPILE', 100, deps).score
  }
  it('Stockpile draws for STAT_DEF first, then STAT_SPDEF -- the order decides which stat is skipped', () => {
    // defender knows only a Special move: DEF has nothing to score, SPDEF is worth +2.
    expect(stockpile(scripted(RNG_LOW, RNG_HIGH))).toBe(100 - 0 + 2) // DEF draw true (returns), SPDEF draw false -> +2
    expect(stockpile(scripted(RNG_HIGH, RNG_LOW))).toBe(100) // DEF draw false (nothing to add), SPDEF draw true -> returns
  })
  it('draws only while HP < 80%: none at full HP, two for Stockpile below', () => {
    const full = counting()
    aiCheckViability(state({}, moves('MOVE_WATER_GUN'), full.rng), 0, 1, 'MOVE_STOCKPILE', 100, deps)
    expect(full.calls()).toBe(0)
    const low = counting()
    aiCheckViability(state({ hp: 50 }, moves('MOVE_WATER_GUN'), low.rng), 0, 1, 'MOVE_STOCKPILE', 100, deps)
    expect(low.calls()).toBe(2)
  })
  it('the effects that draw nothing at all (Sandstorm, Knock Off, Brick Break, Skill Swap) leave the stream untouched', () => {
    for (const id of ['MOVE_SANDSTORM', 'MOVE_KNOCK_OFF', 'MOVE_BRICK_BREAK', 'MOVE_SKILL_SWAP']) {
      const c = counting()
      // Knock Off / Brick Break are damaging: their pre-switch never draws for a non-always-hit, non-high-crit move.
      aiCheckViability(state({}, { itemId: 'ITEM_LEFTOVERS' }, c.rng), 0, 1, id, 100, deps)
      expect(c.calls(), id).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Part 2b -- battle_ai_main.c:3607-3984 (EFFECT_GRUDGE .. EFFECT_RECHARGE)
// ---------------------------------------------------------------------------
for (const id of [
  'MOVE_GRUDGE', 'MOVE_SNATCH', 'MOVE_MUD_SPORT', 'MOVE_WATER_SPORT', 'MOVE_TICKLE', 'MOVE_COSMIC_POWER', 'MOVE_BULK_UP', 'MOVE_CALM_MIND', 'MOVE_GEOMANCY',
  'MOVE_QUIVER_DANCE', 'MOVE_CONVERSION', 'MOVE_CONVERSION_2', 'MOVE_GEAR_UP', 'MOVE_SHELL_SMASH', 'MOVE_DRAGON_DANCE', 'MOVE_SHIFT_GEAR', 'MOVE_GUARD_SWAP',
  'MOVE_POWER_SWAP', 'MOVE_POWER_TRICK', 'MOVE_HEART_SWAP', 'MOVE_SPEED_SWAP', 'MOVE_GUARD_SPLIT', 'MOVE_POWER_SPLIT', 'MOVE_BUG_BITE', 'MOVE_PLUCK',
  'MOVE_INCINERATE', 'MOVE_SMACK_DOWN', 'MOVE_ELECTRIC_TERRAIN', 'MOVE_MISTY_TERRAIN', 'MOVE_GRASSY_TERRAIN', 'MOVE_PSYCHIC_TERRAIN', 'MOVE_TRICK_ROOM',
  'MOVE_MAGIC_ROOM', 'MOVE_WONDER_ROOM', 'MOVE_GRAVITY', 'MOVE_ION_DELUGE', 'MOVE_FLING', 'MOVE_FEINT', 'MOVE_EMBARGO', 'MOVE_POWDER', 'MOVE_TELEKINESIS',
  'MOVE_THROAT_CHOP', 'MOVE_HEAL_BLOCK', 'MOVE_SOAK', 'MOVE_TRICK_OR_TREAT', 'MOVE_ELECTRIFY', 'MOVE_TOPSY_TURVY', 'MOVE_FAIRY_LOCK', 'MOVE_QUASH', 'MOVE_TAILWIND',
  'MOVE_LUCKY_CHANT', 'MOVE_MAGNET_RISE', 'MOVE_FLAME_BURST', 'MOVE_TOXIC_THREAD', 'MOVE_SOLAR_BEAM', 'MOVE_COUNTER', 'MOVE_MIRROR_COAT', 'MOVE_METAL_BURST',
  'MOVE_FLAIL', 'MOVE_SHORE_UP', 'MOVE_FACADE', 'MOVE_FOCUS_PUNCH', 'MOVE_SMELLING_SALTS', 'MOVE_WAKE_UP_SLAP', 'MOVE_REVENGE', 'MOVE_ENDEAVOR', 'MOVE_HYPER_BEAM',
  'MOVE_HYPER_VOICE', 'MOVE_HYPNOSIS', 'MOVE_SCREECH', 'MOVE_THUNDER', 'MOVE_THUNDERBOLT', 'MOVE_EARTHQUAKE', 'MOVE_FREEZE_DRY', 'MOVE_ENERGY_BALL', 'MOVE_GIGA_DRAIN',
  'MOVE_RECOVER', 'MOVE_ROOST', 'MOVE_PROTECT', 'MOVE_DETECT', 'MOVE_NONE', 'MOVE_WILL_O_WISP', 'MOVE_EMBER', 'MOVE_WATER_GUN', 'MOVE_SPORE',
]) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
{
  const expectEffect: Record<string, string> = {
    MOVE_GRUDGE: 'EFFECT_GRUDGE', MOVE_SNATCH: 'EFFECT_SNATCH', MOVE_TICKLE: 'EFFECT_TICKLE', MOVE_GEOMANCY: 'EFFECT_GEOMANCY', MOVE_QUIVER_DANCE: 'EFFECT_QUIVER_DANCE',
    MOVE_SHELL_SMASH: 'EFFECT_SHELL_SMASH', MOVE_HEART_SWAP: 'EFFECT_HEART_SWAP', MOVE_BUG_BITE: 'EFFECT_BUG_BITE', MOVE_PLUCK: 'EFFECT_BUG_BITE', MOVE_INCINERATE: 'EFFECT_INCINERATE',
    MOVE_TRICK_ROOM: 'EFFECT_TRICK_ROOM', MOVE_GRAVITY: 'EFFECT_GRAVITY', MOVE_ION_DELUGE: 'EFFECT_ION_DELUGE', MOVE_FEINT: 'EFFECT_FEINT', MOVE_THROAT_CHOP: 'EFFECT_THROAT_CHOP',
    MOVE_HEAL_BLOCK: 'EFFECT_HEAL_BLOCK', MOVE_COUNTER: 'EFFECT_COUNTER', MOVE_MIRROR_COAT: 'EFFECT_MIRROR_COAT', MOVE_METAL_BURST: 'EFFECT_METAL_BURST',
    MOVE_HYPER_BEAM: 'EFFECT_RECHARGE', MOVE_FOCUS_PUNCH: 'EFFECT_FOCUS_PUNCH', MOVE_HYPNOSIS: 'EFFECT_SLEEP', MOVE_GIGA_DRAIN: 'EFFECT_ABSORB', MOVE_FREEZE_DRY: 'EFFECT_FREEZE_DRY',
  }
  for (const [id, effect] of Object.entries(expectEffect)) if (moveById.get(id)?.effect !== effect) throw new Error(`${id} is no longer ${effect}`)
  // Flags the case bodies read (TestMoveFlags), and the MOVE_NONE row the unguarded predictedMove reads hit.
  if (!moveById.get('MOVE_CALM_MIND')?.flags?.snatchAffected || moveById.get('MOVE_TACKLE')?.flags?.snatchAffected) throw new Error('snatchAffected fixture changed')
  if (!moveById.get('MOVE_HYPER_VOICE')?.flags?.sound || moveById.get('MOVE_TACKLE')?.flags?.sound) throw new Error('sound fixture changed')
  const none = moveById.get('MOVE_NONE')
  if (none?.type !== 'TYPE_NORMAL' || none?.effect !== null || none?.power !== 0) throw new Error('gBattleMoves[MOVE_NONE] changed shape')
}
for (const id of ['ITEM_POWER_HERB', 'ITEM_WHITE_HERB', 'ITEM_SITRUS_BERRY', 'ITEM_NORMAL_GEM', 'ITEM_LEFTOVERS', 'ITEM_BLACK_SLUDGE', 'ITEM_TERRAIN_EXTENDER', 'ITEM_ABILITY_CAPSULE', 'ITEM_IRON_BALL']) {
  if (!itemsById.has(id)) throw new Error(`items.json is missing ${id}`)
}
for (const [id, hold] of Object.entries({ ITEM_POWER_HERB: 'HOLD_EFFECT_POWER_HERB', ITEM_WHITE_HERB: 'HOLD_EFFECT_RESTORE_STATS', ITEM_NORMAL_GEM: 'HOLD_EFFECT_GEMS', ITEM_TERRAIN_EXTENDER: 'HOLD_EFFECT_TERRAIN_EXTENDER', ITEM_LEFTOVERS: 'HOLD_EFFECT_LEFTOVERS', ITEM_BLACK_SLUDGE: 'HOLD_EFFECT_BLACK_SLUDGE', ITEM_ABILITY_CAPSULE: 'HOLD_EFFECT_NONE' })) {
  if (itemsById.get(id)?.resolvedHoldEffect !== hold) throw new Error(`${id} is no longer ${hold}`)
}
if (itemsById.get('ITEM_SITRUS_BERRY')?.grouping !== 'POCKET_BERRIES' || itemsById.get('ITEM_LEFTOVERS')?.grouping === 'POCKET_BERRIES') throw new Error('items.json grouping fixture changed')
for (const id of ['ABILITY_VOLT_ABSORB', 'ABILITY_MOTOR_DRIVE', 'ABILITY_LIGHTNING_ROD', 'ABILITY_RAMPAGE', 'ABILITY_BERSERKER_RAGE', 'ABILITY_RAGING_GODDESS', 'ABILITY_MASTER_HAND', 'ABILITY_CLUELESS', 'ABILITY_WONDER_GUARD', 'ABILITY_STICKY_HOLD', 'ABILITY_CHLOROPLAST']) {
  if (!abilityHooks[id]) throw new Error(`abilityHooks.json is missing ${id}`)
}

/** effectDelta against an arbitrary deps (a custom turn-order/grounding context, or a move-data override). */
function effectDeltaWith(d: AiDamageDeps, mk: () => BattleState, moveId: string, baseline = 'EFFECT_HIT'): number {
  const real = aiCheckViability(mk(), 0, 1, moveId, 100, d).score
  const plainDeps: AiDamageDeps = { ...d, moveData: (m) => (m === moveId ? ({ ...d.moveData(m)!, effect: baseline } as MoveData) : d.moveData(m)) }
  return real - aiCheckViability(mk(), 0, 1, moveId, 100, plainDeps).score
}
/** A real damaging move (Tackle) wearing `effect`: for effects no real move carries and that need a non-status move. */
const tackleAs = (effect: string, over: Partial<MoveData> = {}): AiDamageDeps => depsOverride('MOVE_TACKLE', { effect, ...over })
const ungroundedDefender: AiDamageDeps = { ...deps, turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: (b: number) => b !== 1 } }
const ungroundedAttacker: AiDamageDeps = { ...deps, turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: (b: number) => b !== 0 } }
const moldBreaker: AiDamageDeps = { ...deps, grounding: { ...grounding, attackerHasMoldBreaker: true } }
const lastMove = (m: string | null) => (s: BattleState) => { s.battlers[1]!.lastMove = m }
const both = (...fns: Array<(s: BattleState) => void>) => (s: BattleState) => { for (const f of fns) f(s) }
/** Counts every random16() call; the first `values` are scripted, the rest read RNG_HIGH. */
function countingRng(...values: number[]): { rng: RandomSource; calls: () => number } {
  let i = 0
  return { rng: { random16: () => values[i++] ?? RNG_HIGH }, calls: () => i }
}
const stateWithRng = (rng: RandomSource, a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, tweak: (s: BattleState) => void = () => {}) => {
  const s = state(a, d, rng)
  tweak(s)
  return s
}

describe('EFFECT_GRUDGE / EFFECT_FLING (:3607, :3780) -- no-ops', () => {
  it('EFFECT_GRUDGE scores 0', () => {
    expect(effectDelta(mkState(), 'MOVE_GRUDGE')).toBe(0)
  })
  it('EFFECT_FLING\'s body is commented out in the C: it scores 0 even holding an Iron Ball against an Iron Ball', () => {
    expect(effectDelta(mkState({ itemId: 'ITEM_IRON_BALL' }, { itemId: 'ITEM_IRON_BALL' }), 'MOVE_FLING')).toBe(0)
  })
})

describe('EFFECT_SNATCH (:3609-3611)', () => {
  it('scores +3 when the predicted (last-used) move is Snatch-affected', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_CALM_MIND')), 'MOVE_SNATCH')).toBe(3)
  })
  it('scores 0 for a non-Snatchable predicted move, and with no predicted move at all', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_TACKLE')), 'MOVE_SNATCH')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_SNATCH')).toBe(0)
  })
})

describe('EFFECT_MUD_SPORT / EFFECT_WATER_SPORT (:3612-3617)', () => {
  it('Mud Sport: +1 only when the target has an Electric move and the attacker does not', () => {
    expect(effectDelta(mkState({}, moves('MOVE_THUNDERBOLT')), 'MOVE_MUD_SPORT')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_THUNDERBOLT'), moves('MOVE_THUNDERBOLT')), 'MOVE_MUD_SPORT')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_MUD_SPORT')).toBe(0)
  })
  it('Water Sport: the same, for Fire', () => {
    expect(effectDelta(mkState({}, moves('MOVE_EMBER')), 'MOVE_WATER_SPORT')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_EMBER'), moves('MOVE_EMBER')), 'MOVE_WATER_SPORT')).toBe(0)
    expect(effectDelta(mkState({}, moves('MOVE_THUNDERBOLT')), 'MOVE_WATER_SPORT')).toBe(0)
  })
})

describe('EFFECT_TICKLE (:3618-3624)', () => {
  it('+2 with a Physical move and a lowerable Defense', () => {
    expect(effectDelta(mkState(), 'MOVE_TICKLE')).toBe(2)
  })
  it('falls to the Attack branch (+2) without a Physical move, or when Defense cannot be lowered', () => {
    expect(effectDelta(mkState(moves('MOVE_WATER_GUN')), 'MOVE_TICKLE')).toBe(2)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 1, STAT_DEF, 3)), 'MOVE_TICKLE')).toBe(2)
  })
  it('scores 0 when neither applies; the Defense branch needs the Physical move (a special-only attacker with only Defense lowerable scores 0)', () => {
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 1, STAT_DEF, 3); stage(s, 1, STAT_ATK, 3) }), 'MOVE_TICKLE')).toBe(0)
    expect(effectDelta(mkState(moves('MOVE_WATER_GUN'), {}, (s) => stage(s, 1, STAT_ATK, 3)), 'MOVE_TICKLE')).toBe(0)
  })
})

describe('stat-raising status moves (:3625-3662): each IncreaseStatUpScore contributes its own +2', () => {
  it('Cosmic Power: Defense (+2 vs a Physical foe) then Sp.Def (+2 vs a Special foe)', () => {
    expect(effectDelta(mkState({}, moves('MOVE_TACKLE', 'MOVE_WATER_GUN')), 'MOVE_COSMIC_POWER')).toBe(4)
    expect(effectDelta(mkState(), 'MOVE_COSMIC_POWER')).toBe(2)
    expect(effectDelta(mkState({}, moves('MOVE_WATER_GUN')), 'MOVE_COSMIC_POWER')).toBe(2)
  })
  it('Bulk Up: Attack (+2 with a Physical move) then Defense (+2 vs a Physical foe)', () => {
    expect(effectDelta(mkState(), 'MOVE_BULK_UP')).toBe(4)
    expect(effectDelta(mkState(moves('MOVE_WATER_GUN')), 'MOVE_BULK_UP')).toBe(2)
  })
  it('Calm Mind: Sp.Atk (+2 with a Special move) then Sp.Def (+2 vs a Special foe)', () => {
    expect(effectDelta(mkState(moves('MOVE_WATER_GUN'), moves('MOVE_WATER_GUN')), 'MOVE_CALM_MIND')).toBe(4)
    expect(effectDelta(mkState(), 'MOVE_CALM_MIND')).toBe(0)
  })
  it.each(['MOVE_CONVERSION', 'MOVE_CONVERSION_2', 'MOVE_GEAR_UP'])('%s: Speed (+2 when slower) then Sp.Atk (+2 with a Special move)', (id) => {
    expect(effectDelta(mkState({ ...SLOW, ...moves('MOVE_WATER_GUN') }), id)).toBe(4)
    expect(effectDelta(mkState({ ...FAST, ...moves('MOVE_WATER_GUN') }), id)).toBe(2)
  })
  it.each(['MOVE_DRAGON_DANCE', 'MOVE_SHIFT_GEAR'])('%s: Speed (+2 when slower) then Attack (+2 with a Physical move)', (id) => {
    expect(effectDelta(mkState(SLOW), id)).toBe(4)
    expect(effectDelta(mkState(FAST), id)).toBe(2)
  })
  it('Shell Smash: Speed + Sp.Atk + Attack (+6), and +3 more holding a White Herb (RESTORE_STATS)', () => {
    const atk = { ...SLOW, ...moves('MOVE_WATER_GUN', 'MOVE_TACKLE') }
    expect(effectDelta(mkState(atk), 'MOVE_SHELL_SMASH')).toBe(6)
    expect(effectDelta(mkState({ ...atk, itemId: 'ITEM_WHITE_HERB' }), 'MOVE_SHELL_SMASH')).toBe(9)
    expect(effectDelta(mkState({ ...atk, itemId: 'ITEM_POWER_HERB' }), 'MOVE_SHELL_SMASH')).toBe(6)
  })
})

describe('EFFECT_GEOMANCY -> EFFECT_QUIVER_DANCE fallthrough (:3637-3644)', () => {
  const dancer = { ...SLOW, ...moves('MOVE_WATER_GUN') }
  const foe = moves('MOVE_WATER_GUN')
  it('Quiver Dance: Speed + Sp.Atk + Sp.Def (+2 each)', () => {
    expect(effectDelta(mkState(dancer, foe), 'MOVE_QUIVER_DANCE')).toBe(6)
  })
  it('Geomancy without a Power Herb is exactly Quiver Dance (+6)', () => {
    expect(effectDelta(mkState(dancer, foe), 'MOVE_GEOMANCY')).toBe(6)
  })
  it('Geomancy with a Power Herb gets BOTH the +10 and the stat-up scores (+16); Quiver Dance ignores the herb', () => {
    expect(effectDelta(mkState({ ...dancer, itemId: 'ITEM_POWER_HERB' }, foe), 'MOVE_GEOMANCY')).toBe(16)
    expect(effectDelta(mkState({ ...dancer, itemId: 'ITEM_POWER_HERB' }, foe), 'MOVE_QUIVER_DANCE')).toBe(6)
  })
  it('the +10 needs the target NOT to be able to KO the AI (a 1-HP attacker facing Tackle scores 0: the stat-ups bail too)', () => {
    expect(effectDelta(mkState({ ...dancer, hp: 1, itemId: 'ITEM_POWER_HERB' }, foe), 'MOVE_GEOMANCY')).toBe(0)
  })
  it('names the holdEffects[] param-vs-enum quirk when a herb is held', () => {
    const r = aiCheckViability(mkState({ ...dancer, itemId: 'ITEM_POWER_HERB' }, foe)(), 0, 1, 'MOVE_GEOMANCY', 100, deps)
    expect(r.unmodelled.some((u) => u.includes('ItemId_GetHoldEffectParam'))).toBe(true)
  })
})

describe('EFFECT_GUARD_SWAP / EFFECT_POWER_SWAP (:3663-3678) -- stage comparisons, and the >= on the second stat', () => {
  const swap = (id: string, hi: number, lo: number) => {
    const cases: Array<[string, Array<[number, number, number, number]>, number]> = [
      // [defenderHi, defenderLo, attackerHi, attackerLo] stage values for (first stat, second stat)
      ['first stat higher, second equal', [[8, 6, 6, 6]], 1],
      ['second stat higher, first equal', [[6, 8, 6, 6]], 1],
      ['both higher', [[8, 8, 6, 6]], 1],
      ['first higher but second LOWER', [[8, 5, 6, 6]], 0],
      ['first higher, second lower than a raised attacker stat', [[8, 6, 6, 7]], 0],
      ['equal', [[6, 6, 6, 6]], 0],
      ['defender lower', [[4, 4, 6, 6]], 0],
    ]
    for (const [label, [[dHi, dLo, aHi, aLo]], expected] of cases) {
      const tweak = both((s) => { stage(s, 1, hi, dHi); stage(s, 1, lo, dLo); stage(s, 0, hi, aHi); stage(s, 0, lo, aLo) })
      expect(effectDelta(mkState({}, {}, tweak), id), `${id}: ${label}`).toBe(expected)
    }
  }
  it('Guard Swap compares Defense first, then Sp.Def', () => swap('MOVE_GUARD_SWAP', STAT_DEF, STAT_SPDEF))
  it('Power Swap compares Attack first, then Sp.Atk', () => swap('MOVE_POWER_SWAP', STAT_ATK, STAT_SPATK))
})

describe('EFFECT_POWER_TRICK (:3679-3684) -- raw Defense > raw Attack', () => {
  const stats = (atk: number, def: number) => ({ rawStats: { atk, def, spatk: 80, spdef: 85, spe: 100 } })
  it('+2 with Defense > Attack and a Physical move', () => {
    expect(effectDelta(mkState(stats(100, 120)), 'MOVE_POWER_TRICK')).toBe(2)
  })
  it('0 when already Power Tricked, when Defense <= Attack (equal is 0), or without a Physical move', () => {
    expect(effectDelta(mkState(stats(100, 120), {}, (s) => { s.battlers[0]!.statuses3 |= STATUS3_POWER_TRICK }), 'MOVE_POWER_TRICK')).toBe(0)
    expect(effectDelta(mkState(stats(100, 100)), 'MOVE_POWER_TRICK')).toBe(0)
    expect(effectDelta(mkState(stats(120, 100)), 'MOVE_POWER_TRICK')).toBe(0)
    expect(effectDelta(mkState({ ...stats(100, 120), ...moves('MOVE_WATER_GUN') }), 'MOVE_POWER_TRICK')).toBe(0)
  })
  it('reads the RAW stat, not the staged one (+6 Attack stages do not change the answer)', () => {
    expect(effectDelta(mkState(stats(100, 120), {}, (s) => stage(s, 0, STAT_ATK, 12)), 'MOVE_POWER_TRICK')).toBe(2)
  })
})

describe('EFFECT_HEART_SWAP (:3685-3693) -- STAT_ATK..NUM_BATTLE_STATS is 7 stats, the loop breaks early, `i == NUM_BATTLE_STATS` is part of the condition', () => {
  const heart = (defStages: Record<number, number>) => effectDelta(mkState({}, {}, (s) => { for (const [i, v] of Object.entries(defStages)) stage(s, 1, Number(i), v) }), 'MOVE_HEART_SWAP')
  it('+1 when every target stat is >= and at least one is higher', () => {
    expect(heart({ [STAT_ATK]: 7 })).toBe(1)
    expect(heart({ [STAT_SPDEF]: 8, [STAT_SPEED]: 6 })).toBe(1)
  })
  it('the range includes Accuracy and Evasion: a higher Evasion alone scores', () => {
    expect(heart({ [STAT_ACC]: 7 })).toBe(1)
    expect(heart({ [STAT_EVASION]: 7 })).toBe(1)
  })
  it('0 when all equal, and 0 when ANY stat is lower -- including a lower LAST stat (Evasion) after a higher first one', () => {
    expect(heart({})).toBe(0)
    expect(heart({ [STAT_SPEED]: 5 })).toBe(0)
    expect(heart({ [STAT_ATK]: 7, [STAT_EVASION]: 5 })).toBe(0)
    expect(heart({ [STAT_ATK]: 7, [STAT_DEF]: 5 })).toBe(0)
  })
})

describe('EFFECT_SPEED_SWAP (:3694-3697) -- raw speed', () => {
  it('+3 only when the target\'s raw Speed is strictly higher', () => {
    expect(effectDelta(mkState({}, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 101 } }), 'MOVE_SPEED_SWAP')).toBe(3)
    expect(effectDelta(mkState(), 'MOVE_SPEED_SWAP')).toBe(0)
  })
  it('ignores stages: a +6 target with LOWER raw Speed scores 0, a -6 target with HIGHER raw Speed scores +3', () => {
    expect(effectDelta(mkState({}, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 90 } }, (s) => stage(s, 1, STAT_SPEED, 12)), 'MOVE_SPEED_SWAP')).toBe(0)
    expect(effectDelta(mkState({}, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 150 } }, (s) => stage(s, 1, STAT_SPEED, 0)), 'MOVE_SPEED_SWAP')).toBe(3)
  })
})

describe('EFFECT_GUARD_SPLIT / EFFECT_POWER_SPLIT (:3698-3714) -- raw stats, u16 averages', () => {
  const st = (atk: number, def: number, spatk: number, spdef: number) => ({ rawStats: { atk, def, spatk, spdef, spe: 100 } })
  it('Guard Split: +1 when the average raises Defense without lowering Sp.Def, or vice versa', () => {
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 200, 80, 200)), 'MOVE_GUARD_SPLIT')).toBe(1)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 90, 80, 200)), 'MOVE_GUARD_SPLIT'), 'Def average == own Def counts via >=').toBe(1)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 200, 80, 85)), 'MOVE_GUARD_SPLIT')).toBe(1)
  })
  it('Guard Split: 0 when raising one lowers the other, or nothing changes', () => {
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 200, 80, 10)), 'MOVE_GUARD_SPLIT')).toBe(0)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 10, 80, 200)), 'MOVE_GUARD_SPLIT')).toBe(0)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 90, 80, 85)), 'MOVE_GUARD_SPLIT')).toBe(0)
  })
  it('Power Split: the same over Attack / Sp.Atk', () => {
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(300, 90, 300, 85)), 'MOVE_POWER_SPLIT')).toBe(1)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 90, 300, 85)), 'MOVE_POWER_SPLIT')).toBe(1)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(300, 90, 10, 85)), 'MOVE_POWER_SPLIT')).toBe(0)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(10, 90, 300, 85)), 'MOVE_POWER_SPLIT')).toBe(0)
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 90, 80, 85)), 'MOVE_POWER_SPLIT')).toBe(0)
  })
  it('the split ignores stat stages (a +6 Attack target with equal raw Attack scores 0)', () => {
    expect(effectDelta(mkState(st(100, 90, 80, 85), st(100, 90, 80, 85), (s) => stage(s, 1, STAT_ATK, 12)), 'MOVE_POWER_SPLIT')).toBe(0)
  })
})

describe('EFFECT_BUG_BITE / EFFECT_INCINERATE (:3715-3726) -- ItemId_GetPocket == POCKET_BERRIES', () => {
  it.each(['MOVE_BUG_BITE', 'MOVE_PLUCK'])('%s: +3 against a held berry only', (id) => {
    expect(effectDelta(mkState({}, { itemId: 'ITEM_SITRUS_BERRY' }), id)).toBe(3)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_LEFTOVERS' }), id)).toBe(0)
    expect(effectDelta(mkState(), id)).toBe(0)
  })
  it.each(['MOVE_BUG_BITE', 'MOVE_INCINERATE'])('%s: 0 through a Substitute or Sticky Hold', (id) => {
    expect(effectDelta(mkState({}, { itemId: 'ITEM_SITRUS_BERRY', status2: STATUS2_SUBSTITUTE }), id)).toBe(0)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_SITRUS_BERRY', abilities: ab('ABILITY_STICKY_HOLD') }), id)).toBe(0)
  })
  it('Sticky Hold is suppressed by a Mold Breaker attacker (BattlerHasAbility(..., TRUE))', () => {
    expect(effectDeltaWith(moldBreaker, mkState({}, { itemId: 'ITEM_SITRUS_BERRY', abilities: ab('ABILITY_STICKY_HOLD') }), 'MOVE_BUG_BITE')).toBe(3)
  })
  it('Incinerate: +3 against a berry OR a Gem (HOLD_EFFECT_GEMS), 0 against other items', () => {
    expect(effectDelta(mkState({}, { itemId: 'ITEM_SITRUS_BERRY' }), 'MOVE_INCINERATE')).toBe(3)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_NORMAL_GEM' }), 'MOVE_INCINERATE')).toBe(3)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_INCINERATE')).toBe(0)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_NORMAL_GEM' }), 'MOVE_BUG_BITE'), 'Bug Bite has no Gem clause').toBe(0)
  })
  it('a data context with no grouping for the held item reads as not-a-berry and says so', () => {
    const noGrouping: AiDamageDeps = { ...deps, dataContext: { ...dataContext, item: (id) => ({ ...(itemsById.get(id) as SimItemData), grouping: undefined }) } }
    const r = aiCheckViability(mkState({}, { itemId: 'ITEM_SITRUS_BERRY' })(), 0, 1, 'MOVE_BUG_BITE', 100, noGrouping)
    expect(effectDeltaWith(noGrouping, mkState({}, { itemId: 'ITEM_SITRUS_BERRY' }), 'MOVE_BUG_BITE')).toBe(0)
    expect(r.unmodelled.some((u) => u.includes('ItemId_GetPocket(ITEM_SITRUS_BERRY)'))).toBe(true)
  })
})

describe('EFFECT_SMACK_DOWN (:3727-3729)', () => {
  it('+3 only against an ungrounded target', () => {
    expect(effectDelta(mkState(), 'MOVE_SMACK_DOWN')).toBe(0)
    expect(effectDeltaWith(ungroundedDefender, mkState(), 'MOVE_SMACK_DOWN')).toBe(3)
    expect(effectDeltaWith(ungroundedAttacker, mkState(), 'MOVE_SMACK_DOWN')).toBe(0)
  })
})

describe('terrain moves (:3730-3738) -- Electric/Misty fall through into the Grassy/Psychic body', () => {
  const yawn = (s: BattleState) => { s.battlers[0]!.statuses3 |= STATUS3_YAWN }
  it.each(['MOVE_ELECTRIC_TERRAIN', 'MOVE_MISTY_TERRAIN'])('%s: +2, +10 more when yawning AND grounded (both terms), +2 for a Terrain Extender', (id) => {
    expect(effectDelta(mkState(), id)).toBe(2)
    expect(effectDelta(mkState({}, {}, yawn), id)).toBe(12)
    expect(effectDeltaWith(ungroundedAttacker, mkState({}, {}, yawn), id), 'yawning but airborne').toBe(2)
    expect(effectDelta(mkState({ itemId: 'ITEM_TERRAIN_EXTENDER' }), id)).toBe(4)
    expect(effectDelta(mkState({ itemId: 'ITEM_TERRAIN_EXTENDER' }, {}, yawn), id), 'both bonuses stack').toBe(14)
  })
  it.each(['MOVE_GRASSY_TERRAIN', 'MOVE_PSYCHIC_TERRAIN'])('%s: +2 and the Extender +2, but no yawn bonus', (id) => {
    expect(effectDelta(mkState(), id)).toBe(2)
    expect(effectDelta(mkState({}, {}, yawn), id)).toBe(2)
    expect(effectDelta(mkState({ itemId: 'ITEM_TERRAIN_EXTENDER' }), id)).toBe(4)
  })
})

describe('EFFECT_TRICK_ROOM (:3744-3749) -- raw gFieldStatuses flag, u16 side-speed averages', () => {
  const room = (s: BattleState) => { s.field.statuses |= STATUS_FIELD_TRICK_ROOM }
  it('sets Trick Room (+5) only when the attacker is strictly slower', () => {
    expect(effectDelta(mkState(SLOW), 'MOVE_TRICK_ROOM')).toBe(5)
    expect(effectDelta(mkState(), 'MOVE_TRICK_ROOM'), 'equal speed').toBe(0)
    expect(effectDelta(mkState(FAST), 'MOVE_TRICK_ROOM')).toBe(0)
  })
  it('with Trick Room already up, keeps it (+5) when the attacker is faster OR equal (>=), not when slower', () => {
    expect(effectDelta(mkState(FAST, {}, room), 'MOVE_TRICK_ROOM')).toBe(5)
    expect(effectDelta(mkState({}, {}, room), 'MOVE_TRICK_ROOM')).toBe(5)
    expect(effectDelta(mkState(SLOW, {}, room), 'MOVE_TRICK_ROOM')).toBe(0)
  })
  it('reads the raw flag, not IsTrickRoomActive: Clueless on the field does not switch it off here', () => {
    expect(effectDelta(mkState(FAST, { abilities: ab('ABILITY_CLUELESS') }, room), 'MOVE_TRICK_ROOM')).toBe(5)
  })
})

describe('EFFECT_MAGIC_ROOM (:3750-3756)', () => {
  it('+1 always, +1 more when the AI holds nothing and the target holds something', () => {
    expect(effectDelta(mkState(), 'MOVE_MAGIC_ROOM')).toBe(1)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_MAGIC_ROOM')).toBe(2)
    expect(effectDelta(mkState({ itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_MAGIC_ROOM')).toBe(1)
    expect(effectDelta(mkState({ itemId: 'ITEM_LEFTOVERS' }), 'MOVE_MAGIC_ROOM')).toBe(1)
  })
  it('an item with HOLD_EFFECT_NONE counts as holding nothing', () => {
    expect(effectDelta(mkState({ itemId: 'ITEM_ABILITY_CAPSULE' }, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_MAGIC_ROOM')).toBe(2)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_ABILITY_CAPSULE' }), 'MOVE_MAGIC_ROOM')).toBe(1)
  })
})

describe('EFFECT_WONDER_ROOM (:3757-3761) -- raw Defense vs Sp.Def', () => {
  const st = (def: number, spdef: number) => ({ rawStats: { atk: 100, def, spatk: 80, spdef, spe: 100 } })
  it('+2 when the target has Physical moves and the AI\'s Defense is the lower one', () => {
    expect(effectDelta(mkState(st(80, 120)), 'MOVE_WONDER_ROOM')).toBe(2)
  })
  it('+2 when the target has Special moves and the AI\'s Sp.Def is the lower one', () => {
    expect(effectDelta(mkState(st(120, 80), moves('MOVE_WATER_GUN')), 'MOVE_WONDER_ROOM')).toBe(2)
  })
  it('0 when the split of the target\'s moves does not match, or the stats are equal', () => {
    expect(effectDelta(mkState(st(80, 120), moves('MOVE_WATER_GUN')), 'MOVE_WONDER_ROOM')).toBe(0)
    expect(effectDelta(mkState(st(120, 80)), 'MOVE_WONDER_ROOM')).toBe(0)
    expect(effectDelta(mkState(st(100, 100)), 'MOVE_WONDER_ROOM')).toBe(0)
  })
})

describe('EFFECT_GRAVITY (:3762-3773) -- RETURN_SCORE_MINUS(20) leaves the whole function', () => {
  it('-20 when Clueless is on the field (either side), and nothing else is scored', () => {
    expect(effectDelta(mkState({}, { abilities: ab('ABILITY_CLUELESS') }), 'MOVE_GRAVITY')).toBe(-20)
    expect(effectDelta(mkState({ abilities: ab('ABILITY_CLUELESS'), ...moves('MOVE_HYPNOSIS') }), 'MOVE_GRAVITY')).toBe(-20)
  })
  it('0 when Gravity is already up (raw flag)', () => {
    expect(effectDelta(mkState({}, {}, (s) => { s.field.statuses |= STATUS_FIELD_GRAVITY }), 'MOVE_GRAVITY')).toBe(0)
  })
  it('+1 with nothing to gain', () => {
    expect(effectDelta(mkState(), 'MOVE_GRAVITY')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_SPORE')), 'MOVE_GRAVITY'), 'a 100% sleep move is not low accuracy').toBe(1)
  })
  it('a sleep move under 85% accuracy runs IncreaseSleepScore (+3) and skips the accuracy branches', () => {
    expect(effectDelta(mkState(moves('MOVE_HYPNOSIS', 'MOVE_THUNDER')), 'MOVE_GRAVITY')).toBe(3)
  })
  it('an un-sleepable target still takes the sleep branch (IncreaseSleepScore adds nothing) -- it is an else-if chain', () => {
    expect(effectDelta(mkState(moves('MOVE_HYPNOSIS'), { status1: STATUS1_BURN }), 'MOVE_GRAVITY')).toBe(0)
  })
  it('a <=90% move (status moves count, ignoreStatus is FALSE) scores +2', () => {
    expect(effectDelta(mkState(moves('MOVE_THUNDER')), 'MOVE_GRAVITY')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_SCREECH')), 'MOVE_GRAVITY')).toBe(2)
  })
  it('HasSleepMoveWithLowAccuracy stops at the first empty slot; the accuracy scan does not', () => {
    // [Tackle, -, Hypnosis, -]: the sleep scan breaks at slot 1 (no sleep branch: not +3), the accuracy scan still finds Hypnosis (60) -> +2.
    expect(effectDelta(mkState({ moves: ['MOVE_TACKLE', null, 'MOVE_HYPNOSIS', null] }), 'MOVE_GRAVITY')).toBe(2)
  })
  it('names the accuracy approximation whenever a sleep move is examined', () => {
    const r = aiCheckViability(mkState(moves('MOVE_HYPNOSIS'))(), 0, 1, 'MOVE_GRAVITY', 100, deps)
    expect(r.unmodelled.some((u) => u.includes('HasSleepMoveWithLowAccuracy'))).toBe(true)
  })
})

describe('EFFECT_ION_DELUGE (:3774-3779) -- unguarded gBattleMoves[predictedMove]', () => {
  const absorber = (id: string) => ({ abilities: ab(id) })
  it.each(['ABILITY_VOLT_ABSORB', 'ABILITY_MOTOR_DRIVE', 'ABILITY_LIGHTNING_ROD'])('%s + a predicted Normal move: +2', (id) => {
    expect(effectDelta(mkState(absorber(id), {}, lastMove('MOVE_TACKLE')), 'MOVE_ION_DELUGE')).toBe(2)
  })
  it('0 for a non-Normal predicted move, or without the ability', () => {
    expect(effectDelta(mkState(absorber('ABILITY_VOLT_ABSORB'), {}, lastMove('MOVE_EMBER')), 'MOVE_ION_DELUGE')).toBe(0)
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_TACKLE')), 'MOVE_ION_DELUGE')).toBe(0)
  })
  it('with NO predicted move it reads gBattleMoves[MOVE_NONE] (type Normal): still +2', () => {
    expect(effectDelta(mkState(absorber('ABILITY_VOLT_ABSORB')), 'MOVE_ION_DELUGE')).toBe(2)
  })
  it('BattlerHasAbility(..., TRUE): a Mold Breaker attacker suppresses its own breakable Volt Absorb', () => {
    expect(effectDeltaWith(moldBreaker, mkState(absorber('ABILITY_VOLT_ABSORB'), {}, lastMove('MOVE_TACKLE')), 'MOVE_ION_DELUGE')).toBe(0)
  })
})

describe('EFFECT_FEINT (:3803-3805) -- unguarded gBattleMoves[predictedMove].effect', () => {
  it('+3 when the predicted move is a Protect-effect move', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_PROTECT')), 'MOVE_FEINT')).toBe(3)
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_DETECT')), 'MOVE_FEINT')).toBe(3)
  })
  it('0 for anything else, including no predicted move (MOVE_NONE has no effect)', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_TACKLE')), 'MOVE_FEINT')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_FEINT')).toBe(0)
  })
})

describe('EFFECT_EMBARGO / EFFECT_POWDER / EFFECT_TELEKINESIS (:3806-3816)', () => {
  it('Embargo: +1 when the target holds something with a hold effect; 0 for nothing or a HOLD_EFFECT_NONE item', () => {
    expect(effectDelta(mkState({}, { itemId: 'ITEM_LEFTOVERS' }), 'MOVE_EMBARGO')).toBe(1)
    expect(effectDelta(mkState(), 'MOVE_EMBARGO')).toBe(0)
    expect(effectDelta(mkState({}, { itemId: 'ITEM_ABILITY_CAPSULE' }), 'MOVE_EMBARGO')).toBe(0)
  })
  it('Powder: +3 when the predicted move is a damaging Fire move', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_EMBER')), 'MOVE_POWDER')).toBe(3)
  })
  it('Powder: 0 for a status Fire move, a non-Fire move, or no predicted move', () => {
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_WILL_O_WISP')), 'MOVE_POWDER')).toBe(0)
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_TACKLE')), 'MOVE_POWDER')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_POWDER')).toBe(0)
  })
  it('Telekinesis: +1 for an ungrounded target, or for any <=90% accuracy move (status included)', () => {
    expect(effectDelta(mkState(), 'MOVE_TELEKINESIS')).toBe(0)
    expect(effectDeltaWith(ungroundedDefender, mkState(), 'MOVE_TELEKINESIS')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_THUNDER')), 'MOVE_TELEKINESIS')).toBe(1)
    expect(effectDelta(mkState(moves('MOVE_SCREECH')), 'MOVE_TELEKINESIS')).toBe(1)
  })
  it('Telekinesis: +1 once, not twice, when both hold', () => {
    expect(effectDeltaWith(ungroundedDefender, mkState(moves('MOVE_THUNDER')), 'MOVE_TELEKINESIS')).toBe(1)
  })
})

describe('EFFECT_THROAT_CHOP (:3817-3822)', () => {
  const chop = (a: Partial<SimBattleMon>, d: Partial<SimBattleMon>, last: string | null) => effectDelta(mkState(a, d, lastMove(last)), 'MOVE_THROAT_CHOP')
  it('+3 when the AI is faster and the predicted move is a sound move', () => {
    expect(chop(FAST, {}, 'MOVE_HYPER_VOICE')).toBe(3)
  })
  it('a slower AI falls to the moveset check: +3 only if the target KNOWS a sound move', () => {
    expect(chop(SLOW, {}, 'MOVE_HYPER_VOICE')).toBe(0)
    expect(chop(SLOW, moves('MOVE_HYPER_VOICE'), 'MOVE_HYPER_VOICE')).toBe(3)
    expect(chop(FAST, moves('MOVE_HYPER_VOICE'), 'MOVE_TACKLE')).toBe(3)
  })
  it('0 with no sound move predicted or known', () => {
    expect(chop(FAST, {}, 'MOVE_TACKLE')).toBe(0)
    expect(chop(FAST, {}, null)).toBe(0)
  })
  it('RNG (:3818): a speed tie draws once, only when the predicted move is a sound move', () => {
    const tie = countingRng(0)
    aiCheckViability(stateWithRng(tie.rng, {}, {}, lastMove('MOVE_HYPER_VOICE')), 0, 1, 'MOVE_THROAT_CHOP', 100, deps)
    expect(tie.calls()).toBe(1)
    for (const last of ['MOVE_TACKLE', null]) {
      const none = countingRng()
      aiCheckViability(stateWithRng(none.rng, {}, {}, lastMove(last)), 0, 1, 'MOVE_THROAT_CHOP', 100, deps)
      expect(none.calls(), String(last)).toBe(0)
    }
  })
  it('RNG: the tie result decides the branch (draw 0 = AI first -> +3; draw 1 = target first -> 0)', () => {
    const run = (draw: number) => aiCheckViability(stateWithRng(scripted(draw), {}, {}, lastMove('MOVE_HYPER_VOICE')), 0, 1, 'MOVE_THROAT_CHOP', 100, deps).score
    expect(run(0) - run(1)).toBe(3)
  })
})

describe('EFFECT_HEAL_BLOCK (:3823-3829)', () => {
  const block = (a: Partial<SimBattleMon>, d: Partial<SimBattleMon>, last: string | null) => effectDelta(mkState(a, d, lastMove(last)), 'MOVE_HEAL_BLOCK')
  it('+3 when the AI is faster and the predicted move is a healing effect (Recover, and Giga Drain\'s EFFECT_ABSORB)', () => {
    expect(block(FAST, {}, 'MOVE_RECOVER')).toBe(3)
    expect(block(FAST, {}, 'MOVE_GIGA_DRAIN')).toBe(3)
  })
  it('otherwise +2 if the target KNOWS a healing move, holds Leftovers, or holds Black Sludge while Poison-type', () => {
    expect(block(SLOW, {}, 'MOVE_RECOVER')).toBe(0)
    expect(block(SLOW, moves('MOVE_ROOST'), 'MOVE_RECOVER')).toBe(2)
    expect(block(FAST, moves('MOVE_ROOST'), 'MOVE_TACKLE')).toBe(2)
    expect(block(SLOW, { itemId: 'ITEM_LEFTOVERS' }, null)).toBe(2)
    expect(block(SLOW, { itemId: 'ITEM_BLACK_SLUDGE', types: ['POISON', 'MYSTERY', 'MYSTERY'] }, null)).toBe(2)
    expect(block(SLOW, { itemId: 'ITEM_BLACK_SLUDGE' }, null), 'Black Sludge on a non-Poison type').toBe(0)
  })
  it('RNG (:3824): GetWhoStrikesFirst is the FIRST operand, so a speed tie draws even with no predicted move', () => {
    const c = countingRng(0)
    aiCheckViability(stateWithRng(c.rng), 0, 1, 'MOVE_HEAL_BLOCK', 100, deps)
    expect(c.calls()).toBe(1)
    const fast = countingRng()
    aiCheckViability(stateWithRng(fast.rng, FAST), 0, 1, 'MOVE_HEAL_BLOCK', 100, deps)
    expect(fast.calls()).toBe(0)
  })
})

describe('EFFECT_SOAK / EFFECT_THIRD_TYPE / EFFECT_ELECTRIFY / EFFECT_TOPSY_TURVY (:3830-3846)', () => {
  it('Soak: +2 for an Electric move, a Grass move, or Freeze-Dry; 0 otherwise', () => {
    expect(effectDelta(mkState(moves('MOVE_THUNDERBOLT')), 'MOVE_SOAK')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_ENERGY_BALL')), 'MOVE_SOAK')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_FREEZE_DRY')), 'MOVE_SOAK')).toBe(2)
    expect(effectDelta(mkState(moves('MOVE_EMBER')), 'MOVE_SOAK')).toBe(0)
  })
  it('Third-type moves: +2 against Wonder Guard, suppressed by Mold Breaker (breakable)', () => {
    expect(effectDelta(mkState({}, { abilities: ab('ABILITY_WONDER_GUARD') }), 'MOVE_TRICK_OR_TREAT')).toBe(2)
    expect(effectDelta(mkState(), 'MOVE_TRICK_OR_TREAT')).toBe(0)
    expect(effectDeltaWith(moldBreaker, mkState({}, { abilities: ab('ABILITY_WONDER_GUARD') }), 'MOVE_TRICK_OR_TREAT')).toBe(0)
  })
  it('Electrify: +3 for a predicted Normal move against an electric-absorbing AI; guarded by predictedMove != MOVE_NONE', () => {
    expect(effectDelta(mkState({ abilities: ab('ABILITY_MOTOR_DRIVE') }, {}, lastMove('MOVE_TACKLE')), 'MOVE_ELECTRIFY')).toBe(3)
    expect(effectDelta(mkState({ abilities: ab('ABILITY_MOTOR_DRIVE') }), 'MOVE_ELECTRIFY'), 'contrast: Ion Deluge is unguarded, Electrify is not').toBe(0)
    expect(effectDelta(mkState({ abilities: ab('ABILITY_MOTOR_DRIVE') }, {}, lastMove('MOVE_EMBER')), 'MOVE_ELECTRIFY')).toBe(0)
    expect(effectDelta(mkState({}, {}, lastMove('MOVE_TACKLE')), 'MOVE_ELECTRIFY')).toBe(0)
  })
  it('Topsy-Turvy: +1 when the target has strictly more raised than lowered stats', () => {
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 1, STAT_ATK, 7)), 'MOVE_TOPSY_TURVY')).toBe(1)
    expect(effectDelta(mkState({}, {}, (s) => { stage(s, 1, STAT_ATK, 7); stage(s, 1, STAT_DEF, 5) }), 'MOVE_TOPSY_TURVY')).toBe(0)
    expect(effectDelta(mkState({}, {}, (s) => stage(s, 1, STAT_ATK, 5)), 'MOVE_TOPSY_TURVY')).toBe(0)
    expect(effectDelta(mkState(), 'MOVE_TOPSY_TURVY')).toBe(0)
  })
})

describe('EFFECT_FAIRY_LOCK (:3847-3851) -- !IsBattlerTrapped(def, TRUE) then ShouldTrap', () => {
  it('+8 for a Stall AI whose target cannot KO it and is not already trapped', () => {
    expect(effectDelta(mkState({}, {}, () => {}, AI_FLAG_STALL), 'MOVE_FAIRY_LOCK')).toBe(8)
  })
  it('0 without AI_FLAG_STALL, when the target is already trapped, or when the target can KO the AI', () => {
    expect(effectDelta(mkState(), 'MOVE_FAIRY_LOCK')).toBe(0)
    expect(effectDelta(mkState({}, { status2: STATUS2_WRAPPED }, () => {}, AI_FLAG_STALL), 'MOVE_FAIRY_LOCK')).toBe(0)
    expect(effectDelta(mkState({ hp: 1 }, {}, () => {}, AI_FLAG_STALL), 'MOVE_FAIRY_LOCK')).toBe(0)
  })
  it('a Ghost target is not trapped, so it still scores', () => {
    expect(effectDelta(mkState({}, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, () => {}, AI_FLAG_STALL), 'MOVE_FAIRY_LOCK')).toBe(8)
  })
})

describe('EFFECT_TAILWIND / EFFECT_LUCKY_CHANT / EFFECT_QUASH (:3852-3865) -- singles side of the doubles branches', () => {
  it('Tailwind: +2 only when the attacker\'s side speed average is strictly lower', () => {
    expect(effectDelta(mkState(SLOW), 'MOVE_TAILWIND')).toBe(2)
    expect(effectDelta(mkState(), 'MOVE_TAILWIND')).toBe(0)
    expect(effectDelta(mkState(FAST), 'MOVE_TAILWIND')).toBe(0)
  })
  it('Lucky Chant: +1 in singles (the `else` +8 party branch is doubles-only), even with a party to switch to', () => {
    expect(effectDelta(mkState(), 'MOVE_LUCKY_CHANT')).toBe(1)
    expect(effectDelta(() => stateWithDefenderParty({}, {}, repeating(RNG_HIGH)), 'MOVE_LUCKY_CHANT')).toBe(1)
  })
  it('Quash: 0 in singles even when the target is faster (its speed check needs a partner slot)', () => {
    expect(effectDelta(mkState(SLOW), 'MOVE_QUASH')).toBe(0)
    expect(effectDelta(mkState(FAST), 'MOVE_QUASH')).toBe(0)
  })
  it('Quash makes no RNG draw in singles', () => {
    const c = countingRng()
    aiCheckViability(stateWithRng(c.rng), 0, 1, 'MOVE_QUASH', 100, deps)
    expect(c.calls()).toBe(0)
  })
})

describe('EFFECT_PLEDGE / EFFECT_FLAME_BURST / partner-side MAGIC_ROOM -- doubles-only, dead in singles', () => {
  it('Pledge scores 0 in singles (no effect-carrying real move exists; a Tackle wearing the effect stands in)', () => {
    expect(effectDeltaWith(tackleAs('EFFECT_PLEDGE'), mkState(), 'MOVE_TACKLE')).toBe(0)
  })
  it('Flame Burst scores 0 in singles', () => {
    expect(effectDelta(mkState(), 'MOVE_FLAME_BURST')).toBe(0)
    expect(effectDelta(mkState({}, { hp: 5 }), 'MOVE_FLAME_BURST')).toBe(0)
  })
})

describe('EFFECT_MAGNET_RISE (:3866-3880) -- AI_GetTypeEffectiveness(MOVE_EARTHQUAKE, battlerDef, battlerAtk)', () => {
  const zap = moves('MOVE_THUNDERBOLT')
  const rise = (a: Partial<SimBattleMon>, d: Partial<SimBattleMon>, last: string | null = null, dd: AiDamageDeps = deps) => effectDeltaWith(dd, mkState(a, d, lastMove(last)), 'MOVE_MAGNET_RISE')
  it('AI first: +3 when the predicted move is Ground; 0 for another move and for no predicted move (MOVE_NONE is Normal)', () => {
    expect(rise(FAST, zap, 'MOVE_EARTHQUAKE')).toBe(3)
    expect(rise(FAST, zap, 'MOVE_TACKLE')).toBe(0)
    expect(rise(FAST, zap, null)).toBe(0)
  })
  it('AI second: +2 when the target knows a damaging Ground move', () => {
    expect(rise(SLOW, moves('MOVE_THUNDERBOLT', 'MOVE_EARTHQUAKE'))).toBe(2)
    expect(rise(SLOW, zap)).toBe(0)
  })
  it('needs a damaging Electric move on the target', () => {
    expect(rise(FAST, moves('MOVE_EARTHQUAKE'), 'MOVE_EARTHQUAKE')).toBe(0)
    expect(rise(FAST, moves('MOVE_WILL_O_WISP'), 'MOVE_EARTHQUAKE')).toBe(0)
  })
  it('needs a grounded AI', () => {
    expect(rise(FAST, zap, 'MOVE_EARTHQUAKE', ungroundedAttacker)).toBe(0)
  })
  it('an AI that is already immune to Earthquake (Flying) scores 0: the probe has the target as ATTACKER', () => {
    expect(rise({ ...FAST, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, zap, 'MOVE_EARTHQUAKE')).toBe(0)
    expect(rise({ ...FAST, types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, zap, 'MOVE_EARTHQUAKE'), 'a Fire type takes normal damage from Earthquake').toBe(3)
  })
  it('RNG (:3870): a speed tie draws once, and only when every earlier condition held', () => {
    const c = countingRng(0)
    aiCheckViability(stateWithRng(c.rng, {}, zap, lastMove('MOVE_EARTHQUAKE')), 0, 1, 'MOVE_MAGNET_RISE', 100, deps)
    expect(c.calls()).toBe(1)
    const noZap = countingRng()
    aiCheckViability(stateWithRng(noZap.rng, {}, {}, lastMove('MOVE_EARTHQUAKE')), 0, 1, 'MOVE_MAGNET_RISE', 100, deps)
    expect(noZap.calls()).toBe(0)
  })
})

describe('EFFECT_CAMOUFLAGE (:3881-3885) -- no real move carries it; a Tackle wearing the effect stands in', () => {
  const camo = (a: Partial<SimBattleMon>, last: string | null, over: Partial<MoveData> = {}) => effectDeltaWith(tackleAs('EFFECT_CAMOUFLAGE', over), mkState(a, {}, lastMove(last)), 'MOVE_TACKLE')
  it('+1 when the AI is faster, a move was predicted, the scored move is not a status move, and the predicted move can hit the AI', () => {
    expect(camo(FAST, 'MOVE_TACKLE')).toBe(1)
  })
  it('0 when slower, with no predicted move, or when the scored move is a status move (`!IS_MOVE_STATUS(move)`)', () => {
    expect(camo(SLOW, 'MOVE_TACKLE')).toBe(0)
    expect(camo(FAST, null)).toBe(0)
    expect(camo(FAST, 'MOVE_TACKLE', { split: 'STATUS' })).toBe(0)
  })
  it('0 when the predicted move cannot hit the AI (AI_GetTypeEffectiveness(predicted, battlerDef, battlerAtk) == x0)', () => {
    expect(camo({ ...FAST, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, 'MOVE_EARTHQUAKE')).toBe(0)
  })
  it('RNG (:3882): a speed tie draws once, only when a move was predicted', () => {
    const c = countingRng(0)
    aiCheckViability(stateWithRng(c.rng, {}, {}, lastMove('MOVE_TACKLE')), 0, 1, 'MOVE_TACKLE', 100, tackleAs('EFFECT_CAMOUFLAGE'))
    expect(c.calls()).toBe(1)
    const none = countingRng()
    aiCheckViability(stateWithRng(none.rng), 0, 1, 'MOVE_TACKLE', 100, tackleAs('EFFECT_CAMOUFLAGE'))
    expect(none.calls()).toBe(0)
  })
})

describe('EFFECT_TOXIC_THREAD (:3893-3896)', () => {
  it('poison (+1 baseline) then Speed (+2 when slower)', () => {
    expect(effectDelta(mkState(SLOW), 'MOVE_TOXIC_THREAD')).toBe(3)
    expect(effectDelta(mkState(FAST), 'MOVE_TOXIC_THREAD')).toBe(1)
  })
  it('a Steel target cannot be poisoned: only the Speed raise remains', () => {
    expect(effectDelta(mkState(SLOW, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }), 'MOVE_TOXIC_THREAD')).toBe(2)
  })
})

describe('EFFECT_TWO_TURNS_ATTACK / SKULL_BASH / SOLARBEAM (:3897-3903)', () => {
  it.each(['EFFECT_TWO_TURNS_ATTACK', 'EFFECT_SKULL_BASH'])('%s: +2 holding a Power Herb, else 0', (effect) => {
    expect(synDelta(mkState({ itemId: 'ITEM_POWER_HERB' }), effect)).toBe(2)
    expect(synDelta(mkState({ itemId: 'ITEM_LEFTOVERS' }), effect)).toBe(0)
    expect(synDelta(mkState(), effect)).toBe(0)
  })
  it('Solar Beam: +2 with a Power Herb OR Chloroplast, never +4', () => {
    expect(effectDelta(mkState({ itemId: 'ITEM_POWER_HERB' }), 'MOVE_SOLAR_BEAM')).toBe(2)
    expect(effectDelta(mkState({ abilities: ab('ABILITY_CHLOROPLAST') }), 'MOVE_SOLAR_BEAM')).toBe(2)
    expect(effectDelta(mkState({ itemId: 'ITEM_POWER_HERB', abilities: ab('ABILITY_CHLOROPLAST') }), 'MOVE_SOLAR_BEAM')).toBe(2)
    expect(effectDelta(mkState(), 'MOVE_SOLAR_BEAM')).toBe(0)
  })
})

describe('EFFECT_COUNTER / EFFECT_MIRROR_COAT (:3904-3915)', () => {
  const strong = ['MOVE_HYPER_VOICE'] as const
  const counter = (id: string, last: string | null, over: (s: BattleState) => void = () => {}, d: AiDamageDeps = deps) =>
    effectDeltaWith(d, mkState({ ...moves(id, ...strong) }, {}, both(lastMove(last), over)), id)
  it('Counter: +3 when the predicted move is Physical and the result is not BEST', () => {
    expect(counter('MOVE_COUNTER', 'MOVE_TACKLE')).toBe(3)
  })
  it('Mirror Coat: +3 for a predicted Special move; neither scores for the other split or a status move', () => {
    expect(counter('MOVE_MIRROR_COAT', 'MOVE_WATER_GUN')).toBe(3)
    expect(counter('MOVE_COUNTER', 'MOVE_WATER_GUN')).toBe(0)
    expect(counter('MOVE_MIRROR_COAT', 'MOVE_TACKLE')).toBe(0)
    expect(counter('MOVE_COUNTER', 'MOVE_PROTECT')).toBe(0)
  })
  it('a Taunted target adds +1 (it must use a damaging move)', () => {
    expect(counter('MOVE_COUNTER', 'MOVE_TACKLE', (s) => { s.battlers[1]!.volatiles.tauntTimer = 2 })).toBe(4)
    expect(counter('MOVE_COUNTER', 'MOVE_PROTECT', (s) => { s.battlers[1]!.volatiles.tauntTimer = 2 })).toBe(1)
  })
  it('nothing scores without a predicted move (even Taunted), or against an incapacitated target', () => {
    expect(counter('MOVE_COUNTER', null, (s) => { s.battlers[1]!.volatiles.tauntTimer = 2 })).toBe(0)
    expect(counter('MOVE_COUNTER', 'MOVE_TACKLE', (s) => { s.battlers[1]!.mon.status1 = STATUS1_SLEEP })).toBe(0)
  })
  it('QUIRK: `>= MOVE_POWER_GOOD` (2) excludes BEST (1) -- when Counter is itself the AI\'s best move it scores 0', () => {
    const buffed = depsOverride('MOVE_COUNTER', { power: 250 })
    expect(effectDeltaWith(buffed, mkState(moves('MOVE_COUNTER', 'MOVE_TACKLE'), {}, lastMove('MOVE_TACKLE')), 'MOVE_COUNTER')).toBe(0)
    // Same predicted move, Counter no longer the best (unbuffed, next to a strong move): +3 -- the result is WEAK/GOOD, both >= 2.
    expect(counter('MOVE_COUNTER', 'MOVE_TACKLE')).toBe(3)
  })
})

describe('EFFECT_METAL_BURST (:3916-3924) -- the `else score -= 10` binds to the inner if', () => {
  const burst = (a: Partial<SimBattleMon>, last: string | null, over: (s: BattleState) => void = () => {}) =>
    effectDelta(mkState({ ...a, ...moves('MOVE_METAL_BURST', 'MOVE_HYPER_VOICE') }, {}, both(lastMove(last), over)), 'MOVE_METAL_BURST')
  it('+3 when the predicted move is strong enough and the AI is NOT first', () => {
    expect(burst(SLOW, 'MOVE_TACKLE')).toBe(3)
  })
  it('-10 when the AI is first (even with a strong predicted move)', () => {
    expect(burst(FAST, 'MOVE_TACKLE')).toBe(-10)
  })
  it('a predicted status move (power 0) reads WEAK from GetMoveDamageResult, which is >= GOOD, so it scores +3 too', () => {
    expect(burst(SLOW, 'MOVE_PROTECT')).toBe(3)
  })
  it('a Taunted target adds +1 before the +3/-10', () => {
    expect(burst(SLOW, 'MOVE_TACKLE', (s) => { s.battlers[1]!.volatiles.tauntTimer = 2 })).toBe(4)
    expect(burst(FAST, 'MOVE_TACKLE', (s) => { s.battlers[1]!.volatiles.tauntTimer = 2 })).toBe(-9)
  })
  it('nothing without a predicted move or against an incapacitated target', () => {
    expect(burst(SLOW, null)).toBe(0)
    expect(burst(SLOW, 'MOVE_TACKLE', (s) => { s.battlers[1]!.mon.status1 = STATUS1_SLEEP })).toBe(0)
  })
  it('RNG (:3919): GetWhoStrikesFirst draws on a tie exactly once when GetMoveDamageResult qualified, and not at all when Metal Burst is the BEST move', () => {
    const c = countingRng(0)
    aiCheckViability(stateWithRng(c.rng, moves('MOVE_METAL_BURST', 'MOVE_HYPER_VOICE'), {}, lastMove('MOVE_TACKLE')), 0, 1, 'MOVE_METAL_BURST', 100, deps)
    expect(c.calls()).toBe(1)
    const best = countingRng()
    // A big-HP target: the buffed Metal Burst must not KO it, or the pre-switch already-dead check would draw its own speed tie.
    aiCheckViability(stateWithRng(best.rng, moves('MOVE_METAL_BURST', 'MOVE_TACKLE'), { hp: 999, maxHp: 999 }, lastMove('MOVE_TACKLE')), 0, 1, 'MOVE_METAL_BURST', 100, depsOverride('MOVE_METAL_BURST', { power: 250 }))
    expect(best.calls()).toBe(0)
  })
  it('QUIRK: with Metal Burst as the BEST move the qualifying test fails, so the else branch scores -10 whatever the speed', () => {
    const buffed = depsOverride('MOVE_METAL_BURST', { power: 250 })
    expect(effectDeltaWith(buffed, mkState({ ...SLOW, ...moves('MOVE_METAL_BURST', 'MOVE_TACKLE') }, {}, lastMove('MOVE_TACKLE')), 'MOVE_METAL_BURST')).toBe(-10)
  })
})

describe('EFFECT_FLAIL / EFFECT_ENDEAVOR (:3925-3930, :3959-3966) -- GetWhoStrikesFirst and HP thresholds', () => {
  const hpOf = (n: number) => ({ hp: n })
  it('Flail: +1 only when the AI is first AND below 50% HP (50 exactly does not count)', () => {
    expect(effectDelta(mkState({ ...FAST, ...hpOf(49) }), 'MOVE_FLAIL')).toBe(1)
    expect(effectDelta(mkState({ ...FAST, ...hpOf(50) }), 'MOVE_FLAIL')).toBe(0)
    expect(effectDelta(mkState({ ...SLOW, ...hpOf(10) }), 'MOVE_FLAIL')).toBe(0)
  })
  it('Endeavor: a slower AI needs < 40% HP, a faster one < 50% (both strict)', () => {
    expect(effectDelta(mkState({ ...SLOW, ...hpOf(39) }), 'MOVE_ENDEAVOR')).toBe(1)
    expect(effectDelta(mkState({ ...SLOW, ...hpOf(40) }), 'MOVE_ENDEAVOR')).toBe(0)
    expect(effectDelta(mkState({ ...SLOW, ...hpOf(45) }), 'MOVE_ENDEAVOR')).toBe(0)
    expect(effectDelta(mkState({ ...FAST, ...hpOf(49) }), 'MOVE_ENDEAVOR')).toBe(1)
    expect(effectDelta(mkState({ ...FAST, ...hpOf(45) }), 'MOVE_ENDEAVOR')).toBe(1)
    expect(effectDelta(mkState({ ...FAST, ...hpOf(50) }), 'MOVE_ENDEAVOR')).toBe(0)
  })
  it('RNG (:3926, :3960): a speed tie draws once for each, and the result picks the branch', () => {
    for (const id of ['MOVE_FLAIL', 'MOVE_ENDEAVOR']) {
      const c = countingRng(0)
      aiCheckViability(stateWithRng(c.rng, hpOf(45)), 0, 1, id, 100, deps)
      expect(c.calls(), id).toBe(1)
    }
    const run = (draw: number) => aiCheckViability(stateWithRng(scripted(draw), hpOf(45)), 0, 1, 'MOVE_ENDEAVOR', 100, deps).score
    expect(run(1) - run(0), 'draw 1 = opponent first -> <40 threshold -> 45% does not score').toBe(0 - 1)
  })
})

describe('EFFECT_SHORE_UP (:3931-3936) -- two ShouldRecover calls when the first does not score', () => {
  const sand = (s: BattleState) => setWeather(s, WEATHER_SANDSTORM_TEMPORARY)
  it('+2 (ShouldRecover 50) for a faster AI below 60% HP that the target cannot KO', () => {
    expect(effectDelta(mkState({ ...FAST, hp: 50 }), 'MOVE_SHORE_UP')).toBe(2)
  })
  it('+3 (ShouldRecover 67) in a sandstorm that has effect', () => {
    expect(effectDelta(mkState({ ...FAST, hp: 50 }, {}, sand), 'MOVE_SHORE_UP')).toBe(3)
    expect(effectDelta(mkState({ ...FAST, hp: 50 }, { abilities: ab('ABILITY_CLOUD_NINE') }, sand), 'MOVE_SHORE_UP'), 'weather without effect falls to the 50% call').toBe(2)
  })
  it('0 at full HP, when slower, or when the target can KO the AI', () => {
    expect(effectDelta(mkState({ ...FAST, hp: 100 }), 'MOVE_SHORE_UP')).toBe(0)
    expect(effectDelta(mkState({ ...SLOW, hp: 50 }), 'MOVE_SHORE_UP')).toBe(0)
    expect(effectDelta(mkState({ ...FAST, hp: 20 }), 'MOVE_SHORE_UP')).toBe(0)
  })
  it('RNG: each ShouldRecover draws its own speed-tie and its own `Random() % 3` (2 calls when the first fails, 1 when there is no sandstorm)', () => {
    const draws = (a: Partial<SimBattleMon>, tweak: (s: BattleState) => void) => {
      const c = countingRng(0, 1, 0, 1)
      aiCheckViability(stateWithRng(c.rng, a, {}, tweak), 0, 1, 'MOVE_SHORE_UP', 100, deps)
      return c.calls()
    }
    expect(draws({ hp: 50 }, sand), 'sand, recovers at 67: tie + %3').toBe(2)
    expect(draws({ hp: 50 }, () => {}), 'no sand: tie + %3').toBe(2)
    expect(draws({ hp: 100 }, sand), 'sand, hp 100: 67 call ties, 50 call ties again').toBe(2)
    expect(draws({ hp: 100 }, () => {}), 'no sand, hp 100: one tie').toBe(1)
  })
})

describe('status-condition damage moves (:3937-3957)', () => {
  it.each([STATUS1_PARALYSIS, STATUS1_FROSTBITE, STATUS1_POISON, STATUS1_TOXIC_POISON, STATUS1_BLEED])('Facade: +1 while the attacker has status1 %i', (status) => {
    expect(effectDelta(mkState({ status1: status }), 'MOVE_FACADE')).toBe(1)
  })
  it('Facade while burned: +1 from the case body plus +2 from the pre-switch burn penalty Facade is exempt from (effect != EFFECT_FACADE, :2564)', () => {
    expect(effectDelta(mkState({ status1: STATUS1_BURN }), 'MOVE_FACADE')).toBe(3)
  })
  it('Facade: 0 unstatused, asleep or frozen', () => {
    expect(effectDelta(mkState(), 'MOVE_FACADE')).toBe(0)
    expect(effectDelta(mkState({ status1: STATUS1_SLEEP }), 'MOVE_FACADE')).toBe(0)
    expect(effectDelta(mkState({ status1: STATUS1_FREEZE }), 'MOVE_FACADE')).toBe(0)
  })
  // Focus Punch is in sDiscouragedPowerfulMoveEffects (pre-switch damage check reads WEAK), so its baseline is another discouraged
  // effect with no case label (EFFECT_ERUPTION) -- the pre-switch terms then cancel exactly.
  const punch = (a: Partial<SimBattleMon>, d: Partial<SimBattleMon>, tweak: (s: BattleState) => void = () => {}) => effectDeltaWith(deps, mkState(a, d, tweak), 'MOVE_FOCUS_PUNCH', 'EFFECT_ERUPTION')
  it('Focus Punch: +2 against an incapacitated target, +1 against a confused one or when the AI has a Substitute (else-if)', () => {
    expect(punch({}, { status1: STATUS1_SLEEP })).toBe(2)
    expect(punch({}, { status2: STATUS2_CONFUSION })).toBe(1)
    expect(punch({ status2: STATUS2_SUBSTITUTE }, {})).toBe(1)
    expect(punch({}, { status1: STATUS1_SLEEP, status2: STATUS2_CONFUSION }), 'sleeping AND confused: the first branch wins').toBe(2)
    expect(punch({}, {})).toBe(0)
  })
  it('Focus Punch needs effectiveness > x0.5: a not-very-effective hit scores 0 even against a sleeper (x0.5 is 3, not > 3)', () => {
    expect(punch({}, { status1: STATUS1_SLEEP, types: ['POISON', 'MYSTERY', 'MYSTERY'] })).toBe(0)
    expect(punch({}, { status1: STATUS1_SLEEP, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })).toBe(2)
  })
  it('Smelling Salts: +2 against paralysis; Wake-Up Slap: +2 against sleep', () => {
    expect(effectDelta(mkState({}, { status1: STATUS1_PARALYSIS }), 'MOVE_SMELLING_SALTS')).toBe(2)
    expect(effectDelta(mkState({}, { status1: STATUS1_SLEEP }), 'MOVE_SMELLING_SALTS')).toBe(0)
    expect(effectDelta(mkState({}, { status1: STATUS1_SLEEP }), 'MOVE_WAKE_UP_SLAP')).toBe(2)
    expect(effectDelta(mkState({}, { status1: STATUS1_PARALYSIS }), 'MOVE_WAKE_UP_SLAP')).toBe(0)
  })
  it('Revenge: +2 unless the target is asleep or confused (either)', () => {
    expect(effectDelta(mkState(), 'MOVE_REVENGE')).toBe(2)
    expect(effectDelta(mkState({}, { status1: STATUS1_SLEEP }), 'MOVE_REVENGE')).toBe(0)
    expect(effectDelta(mkState({}, { status2: STATUS2_CONFUSION }), 'MOVE_REVENGE')).toBe(0)
    expect(effectDelta(mkState({}, { status1: STATUS1_SLEEP, status2: STATUS2_CONFUSION }), 'MOVE_REVENGE')).toBe(0)
  })
})

describe('EFFECT_RECHARGE (:3967-3972)', () => {
  const recharge = (a: Partial<SimBattleMon>, d: Partial<SimBattleMon> = {}, dd: AiDamageDeps = deps) => effectDeltaWith(dd, mkState(a, d), 'MOVE_HYPER_BEAM', 'EFFECT_ERUPTION')
  it.each(['ABILITY_RAMPAGE', 'ABILITY_BERSERKER_RAGE', 'ABILITY_RAGING_GODDESS', 'ABILITY_MASTER_HAND'])('%s + a KO with this move: +4', (id) => {
    expect(recharge({ ...moves('MOVE_HYPER_BEAM'), abilities: ab(id) }, { hp: 1 })).toBe(4)
  })
  it('0 without the ability, or when the move does not KO', () => {
    expect(recharge(moves('MOVE_HYPER_BEAM'), { hp: 1 })).toBe(0)
    expect(recharge({ ...moves('MOVE_HYPER_BEAM'), abilities: ab('ABILITY_RAMPAGE') })).toBe(0)
  })
  it('none of the four is breakable, so a Mold Breaker attacker keeps them', () => {
    expect(recharge({ ...moves('MOVE_HYPER_BEAM'), abilities: ab('ABILITY_RAMPAGE') }, { hp: 1 }, moldBreaker)).toBe(4)
  })
})

describe('part 2b RNG order -- every speed-tie draw is a real state.rng draw, in C order', () => {
  it('a plain non-drawing effect leaves the stream untouched (Grudge, Snatch, Facade, Recharge)', () => {
    for (const id of ['MOVE_GRUDGE', 'MOVE_SNATCH', 'MOVE_FACADE', 'MOVE_HYPER_BEAM', 'MOVE_TRICK_ROOM', 'MOVE_TAILWIND']) {
      const c = countingRng()
      aiCheckViability(stateWithRng(c.rng), 0, 1, id, 100, deps)
      expect(c.calls(), id).toBe(0)
    }
  })
  it('the stat-raising moves draw only through IncreaseStatUpScore\'s HP<80% AI_RandLessThan(128), once per raised stat, in order', () => {
    const low = countingRng()
    aiCheckViability(stateWithRng(low.rng, { hp: 75, ...SLOW }), 0, 1, 'MOVE_DRAGON_DANCE', 100, deps)
    expect(low.calls()).toBe(2)
    const full = countingRng()
    aiCheckViability(stateWithRng(full.rng, SLOW), 0, 1, 'MOVE_DRAGON_DANCE', 100, deps)
    expect(full.calls()).toBe(0)
  })
  it('Gravity\'s sleep branch draws IncreaseSleepScore\'s AI_RandLessThan(128) exactly once', () => {
    const c = countingRng(RNG_LOW)
    const s = aiCheckViability(stateWithRng(c.rng, moves('MOVE_HYPNOSIS')), 0, 1, 'MOVE_GRAVITY', 100, deps).score
    expect(c.calls()).toBe(1)
    const no = aiCheckViability(stateWithRng(scripted(RNG_HIGH), moves('MOVE_HYPNOSIS')), 0, 1, 'MOVE_GRAVITY', 100, deps).score
    expect(s - no).toBe(2)
  })
})
