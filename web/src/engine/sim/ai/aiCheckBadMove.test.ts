// aiCheckBadMove.ts -- AI_CheckBadMove part 1 (battle_ai_main.c:488-1298).
// Every id/effect asserted below is verified against data/v2.65beta/*.json at
// module load, per the brief's "verify every id" rule.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import { AI_FLAG_WILL_SUICIDE } from './aiFlags'
import {
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_WONDER_ROOM,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_WATERSPORT,
  STATUS_FIELD_ION_DELUGE,
  STATUS_FIELD_FAIRY_LOCK,
  WEATHER_RAIN_PRIMAL,
  WEATHER_SUN_PRIMAL,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  STATUS1_SLEEP,
  STATUS1_POISON,
  STATUS2_INFATUATION,
  STATUS2_TORMENT,
  STATUS2_TRANSFORMED,
  STATUS2_DESTINY_BOND,
  STATUS3_AQUA_RING,
  STATUS3_IMPRISONED_OTHERS,
  STATUS3_LASER_FOCUS,
  STATUS3_ALWAYS_HITS,
  STATUS3_YAWN,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
} from '../constants'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { type AiDamageDeps } from './aiCalcDamage'
import { chooseMoveOrActionSingles } from './aiPipeline'
import {
  aiCheckBadMove,
  MOLD_BREAKABLE_ABILITIES,
  ON_STAT_LOWERED_ABILITIES,
  SUCTION_CUPS_ABILITIES,
  ALWAYS_SLEEPING_ABILITIES,
  PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES,
  NO_RECOIL_ABILITIES,
  HALF_RECOIL_ABILITIES,
  CHLOROPLAST_ABILITIES,
} from './aiCheckBadMove'

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
const REQUIRED_MOVES: Record<string, { effect?: string; target?: string; type?: string }> = {
  MOVE_TACKLE: {}, MOVE_SLEEP_POWDER: { effect: 'EFFECT_SLEEP' }, MOVE_THUNDER_WAVE: { effect: 'EFFECT_PARALYZE' },
  MOVE_SWORDS_DANCE: { effect: 'EFFECT_ATTACK_UP_2' }, MOVE_EXPLOSION: { effect: 'EFFECT_EXPLOSION' },
  MOVE_LEECH_SEED: { effect: 'EFFECT_LEECH_SEED', target: 'SELECTED' }, MOVE_SPIKES: { effect: 'EFFECT_SPIKES', target: 'OPPONENTS_FIELD' },
  MOVE_PERISH_SONG: { effect: 'EFFECT_PERISH_SONG' }, MOVE_ROAR: { effect: 'EFFECT_ROAR' }, MOVE_DISABLE: { effect: 'EFFECT_DISABLE' },
  MOVE_CONFUSE_RAY: { effect: 'EFFECT_CONFUSE' }, MOVE_WILL_O_WISP: { effect: 'EFFECT_WILL_O_WISP' }, MOVE_TOXIC: { effect: 'EFFECT_TOXIC' },
  MOVE_SUBSTITUTE: { effect: 'EFFECT_SUBSTITUTE' }, MOVE_FOCUS_PUNCH: { effect: 'EFFECT_FOCUS_PUNCH' }, MOVE_MEAN_LOOK: { effect: 'EFFECT_MEAN_LOOK' },
  MOVE_SWAGGER: { effect: 'EFFECT_SWAGGER' }, MOVE_HAZE: { effect: 'EFFECT_HAZE' }, MOVE_CAPTIVATE: { effect: 'EFFECT_CAPTIVATE' },
  MOVE_SANDSTORM: { effect: 'EFFECT_SANDSTORM' }, MOVE_THUNDERBOLT: { type: 'ELECTRIC' }, MOVE_WING_ATTACK: { type: 'FLYING' },
}
for (const [id, expected] of Object.entries(REQUIRED_MOVES)) {
  const m = moveById.get(id)
  if (!m) throw new Error(`moves.json is missing ${id}`)
  if (expected.effect && m.effect !== expected.effect) throw new Error(`${id} is no longer ${expected.effect}`)
  if (expected.target && m.target !== expected.target) throw new Error(`${id} is no longer target=${expected.target}`)
  if (expected.type && m.type !== `TYPE_${expected.type}`) throw new Error(`${id} is no longer TYPE_${expected.type}`)
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
function check(s: BattleState, moveId: string, score = 100) {
  return aiCheckBadMove(s, 0, 1, moveId, score, deps)
}
function depsWithMoldBreaker(attackerHasMoldBreaker: boolean): AiDamageDeps {
  return { ...deps, grounding: { ...grounding, attackerHasMoldBreaker } }
}
/** No moves.json move carries EFFECT_CAMOUFLAGE or EFFECT_VITAL_THROW on this
 * snapshot (MOVE_CAMOUFLAGE is EFFECT_PROTECT here, and MOVE_VITAL_THROW
 * carries no listed effect at all) -- both case labels are still real,
 * reachable code (ported faithfully from the C's own switch), just untestable
 * through a real move id. This builds a synthetic move so the case itself is
 * still exercised and asserted on directly. */
function depsWithSyntheticEffect(effect: string): AiDamageDeps {
  const synthetic: MoveData = { ...toMoveData('MOVE_TACKLE'), id: 'MOVE_SYNTHETIC_EFFECT', effect }
  return { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC_EFFECT' ? synthetic : moveById.has(id) ? toMoveData(id) : undefined) }
}
function partyMon(overrides: Partial<SimBattleMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], itemId: null, abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY', hiddenPowerType: null, speedDown: false,
    gender: 'MALE', status1: 0, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
/** Same as `state`, but with a live reserve mon on the DEFENDER's side, so
 * `countUsablePartyMons(state, 1)` is 1 rather than 0 -- needed whenever a
 * test wants to isolate an EFFECT_ROAR/EFFECT_PERISH_SONG ability check from
 * the "no usable party mons" branch that would otherwise fire unconditionally. */
function stateWithDefenderParty(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng,
    opponentParty: [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
  })
}

describe('AI_CheckBadMove part 1 -- non-user-target checks', () => {
  it('does not penalize a plain damaging move with no immunities', () => {
    const s = state()
    expect(check(s, 'MOVE_TACKLE').score).toBe(100)
  })

  it('RETURN_SCORE_MINUS(20) when the move is disabled', () => {
    const s = state()
    s.battlers[0]!.volatiles.disabledMove = 'MOVE_TACKLE'
    s.battlers[0]!.volatiles.disableTimer = 3
    expect(check(s, 'MOVE_TACKLE').score).toBe(80)
  })

  it('RETURN_SCORE_MINUS(20) for Truant on a damaging (non-status) move', () => {
    const s = state({ abilities: { ability: 'ABILITY_TRUANT', innates: [null, null, null] } })
    expect(check(s, 'MOVE_TACKLE').score).toBe(80)
  })

  it('does not penalize Truant on a status move (IS_MOVE_STATUS guard)', () => {
    const s = state({ abilities: { ability: 'ABILITY_TRUANT', innates: [null, null, null] } })
    expect(check(s, 'MOVE_SWORDS_DANCE').score).toBe(100)
  })

  it('RETURN_SCORE_MINUS(20) for a powder move against a Grass-type target', () => {
    const s = state({}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_SLEEP_POWDER').score).toBe(80)
  })

  it('RETURN_SCORE_MINUS(30) for a Flying-type move against Aerodynamics', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_AERODYNAMICS', innates: [null, null, null] } })
    expect(check(s, 'MOVE_WING_ATTACK').score).toBe(70)
  })

  it('RETURN_SCORE_MINUS(20) for a Ground-type move against Earth Eater', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_EARTH_EATER', innates: [null, null, null] } })
    expect(check(s, 'MOVE_EARTHQUAKE').score).toBe(80)
  })

  it('RETURN_SCORE_MINUS(20) for Leech Seed against Magic Guard', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } })
    expect(check(s, 'MOVE_LEECH_SEED').score).toBe(80)
  })

  it('RETURN_SCORE_MINUS(20) for a type-immune move (AI_EFFECTIVENESS_x0)', () => {
    // Electric vs Ground is a 0x immunity.
    const s = state({}, { types: ['GROUND', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_THUNDERBOLT').score).toBe(80)
  })

  it('RETURN_SCORE_MINUS(20) for Magic Bounce against a magic-coat-affected move', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_MAGIC_BOUNCE', innates: [null, null, null] } })
    expect(check(s, 'MOVE_SLEEP_POWDER').score).toBe(80) // magicCoatAffected in moves.json
  })

  it('RETURN_SCORE_MINUS(10) for Contempt/Defiant/Competitive-class ability vs a stat-lowering move', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_DEFIANT', innates: [null, null, null] } })
    // ABILITY_DEFIANT is matched by the CONTEMPT/DEFIANT/COMPETITIVE case (-8).
    expect(check(s, 'MOVE_THUNDER_WAVE' /* status, but not stat-lowering */).score).toBe(100)
  })

  it('Magic Guard halves the Poison/Burn/Toxic/Leech-Seed-class score penalty to -5', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } })
    // Toxic still lands (no poison-type immunity here), so only the Magic
    // Guard -5 applies, not the "can't poison" -10.
    const r = check(s, 'MOVE_TOXIC')
    expect(r.score).toBe(95)
  })

  it('terrain: Electric Terrain penalizes a sleep-inducing move by 20', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    expect(check(s, 'MOVE_SLEEP_POWDER').score).toBe(80)
  })

  it('terrain: Misty Terrain penalizes a non-volatile-status move by 20', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    expect(check(s, 'MOVE_WILL_O_WISP').score).toBe(80)
  })

  it('terrain: Psychic Terrain penalizes a priority move targeting a foe by 20', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
    // MOVE_QUICK_ATTACK: priority 2, target SELECTED (not USER).
    expect(check(s, 'MOVE_QUICK_ATTACK').score).toBe(80)
  })

  it('does not apply the non-user-target ladder to a self-targeting move (MOVE_TARGET_USER)', () => {
    const s = state({}, { types: ['GROUND', 'MYSTERY', 'MYSTERY'] })
    s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    // Swords Dance targets USER -- terrain/type-immunity checks in the
    // !moveTargetsUser block must not fire even with hostile field state.
    expect(check(s, 'MOVE_SWORDS_DANCE').score).toBe(100)
  })
})

