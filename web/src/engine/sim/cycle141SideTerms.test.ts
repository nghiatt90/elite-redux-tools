/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 141: unit tests for the opt-in per-SIDE terms in the expectimax leaf
// score -- entry hazards (Spikes, Stealth Rock, Toxic Spikes, Sticky Web),
// screens (Reflect, Light Screen, Aurora Veil) and Tailwind. Every expected
// number is hand-derived below from the cited C. The model weights
// (SCREEN_VALUE, TAILWIND_SPEED_VALUE, STICKY_WEB_SPEED_VALUE, the neutral
// Stealth Rock /8) are named MODEL CHOICES in expectimax.ts; the damage
// fractions, the hazard layers and the timer countdown are transcribed from
// battle_script_commands.c / battle_util.c / battle_main.c.
import { describe, expect, it } from 'vitest'

import {
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
} from './constants'
import type { AbilitySlots } from '../abilities/dispatch'
import { DEFAULT_EXPECTIMAX, evaluateState, positionScore, statusMonValue, statusScore } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { TYPE_ROCK_ID } from './hazards'
import { createRandomSource } from './rng'
import type { BattleSession } from './driver/session'
import type { BattleState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[]): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[]): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  // The scenarios never want an AI switch to move the bench around.
  noSwitching: true,
  parties: parties(mons),
})

function session(playerMons: string[], foeMons: TrainerMonData[]): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(
      playerMons.map((species) => ({ species, level: 50, moves: ['MOVE_TACKLE'] })),
      50,
      data,
    ),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on BOTH copies of a party slot (active battler mon and the
 * party mon), as `sideStatusScore` reads the active copy for the active slot. */
function patchMon(
  state: BattleState,
  side: 0 | 1,
  partyIndex: number,
  patch: { status1?: number; hp?: number; maxHp?: number; abilities?: AbilitySlots },
): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

/** A foe (and player) at maxHp 320 so every fraction below is a round number. */
function fresh(s: BattleSession): BattleState {
  patchMon(s.state, 0, 0, { hp: 320, maxHp: 320 })
  patchMon(s.state, 1, 0, { hp: 320, maxHp: 320 })
  return s.state
}

/** Writes volatile fields on the ACTIVE battler only -- status2/statuses3/
 * volatiles have no party-mon copy and are cleared on switch out. */
function setVolatiles(
  state: BattleState,
  side: 0 | 1,
  patch: { status2?: number; statuses3?: number; wrapTurns?: number; substituteHp?: number },
): void {
  const battler = state.battlers[side]!
  if (patch.status2 !== undefined) battler.mon.status2 = patch.status2
  if (patch.statuses3 !== undefined) battler.statuses3 = patch.statuses3
  if (patch.wrapTurns !== undefined) battler.volatiles.wrapTurns = patch.wrapTurns
  if (patch.substituteHp !== undefined) battler.volatiles.substituteHp = patch.substituteHp
}

/** Writes the side status word and the per-side timers the leaf scorer reads.
 * Hazards need both the bit and the layer count (hazards.ts:165-171). */
function setSideField(
  state: BattleState,
  side: 0 | 1,
  patch: {
    statuses?: number
    spikesAmount?: number
    toxicSpikesAmount?: number
    stealthRockType?: number
    reflectTimer?: number
    lightscreenTimer?: number
    auroraVeilTimer?: number
    tailwindTimer?: number
    startedReflect?: boolean
  },
): void {
  const sideState = state.sides[side]
  if (patch.statuses !== undefined) sideState.statuses = patch.statuses
  if (patch.spikesAmount !== undefined) sideState.timers.spikesAmount = patch.spikesAmount
  if (patch.toxicSpikesAmount !== undefined) sideState.timers.toxicSpikesAmount = patch.toxicSpikesAmount
  if (patch.stealthRockType !== undefined) sideState.timers.stealthRockType = patch.stealthRockType
  if (patch.reflectTimer !== undefined) sideState.timers.reflectTimer = patch.reflectTimer
  if (patch.lightscreenTimer !== undefined) sideState.timers.lightscreenTimer = patch.lightscreenTimer
  if (patch.auroraVeilTimer !== undefined) sideState.timers.auroraVeilTimer = patch.auroraVeilTimer
  if (patch.tailwindTimer !== undefined) sideState.timers.tailwindTimer = patch.tailwindTimer
  if (patch.startedReflect !== undefined) sideState.timers.started.reflect = patch.startedReflect
}

