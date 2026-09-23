import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeParentalBondTrigger, getParentalBondMultiplier } from '../dispatchCalc'
import { PARENTAL_BOND_ABILITIES } from './24-parental-bond'
import { ADDS_TYPE_ABILITIES } from './12-adds-type'
import { ALIAS_ABILITIES } from './10-aliases'
import { SWARM_FAMILY } from './08-swarm-family'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import { uq } from '../../fixed'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function ctx(overrides: Partial<{ moveType: string; moveFlags: Record<string, true>; weather: string; attackerHeads: number }> = {}) {
  return {
    moveType: 'NORMAL',
    moveFlags: {},
    weather: 'NONE',
    attackerHeads: 1,
    ...overrides,
  }
}

describe('parental bond batch X', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(PARENTAL_BOND_ABILITIES)
    registerAbilities(ADDS_TYPE_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(SWARM_FAMILY)
    registerAbilities(ATE_FAMILY_AND_ONSTAB)
  })

  it('Parental Bond and its unconditional aliases (Hyper Aggressive, Ghost Frenzy, Raging Goddess, Balloon Blitz, Frenzied Phantom, Witch Broom) all trigger HYPER_AGGRESSIVE', () => {
    for (const id of [
      'ABILITY_PARENTAL_BOND',
      'ABILITY_HYPER_AGGRESSIVE',
      'ABILITY_GHOST_FRENZY',
      'ABILITY_RAGING_GODDESS',
      'ABILITY_BALLOON_BLITZ',
      'ABILITY_FRENZIED_PHANTOM',
      'ABILITY_WITCH_BROOM',
    ]) {
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx())).toBe('HYPER_AGGRESSIVE')
    }
  })

  it('Dual Hammer/Dual Wield trigger DUAL_WIELD only for their own qualifying move flags', () => {
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_HAMMER'), slots(null), ctx({ moveFlags: { hammerBased: true } }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_HAMMER'), slots(null), ctx())).toBeNull()
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_WIELD'), slots(null), ctx({ moveFlags: { bulletBased: true } }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_WIELD'), slots(null), ctx({ moveFlags: { sliceBased: true } }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_WIELD'), slots(null), ctx())).toBeNull()
  })

  it('Raging Moth (Fire moves) also triggers DUAL_WIELD', () => {
    expect(computeParentalBondTrigger(slots('ABILITY_RAGING_MOTH'), slots(null), ctx({ moveType: 'FIRE' }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_RAGING_MOTH'), slots(null), ctx({ moveType: 'WATER' }))).toBeNull()
  })

  it('Minion Control is unconditional MINION_CONTROL', () => {
    expect(computeParentalBondTrigger(slots('ABILITY_MINION_CONTROL'), slots(null), ctx())).toBe('MINION_CONTROL')
  })

  it('Ice Cold Hunter needs Ice type AND Hail', () => {
    expect(computeParentalBondTrigger(slots('ABILITY_ICE_COLD_HUNTER'), slots(null), ctx({ moveType: 'ICE', weather: 'HAIL' }))).toBe('ICE_COLD_HUNTER')
    expect(computeParentalBondTrigger(slots('ABILITY_ICE_COLD_HUNTER'), slots(null), ctx({ moveType: 'ICE', weather: 'NONE' }))).toBeNull()
    expect(computeParentalBondTrigger(slots('ABILITY_ICE_COLD_HUNTER'), slots(null), ctx({ moveType: 'WATER', weather: 'HAIL' }))).toBeNull()
  })

  // Released v2.65beta (sources.lock.json's pinned SHA, not `upcoming`'s tip):
  // Magus Blades aliases Dual Wield's own condition (bulletBased || sliceBased ->
  // DUAL_WIELD), not a standalone MAGUS_BLADES-typed trigger -- see 10-aliases.ts's
  // own doc on this pin correction.
  it("Magus Blades needs a bullet or slicing move (aliases Dual Wield's own condition)", () => {
    expect(computeParentalBondTrigger(slots('ABILITY_MAGUS_BLADES'), slots(null), ctx({ moveFlags: { sliceBased: true } }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_MAGUS_BLADES'), slots(null), ctx({ moveFlags: { bulletBased: true } }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_MAGUS_BLADES'), slots(null), ctx())).toBeNull()
  })

  it('Primal Maw/Devourer/Metallic Jaws need a biting move; Raging Boxer/Steel Beetle need a punching move (both share PRIMAL_MAW)', () => {
    for (const id of ['ABILITY_PRIMAL_MAW', 'ABILITY_DEVOURER', 'ABILITY_METALLIC_JAWS']) {
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx({ moveFlags: { biteBased: true } }))).toBe('PRIMAL_MAW')
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx())).toBeNull()
    }
    for (const id of ['ABILITY_RAGING_BOXER', 'ABILITY_STEEL_BEETLE']) {
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx({ moveFlags: { punchBased: true } }))).toBe('PRIMAL_MAW')
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx())).toBeNull()
    }
  })

  it('Multi Headed (and its aliases 3 GT 1, Hand Barnacles, Hydra) read attackerHeads: 2 -> HYPER_AGGRESSIVE, 3+ -> THREE_HEADED, else null', () => {
    for (const id of ['ABILITY_MULTI_HEADED', 'ABILITY_3_GT_1', 'ABILITY_HAND_BARNACLES', 'ABILITY_HYDRA']) {
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx({ attackerHeads: 1 }))).toBeNull()
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx({ attackerHeads: 2 }))).toBe('HYPER_AGGRESSIVE')
      expect(computeParentalBondTrigger(slots(id), slots(null), ctx({ attackerHeads: 3 }))).toBe('THREE_HEADED')
    }
  })

  it('Unrelenting returns TWO_TO_FIVE, a different multi-hit family getParentalBondMultiplier does not reduce', () => {
    expect(computeParentalBondTrigger(slots('ABILITY_UNRELENTING'), slots(null), ctx())).toBe('TWO_TO_FIVE')
    expect(getParentalBondMultiplier('TWO_TO_FIVE', 1)).toBe(uq(1.0))
  })

  it('resistsFortKnox lets Parental Bond through a Fort Knox defender; a non-resisting trigger does not', () => {
    // Fort Knox itself isn't ported yet (99-unmodelled.ts) -- register a throwaway
    // fortKnox-flagged ability locally so this test doesn't depend on that stub.
    registerAbilities([{ id: 'ABILITY_TEST_FORT_KNOX', src: 'src/abilities.cc:0', flags: { fortKnox: true } }])
    const defender = slots('ABILITY_TEST_FORT_KNOX')
    expect(computeParentalBondTrigger(slots('ABILITY_PARENTAL_BOND'), defender, ctx())).toBe('HYPER_AGGRESSIVE') // resistsFortKnox: true
    expect(computeParentalBondTrigger(slots('ABILITY_DUAL_HAMMER'), defender, ctx({ moveFlags: { hammerBased: true } }))).toBeNull() // no resistsFortKnox
  })

  it('getParentalBondMultiplier matches GetParentalBondMultiplier turn-by-turn (battle_util.c:7483-7513)', () => {
    expect(getParentalBondMultiplier('HYPER_AGGRESSIVE', 1)).toBe(uq(0.25))
    expect(getParentalBondMultiplier('HYPER_AGGRESSIVE', 0)).toBe(uq(1.0)) // REQUIRE(turn) fails -> default
    expect(getParentalBondMultiplier('THREE_HEADED', 1)).toBe(uq(0.2))
    expect(getParentalBondMultiplier('THREE_HEADED', 2)).toBe(uq(0.15))
    expect(getParentalBondMultiplier('THREE_HEADED', 3)).toBe(uq(1.0)) // no case for turn 3 -> default
    expect(getParentalBondMultiplier('MINION_CONTROL', 1)).toBe(uq(0.1))
    expect(getParentalBondMultiplier('PRIMAL_MAW', 1)).toBe(uq(0.4))
    expect(getParentalBondMultiplier('DUAL_WIELD', 0)).toBe(uq(0.7)) // no REQUIRE gate at all
    expect(getParentalBondMultiplier('ICE_COLD_HUNTER', 1)).toBe(uq(1.0)) // no case -> full power both hits
    expect(getParentalBondMultiplier(null, 1)).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of PARENTAL_BOND_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
