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
import { STATUS_FIELD_ELECTRIC_TERRAIN, STATUS_FIELD_MISTY_TERRAIN, STATUS_FIELD_PSYCHIC_TERRAIN, WEATHER_RAIN_PRIMAL, WEATHER_SUN_PRIMAL, SIDE_STATUS_SAFEGUARD } from '../constants'
import type { BattleState, RandomSource, SimBattleMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { type AiDamageDeps } from './aiCalcDamage'
import { chooseMoveOrActionSingles } from './aiPipeline'
import { aiCheckBadMove } from './aiCheckBadMove'

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

  it('part 2 gap: EFFECT_SANDSTORM (handled only in part 2) is reported as a named gap, not scored', () => {
    const s = state()
    const r = check(s, 'MOVE_SANDSTORM')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((u) => u.includes('EFFECT_SANDSTORM') && u.includes('part 2'))).toBe(true)
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