/** One foe active plus one foe bench, both at 320 HP, so the party is one
 * active slot plus exactly one benched living mon. */
const TWO_FOE = () => [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]

describe('cycle 141 - spikes', () => {
  // HAZARD_MODE_SPIKES, battle_script_commands.c:8729-8742 (ported at
  // hazards.ts:165-171): `(5 - spikesAmount) * 2` divides maxHP. With one
  // benched Golem at 320 HP: 1 layer -> 320 / 8 = 40 -> 40 / 320 = 0.125;
  // 2 layers -> trunc(320 / 6) = 53 -> 53 / 320 = 0.165625; 3 layers ->
  // 320 / 4 = 80 -> 0.25.
  it('1 layer on the foe side -> 0.125', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 })
    expect(statusScore(s)).toBeCloseTo(0.125, 10)
  })

  it('2 layers on the foe side -> 0.165625', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 2 })
    expect(statusScore(s)).toBeCloseTo(0.165625, 10)
  })

  it('3 layers on the foe side -> 0.25', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 3 })
    expect(statusScore(s)).toBeCloseTo(0.25, 10)
  })

  // IsBattlerGrounded: a benched Flying type is airborne, so Spikes miss it
  // (battle_script_commands.c:8734 REQUIRE(IsBattlerGrounded)). Levitate and
  // Air Balloon are not readable on a bench and are left unmodelled.
  it('a Flying benched mon contributes 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_PIDGEY', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 })
    expect(statusScore(s)).toBe(0)
  })

  it('a fainted benched mon contributes 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 0, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 })
    expect(statusScore(s)).toBe(0)
  })

  // The hazard needs BOTH the presence bit and the layer count.
  it('layers without the SIDE_STATUS_SPIKES bit -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { spikesAmount: 2 })
    expect(statusScore(s)).toBe(0)
  })

  it('the bit without a layer count -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 0 })
    expect(statusScore(s)).toBe(0)
  })

  // The same hazard on the player's side is the same burden, so statusScore
  // (foe burden minus player burden) is its negative.
  it('1 layer on the player side -> -0.125', () => {
    const s = fresh(session(['SPECIES_GOLEM', 'SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 0, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 0, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 })
    expect(statusScore(s)).toBeCloseTo(-0.125, 10)
  })
})

describe('cycle 141 - stealth rock', () => {
  // HAZARD_MODE_ROCKS, battle_script_commands.c:8743-8757. GetStealthHazardDamage
  // (battle_util.c:8040-8079) divides by 8 at neutral effectiveness. The type
  // chart is not reachable in the leaf scorer, so the neutral /8 is charged to
  // every benched mon (MODEL CHOICE): 320 / 8 = 40 -> 40 / 320 = 0.125 each.
  it('one benched mon -> 0.125', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_STEALTH_ROCK, stealthRockType: TYPE_ROCK_ID })
    expect(statusScore(s)).toBeCloseTo(0.125, 10)
  })

  it('two benched mons -> 0.25', () => {
    const s = fresh(
      session(
        ['SPECIES_GOLEM'],
        [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])],
      ),
    )
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    patchMon(s, 1, 2, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_STEALTH_ROCK, stealthRockType: TYPE_ROCK_ID })
    expect(statusScore(s)).toBeCloseTo(0.25, 10)
  })

  // The hazard type is only readable when the presence bit is set.
  it('stealthRockType set but the bit clear -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { stealthRockType: TYPE_ROCK_ID })
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 141 - toxic spikes', () => {
  // HAZARD_MODE_POISON_SPIKES, battle_script_commands.c:8758-8787: a grounded
  // non-Poison/non-Steel mon with no status1 is poisoned on entry -- bad poison
  // at >= 2 layers, plain poison at 1. The chip is `statusMonValue`, benched:
  // poison = 3 * (320 / 8) / 320 = 0.375; bad poison = 20 * (1 + 2 + 3) / 320
  // = 0.375 (statusToxicFraction, battle_util.c:2516-2544, counter starting 0).
  it('1 layer -> plain poison chip, 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 1 })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  it('2 layers -> bad poison chip, matching statusMonValue, 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 2 })
    const expected = statusMonValue({ status1: STATUS1_TOXIC_POISON, hp: 320, maxHp: 320 }, false)
    expect(expected).toBeCloseTo(0.375, 10)
    expect(statusScore(s)).toBeCloseTo(expected, 10)
  })

  // The Poison absorb branch (:8764-8769) clears the hazard and does not
  // poison the mon; Gengar is Ghost/Poison and grounded here.
  it('a Poison-type benched mon -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GENGAR', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 1 })
    expect(statusScore(s)).toBe(0)
  })

  // CanPoisonType (battle_script_commands.c:6465-6471): Poison and Steel types
  // are not poisoned by Toxic Spikes (Steelix is Steel/Ground and grounded).
  it('a Steel-type benched mon cannot be poisoned -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_STEELIX', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 1 })
    expect(statusScore(s)).toBe(0)
  })

  // CanBePoisoned's first check (battle_util.c:5044): an already-statused mon
  // takes nothing. STATUS1_PARALYSIS has no benched statusMonValue term, so the
  // whole score must be 0.
  it('a benched mon already statused -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320, status1: STATUS1_PARALYSIS })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 1 })
    expect(statusScore(s)).toBe(0)
  })

  it('the bit without a layer count -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 0 })
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 141 - sticky web', () => {
  // HAZARD_MODE_WEBS, battle_script_commands.c:8788-8798:
  // `SetStatChanger(STAT_SPEED, -1)`. The stage's value is a MODEL CHOICE flat
  // weight, STICKY_WEB_SPEED_VALUE = 0.05, per grounded benched mon.
  it('two grounded benched mons -> 0.1', () => {
    const s = fresh(
      session(
        ['SPECIES_GOLEM'],
        [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])],
      ),
    )
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    patchMon(s, 1, 2, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_STICKY_WEB })
    expect(statusScore(s)).toBeCloseTo(0.1, 10)
  })

  it('a Flying benched mon is not slowed -> only the grounded one counts, 0.05', () => {
    const s = fresh(
      session(
        ['SPECIES_GOLEM'],
        [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE']), mon('SPECIES_PIDGEY', ['MOVE_TACKLE'])],
      ),
    )
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    patchMon(s, 1, 2, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_STICKY_WEB })
    expect(statusScore(s)).toBeCloseTo(0.05, 10)
  })

  it('bit clear -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBe(0)
  })

  it('the same web on the player side -> -0.05', () => {
    const s = fresh(session(['SPECIES_GOLEM', 'SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 0, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 0, { statuses: SIDE_STATUS_STICKY_WEB })
    expect(statusScore(s)).toBeCloseTo(-0.05, 10)
  })
})

describe('cycle 141 - screens', () => {
  // battle_util.c:7622-7630: a screen multiplies the final damage by
  // UQ_4_12(0.5) in singles (:7627-7628). Each remaining turn of one screen is
  // worth SCREEN_VALUE = 0.1 (MODEL CHOICE), capped by the model horizon
  // STATUS_HORIZON_TURNS = 3. ENDTURN_REFLECT (:1793-1803) only counts a timer
  // down after the turn it was set, so `started.reflect` still counts the full
  // timer. A screen is a BENEFIT for its owner.
  it('foe Reflect timer 5 -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('foe Reflect timer 2 -> -0.2', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 2 })
    expect(statusScore(s)).toBeCloseTo(-0.2, 10)
  })

  it('foe Reflect timer 0 -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 0 })
    expect(statusScore(s)).toBe(0)
  })

  it('a timer above the horizon is capped -> Reflect timer 8 is still -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 8 })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('a timer with the bit clear -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { reflectTimer: 5 })
    expect(statusScore(s)).toBe(0)
  })

  // `started.reflect` true is the just-set guard; the timer is still full.
  it('started.reflect true still counts the full timer -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5, startedReflect: true })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('foe Light Screen timer 5 -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_LIGHTSCREEN, lightscreenTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  // No move lookup is passed here, so the data-free flat weights apply: Aurora
  // Veil halves both physical and special damage and is worth two screens:
  // 2 * 0.1 * min(5, 3) = 0.6. (With a lookup it is one screen's weight times
  // the foe's physShare + specShare; see cycle141bScreenTerms.test.ts.)
  it('foe Aurora Veil timer 5 -> -0.6 (data-free path)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(-0.6, 10)
  })

  it('the player own Reflect is a benefit -> +0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(0.3, 10)
  })
})

