/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 140: unit tests for the opt-in volatile terms in the expectimax leaf
// score (confusion, nightmare, wrap, Leech Seed, Substitute). Every expected
// number is hand-derived below from the cited C. The horizon and per-action
// model constants are named model choices in expectimax.ts; the damage
// fractions are transcribed from battle_util.c / battle_script_commands.c.
import { describe, expect, it } from 'vitest'

import {
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_LEECHSEED,
  setCounter,
} from './constants'
import { DEFAULT_EXPECTIMAX, evaluateState, positionScore, statusScore } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
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
  // The scenarios never want an AI switch to move the status to a fresh body.
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
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: { status1?: number; hp?: number; maxHp?: number }): void {
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

describe('cycle 140 - confusion', () => {
  // CANCELLER_CONFUSED, battle_util.c:3368-3399. The C pre-decrements on each
  // move attempt (:3374); the decrement that reaches 0 snaps the mon out and it
  // still acts (:3374-3376), so with counter c the attempts that can be lost are
  // c - 1, each on `Random() % 3 == 0` (:3377). Counter 4 -> 3 attempts:
  // 3 * (1/3) * ACTION_VALUE 0.25 = 0.25. Self-hit damage is not charged.
  it('counter 4 on the foe -> 0.25', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_CONFUSION })
    expect(statusScore(s)).toBeCloseTo(0.25, 10)
  })

  // Counter 1: the first attempt decrements to 0, snaps out and acts, so no
  // attempt can be lost -> c - 1 = 0.
  it('counter 1 snaps out on the first attempt -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: 1 })
    expect(statusScore(s)).toBe(0)
  })

  // Counter 5 would be 4 lost attempts; the horizon caps them at 3:
  // 3 * (1/3) * 0.25 = 0.25.
  it('counter 5 is capped by the horizon -> 0.25', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: 5 })
    expect(statusScore(s)).toBeCloseTo(0.25, 10)
  })

  it('the same confusion on the player side -> -0.25', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 0, { status2: 4 })
    expect(statusScore(s)).toBeCloseTo(-0.25, 10)
  })
})

describe('cycle 140 - nightmare', () => {
  // ENDTURN_NIGHTMARES, battle_util.c:2608-2623: with STATUS2_NIGHTMARE and
  // STATUS1_SLEEP the mon takes maxHP / 4 each end of turn (:2613-2616); the
  // nightmare ends when it wakes, so the ticks are the sleep counter. Sleep
  // counter 2 loses 2 - 1 = 1 attempt (CANCELLER_ASLEEP, :3218-3242), i.e.
  // 1 * ACTION_VALUE 0.25 = 0.25, and the nightmare is
  // 2 * (320 / 4) / 320 = 2 * 0.25 = 0.5, total 0.75.
  it('nightmare + sleep counter 2 on the foe -> 0.75', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: setCounter(0, STATUS1_SLEEP, 2) })
    setVolatiles(s, 1, { status2: STATUS2_NIGHTMARE })
    expect(statusScore(s)).toBeCloseTo(0.75, 10)
  })

  // :2609-2619: without STATUS1_SLEEP the flag is silently cleared and no damage
  // is dealt -> 0.
  it('nightmare without sleep -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_NIGHTMARE })
    expect(statusScore(s)).toBe(0)
  })

  it('the same nightmare on the player side -> -0.75', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 0, 0, { status1: setCounter(0, STATUS1_SLEEP, 2) })
    setVolatiles(s, 0, { status2: STATUS2_NIGHTMARE })
    expect(statusScore(s)).toBeCloseTo(-0.75, 10)
  })
})

describe('cycle 140 - wrap', () => {
  // ENDTURN_WRAP, battle_util.c:2663-2687: the C pre-decrements wrapTurns
  // (:2664) and only damages while the result is nonzero; the tick that reaches
  // 0 is the break-free tick (:2688-2690). wrapTurns 4 -> 3 damaging ticks, at
  // maxHP / 8 (:2685) = 320 / 8 = 40 -> 40 / 320 = 0.125 each:
  // 3 * 0.125 = 0.375.
  it('wrapTurns 4 on the foe -> 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_WRAPPED, wrapTurns: 4 })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  it('status2 without STATUS2_WRAPPED -> 0 (wrapTurns alone is inert)', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { wrapTurns: 4 })
    expect(statusScore(s)).toBe(0)
  })

  // wrapTurns 1: the first end-of-turn decrements it to 0 and it breaks free
  // with no damage -> 0 damaging ticks.
  it('wrapTurns 1 breaks free with no damage -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_WRAPPED, wrapTurns: 1 })
    expect(statusScore(s)).toBe(0)
  })

  it('the same wrap on the player side -> -0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 0, { status2: STATUS2_WRAPPED, wrapTurns: 4 })
    expect(statusScore(s)).toBeCloseTo(-0.375, 10)
  })
})