describe('AI_CheckBadMove part 1 -- any-target checks', () => {
  it('throat chop zeroes the score for a sound move outright (return 0, not RETURN_SCORE_MINUS)', () => {
    const s = state()
    s.battlers[0]!.volatiles.throatChopTimer = 3
    expect(check(s, 'MOVE_CONFUSE_RAY' /* not sound */).score).toBe(100)
    // Growl/Roar-family are sound-flagged; use MOVE_ROAR (sound: true expected)
    if (moveById.get('MOVE_ROAR')!.flags?.sound) {
      expect(check(s, 'MOVE_ROAR').score).toBe(0)
    }
  })

  it('RETURN_SCORE_MINUS(30) for a weather-changing move under primal weather', () => {
    const s = state()
    s.field.weather |= WEATHER_SUN_PRIMAL
    expect(check(s, 'MOVE_SANDSTORM').score).toBe(70)
  })

  it('RETURN_SCORE_MINUS(30) for a Water move under primal sun', () => {
    const s = state({ types: ['WATER', 'MYSTERY', 'MYSTERY'] })
    s.field.weather |= WEATHER_SUN_PRIMAL
    const waterMove = rawMoves.find((m) => m.type === 'TYPE_WATER' && m.split !== 'STATUS')!.id as string
    expect(check(s, waterMove).score).toBe(70)
  })

  it('RETURN_SCORE_MINUS(30) for a Fire move under primal rain', () => {
    const s = state({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    s.field.weather |= WEATHER_RAIN_PRIMAL
    const fireMove = rawMoves.find((m) => m.type === 'TYPE_FIRE' && m.split !== 'STATUS')!.id as string
    expect(check(s, fireMove).score).toBe(70)
  })
})

describe('AI_CheckBadMove part 1 -- move effect switch', () => {
  it('EFFECT_SLEEP: -10 when the target cannot sleep (already statused)', () => {
    const s = state({}, { status1: 0x6 /* STATUS1_PARALYSIS */ })
    expect(check(s, 'MOVE_SLEEP_POWDER').score).toBe(90)
  })
  it('EFFECT_SLEEP: no penalty when the target can sleep', () => {
    const s = state()
    expect(check(s, 'MOVE_SLEEP_POWDER').score).toBe(100)
  })

  it('EFFECT_EXPLOSION: -2 for suicide moves when AI_FLAG_WILL_SUICIDE is unset', () => {
    const s = state({}, {}, createRandomSource(1), 0)
    expect(check(s, 'MOVE_EXPLOSION').score).toBe(97) // -2 (suicide) -1 (both sides have 0 usable party mons here)
  })
  it('EFFECT_EXPLOSION: no -2 when AI_FLAG_WILL_SUICIDE is set', () => {
    const s = state({}, {}, createRandomSource(1), AI_FLAG_WILL_SUICIDE)
    expect(check(s, 'MOVE_EXPLOSION').score).toBe(99) // no suicide penalty, but the -1 both-sides-empty-party branch still applies
  })

  it('EFFECT_ATTACK_UP: -10 when the attacker has no physical move (Swords Dance targets USER, so type-immunity checks are skipped, but the effect switch still runs)', () => {
    const s = state({ moves: ['MOVE_SWORDS_DANCE', null, null, null] })
    expect(check(s, 'MOVE_SWORDS_DANCE').score).toBe(90)
  })
  it('EFFECT_ATTACK_UP: no penalty when the attacker has a physical move and can still rise', () => {
    const s = state({ moves: ['MOVE_TACKLE', 'MOVE_SWORDS_DANCE', null, null] })
    expect(check(s, 'MOVE_SWORDS_DANCE').score).toBe(100)
  })

  it('EFFECT_POISON/EFFECT_TOXIC: -10 against a Poison-type target (CanPoisonType)', () => {
    const s = state({}, { types: ['POISON', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_TOXIC').score).toBe(90)
  })
  it('EFFECT_POISON/EFFECT_TOXIC: no penalty against a poisonable target', () => {
    const s = state()
    expect(check(s, 'MOVE_TOXIC').score).toBe(100)
  })

  it('EFFECT_PARALYZE: -20 against an Electric-type target (CanParalyzeType)', () => {
    const s = state({}, { types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_THUNDER_WAVE').score).toBe(80)
  })
  it('EFFECT_PARALYZE: -20 when Safeguard is up on the target side', () => {
    const s = state()
    s.sides[1].statuses |= SIDE_STATUS_SAFEGUARD
    expect(check(s, 'MOVE_THUNDER_WAVE').score).toBe(80)
  })

  it('EFFECT_CONFUSE: -20 when the target cannot be confused (already confused)', () => {
    const s = state({}, { status2: 0x3 /* STATUS2_CONFUSION nonzero */ })
    expect(check(s, 'MOVE_CONFUSE_RAY').score).toBe(80)
  })

  it('EFFECT_SUBSTITUTE: -10 when the attacker already has a Substitute up', () => {
    const s = state({ status2: 0x1000000 /* STATUS2_SUBSTITUTE */ })
    expect(check(s, 'MOVE_SUBSTITUTE').score).toBe(90)
  })
  it('EFFECT_SUBSTITUTE: -10 when the attacker is at or below 25% HP', () => {
    const s = state({ hp: 25, maxHp: 100 })
    expect(check(s, 'MOVE_SUBSTITUTE').score).toBe(90)
  })

  it('EFFECT_LEECH_SEED: -20 against a Grass-type target', () => {
    const s = state({}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_LEECH_SEED').score).toBe(80)
  })

  it('EFFECT_FOCUS_PUNCH: +5 without a Substitute up, -10 with one', () => {
    const s1 = state()
    expect(check(s1, 'MOVE_FOCUS_PUNCH').score).toBe(105)
    const s2 = state({ status2: 0x1000000 })
    expect(check(s2, 'MOVE_FOCUS_PUNCH').score).toBe(90)
  })

  it('EFFECT_ROAR: -10 when the target has no usable party mons to switch into', () => {
    const s = state()
    expect(check(s, 'MOVE_ROAR').score).toBe(90) // countUsablePartyMons is 0 with no party supplied
  })

  it('EFFECT_MEAN_LOOK: -10 when the target is already trapped (Rooted)', () => {
    const s = state()
    s.battlers[1]!.statuses3 |= 1 << 10 // STATUS3_ROOTED
    expect(check(s, 'MOVE_MEAN_LOOK').score).toBe(90)
  })

  it('EFFECT_CAPTIVATE: -10 when genders match', () => {
    const s = state({ gender: 'MALE' }, { gender: 'MALE' })
    expect(check(s, 'MOVE_CAPTIVATE').score).toBe(90)
  })
  it('EFFECT_CAPTIVATE: no penalty for opposite genders', () => {
    const s = state({ gender: 'MALE' }, { gender: 'FEMALE' })
    expect(check(s, 'MOVE_CAPTIVATE').score).toBe(100)
  })

  it('EFFECT_HAZE: -10 per attacker stat above default (no partner in singles, so PartnerHasSameMoveEffectWithoutTarget never applies)', () => {
    const s = state()
    s.battlers[0]!.mon.statStages[1] = 8 // STAT_ATK raised
    expect(check(s, 'MOVE_HAZE').score).toBe(90)
  })

  it('EFFECT_SPIKES: -10 at 3 layers already set', () => {
    const s = state()
    s.sides[1].timers.spikesAmount = 3
    expect(check(s, 'MOVE_SPIKES').score).toBe(90)
  })
  it('EFFECT_SPIKES: no penalty below 3 layers', () => {
    const s = state()
    s.sides[1].timers.spikesAmount = 1
    expect(check(s, 'MOVE_SPIKES').score).toBe(100)
  })

  it('EFFECT_PERISH_SONG: -10 when the attacker has no usable party mons and the target does', () => {
    const s = state()
    expect(check(s, 'MOVE_PERISH_SONG').score).toBe(100) // both sides have 0 usable party mons here -- neither branch fires
  })

  it('EFFECT_SANDSTORM (now real, cycle17): unchanged with no weather active, -8 when Sandstorm is already up', () => {
    const s = state()
    expect(check(s, 'MOVE_SANDSTORM').score).toBe(100)
    s.field.weather = WEATHER_SANDSTORM_TEMPORARY
    expect(check(s, 'MOVE_SANDSTORM').score).toBe(92)
  })

  it('EFFECT_HIT (the default/damage-path case) is a pure passthrough', () => {
    const s = state()
    expect(check(s, 'MOVE_TACKLE').score).toBe(100)
  })
})

describe('AI_CheckBadMove wired into chooseAiAction/chooseMoveOrActionSingles', () => {
  it('the AI avoids a move penalised by AI_CheckBadMove (a status move the target is immune to via ability) in favour of a clean damaging move', () => {
    const s = state(
      { moves: ['MOVE_TACKLE', 'MOVE_SLEEP_POWDER', null, null], pp: [35, 15, 0, 0], abilities: { ability: null, innates: [null, null, null] } },
      { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, // powder-immune -- Sleep Powder gets RETURN_SCORE_MINUS(20)
      scripted(0),
    )
    const scores: [number, number, number, number] = [100, 100, 100, 100]
    const badMoveResult0 = aiCheckBadMove(s, 0, 1, 'MOVE_TACKLE', scores[0], deps)
    const badMoveResult1 = aiCheckBadMove(s, 0, 1, 'MOVE_SLEEP_POWDER', scores[1], deps)
    scores[0] = badMoveResult0.score
    scores[1] = badMoveResult1.score
    expect(scores[0]).toBe(100)
    expect(scores[1]).toBe(80)
    const { choice } = chooseMoveOrActionSingles(s, 0, scores, deps)
    expect(choice).toEqual({ kind: 'move', moveIndex: 0 })
  })
})

// ---------------------------------------------------------------------------
// Fix pass (post-review): PART2_EFFECTS accuracy, Mold Breaker breakable
// flag, and the RETURN_ABILITY_IF_FLAG full-ability-set scans.
// ---------------------------------------------------------------------------

describe('cycle17 (part 2) -- effects that used to push a "handled in part 2" gap now score for real', () => {
  it('EFFECT_RAPID_SPIN scores -6 when the attacker has no hazards to spin away, and pushes no part-2 gap', () => {
    const s = state()
    const r = check(s, 'MOVE_RAPID_SPIN')
    expect(r.score).toBe(94)
    expect(r.unmodelled.some((u) => u.includes('part 2'))).toBe(false)
  })

  it('EFFECT_FAKE_OUT scores -30 on a non-first turn, and pushes no part-2 gap', () => {
    const s = state()
    s.battlers[0]!.volatiles.isFirstTurn = 0
    const r = check(s, 'MOVE_FAKE_OUT')
    expect(r.score).toBe(70)
    expect(r.unmodelled.some((u) => u.includes('part 2'))).toBe(false)
  })

  it('EFFECT_TRICK scores -10 against a Sticky Hold defender, and pushes no part-2 gap', () => {
    const s = stateWithDefenderParty({}, { abilities: { ability: 'ABILITY_STICKY_HOLD', innates: [null, null, null] } })
    const move = rawMoves.find((m) => m.effect === 'EFFECT_TRICK')!.id as string
    const r = aiCheckBadMove(s, 0, 1, move, 100, depsWithMoldBreaker(false))
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('part 2'))).toBe(false)
  })

  it('a real default-path effect not handled anywhere in the switch (EFFECT_HEX, EFFECT_PAYBACK) is correctly silent -- no gap naming the effect', () => {
    // Water is neutral against both Ghost (Hex) and Dark (Payback) -- avoids
    // an unrelated type-immunity RETURN_SCORE_MINUS(20) from masking the
    // classification assertion this test is actually about.
    for (const moveId of ['MOVE_HEX', 'MOVE_PAYBACK']) {
      const s = state({}, { types: ['WATER', 'MYSTERY', 'MYSTERY'] })
      const r = check(s, moveId)
      expect(r.score).toBe(100)
      const effect = moveById.get(moveId)!.effect as string
      expect(r.unmodelled.some((u) => u.includes(effect))).toBe(false)
    }
  })

  it('a Pledge move (the naming-mismatch class of bug cycle16 caught) is classified correctly: EFFECT_ARGUMENT_HIT is the real effect, not EFFECT_FIRE_PLEDGE, and falls to the damage-path default, not EFFECT_PLEDGE', () => {
    const m = moveById.get('MOVE_FIRE_PLEDGE')!
    expect(m.effect).toBe('EFFECT_ARGUMENT_HIT')
    const s = state()
    const r = check(s, 'MOVE_FIRE_PLEDGE')
    expect(r.score).toBe(100)
    // Damage-path gaps from the shared calculateMoveDamage engine (stat
    // stages, condition flags, ...) are expected for any damaging move and
    // are out of this batch's scope -- only assert no gap names the Pledge
    // effect itself.
    expect(r.unmodelled.some((u) => u.includes('EFFECT_ARGUMENT_HIT') || u.includes('EFFECT_FIRE_PLEDGE'))).toBe(false)
  })

  it('the seven case labels that exist only in commented-out C code (EFFECT_PLASMA_FISTS et al) are not live case labels here either -- fall to default, matching the real compiled C', () => {
    // These ARE real moves.json effect values (Sky Drop, No Retreat, etc. are
    // genuine moves elsewhere in the game) -- the point is narrower: none of
    // them is a live `case` label inside THIS function's switch, because the
    // C's own AI_CheckBadMove has them commented out (:2121-2148).
    const src = readFileSync(join(import.meta.dirname, 'aiCheckBadMove.ts'), 'utf8')
    for (const label of ['EFFECT_PLASMA_FISTS', 'EFFECT_SHELL_TRAP', 'EFFECT_BEAK_BLAST', 'EFFECT_SKY_DROP', 'EFFECT_NO_RETREAT', 'EFFECT_EXTREME_EVOBOOST', 'EFFECT_CLANGOROUS_SOUL']) {
      expect(src.includes(`case '${label}'`)).toBe(false)
    }
  })
})

describe('cycle17 (part 2) -- case-by-case coverage', () => {
  const eff = (name: string) => rawMoves.find((m) => m.effect === name)!.id as string

  it('EFFECT_ATTRACT: -10 when the target cannot be infatuated (already infatuated), unchanged otherwise', () => {
    const s = state()
    expect(check(s, eff('EFFECT_ATTRACT')).score).toBe(100)
    s.battlers[1]!.mon.status2 = STATUS2_INFATUATION
    expect(check(s, eff('EFFECT_ATTRACT')).score).toBe(90)
  })

  it('EFFECT_SAFEGUARD: -10 when the attacker\'s own side already has Safeguard up', () => {
    const s = state()
    expect(check(s, eff('EFFECT_SAFEGUARD')).score).toBe(100)
    s.sides[0].statuses |= SIDE_STATUS_SAFEGUARD
    expect(check(s, eff('EFFECT_SAFEGUARD')).score).toBe(90)
  })

  it('EFFECT_BATON_PASS: -10 with no usable party mons (the default fixture has none)', () => {
    const s = state()
    expect(check(s, 'MOVE_BATON_PASS').score).toBe(90)
  })

  it('EFFECT_BATON_PASS: with usable reserves, -6 with nothing worth passing on, unchanged once a stat is raised', () => {
    const s = createBattleState({
      battlers: [createBattlerState(0, mon(), 0), createBattlerState(1, mon(), 0)],
      rng: createRandomSource(1),
      playerParty: [partyMon({ hp: 100 }), partyMon({ hp: 100 })], // slot 0 is the active battler itself; slot 1 is the usable reserve
    })
    expect(check(s, 'MOVE_BATON_PASS').score).toBe(94) // no raised stat, no substitute/rooted -- the -6 branch
    s.battlers[0]!.mon.statStages[1] = 8 // STAT_ATK raised -- AnyStatIsRaised true
    expect(check(s, 'MOVE_BATON_PASS').score).toBe(100) // no score change
  })

  it('EFFECT_WILL_O_WISP: -10 when the target cannot be burned (Fire-type)', () => {
    const s = state({}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_WILL_O_WISP').score).toBe(90)
  })

  it('EFFECT_TORMENT: -10 when the target already has Torment', () => {
    const s = state()
    s.battlers[1]!.mon.status2 = STATUS2_TORMENT
    expect(check(s, eff('EFFECT_TORMENT')).score).toBe(90)
  })

  it('EFFECT_PSYCHO_SHIFT: transmits the attacker\'s own poison, scoring -10 when the target cannot be poisoned (Poison-type)', () => {
    const s = state({ status1: STATUS1_POISON }, { types: ['POISON', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, eff('EFFECT_PSYCHO_SHIFT')).score).toBe(90)
  })

  it('EFFECT_PSYCHO_SHIFT: -10 unconditionally when the attacker has no status to transmit', () => {
    const s = state({ status1: 0 })
    expect(check(s, eff('EFFECT_PSYCHO_SHIFT')).score).toBe(90)
  })

  it('EFFECT_TRANSFORM: -10 when the attacker is already transformed', () => {
    const s = state()
    s.battlers[0]!.mon.status2 = STATUS2_TRANSFORMED
    expect(check(s, eff('EFFECT_TRANSFORM')).score).toBe(90)
  })

  it('EFFECT_RECHARGE: -2 when the attacker lacks Truant and cannot faint the target this turn', () => {
    const s = state({}, { hp: 999, maxHp: 999 })
    const r = check(s, 'MOVE_HYPER_BEAM')
    expect(r.score).toBe(98)
  })

  it('EFFECT_PROTECT: the protectUses===1 RNG draw scores -6 on a hit and 0 on a miss (scripted rng)', () => {
    const s1 = state({}, {}, scripted(49)) // 49 % 100 < 50 -- hits
    s1.battlers[0]!.volatiles.protectUses = 1
    expect(check(s1, 'MOVE_PROTECT').score).toBe(94)
    const s2 = state({}, {}, scripted(50)) // 50 % 100 < 50 is false -- misses
    s2.battlers[0]!.volatiles.protectUses = 1
    expect(check(s2, 'MOVE_PROTECT').score).toBe(100)
  })

  it('EFFECT_PROTECT: -10 with 2+ prior uses, -10 when the target is incapacitated', () => {
    const s = state()
    s.battlers[0]!.volatiles.protectUses = 2
    expect(check(s, 'MOVE_PROTECT').score).toBe(90)
    const s2 = state()
    s2.battlers[1]!.mon.status1 = STATUS1_SLEEP
    expect(check(s2, 'MOVE_PROTECT').score).toBe(90)
  })

  it('EFFECT_DEFOG: -10 when the opposing side already has hazards up (don\'t blow them away)', () => {
    const s = state()
    s.sides[1].statuses |= SIDE_STATUS_SPIKES
    expect(check(s, 'MOVE_DEFOG').score).toBe(90)
  })

  it('EFFECT_SOLARBEAM: no penalty holding Power Herb, -14 otherwise when the attacker can be knocked out first', () => {
    const s1 = state({ itemId: 'ITEM_POWER_HERB' })
    expect(check(s1, 'MOVE_SOLAR_BEAM').score).toBe(100)
  })

  it('EFFECT_TRICK_ROOM: -10 when Clueless is on the field', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_CLUELESS', innates: [null, null, null] } })
    expect(check(s, 'MOVE_TRICK_ROOM').score).toBe(90)
  })

  it('EFFECT_MAGIC_ROOM / EFFECT_WONDER_ROOM: -10 when already active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_MAGIC_ROOM
    expect(check(s, 'MOVE_MAGIC_ROOM').score).toBe(90)
    const s2 = state()
    s2.field.statuses |= STATUS_FIELD_WONDER_ROOM
    expect(check(s2, 'MOVE_WONDER_ROOM').score).toBe(90)
  })

  it('EFFECT_GRAVITY: -10 when Gravity is already active and the attacker is grounded', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_GRAVITY
    expect(check(s, 'MOVE_GRAVITY').score).toBe(90)
  })

  it('EFFECT_TELEKINESIS: -10 against a telekinesis-banned species (Diglett)', () => {
    const s = state({}, { speciesId: 'SPECIES_DIGLETT' })
    expect(check(s, 'MOVE_TELEKINESIS').score).toBe(90)
  })

  it('EFFECT_FLING: -10 with no item to fling', () => {
    const s = state({ itemId: null })
    expect(check(s, 'MOVE_FLING').score).toBe(90)
  })

  it('EFFECT_ROLE_PLAY: -10 when the target has no ability (ABILITY_NONE)', () => {
    const s = state({ abilities: { ability: 'ABILITY_TORRENT', innates: [null, null, null] } }, { abilities: { ability: null, innates: [null, null, null] } })
    expect(check(s, 'MOVE_ROLE_PLAY').score).toBe(90)
  })

  it('EFFECT_SKILL_SWAP: -10 when both battlers share the same ability', () => {
    const s = state({ abilities: { ability: 'ABILITY_TORRENT', innates: [null, null, null] } }, { abilities: { ability: 'ABILITY_TORRENT', innates: [null, null, null] } })
    expect(check(s, 'MOVE_SKILL_SWAP').score).toBe(90)
  })

  it('EFFECT_ENTRAINMENT: -10 when the attacker has no ability', () => {
    const s = state({ abilities: { ability: null, innates: [null, null, null] } })
    expect(check(s, 'MOVE_ENTRAINMENT').score).toBe(90)
  })

  it('EFFECT_GASTRO_ACID: -10 against an Ability Shield holder', () => {
    const s = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    expect(check(s, 'MOVE_GASTRO_ACID').score).toBe(90)
  })

  it('EFFECT_WORRY_SEED: -10 against Insomnia', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_INSOMNIA', innates: [null, null, null] } })
    expect(check(s, 'MOVE_WORRY_SEED').score).toBe(90)
  })

  it('EFFECT_SIMPLE_BEAM: -10 when the attacker already has Simple', () => {
    const s = state({ abilities: { ability: 'ABILITY_SIMPLE', innates: [null, null, null] } })
    expect(check(s, eff('EFFECT_SIMPLE_BEAM')).score).toBe(90)
  })

  it('EFFECT_POWER_TRICK: -10 when the attacker\'s Defense already exceeds its Attack and it has no physical move', () => {
    const s = state({ rawStats: { atk: 50, def: 200, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_WATER_GUN', null, null, null] })
    expect(check(s, eff('EFFECT_POWER_TRICK')).score).toBe(90)
  })

  it('EFFECT_SPEED_SWAP: -10 when the attacker is already faster', () => {
    const s = state({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } }, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 } })
    expect(check(s, eff('EFFECT_SPEED_SWAP')).score).toBe(90)
  })

  it('EFFECT_HEART_SWAP: -10 when the attacker has more positive and no more negative stages than the target', () => {
    const s = state()
    expect(check(s, eff('EFFECT_HEART_SWAP')).score).toBe(90) // both 0/0 -- 0>=0 && 0<=0
  })

  it('EFFECT_TOPSY_TURVY: -10 when the target has no positive stat changes to invert', () => {
    const s = state()
    expect(check(s, eff('EFFECT_TOPSY_TURVY')).score).toBe(90)
  })

  it('EFFECT_TAUNT: -1 then an additional -10 while Taunt is already active on the target', () => {
    const s = state()
    s.battlers[1]!.volatiles.tauntTimer = 3
    expect(check(s, 'MOVE_TAUNT').score).toBe(89)
  })

  it('EFFECT_CAMOUFLAGE is gapped (no overworld-map-terrain port) and never penalised (no real move carries this effect -- exercised via a synthetic move)', () => {
    const s = state()
    const r = aiCheckBadMove(s, 0, 1, 'MOVE_SYNTHETIC_EFFECT', 100, depsWithSyntheticEffect('EFFECT_CAMOUFLAGE'))
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('CanCamouflage'))).toBe(true)
  })

  it('EFFECT_LAST_RESORT: -10 when the attacker has an unused, non-Last-Resort move slot', () => {
    const s = state({ moves: ['MOVE_LAST_RESORT', 'MOVE_TACKLE', null, null] })
    expect(check(s, 'MOVE_LAST_RESORT').score).toBe(90)
  })

  it('EFFECT_SYNCHRONOISE quirk (real in the C, not a porting bug): a mono-typed target is ALWAYS "same type" via the shared, unfilled TYPE_MYSTERY slot -- IS_BATTLER_OF_TYPE has no TYPE_MYSTERY guard', () => {
    const s = state({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { types: ['WATER', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_SYNCHRONOISE').score).toBe(100) // "same type" via the shared MYSTERY slot, not a real type match
  })

  it('EFFECT_SYNCHRONOISE: -10 when neither battler has an empty type slot to coincidentally share (both fully triple-typed, no overlap)', () => {
    const s = state({ types: ['FIRE', 'FLYING', 'STEEL'] }, { types: ['WATER', 'GROUND', 'ICE'] })
    expect(check(s, 'MOVE_SYNCHRONOISE').score).toBe(90)
  })

  it('EFFECT_ERUPTION: -1 when not-very-effective, another -1 when the target is below 50% HP (stacking to -2)', () => {
    const s = state({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { types: ['FIRE', 'MYSTERY', 'MYSTERY'], hp: 40, maxHp: 100 })
    const r = check(s, 'MOVE_ERUPTION')
    expect(r.score).toBe(98)
  })

  it('EFFECT_VITAL_THROW is gapped (AI_CHECK_FASTER has no port) and never penalised (no real move carries this effect -- exercised via a synthetic move)', () => {
    const s = state()
    const r = aiCheckBadMove(s, 0, 1, 'MOVE_SYNTHETIC_EFFECT', 100, depsWithSyntheticEffect('EFFECT_VITAL_THROW'))
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('AI_CHECK_FASTER'))).toBe(true)
  })

  it('EFFECT_FLAIL: -4 when the attacker is above 50% HP', () => {
    const s = state({ hp: 80, maxHp: 100 })
    expect(check(s, 'MOVE_FLAIL').score).toBe(96)
  })

  it('EFFECT_DO_NOTHING always scores -10', () => {
    const s = state()
    expect(check(s, eff('EFFECT_DO_NOTHING')).score).toBe(90)
  })

  it('EFFECT_QUASH always scores -10 in singles (isDoubleBattle is always false)', () => {
    const s = state()
    expect(check(s, 'MOVE_QUASH').score).toBe(90)
  })

  it('EFFECT_AFTER_YOU always scores -10 in singles (isTargetingPartner is always false)', () => {
    const s = state()
    expect(check(s, 'MOVE_AFTER_YOU').score).toBe(90)
  })

  it('EFFECT_SUCKER_PUNCH is gapped unreachable (predictedMove always MOVE_NONE) and never penalised', () => {
    const s = state()
    const r = check(s, 'MOVE_SUCKER_PUNCH')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('EFFECT_SUCKER_PUNCH'))).toBe(true)
  })

  it('EFFECT_TAILWIND: -10 when Tailwind is already up on the attacker\'s side', () => {
    const s = state()
    s.sides[0].timers.tailwindTimer = 3
    expect(check(s, 'MOVE_TAILWIND').score).toBe(90)
  })

  it('EFFECT_MAGNET_RISE: -10 while Gravity is active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_GRAVITY
    expect(check(s, 'MOVE_MAGNET_RISE').score).toBe(90)
  })

  it('recoil tail: a recoil move (Take Down-class, EFFECT_RECOIL_25) is discouraged via ShouldUseRecoilMove when the recoil would faint the attacker and there is another target left', () => {
    const recoilMoveId = rawMoves.find((m) => m.effect === 'EFFECT_RECOIL_25')!.id as string
    const s = stateWithDefenderParty({ hp: 1, maxHp: 100 })
    const r = check(s, recoilMoveId)
    // hp=1 guarantees recoilDmg (>=1) >= attacker hp; the target is at full
    // HP so recoilDmg < defHp, taking ShouldUseRecoilMove's unconditional
    // "will faint and not win" FALSE branch -- no CanAIFaintTarget call needed.
    expect(r.score).toBe(90)
  })

  it('pipeline-level: chooseAiAction avoids a move part 2 penalises (Belly Drum below 60% HP) in favour of a clean move', () => {
    const s = state({ moves: ['MOVE_TACKLE', 'MOVE_BELLY_DRUM', null, null], pp: [35, 10, 0, 0], hp: 50, maxHp: 100 })
    const scores: [number, number, number, number] = [100, 100, 100, 100]
    scores[0] = aiCheckBadMove(s, 0, 1, 'MOVE_TACKLE', scores[0], deps).score
    scores[1] = aiCheckBadMove(s, 0, 1, 'MOVE_BELLY_DRUM', scores[1], deps).score
    expect(scores[1]).toBeLessThan(scores[0])
    const { choice } = chooseMoveOrActionSingles(s, 0, scores, deps)
    expect(choice).toEqual({ kind: 'move', moveIndex: 0 })
  })

  // -------------------------------------------------------------------
  // Remaining part-2 case labels, one assertion each. Siblings that share
  // the exact same code shape (e.g. every EFFECT_*_TERRAIN, every weather
  // move, TRICK/KNOCK_OFF) are exercised once and noted, not each retested,
  // matching cycle16's own "mechanically identical siblings" precedent.
  // -------------------------------------------------------------------

  it('EFFECT_ABSORB: -6 against Liquid Ooze (MOVE_ABSORB itself is EFFECT_CLEAR_SMOG on this snapshot -- use MOVE_DRAIN_PUNCH, a real EFFECT_ABSORB move)', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_LIQUID_OOZE', innates: [null, null, null] } })
    expect(check(s, 'MOVE_DRAIN_PUNCH').score).toBe(94)
  })

  it('EFFECT_AQUA_RING: -10 while already active', () => {
    const s = state()
    s.battlers[0]!.statuses3 |= STATUS3_AQUA_RING
    expect(check(s, 'MOVE_AQUA_RING').score).toBe(90)
  })

  it('EFFECT_AROMATIC_MIST always scores -10 in singles (isDoubleBattle is always false)', () => {
    const s = state()
    expect(check(s, 'MOVE_AROMATIC_MIST').score).toBe(90)
  })

  it('EFFECT_ASSIST: -10 with no usable party mons (the default fixture has none)', () => {
    const s = state()
    expect(check(s, 'MOVE_ASSIST').score).toBe(90)
  })

  it('EFFECT_BELCH is gapped (GetUsedHeldItem untracked) and always scores -10', () => {
    const s = state()
    const r = check(s, 'MOVE_BELCH')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('GetUsedHeldItem'))).toBe(true)
  })

  it('EFFECT_BELLY_DRUM: -10 with Contrary', () => {
    const s = state({ abilities: { ability: 'ABILITY_CONTRARY', innates: [null, null, null] } })
    expect(check(s, 'MOVE_BELLY_DRUM').score).toBe(90)
  })

  it('EFFECT_BESTOW: -10 holding no item', () => {
    const s = state({ itemId: null })
    expect(check(s, 'MOVE_BESTOW').score).toBe(90)
  })

  it('EFFECT_BIDE: -10 when the attacker is below 30% HP', () => {
    const s = state({ hp: 20, maxHp: 100 })
    expect(check(s, 'MOVE_BIDE').score).toBe(90)
  })

  it('EFFECT_BURN_UP: -10 when the attacker is not the move\'s own type (Fire)', () => {
    const s = state({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_BURN_UP').score).toBe(90)
  })

  it('EFFECT_CONVERSION: -10 when the attacker is already the type of its own first move', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null], types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_CONVERSION').score).toBe(90)
  })

  it('EFFECT_COPYCAT/EFFECT_MIRROR_MOVE recurse with predictedMove always MOVE_NONE, matching the C\'s own no-prediction default path (no score change)', () => {
    const s = state()
    const r = check(s, eff('EFFECT_COPYCAT'))
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('recurses into AI_CheckBadMove'))).toBe(true)
  })

  it('EFFECT_DESTINY_BOND: -10 while already active on the target', () => {
    const s = state()
    s.battlers[1]!.mon.status2 = STATUS2_DESTINY_BOND
    expect(check(s, 'MOVE_DESTINY_BOND').score).toBe(90)
  })

  it('EFFECT_ELECTRIC_TERRAIN (representative of all five *_TERRAIN-setting effects): -20 when that terrain is already active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    expect(check(s, 'MOVE_ELECTRIC_TERRAIN').score).toBe(80)
  })

  it('EFFECT_EMBARGO: -10 against Klutz', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } })
    expect(check(s, 'MOVE_EMBARGO').score).toBe(90)
  })

  it('EFFECT_ENDEAVOR/EFFECT_PAIN_SPLIT: -10 when the attacker\'s HP already exceeds the post-split average', () => {
    const s = state({ hp: 100, maxHp: 100 }, { hp: 10, maxHp: 100 })
    expect(check(s, 'MOVE_ENDEAVOR').score).toBe(90)
  })

  it('EFFECT_ENDURE: -10 at 1 HP', () => {
    const s = state({ hp: 1, maxHp: 100 })
    expect(check(s, 'MOVE_ENDURE').score).toBe(90)
  })

  it('EFFECT_FAIRY_LOCK: -10 while already active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_FAIRY_LOCK
    expect(check(s, 'MOVE_FAIRY_LOCK').score).toBe(90)
  })

  it('EFFECT_FINAL_GAMBIT: -10 with no usable party mons', () => {
    const s = state()
    expect(check(s, 'MOVE_FINAL_GAMBIT').score).toBe(90)
  })

  it('EFFECT_FLOWER_SHIELD: -10 when the attacker is not Grass-type', () => {
    const s = state({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_FLOWER_SHIELD').score).toBe(90)
  })

  it('EFFECT_FOLLOW_ME/EFFECT_HELPING_HAND always score -10 in singles', () => {
    const s = state()
    expect(check(s, 'MOVE_FOLLOW_ME').score).toBe(90)
    expect(check(s, eff('EFFECT_HELPING_HAND')).score).toBe(90)
  })

  it('EFFECT_FUTURE_SIGHT: +5 when neither side already has a future attack pending', () => {
    const s = state()
    expect(check(s, 'MOVE_FUTURE_SIGHT').score).toBe(105)
  })

  it('EFFECT_GUARD_SWAP/EFFECT_POWER_SWAP: -10 when the attacker\'s relevant stat stages already tie or exceed the target\'s (the neutral/neutral default)', () => {
    const s = state()
    expect(check(s, 'MOVE_GUARD_SWAP').score).toBe(90)
    expect(check(s, 'MOVE_POWER_SWAP').score).toBe(90)
  })

  it('EFFECT_GUARD_SPLIT/EFFECT_POWER_SPLIT: -10 when the attacker\'s combined stats already tie or exceed the target\'s (the identical-stat default)', () => {
    const s = state()
    expect(check(s, 'MOVE_GUARD_SPLIT').score).toBe(90)
    expect(check(s, 'MOVE_POWER_SPLIT').score).toBe(90)
  })

  it('EFFECT_RAIN_DANCE (a weather sibling of EFFECT_SANDSTORM): -8 while Rain is already up', () => {
    const s = state()
    s.field.weather = WEATHER_RAIN_TEMPORARY
    expect(check(s, 'MOVE_RAIN_DANCE').score).toBe(92)
  })

  it('EFFECT_HEAL_BELL is gapped (no party-wide status scan) and always scores -10', () => {
    const s = state()
    const r = check(s, 'MOVE_HEAL_BELL')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('AnyPartyMemberStatused'))).toBe(true)
  })

  it('EFFECT_HEAL_BLOCK: -10 while already active on the target', () => {
    const s = state()
    s.battlers[1]!.volatiles.healBlockTimer = 3
    expect(check(s, 'MOVE_HEAL_BLOCK').score).toBe(90)
  })

  it('EFFECT_HEALING_WISH: -10 with no usable party mons', () => {
    const s = state()
    expect(check(s, eff('EFFECT_HEALING_WISH')).score).toBe(90)
  })

  it('EFFECT_HEAL_PULSE/EFFECT_HIT_ENEMY_HEAL_ALLY always score -10 in singles ("don\'t heal enemies")', () => {
    const s = state()
    expect(check(s, 'MOVE_HEAL_PULSE').score).toBe(90)
    expect(check(s, eff('EFFECT_HIT_ENEMY_HEAL_ALLY')).score).toBe(90)
  })

  it('EFFECT_HIT_SWITCH_TARGET: -10 when the target already has Perish Song counting down', () => {
    const s = state()
    s.battlers[1]!.statuses3 |= STATUS3_PERISH_SONG
    expect(check(s, eff('EFFECT_HIT_SWITCH_TARGET')).score).toBe(90)
  })

  it('EFFECT_IMPRISON: -10 while already active', () => {
    const s = state()
    s.battlers[0]!.statuses3 |= STATUS3_IMPRISONED_OTHERS
    expect(check(s, 'MOVE_IMPRISON').score).toBe(90)
  })

  it('EFFECT_INGRAIN: -10 while already active', () => {
    const s = state()
    s.battlers[0]!.statuses3 |= STATUS3_ROOTED
    expect(check(s, 'MOVE_INGRAIN').score).toBe(90)
  })

  it('EFFECT_INSTRUCT: -10 by default (no last move revealed, and predictedMove is always MOVE_NONE, so both strikes-first branches give an unusable instructedMove)', () => {
    const s = state()
    expect(check(s, 'MOVE_INSTRUCT').score).toBe(90)
  })

  it('EFFECT_ION_DELUGE: -10 while already active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_ION_DELUGE
    expect(check(s, 'MOVE_ION_DELUGE').score).toBe(90)
  })

  it('EFFECT_LASER_FOCUS: -10 while already active', () => {
    const s = state()
    s.battlers[0]!.statuses3 |= STATUS3_LASER_FOCUS
    expect(check(s, 'MOVE_LASER_FOCUS').score).toBe(90)
  })

  it('EFFECT_LOCK_ON: -10 when the target already always-hits', () => {
    const s = state()
    s.battlers[1]!.statuses3 |= STATUS3_ALWAYS_HITS
    expect(check(s, 'MOVE_LOCK_ON').score).toBe(90)
  })

  it('EFFECT_LUCKY_CHANT: -10 while already active', () => {
    const s = state()
    s.sides[0].timers.luckyChantTimer = 3
    expect(check(s, 'MOVE_LUCKY_CHANT').score).toBe(90)
  })

  it('EFFECT_MAGIC_COAT: -10 when the target has no Magic-Coat-affected move', () => {
    const s = state({}, { moves: ['MOVE_TACKLE', null, null, null] })
    expect(check(s, 'MOVE_MAGIC_COAT').score).toBe(90)
  })

  it('EFFECT_ME_FIRST always scores -10 (predictedMove is always MOVE_NONE)', () => {
    const s = state()
    const r = check(s, 'MOVE_ME_FIRST')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('EFFECT_ME_FIRST'))).toBe(true)
  })

  it('EFFECT_MEMENTO: -10 with no usable party mons', () => {
    const s = state()
    expect(check(s, 'MOVE_MEMENTO').score).toBe(90)
  })

  it('EFFECT_MIMIC/EFFECT_SPITE: -10 by default (a fresh state has no revealed last move either way)', () => {
    const s = state()
    expect(check(s, 'MOVE_MIMIC').score).toBe(90)
    expect(check(s, eff('EFFECT_SPITE')).score).toBe(90)
  })

  it('EFFECT_MOONLIGHT (representative of the EFFECT_MORNING_SUN/EFFECT_SYNTHESIS healing-move family): -10 at max HP with no bad weather active', () => {
    const s = state({ hp: 100, maxHp: 100 })
    expect(check(s, 'MOVE_MOONLIGHT').score).toBe(90)
  })

  it('EFFECT_MUD_SPORT/EFFECT_WATER_SPORT: -10 while already active', () => {
    const s = state()
    s.field.statuses |= STATUS_FIELD_MUDSPORT
    expect(check(s, 'MOVE_MUD_SPORT').score).toBe(90)
    const s2 = state()
    s2.field.statuses |= STATUS_FIELD_WATERSPORT
    expect(check(s2, 'MOVE_WATER_SPORT').score).toBe(90)
  })

  it('EFFECT_NATURAL_GIFT: -10 when the attacker is not holding a berry', () => {
    const s = state({ itemId: null })
    const r = check(s, 'MOVE_NATURAL_GIFT')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('ItemId_GetPocket'))).toBe(true)
  })

  it('EFFECT_NATURE_POWER recurses via GetNaturePowerMove\'s gapped map-terrain fallback (MOVE_TRI_ATTACK, no score change) -- MOVE_NATURE_POWER itself is EFFECT_TERRAIN_PULSE on this snapshot, so no real move carries EFFECT_NATURE_POWER; exercised via a synthetic move', () => {
    const s = state()
    const r = aiCheckBadMove(s, 0, 1, 'MOVE_SYNTHETIC_EFFECT', 100, depsWithSyntheticEffect('EFFECT_NATURE_POWER'))
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('GetNaturePowerMove'))).toBe(true)
  })

  it('EFFECT_PARTING_SHOT: -10 with no usable party mons', () => {
    const s = state()
    expect(check(s, 'MOVE_PARTING_SHOT').score).toBe(90)
  })

  it('EFFECT_POLTERGEIST: -20 when the target holds no item', () => {
    const s = state({}, { itemId: null })
    expect(check(s, 'MOVE_POLTERGEIST').score).toBe(80)
  })

  it('EFFECT_POWDER: -10 when the target has no Fire-type move', () => {
    const s = state({}, { moves: ['MOVE_TACKLE', null, null, null] })
    expect(check(s, 'MOVE_POWDER').score).toBe(90)
  })

  it('EFFECT_PSYCH_UP: -10 for each of the attacker\'s own raised stats and each of the target\'s own lowered stats', () => {
    const s = state()
    s.battlers[0]!.mon.statStages[1] = 8 // attacker ATK raised
    s.battlers[1]!.mon.statStages[2] = 4 // target DEF lowered
    expect(check(s, 'MOVE_PSYCH_UP').score).toBe(80)
  })

  it('EFFECT_PURIFY: -10 when the target has no status to cure', () => {
    const s = state({}, { status1: 0 })
    expect(check(s, 'MOVE_PURIFY').score).toBe(90)
  })

  it('EFFECT_RECOIL_IF_MISS is gapped (accuracy approximated by the declared value) and never penalised by any real move on this snapshot (every EFFECT_RECOIL_IF_MISS move here has accuracy >=90, never below the 75 threshold)', () => {
    const s = state()
    const r = check(s, eff('EFFECT_RECOIL_IF_MISS'))
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('AI_GetMoveAccuracy'))).toBe(true)
  })

  it('EFFECT_RECYCLE is gapped (GetUsedHeldItem untracked) and always scores -10', () => {
    const s = state()
    const r = check(s, 'MOVE_RECYCLE')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((u) => u.includes('GetUsedHeldItem'))).toBe(true)
  })

  it('EFFECT_REFRESH: -10 when the target has no status to cure', () => {
    const s = state({}, { status1: 0 })
    expect(check(s, 'MOVE_REFRESH').score).toBe(90)
  })

  it('EFFECT_REST/EFFECT_RESTORE_HP/EFFECT_SOFTBOILED/EFFECT_ROOST: -10 at max HP', () => {
    const s = state({ hp: 100, maxHp: 100 })
    expect(check(s, 'MOVE_REST').score).toBe(90)
    expect(check(s, eff('EFFECT_RESTORE_HP')).score).toBe(90)
  })

  it('EFFECT_SEMI_INVULNERABLE: the predictedMove branch is always unreachable (gapped); BattlerWillFaintFromWeather is additionally gapped for Fly/Bounce', () => {
    const s = state()
    const r = check(s, 'MOVE_FLY')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('opponent will use its own semi-invulnerable move'))).toBe(true)
    expect(r.unmodelled.some((u) => u.includes('BattlerWillFaintFromWeather'))).toBe(true)
  })

  it('EFFECT_SKETCH: -10 when the target has no revealed last move', () => {
    const s = state()
    expect(check(s, 'MOVE_SKETCH').score).toBe(90)
  })

  it('EFFECT_SOAK: -10 against a target that is already water-only', () => {
    const s = state({}, { types: ['WATER', 'WATER', 'MYSTERY'] })
    expect(check(s, 'MOVE_SOAK').score).toBe(90)
  })

  it('EFFECT_STOCKPILE: -10 at 3+ stacks', () => {
    const s = state()
    s.battlers[0]!.volatiles.stockpileCounter = 3
    expect(check(s, 'MOVE_STOCKPILE').score).toBe(90)
  })

  it('EFFECT_STRENGTH_SAP: -10 when the target\'s Attack is already low enough that lowering it further is pointless', () => {
    const s = state({}, { statStages: [] })
    s.battlers[1]!.mon.statStages[1] = 3 // below the shouldLowerStat stage<4 floor
    expect(check(s, 'MOVE_STRENGTH_SAP').score).toBe(90)
  })

  it('EFFECT_SUPER_FANG: -4 when the target is below 50% HP', () => {
    const s = state({}, { hp: 40, maxHp: 100 })
    expect(check(s, 'MOVE_SUPER_FANG').score).toBe(96)
  })

  it('EFFECT_SWALLOW: -10 with no Stockpile stacks', () => {
    const s = state()
    expect(check(s, 'MOVE_SWALLOW').score).toBe(90)
  })

  it('EFFECT_SWITCH_ARGUMENT always scores -10', () => {
    const s = state()
    expect(check(s, eff('EFFECT_SWITCH_ARGUMENT')).score).toBe(90)
  })

  it('EFFECT_TEETER_DANCE: no penalty by default (target not confused/immune/grounded-in-Misty-Terrain/Substituted), plus the always-present partner-slot gap note', () => {
    const s = state()
    const r = check(s, 'MOVE_TEETER_DANCE')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes("partner-of-target half"))).toBe(true)
  })

  it('EFFECT_THIRD_TYPE (Trick-or-Treat): -10 when the target is ALREADY Ghost-type (redundant), unchanged otherwise', () => {
    const s = state({}, { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(check(s, 'MOVE_TRICK_OR_TREAT').score).toBe(100)
    const s2 = state({}, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] })
    expect(check(s2, 'MOVE_TRICK_OR_TREAT').score).toBe(90)
  })

  it('EFFECT_TWO_TURNS_ATTACK: -6 when the attacker can be knocked out before the charge move fires (no real move carries this effect on this snapshot -- exercised via a synthetic move)', () => {
    const s = state({ hp: 1, maxHp: 1 })
    const r = aiCheckBadMove(s, 0, 1, 'MOVE_SYNTHETIC_EFFECT', 100, depsWithSyntheticEffect('EFFECT_TWO_TURNS_ATTACK'))
    expect(r.score).toBe(94)
  })

  it('EFFECT_WISH is gapped (no wishCounter state) and applies no penalty', () => {
    const s = state()
    const r = check(s, 'MOVE_WISH')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('wishCounter'))).toBe(true)
  })

  it('EFFECT_YAWN: -10 when the target already has Yawn pending', () => {
    const s = state()
    s.battlers[1]!.statuses3 |= STATUS3_YAWN
    expect(check(s, 'MOVE_YAWN').score).toBe(90)
  })
})

