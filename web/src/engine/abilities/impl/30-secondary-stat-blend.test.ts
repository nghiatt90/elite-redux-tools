import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeChooseOffensiveStat, computeChooseDefensiveStat } from '../dispatchCalc'
import { SECONDARY_STAT_BLEND_ABILITIES } from './30-secondary-stat-blend'
import { ALIAS_ABILITIES } from './10-aliases'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function offInputs(overrides: Partial<{ moveFlags: Record<string, true>; moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS' }> = {}) {
  return {
    battlerId: 'attacker',
    moveId: 'MOVE_TACKLE',
    isCrit: false,
    isUnaware: false,
    moveSplit: 'PHYSICAL' as const,
    moveFlags: {},
    isHighestAttackingStat: false,
    ...overrides,
  }
}

function defInputs(overrides: Partial<{ moveFlags: Record<string, true> }> = {}) {
  return {
    attackerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    noPositiveStatStages: false,
    isUnaware: false,
    isCrit: false,
    moveFlags: {},
    defenderHasAnyStatus: false,
    defenderDefComparison: 'equal' as const,
    ...overrides,
  }
}

describe('secondary stat blend batch AD', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(SECONDARY_STAT_BLEND_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
  })

  it('Juggernaut (and its aliases Iron Giant, Sumo Guard, Sand Titan) blend 20% Def into Atk on contact moves only', () => {
    for (const id of ['ABILITY_JUGGERNAUT', 'ABILITY_IRON_GIANT', 'ABILITY_SUMO_GUARD', 'ABILITY_SAND_TITAN']) {
      const on = computeChooseOffensiveStat(slots(id), 'atk', offInputs({ moveFlags: { contact: true } }))
      expect(on.statToUse).toBe('atk')
      expect(on.secondaryStat).toEqual({ def: 20 })

      const off = computeChooseOffensiveStat(slots(id), 'atk', offInputs())
      expect(off.secondaryStat).toEqual({})
    }
  })

  it('Speed Force blends 20% Speed into Atk on contact moves only', () => {
    const on = computeChooseOffensiveStat(slots('ABILITY_SPEED_FORCE'), 'atk', offInputs({ moveFlags: { contact: true } }))
    expect(on.secondaryStat).toEqual({ spe: 20 })
    const off = computeChooseOffensiveStat(slots('ABILITY_SPEED_FORCE'), 'atk', offInputs())
    expect(off.secondaryStat).toEqual({})
  })

  it('Power Core (and Unstable Core) blend 20% of Def (physical) or SpDef (special)', () => {
    for (const id of ['ABILITY_POWER_CORE', 'ABILITY_UNSTABLE_CORE']) {
      expect(computeChooseOffensiveStat(slots(id), 'atk', offInputs({ moveSplit: 'PHYSICAL' })).secondaryStat).toEqual({ def: 20 })
      expect(computeChooseOffensiveStat(slots(id), 'spatk', offInputs({ moveSplit: 'SPECIAL' })).secondaryStat).toEqual({ spdef: 20 })
    }
  })

  it('Terminal Velocity blends 20% Speed into special moves only', () => {
    expect(computeChooseOffensiveStat(slots('ABILITY_TERMINAL_VELOCITY'), 'spatk', offInputs({ moveSplit: 'SPECIAL' })).secondaryStat).toEqual({ spe: 20 })
    expect(computeChooseOffensiveStat(slots('ABILITY_TERMINAL_VELOCITY'), 'atk', offInputs({ moveSplit: 'PHYSICAL' })).secondaryStat).toEqual({})
  })

  it('Slipstream (and its aliases Maximum Acceleration, Mach 3) unconditionally blend 20% Speed', () => {
    for (const id of ['ABILITY_SLIPSTREAM', 'ABILITY_MAXIMUM_ACCELERATION', 'ABILITY_MACH_3']) {
      expect(computeChooseOffensiveStat(slots(id), 'atk', offInputs()).secondaryStat).toEqual({ spe: 20 })
    }
  })

  it('Sleek Scales blends 15% Speed into the DEFENSIVE stat without changing statToUse, and only fires as the defender', () => {
    const result = computeChooseDefensiveStat(slots(null), slots('ABILITY_SLEEK_SCALES'), 'def', defInputs())
    expect(result.statToUse).toBe('def') // unchanged -- Sleek Scales never touches defStatToUse
    expect(result.secondaryStat).toEqual({ spe: 15 })

    // APPLY_ON_TARGET -- held by the ATTACKER instead, it must not fire at all.
    const asAttacker = computeChooseDefensiveStat(slots('ABILITY_SLEEK_SCALES'), slots(null), 'def', defInputs())
    expect(asAttacker.secondaryStat).toEqual({})
  })

  it("an attacker-side stat override stops the scan before the defender's Sleek Scales ever runs (matching the C's for-loop-stop-at-primary-override)", () => {
    // A defender-scoped ability picking a different primary stat would normally
    // never coexist with Sleek Scales in real data, but this proves the ordering:
    // if run(attackerSlots) already returned a non-default stat, run(defenderSlots)
    // (and Sleek Scales's secondaryStat contribution) is skipped entirely.
    const fakeOverride: import('../types').AbilityImpl = {
      id: 'ABILITY_TEST_DEF_OVERRIDE',
      src: 'test',
      onChooseDefensiveStat: (ctx) => {
        ctx.statToUse = 'spdef'
      },
    }
    registerAbilities([fakeOverride])
    const result = computeChooseDefensiveStat(slots('ABILITY_TEST_DEF_OVERRIDE'), slots('ABILITY_SLEEK_SCALES'), 'def', defInputs())
    expect(result.statToUse).toBe('spdef')
    expect(result.secondaryStat).toEqual({}) // Sleek Scales' run never happened
  })

  it('every entry cites a src line', () => {
    for (const ability of SECONDARY_STAT_BLEND_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
