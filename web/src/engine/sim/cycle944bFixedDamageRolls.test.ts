/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 944b: aiDamageRolls must report the FIXED damage of the moves whose
// scripts bypass damagecalc (battle_script_commands.c:10626-10704, :11857-11864,
// :13102-13130, :9381) instead of the ordinary formula's 16 rolls. Every
// expectation below is hand-derived from those scripts; see turn.ts's
// fixedDamageFor.
import { describe, expect, it } from 'vitest'

import { aiCalcDamage, aiDamageRolls } from './ai/aiCalcDamage'
import type { PlayerMonSpec } from './driver/buildParty'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { guaranteedKo, ourDamageRange } from './driver/policyInputs'
import { aiDamageDepsFor, createSession } from './driver/session'
import type { BattleSession } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, BattlerState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[], ability = 'ABILITY_GUTS'): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability,
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(playerMons: PlayerMonSpec[], foeMons: TrainerMonData[], overrides: Partial<TrainerData> = {}): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a test needs for item/hp/stat overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const zeros = (): number[] => Array.from({ length: 16 }, () => 0)
const filled = (value: number): number[] => Array.from({ length: 16 }, () => value)

const snorlax = (level = 50, moves: string[] = ['MOVE_SEISMIC_TOSS']): PlayerMonSpec[] => [
  { species: 'SPECIES_SNORLAX', level, moves },
]