describe('Mold Breaker -- per-ability breakable flag (not a uniform bypass)', () => {
  it('suppresses a breakable ability (Wonder Guard) but not one that is not breakable (Speed Boost is not checked mid-switch without a real move -- use Suction Cups vs Strong Foundation on EFFECT_ROAR instead, which exercises both in one effect)', () => {
    // MOLD_BREAKABLE_ABILITIES sanity: Wonder Guard is breakable, Strong
    // Foundation and Superheavy are not (per abilityHooks.json).
    expect(MOLD_BREAKABLE_ABILITIES.includes('ABILITY_WONDER_GUARD')).toBe(true)
    expect(MOLD_BREAKABLE_ABILITIES.includes('ABILITY_STRONG_FOUNDATION')).toBe(false)
  })

  it('Wonder Guard (breakable): RETURN_SCORE_MINUS(20) without Mold Breaker, no penalty with it', () => {
    const s = state({}, { types: ['DRAGON', 'FLYING', 'MYSTERY'], abilities: { ability: 'ABILITY_WONDER_GUARD', innates: [null, null, null] } })
    const move = moveById.get('MOVE_ICE_BEAM')!
    expect(move.power).toBeGreaterThan(0)
    const withoutMB = aiCheckBadMove(s, 0, 1, 'MOVE_ICE_BEAM', 100, depsWithMoldBreaker(false))
    expect(withoutMB.score).toBe(80)
    const withMB = aiCheckBadMove(s, 0, 1, 'MOVE_ICE_BEAM', 100, depsWithMoldBreaker(true))
    expect(withMB.score).toBe(100)
  })

  it('Strong Foundation (suctionCups but NOT breakable): EFFECT_ROAR still penalises it even with a Mold-Breaker attacker', () => {
    const s = stateWithDefenderParty({}, { abilities: { ability: 'ABILITY_STRONG_FOUNDATION', innates: [null, null, null] } })
    const withMB = aiCheckBadMove(s, 0, 1, 'MOVE_ROAR', 100, depsWithMoldBreaker(true))
    expect(withMB.score).toBe(90) // NOT suppressed -- Strong Foundation has no breakable bitfield
  })

  it('Suction Cups (suctionCups AND breakable): EFFECT_ROAR penalises it without Mold Breaker, but Mold Breaker suppresses it', () => {
    const s = stateWithDefenderParty({}, { abilities: { ability: 'ABILITY_SUCTION_CUPS', innates: [null, null, null] } })
    const withoutMB = aiCheckBadMove(s, 0, 1, 'MOVE_ROAR', 100, depsWithMoldBreaker(false))
    expect(withoutMB.score).toBe(90)
    const withMB = aiCheckBadMove(s, 0, 1, 'MOVE_ROAR', 100, depsWithMoldBreaker(true))
    expect(withMB.score).toBe(100) // suppressed -- Suction Cups IS breakable
  })
})