describe('cycle 141 - tailwind', () => {
  // battle_main.c:4203-4204: `speed *= 2` for the side holding the bit.
  // ENDTURN_TAILWIND (battle_util.c:1924-1934) counts the timer down after the
  // turn it was set. Each remaining turn is TAILWIND_SPEED_VALUE = 0.1 (MODEL
  // CHOICE) capped by the horizon; it is a BENEFIT for its owner.
  it('foe Tailwind timer 4 -> 3 turns -> -0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 4 })
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('foe Tailwind timer 1 -> -0.1', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 1 })
    expect(statusScore(s)).toBeCloseTo(-0.1, 10)
  })

  it('a timer with the bit clear -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 1, { tailwindTimer: 4 })
    expect(statusScore(s)).toBe(0)
  })

  it('the player own Tailwind -> +0.3', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setSideField(s, 0, { statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 5 })
    expect(statusScore(s)).toBeCloseTo(0.3, 10)
  })
})

describe('cycle 141 - evaluateState gating', () => {
  const withTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: true }
  const withoutTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: false }

  // One Spikes layer on a 320 HP foe bench is 0.125; a foe confusion counter of
  // 4 adds the existing 3 * (1/3) * 0.25 = 0.25 (CANCELLER_CONFUSED,
  // battle_util.c:3368-3399). Total 0.375.
  it('with terms on, the opt-in score is positionScore plus the hand number', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 })
    setVolatiles(s, 1, { status2: 4 })
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(0.375, 10)
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(statusScore(s), 10)
  })

  it('with the option off, none of the side terms change evaluateState', () => {
    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, {
      statuses: SIDE_STATUS_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB | SIDE_STATUS_REFLECT | SIDE_STATUS_TAILWIND,
      spikesAmount: 1,
      reflectTimer: 5,
      tailwindTimer: 4,
    })
    expect(evaluateState(s, withoutTerms)).toBe(positionScore(s))
  })

  it('DEFAULT_EXPECTIMAX turns statusTerms on', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBe(true)
  })
})