describe('cycle 944b - fixed-damage moves answer in all 16 slots', () => {
  it('Seismic Toss reports the attacker level, not the formula', () => {
    const s = session(snorlax(37), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const rolls = aiDamageRolls(s.state, 'MOVE_SEISMIC_TOSS', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(filled(37))
    expect(rolls.critRolls).toBeNull()
    expect(rolls.totalRolls).toBeNull()
    expect(rolls.isImmune).toBe(false)
    expect(rolls.unmodelled).not.toContain('MOVE_SEISMIC_TOSS: not modelled')
    expect(rolls.unmodelled).not.toContain('EFFECT_SKY_DROP: not modelled')
  })

  it('Seismic Toss into a Ghost is immune: 16 zeros', () => {
    const s = session(snorlax(37), [mon('SPECIES_GENGAR', ['MOVE_CELEBRATE'])])
    const rolls = aiDamageRolls(s.state, 'MOVE_SEISMIC_TOSS', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.isImmune).toBe(true)
    expect(rolls.rolls).toEqual(zeros())
  })

  it('Night Shade (Level Damage) from the AI side is its level x16', () => {
    const s = session([{ species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_CELEBRATE'] }], [
      mon('SPECIES_GENGAR', ['MOVE_NIGHT_SHADE']),
    ])
    // The AI's level is the player's highest level (battle_main.c:1819-1827).
    expect(s.state.battlers[1]!.mon.level).toBe(50)
    const rolls = aiDamageRolls(s.state, 'MOVE_NIGHT_SHADE', 1, 0, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(filled(50))
    expect(rolls.critRolls).toBeNull()
    expect(rolls.totalRolls).toBeNull()
    expect(rolls.isImmune).toBe(false)
  })

  it('Super Fang halves the target hp, floored, minimum 1', () => {
    const odd = session(snorlax(50, ['MOVE_SUPER_FANG']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(odd.state, 1, 0, { hp: 101 })
    const half = aiDamageRolls(odd.state, 'MOVE_SUPER_FANG', 0, 1, aiDamageDepsFor(odd.data, odd.state))!
    expect(half.rolls).toEqual(filled(50))

    const one = session(snorlax(50, ['MOVE_SUPER_FANG']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(one.state, 1, 0, { hp: 1 })
    const atOne = aiDamageRolls(one.state, 'MOVE_SUPER_FANG', 0, 1, aiDamageDepsFor(one.data, one.state))!
    expect(atOne.rolls).toEqual(filled(1))
  })

  it("Nature's Madness (Super Fang Haze) halves the target hp", () => {
    const s = session(snorlax(50, ['MOVE_NATURES_MADNESS']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { hp: 101 })
    const rolls = aiDamageRolls(s.state, 'MOVE_NATURES_MADNESS', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(filled(50))
  })

  it('Endeavor is the hp difference and fails when the target is not above us', () => {
    const above = session(snorlax(50, ['MOVE_ENDEAVOR']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(above.state, 0, 0, { hp: 100 })
    patchMon(above.state, 1, 0, { hp: 150 })
    expect(aiDamageRolls(above.state, 'MOVE_ENDEAVOR', 0, 1, aiDamageDepsFor(above.data, above.state))!.rolls).toEqual(filled(50))

    const equal = session(snorlax(50, ['MOVE_ENDEAVOR']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(equal.state, 0, 0, { hp: 100 })
    patchMon(equal.state, 1, 0, { hp: 100 })
    expect(aiDamageRolls(equal.state, 'MOVE_ENDEAVOR', 0, 1, aiDamageDepsFor(equal.data, equal.state))!.rolls).toEqual(zeros())

    const below = session(snorlax(50, ['MOVE_ENDEAVOR']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(below.state, 0, 0, { hp: 100 })
    patchMon(below.state, 1, 0, { hp: 80 })
    expect(aiDamageRolls(below.state, 'MOVE_ENDEAVOR', 0, 1, aiDamageDepsFor(below.data, below.state))!.rolls).toEqual(zeros())
  })

  it('Final Gambit is the attacker current hp', () => {
    const s = session(snorlax(50, ['MOVE_FINAL_GAMBIT']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 0, 0, { hp: 123 })
    const rolls = aiDamageRolls(s.state, 'MOVE_FINAL_GAMBIT', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(filled(123))
  })
})

describe('cycle 944b - Counter / Mirror Coat / Metal Burst read gRoundStructs', () => {
  const counterSession = () => session(snorlax(50, ['MOVE_COUNTER']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])

  it('Counter fails with no physical damage taken this round', () => {
    const s = counterSession()
    const rolls = aiDamageRolls(s.state, 'MOVE_COUNTER', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(zeros())
  })

  it('Counter doubles the physical damage taken from the opposing side', () => {
    const s = counterSession()
    const attacker = s.state.battlers[0]! as BattlerState
    attacker.round.physicalDmg = 40
    attacker.round.physicalBattlerId = 1
    const rolls = aiDamageRolls(s.state, 'MOVE_COUNTER', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(filled(80))
  })

  it('Counter ignores special damage alone', () => {
    const s = counterSession()
    const attacker = s.state.battlers[0]! as BattlerState
    attacker.round.specialDmg = 40
    attacker.round.specialBattlerId = 1
    expect(aiDamageRolls(s.state, 'MOVE_COUNTER', 0, 1, aiDamageDepsFor(s.data, s.state))!.rolls).toEqual(zeros())
  })

  it('Mirror Coat doubles the special damage taken from the opposing side', () => {
    const s = session(snorlax(50, ['MOVE_MIRROR_COAT']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const attacker = s.state.battlers[0]! as BattlerState
    attacker.round.specialDmg = 40
    attacker.round.specialBattlerId = 1
    expect(aiDamageRolls(s.state, 'MOVE_MIRROR_COAT', 0, 1, aiDamageDepsFor(s.data, s.state))!.rolls).toEqual(filled(80))
  })

  // Metal Burst and Comeuppance both declare power 0 in the pinned snapshot, so
  // they clear the `!built.move.power` gate only through isFixedDamageMove.
  for (const move of ['MOVE_METAL_BURST', 'MOVE_COMEUPPANCE']) {
    it(`${move} returns a zero range with no damage taken`, () => {
      const s = session(snorlax(50, [move]), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
      const rolls = aiDamageRolls(s.state, move, 0, 1, aiDamageDepsFor(s.data, s.state))!
      expect(rolls).not.toBeNull()
      expect(rolls.rolls).toEqual(zeros())
    })

    it(`${move} is 150% of the physical damage taken`, () => {
      const s = session(snorlax(50, [move]), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
      const attacker = s.state.battlers[0]! as BattlerState
      attacker.round.physicalDmg = 41
      attacker.round.physicalBattlerId = 1
      // Cmd_metalburstdamagecalculator (:13102-13130): damage * 150 / 100, truncating.
      expect(aiDamageRolls(s.state, move, 0, 1, aiDamageDepsFor(s.data, s.state))!.rolls).toEqual(filled(61))
    })
  }
})

describe('cycle 944b - Bide and the untouched moves', () => {
  it('Bide reports zeros and keeps its not-modelled note', () => {
    const s = session(snorlax(50, ['MOVE_BIDE']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const rolls = aiDamageRolls(s.state, 'MOVE_BIDE', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toEqual(zeros())
    expect(rolls.critRolls).toBeNull()
    expect(rolls.totalRolls).toBeNull()
    expect(rolls.unmodelled).toContain('EFFECT_BIDE: not modelled')
  })

  it('Body Slam still returns the ordinary ascending 16 rolls', () => {
    const s = session(snorlax(50, ['MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const rolls = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toHaveLength(16)
    expect(rolls.rolls[0]!).toBeLessThan(rolls.rolls[15]!)
  })

  it('Sky Drop is not flattened to a constant', () => {
    const s = session(snorlax(50, ['MOVE_SKY_DROP']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const rolls = aiDamageRolls(s.state, 'MOVE_SKY_DROP', 0, 1, aiDamageDepsFor(s.data, s.state))!
    expect(rolls.rolls).toHaveLength(16)
    expect(new Set(rolls.rolls).size).toBeGreaterThan(1)
  })

  it('a power-0 status move is still null', () => {
    const s = session(snorlax(50, ['MOVE_CELEBRATE']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    expect(aiDamageRolls(s.state, 'MOVE_CELEBRATE', 0, 1, aiDamageDepsFor(s.data, s.state))).toBeNull()
  })
})

describe('cycle 944b - aiCalcDamage is unchanged and the range drives guaranteedKo', () => {
  it('aiCalcDamage still estimates Seismic Toss with the ordinary formula', () => {
    const s = session(snorlax(37), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const ai = aiCalcDamage(s.state, 'MOVE_SEISMIC_TOSS', 0, 1, aiDamageDepsFor(s.data, s.state))
    // The C's AI_CalcDamage has no Seismic Toss branch (:650-765), so it keeps
    // the small ordinary-formula estimate rather than the fixed level (37).
    expect(ai.dmg).toBeGreaterThan(0)
    expect(ai.dmg).toBeLessThan(37)
  })

  it('guaranteedKo on the Seismic Toss range is true at hp = level and false above it', () => {
    const s = session(snorlax(37), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const range = ourDamageRange(s, 'MOVE_SEISMIC_TOSS', 0, 1)!
    expect(range.rolls).toEqual(filled(37))
    expect(guaranteedKo(range, 37)).toBe(true)
    expect(guaranteedKo(range, 38)).toBe(false)
  })
})