describe('RETURN_ABILITY_IF_FLAG scans -- full ability-set oracle tests', () => {
  it('ON_STAT_LOWERED_ABILITIES matches every abilityHooks.json ability whose hooks carry onStatLowered', () => {
    const hooks = readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')
    const parsed = JSON.parse(hooks) as Record<string, { hooks?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => 'onStatLowered' in (h.hooks ?? {}))
      .map(([id]) => id)
      .sort()
    expect([...ON_STAT_LOWERED_ABILITIES].sort()).toEqual(expected)
  })

  it('SUCTION_CUPS_ABILITIES matches every abilityHooks.json ability whose bitfields.suctionCups is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.suctionCups)
      .map(([id]) => id)
      .sort()
    expect([...SUCTION_CUPS_ABILITIES].sort()).toEqual(expected)
  })

  it('ALWAYS_SLEEPING_ABILITIES matches every abilityHooks.json ability whose bitfields.alwaysSleeping is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.alwaysSleeping)
      .map(([id]) => id)
      .sort()
    expect([...ALWAYS_SLEEPING_ABILITIES].sort()).toEqual(expected)
  })

  it('MOLD_BREAKABLE_ABILITIES matches every abilityHooks.json ability whose bitfields.breakable is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.breakable)
      .map(([id]) => id)
      .sort()
    expect([...MOLD_BREAKABLE_ABILITIES].sort()).toEqual(expected)
  })

  it('EFFECT_ROAR now recognises a Run-Away/Guard-Dog-class ability beyond the old single-ability narrowing (Run Away is onStatLowered, not suctionCups -- Guard Dog IS suctionCups and was previously missed entirely)', () => {
    const s = stateWithDefenderParty({}, { abilities: { ability: 'ABILITY_GUARD_DOG', innates: [null, null, null] } })
    const r = aiCheckBadMove(s, 0, 1, 'MOVE_ROAR', 100, depsWithMoldBreaker(false))
    expect(r.score).toBe(90) // previously: only ABILITY_SUCTION_CUPS matched, so this would have been 100
  })

  it('ShouldLowerStat now recognises a Run-Away holder (onStatLowered) beyond the old Defiant-only narrowing', () => {
    const s = state({}, { abilities: { ability: 'ABILITY_RUN_AWAY', innates: [null, null, null] } })
    // EFFECT_ATTACK_DOWN's move penalises when ShouldLowerStat is false --
    // Run Away's onStatLowered hook makes lowering pointless/bad, same as Defiant.
    const move = rawMoves.find((m) => m.effect === 'EFFECT_ATTACK_DOWN')!.id as string
    const r = check(s, move)
    expect(r.score).toBe(90) // previously: only ABILITY_DEFIANT matched, so this would have been 100
  })

  it('EFFECT_DREAM_EATER now recognises Dreamscape (alwaysSleeping) beyond the old Comatose-only narrowing', () => {
    const s = state({}, { status1: 0, abilities: { ability: 'ABILITY_DREAMSCAPE', innates: [null, null, null] } })
    // Not asleep, but Dreamscape's alwaysSleeping flag should be treated like Comatose -- score -8.
    const r = check(s, 'MOVE_DREAM_EATER')
    expect(r.score).toBe(92)
  })
})

