import { describe, expect, it } from 'vitest'
import { CHOOSE_STAT_ABILITIES } from './19-choose-stat'
import type { AbilityImpl, OnChooseOffensiveStatContext, OnChooseDefensiveStatContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = CHOOSE_STAT_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function offCtx(overrides: Partial<OnChooseOffensiveStatContext> = {}): OnChooseOffensiveStatContext {
  return {
    battlerId: 'attacker',
    moveId: 'MOVE_TACKLE',
    isCrit: false,
    isUnaware: false,
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    isHighestAttackingStat: true,
    statToUse: 'atk',
    secondaryStat: {},
    ...overrides,
  }
}

function defCtx(overrides: Partial<OnChooseDefensiveStatContext> = {}): OnChooseDefensiveStatContext {
  return {
    attackerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    noPositiveStatStages: false,
    isUnaware: false,
    isCrit: false,
    moveFlags: {},
    defenderHasAnyStatus: false,
    defenderDefComparison: 'equal',
    statToUse: 'def',
    secondaryStat: {},
    ...overrides,
  }
}

describe('choose-stat batch Q', () => {
  it('Ancient Idol picks Def/SpDef by the move\'s own split', () => {
    const c1 = offCtx({ moveSplit: 'PHYSICAL' })
    findAbility('ABILITY_ANCIENT_IDOL').onChooseOffensiveStat!(c1)
    expect(c1.statToUse).toBe('def')
    const c2 = offCtx({ moveSplit: 'SPECIAL' })
    findAbility('ABILITY_ANCIENT_IDOL').onChooseOffensiveStat!(c2)
    expect(c2.statToUse).toBe('spdef')
  })

  it('Equinox picks whichever offensive stat is higher', () => {
    const c1 = offCtx({ isHighestAttackingStat: true })
    findAbility('ABILITY_EQUINOX').onChooseOffensiveStat!(c1)
    expect(c1.statToUse).toBe('atk')
    const c2 = offCtx({ isHighestAttackingStat: false })
    findAbility('ABILITY_EQUINOX').onChooseOffensiveStat!(c2)
    expect(c2.statToUse).toBe('spatk')
  })

  it('Impulse and Momentum key off the move\'s contact flag in opposite directions', () => {
    const c1 = offCtx({ moveFlags: {} })
    findAbility('ABILITY_IMPULSE').onChooseOffensiveStat!(c1)
    expect(c1.statToUse).toBe('spe')
    const c2 = offCtx({ moveFlags: { contact: true } })
    findAbility('ABILITY_IMPULSE').onChooseOffensiveStat!(c2)
    expect(c2.statToUse).toBe('atk') // unchanged -- contact move, Impulse doesn't fire

    const c3 = offCtx({ moveFlags: { contact: true } })
    findAbility('ABILITY_MOMENTUM').onChooseOffensiveStat!(c3)
    expect(c3.statToUse).toBe('spe')
    const c4 = offCtx({ moveFlags: {} })
    findAbility('ABILITY_MOMENTUM').onChooseOffensiveStat!(c4)
    expect(c4.statToUse).toBe('atk')
  })

  it('Blur and Elude key off contact in opposite directions, scoped to the target', () => {
    const c1 = defCtx({ moveFlags: { contact: true } })
    findAbility('ABILITY_BLUR').onChooseDefensiveStat!(c1)
    expect(c1.statToUse).toBe('spe')
    expect(findAbility('ABILITY_BLUR').applyOn?.onChooseDefensiveStatFor).toBe('APPLY_ON_TARGET')

    const c2 = defCtx({ moveFlags: {} })
    findAbility('ABILITY_ELUDE').onChooseDefensiveStat!(c2)
    expect(c2.statToUse).toBe('spe')
  })

  it('Deadeye requires a crit and picks the weaker defensive stat', () => {
    const c1 = defCtx({ isCrit: true, defenderDefComparison: 'spdef' })
    findAbility('ABILITY_DEADEYE').onChooseDefensiveStat!(c1)
    expect(c1.statToUse).toBe('spdef')
    const c2 = defCtx({ isCrit: false, defenderDefComparison: 'spdef' })
    findAbility('ABILITY_DEADEYE').onChooseDefensiveStat!(c2)
    expect(c2.statToUse).toBe('def') // unchanged -- no crit
    const c3 = defCtx({ isCrit: true, defenderDefComparison: 'equal' })
    findAbility('ABILITY_DEADEYE').onChooseDefensiveStat!(c3)
    expect(c3.statToUse).toBe('def') // unchanged -- tie
  })

  it('Exploit Weakness requires any status on the target and picks the weaker defensive stat', () => {
    const c1 = defCtx({ defenderHasAnyStatus: true, defenderDefComparison: 'def' })
    findAbility('ABILITY_EXPLOIT_WEAKNESS').onChooseDefensiveStat!(c1)
    expect(c1.statToUse).toBe('def')
    const c2 = defCtx({ defenderHasAnyStatus: false, defenderDefComparison: 'spdef' })
    findAbility('ABILITY_EXPLOIT_WEAKNESS').onChooseDefensiveStat!(c2)
    expect(c2.statToUse).toBe('def') // unchanged -- no status
  })

  it('Roundhouse requires a kick-based move and picks the weaker defensive stat', () => {
    const c1 = defCtx({ moveFlags: { kickBased: true }, defenderDefComparison: 'spdef' })
    findAbility('ABILITY_ROUNDHOUSE').onChooseDefensiveStat!(c1)
    expect(c1.statToUse).toBe('spdef')
    const c2 = defCtx({ moveFlags: {}, defenderDefComparison: 'spdef' })
    findAbility('ABILITY_ROUNDHOUSE').onChooseDefensiveStat!(c2)
    expect(c2.statToUse).toBe('def') // unchanged -- not kick-based
  })

  it('every entry cites a src line', () => {
    for (const ability of CHOOSE_STAT_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
