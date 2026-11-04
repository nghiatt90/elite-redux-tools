/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 139: unit tests for the opt-in status1 term in the expectimax leaf score.
// Every expected number is hand-derived below from the cited C. The horizon and
// per-action/model constants are named model choices in expectimax.ts; the
// damage fractions are transcribed from battle_util.c.
import { describe, expect, it } from 'vitest'

import {
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
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
 * party mon), as the status1 term reads the active copy for the active slot. */
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

describe('cycle 139 - statusScore weights', () => {
  it('no status on either side scores 0', () => {
    expect(statusScore(fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])])))).toBe(0)
  })

  // ENDTURN_BURN, battle_util.c:2573-2582: maxHP / 16 = 320 / 16 = 20 per turn.
  // 20 / 320 = 0.0625; horizon 3 -> 0.1875. The active mon also pays the
  // Attack halving (battle_util.c:7135), modelled as ACTION_VALUE / 2 = 0.125.
  // Total active = 0.1875 + 0.125 = 0.3125.
  it('burn: active foe 0.3125, player side exactly -0.3125', () => {
    const foeBurned = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(foeBurned, 1, 0, { status1: STATUS1_BURN })
    expect(statusScore(foeBurned)).toBeCloseTo(0.3125, 10)

    const meBurned = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(meBurned, 0, 0, { status1: STATUS1_BURN })
    expect(statusScore(meBurned)).toBeCloseTo(-0.3125, 10)
  })

  // ENDTURN_POISON, battle_util.c:2492-2511 (non-Poison-Heal): 320 / 8 = 40;
  // 40 / 320 = 0.125 per turn; 3 turns -> 0.375.
  it('poison: 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_POISON })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  // ENDTURN_BAD_POISON, battle_util.c:2516-2544: the C increments the counter
  // first, so from counter 0 the next ticks are 1, 2, 3; per tick is
  // maxHP / 16 = 20, and the field is counter << 8 with a >> 8 after the
  // multiply, i.e. counter * 20. (1 + 2 + 3) * 20 / 320 = 120 / 320 = 0.375.
  it('toxic: counter 0 sums the next three ticks -> 0.375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_TOXIC_POISON })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  // Counter 15 caps each of the next ticks at 15 (:2532-2533), so the sum is
  // (15 + 15 + 15) * 20 / 320 = 900 / 320 = 2.8125. (Counter + 1 must not wrap
  // to 16: the C only increments while the field != STATUS1_TOXIC_TURN(15).)
  it('toxic: counter 15 stays capped -> 2.8125', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_TOXIC_POISON | (15 << 8) })
    expect(statusScore(s)).toBeCloseTo(2.8125, 10)
  })

  // ENDTURN_FROSTBITE, battle_util.c:2584-2597: maxHP / 16 = 20; 3 turns = 0.1875.
  // The active mon also pays the Special Attack halving (battle_util.c:7145-7147,
  // `statBase /= 2` unless EFFECT_FACADE / IgnoresFrostbiteSpatkDrop), modelled as
  // ACTION_VALUE / 2 = 0.125. Total active = 0.1875 + 0.125 = 0.3125.
  it('frostbite: active foe 0.3125', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_FROSTBITE })
    expect(statusScore(s)).toBeCloseTo(0.3125, 10)
  })

  // ENDTURN_BLEED, battle_util.c:2598-2606 and battle.h:142: BLEED_DAMAGE(hp) =
  // hp / 16 = 20; 3 turns = 0.1875.
  it('bleed: 0.1875', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_BLEED })
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  // CANCELLER_PARALYSED, battle_util.c:3404: 25% of actions lost.
  // 0.25 * horizon 3 * ACTION_VALUE 0.25 = 0.1875; plus the halved-Speed flat
  // weight (battle_main.c:4185-4186) PARALYSIS_SPEED_VALUE = 0.25 -> 0.4375.
  it('paralysis (active): 0.4375', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_PARALYSIS })
    expect(statusScore(s)).toBeCloseTo(0.4375, 10)
  })

  // CANCELLER_ASLEEP, battle_util.c:3218-3242: each attempt subtracts 1 from the
  // 3-bit counter and is cancelled only while the counter stays nonzero; when it
  // reaches 0 the mon wakes and acts that turn (:3238-3242). So counter N loses
  // N-1 attempts, not N. Counter 2 -> (2-1) * ACTION_VALUE 0.25 = 0.25.
  it('sleep: counter 2 loses one attempt -> 0.25', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: setCounter(0, STATUS1_SLEEP, 2) })
    expect(statusScore(s)).toBeCloseTo(0.25, 10)
  })

  // Counter 4 is the longest sleep Spore can roll: `(Random() % 3) + 2`
  // (battle_script_commands.c:2555). (4-1) * 0.25 = 0.75.
  it('sleep: counter 4 loses three attempts -> 0.75', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: setCounter(0, STATUS1_SLEEP, 4) })
    expect(statusScore(s)).toBeCloseTo(0.75, 10)
  })

  // Counter 1: the next attempt subtracts 1, reaches 0 and the mon acts, so no
  // action is lost.
  it('sleep: counter 1 loses no attempt -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: setCounter(0, STATUS1_SLEEP, 1) })
    expect(statusScore(s)).toBe(0)
  })

  // Counter 0 leaves the STATUS1_SLEEP bits clear, so hasFlag reports no sleep.
  it('sleep: counter 0 is not asleep -> 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: setCounter(0, STATUS1_SLEEP, 0) })
    expect(statusScore(s)).toBe(0)
  })

  // CANCELLER_FROZEN, battle_util.c:3248-3262: `Random() % 5` non-zero keeps the
  // mon frozen and a zero roll clears STATUS1_FREEZE (:3255), so after a thaw
  // later turns are not lost. Turn k is lost only if all k rolls kept it frozen
  // (0.8^k): 0.25 * (0.8 + 0.64 + 0.512) = 0.488.
  it('freeze (active): 0.488', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_FREEZE })
    expect(statusScore(s)).toBeCloseTo(0.488, 10)
  })

  it('a fainted mon with a status contributes 0', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_BURN, hp: 0 })
    expect(statusScore(s)).toBe(0)
  })

  // A reserve mon acts only after switching in, so sleep/paralysis tempo terms
  // are deliberately 0 for it; only the chip terms apply. Burn chip alone is
  // 20 / 320 * 3 = 0.1875 (no Attack-halving weight off the field).
  it('benched burn counts only the chip term -> 0.1875', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(s, 1, 0, { status1: 0 })
    patchMon(s, 1, 1, { status1: STATUS1_BURN, hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  // Same split for frostbite: the active-only Sp. Atk halving (battle_util.c:7145-7147)
  // does not apply off the field, so only the 20 / 320 * 3 = 0.1875 chip remains.
  it('benched frostbite counts only the chip term -> 0.1875', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(s, 1, 0, { status1: 0 })
    patchMon(s, 1, 1, { status1: STATUS1_FROSTBITE, hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  it('benched poison counts only the chip term -> 40 / 320 * 3 = 0.375', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(s, 1, 0, { status1: 0 })
    patchMon(s, 1, 1, { status1: STATUS1_POISON, hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  it('benched toxic counts only the chip term -> (1 + 2 + 3) * 20 / 320 = 0.375', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(s, 1, 0, { status1: 0 })
    patchMon(s, 1, 1, { status1: STATUS1_TOXIC_POISON, hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBeCloseTo(0.375, 10)
  })

  it('benched sleep and paralysis are 0 (the tempo terms are active-only)', () => {
    const s = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(s, 1, 0, { status1: 0 })
    patchMon(s, 1, 1, { status1: setCounter(0, STATUS1_SLEEP, 3), hp: 320, maxHp: 320 })
    expect(statusScore(s)).toBe(0)

    const p = fresh(
      session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_GOLEM', ['MOVE_TACKLE'])]),
    )
    patchMon(p, 1, 0, { status1: 0 })
    patchMon(p, 1, 1, { status1: STATUS1_PARALYSIS, hp: 320, maxHp: 320 })
    expect(statusScore(p)).toBe(0)
  })
})

describe('cycle 139 - evaluateState gating', () => {
  const withTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: true }
  const withoutTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: false }

  it('with no status, the opt-in term changes nothing', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    expect(evaluateState(s, withTerms)).toBe(evaluateState(s))
    expect(evaluateState(s, withoutTerms)).toBe(evaluateState(s))
  })

  it('with a status, the term differs from positionScore by exactly statusScore', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_BURN })
    expect(evaluateState(s) - evaluateState(s, withoutTerms)).toBeCloseTo(statusScore(s), 10)
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(0.3125, 10)
  })

  it('statusTerms: undefined and true are identical; false equals positionScore alone', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_BURN })
    expect(evaluateState(s)).toBe(evaluateState(s, withTerms))
    expect(evaluateState(s, { ...DEFAULT_EXPECTIMAX, statusTerms: undefined })).toBe(evaluateState(s, withTerms))
    expect(evaluateState(s, withoutTerms)).toBe(positionScore(s))
  })

  it('terminal outcomes stay +100 / -100 regardless of the flag', () => {
    const s = fresh(session(['SPECIES_GOLEM'], [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]))
    patchMon(s, 1, 0, { status1: STATUS1_BURN })
    s.battleOutcome = 'WON'
    expect(evaluateState(s)).toBe(100)
    expect(evaluateState(s, withTerms)).toBe(100)
    s.battleOutcome = 'LOST'
    expect(evaluateState(s)).toBe(-100)
    expect(evaluateState(s, withTerms)).toBe(-100)
  })

  it('DEFAULT_EXPECTIMAX turns statusTerms on', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBe(true)
  })
})