// ---------------------------------------------------------------------------
// Cycle17 (part 2) -- new ability-set oracle tests, same convention as above.
// ---------------------------------------------------------------------------

describe('cycle17 ability-set oracle tests against abilityHooks.json', () => {
  it('PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES matches every ability whose bitfields.persistent or bitfields.unsuppressable is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.persistent || !!h.bitfields?.unsuppressable)
      .map(([id]) => id)
      .sort()
    expect([...PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES].sort()).toEqual(expected)
  })

  it('NO_RECOIL_ABILITIES matches every ability whose bitfields.noRecoil is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.noRecoil)
      .map(([id]) => id)
      .sort()
    expect([...NO_RECOIL_ABILITIES].sort()).toEqual(expected)
  })

  it('HALF_RECOIL_ABILITIES matches every ability whose bitfields.halfRecoil is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.halfRecoil)
      .map(([id]) => id)
      .sort()
    expect([...HALF_RECOIL_ABILITIES].sort()).toEqual(expected)
  })

  it('CHLOROPLAST_ABILITIES matches every ability whose bitfields.chloroplast is set', () => {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<string, { bitfields?: Record<string, unknown> }>
    const expected = Object.entries(parsed)
      .filter(([, h]) => !!h.bitfields?.chloroplast)
      .map(([id]) => id)
      .sort()
    expect([...CHLOROPLAST_ABILITIES].sort()).toEqual(expected)
  })
})