describe('cycle 141 - additivity', () => {
  // Every term on one foe side, one grounded 320 HP bench mon:
  //   Spikes 1 layer        0.125
  //   Stealth Rock (/8)     0.125
  //   Toxic Spikes 1 layer  0.375  (plain poison chip)
  //   Sticky Web            0.05
  //   Reflect timer 5      -0.3
  //   Light Screen timer 5 -0.3
  //   Aurora Veil timer 5  -0.6
  //   Tailwind timer 5     -0.3
  // sum = 0.125 + 0.125 + 0.375 + 0.05 - 0.3 - 0.3 - 0.6 - 0.3 = -0.825.
  it('all terms together equal the sum of their parts', () => {
    const oneHazard = (patch: Parameters<typeof setSideField>[2]) => {
      const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
      patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
      setSideField(s, 1, patch)
      return statusScore(s)
    }
    const parts = [
      oneHazard({ statuses: SIDE_STATUS_SPIKES, spikesAmount: 1 }),
      oneHazard({ statuses: SIDE_STATUS_STEALTH_ROCK, stealthRockType: TYPE_ROCK_ID }),
      oneHazard({ statuses: SIDE_STATUS_TOXIC_SPIKES, toxicSpikesAmount: 1 }),
      oneHazard({ statuses: SIDE_STATUS_STICKY_WEB }),
      oneHazard({ statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 }),
      oneHazard({ statuses: SIDE_STATUS_LIGHTSCREEN, lightscreenTimer: 5 }),
      oneHazard({ statuses: SIDE_STATUS_AURORA_VEIL, auroraVeilTimer: 5 }),
      oneHazard({ statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 5 }),
    ]
    const sum = parts.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(-0.825, 10)

    const s = fresh(session(['SPECIES_GOLEM'], TWO_FOE()))
    patchMon(s, 1, 1, { hp: 320, maxHp: 320 })
    setSideField(s, 1, {
      statuses:
        SIDE_STATUS_SPIKES |
        SIDE_STATUS_STEALTH_ROCK |
        SIDE_STATUS_TOXIC_SPIKES |
        SIDE_STATUS_STICKY_WEB |
        SIDE_STATUS_REFLECT |
        SIDE_STATUS_LIGHTSCREEN |
        SIDE_STATUS_AURORA_VEIL |
        SIDE_STATUS_TAILWIND,
      spikesAmount: 1,
      toxicSpikesAmount: 1,
      stealthRockType: TYPE_ROCK_ID,
      reflectTimer: 5,
      lightscreenTimer: 5,
      auroraVeilTimer: 5,
      tailwindTimer: 5,
    })
    expect(statusScore(s)).toBeCloseTo(sum, 10)
  })
})