describe('cycle 140 - leech seed', () => {
  // ENDTURN_LEECH_SEED, battle_util.c:2472-2486: STATUS3_LEECHSEED on the
  // victim (:2474), the seeder -- the low bits of statuses3, here player
  // battler 0 -- alive (:2476), victim not Magic Guard (:2477); maxHP / 8, min
  // 1, each end of turn (:2480-2481). 320 / 8 = 40 -> 40 / 320 = 0.125;
  // horizon 3 -> 0.375. Seeder id 0 | STATUS3_LEECHSEED.
  it('foe seeded by the living player -> 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { statuses3: STATUS3_LEECHSEED | 0 })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  it('a fainted seeder -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 0, 0, { hp: 0 })
    setVolatiles(s, 1, { statuses3: STATUS3_LEECHSEED | 0 })
    expect(statusScore(s)).toBe(0)
  })

  it('STATUS3_LEECHSEED absent -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { statuses3: 0 })
    expect(statusScore(s)).toBe(0)
  })

  it('the same seed on the player side, seeded by the foe -> -0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 0, { statuses3: STATUS3_LEECHSEED | 1 })
    expect(statusScore(s)).toBeCloseTo(-0.375, 10)
  })

  // REQUIRE_NOT(IsMagicGuardProtected) at :2477. Clefairy's slot 0 is Fairy
  // Aura, so the ability is named explicitly (Magic Guard is one of its three
  // selectable abilities); isMagicGuardProtected reads the registry's
  // `magicGuard` flag on any of the mon's slots, so this is the whole gate.
  it('a Magic Guard holder is not drained -> 0', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [{ ...mon('SPECIES_CLEFAIRY', ['MOVE_TACKLE']), ability: 'ABILITY_MAGIC_GUARD' }]),
    )
    setVolatiles(s, 1, { statuses3: STATUS3_LEECHSEED | 0 })
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 140 - substitute', () => {
  // Cmd_setsubstitute, battle_script_commands.c:10535-10555: a fresh sub holds
  // maxHP / 4 HP (:10536-10539) for a maxHP / 4 cost (:10537-10538), so its HP
  // fraction is what the holder paid. positionScore already charges that cost,
  // so the buffer is valued SUBSTITUTE_BUFFER_WEIGHT = 2 (MODEL CHOICE) times
  // its HP fraction: 2 * (320 / 4) / 320 = 0.5. A sub is a BENEFIT, so it
  // lowers the holder's burden: a foe's sub makes statusScore -0.5.
  it('foe behind a fresh sub -> -0.5', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_SUBSTITUTE, substituteHp: 80 })
    expect(statusScore(s)).toBeCloseTo(-0.5, 10)
  })

  // The flag and the HP are separate fields; a stale HP with no flag is inert.
  it('substituteHp without STATUS2_SUBSTITUTE -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { substituteHp: 80 })
    expect(statusScore(s)).toBe(0)
  })

  // MOVEEND_SUBSTITUTE clears the flag once substituteHp hits 0, but the term
  // requires both so a half-updated state cannot score a phantom buffer.
  it('STATUS2_SUBSTITUTE with substituteHp 0 -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_SUBSTITUTE, substituteHp: 0 })
    expect(statusScore(s)).toBe(0)
  })

  it('the same sub on the player side -> +0.5', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 0, { status2: STATUS2_SUBSTITUTE, substituteHp: 80 })
    expect(statusScore(s)).toBeCloseTo(0.5, 10)
  })
})

describe('cycle 140 - evaluateState gating', () => {
  const withTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: true }

  it('with a volatile, the opt-in term differs from positionScore by exactly statusScore', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: 4 })
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(statusScore(s), 10)
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(0.25, 10)
  })

  it('with the option off, a volatile changes nothing', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    setVolatiles(s, 1, { status2: STATUS2_WRAPPED, wrapTurns: 4 })
    expect(evaluateState(s)).toBe(positionScore(s))
  })

  it('DEFAULT_EXPECTIMAX leaves statusTerms unset', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBeFalsy()
  })
})
