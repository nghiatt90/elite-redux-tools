import { describe, expect, it } from 'vitest'

import { computeAbilityPriorityBonus } from '../dispatchPriority'
import type { PriorityDispatchInputs } from '../dispatchPriority'
import { REMAINING_ON_PRIORITY } from './44-priority'

function inputs(overrides: Partial<PriorityDispatchInputs> = {}): PriorityDispatchInputs {
  return {
    battlerId: '0',
    holderSlots: { ability: null, innates: [null, null, null] },
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    movePower: 40,
    movePriority: 0,
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    holderHp: 100,
    holderMaxHp: 100,
    targetHp: 100,
    targetMaxHp: 100,
    ...overrides,
  }
}

function withAbility(id: string, overrides: Partial<PriorityDispatchInputs> = {}): number {
  return computeAbilityPriorityBonus(inputs({ holderSlots: { ability: id, innates: [null, null, null] }, ...overrides }))
}

describe('the Gale Wings family', () => {
  // GALE_WINGS_CLONE(type), src/abilities.cc:126-131 -- both CHECKs must pass.
  const family: [string, string][] = [
    ['ABILITY_GALE_WINGS', 'FLYING'],
    ['ABILITY_WATER_GALE_WINGS', 'WATER'],
    ['ABILITY_FLAMING_SOUL', 'FIRE'],
    ['ABILITY_VOLT_RUSH', 'ELECTRIC'],
  ]

  it.each(family)('%s boosts its own type at full HP', (id, type) => {
    expect(withAbility(id, { moveType: type })).toBe(1)
  })

  it.each(family)('%s does nothing on a move of another type', (id) => {
    expect(withAbility(id, { moveType: 'GROUND' })).toBe(0)
  })

  it.each(family)('%s is switched off by a single point of chip damage', (id, type) => {
    // BATTLER_MAX_HP is hp == maxHP exactly (include/battle.h:749), not a
    // threshold -- 99/100 is enough to lose it.
    expect(withAbility(id, { moveType: type, holderHp: 99 })).toBe(0)
  })

  it('reads the RESOLVED move type, not the declared one', () => {
    // GetTypeBeforeUsingMove -- an "-ate" ability or Electrify changes what this
    // family sees. The dispatcher is handed the resolved type, so a Normal move
    // converted to Flying does qualify.
    expect(withAbility('ABILITY_GALE_WINGS', { moveId: 'MOVE_TACKLE', moveType: 'FLYING' })).toBe(1)
  })
})

describe('Prankster', () => {
  it('boosts a status move', () => {
    expect(withAbility('ABILITY_PRANKSTER', { moveSplit: 'STATUS' })).toBe(1)
  })

  it('does nothing for a damaging move, and does not care about HP', () => {
    expect(withAbility('ABILITY_PRANKSTER', { moveSplit: 'PHYSICAL' })).toBe(0)
    expect(withAbility('ABILITY_PRANKSTER', { moveSplit: 'STATUS', holderHp: 1 })).toBe(1)
  })
})

describe('Opportunist', () => {
  it('fires when the target is at or below half HP', () => {
    expect(withAbility('ABILITY_OPPORTUNIST', { targetHp: 50, targetMaxHp: 100 })).toBe(1)
    expect(withAbility('ABILITY_OPPORTUNIST', { targetHp: 51, targetMaxHp: 100 })).toBe(0)
  })

  it('rounds the threshold DOWN on an odd max HP, as integer division does', () => {
    // maxHP 101 -> `101 / 2` is 50 in C, so 51 does not qualify even though it
    // is under half. A float ratio comparison would be a coin toss here.
    expect(withAbility('ABILITY_OPPORTUNIST', { targetHp: 50, targetMaxHp: 101 })).toBe(1)
    expect(withAbility('ABILITY_OPPORTUNIST', { targetHp: 51, targetMaxHp: 101 })).toBe(0)
  })

  it('reads the TARGET, not the holder', () => {
    expect(withAbility('ABILITY_OPPORTUNIST', { holderHp: 1, targetHp: 100, targetMaxHp: 100 })).toBe(0)
  })

  it('does nothing with no resolved target', () => {
    expect(withAbility('ABILITY_OPPORTUNIST', { targetHp: null, targetMaxHp: null })).toBe(0)
  })
})

describe('Blitz Boxer', () => {
  it('needs both a punch move and full HP', () => {
    expect(withAbility('ABILITY_BLITZ_BOXER', { moveFlags: { punchBased: true } })).toBe(1)
    expect(withAbility('ABILITY_BLITZ_BOXER', { moveFlags: {} })).toBe(0)
    expect(withAbility('ABILITY_BLITZ_BOXER', { moveFlags: { punchBased: true }, holderHp: 99 })).toBe(0)
  })
})

describe('Perfectionist', () => {
  it('boosts a weak damaging move but not a strong one', () => {
    expect(withAbility('ABILITY_PERFECTIONIST', { movePower: 25 })).toBe(1)
    expect(withAbility('ABILITY_PERFECTIONIST', { movePower: 26 })).toBe(0)
  })

  it('excludes zero-power moves, so it never doubles up with Prankster', () => {
    // The second CHECK is `CHECK(gBattleMoves[move].power)` -- a status move has
    // power 0 and fails it.
    expect(withAbility('ABILITY_PERFECTIONIST', { movePower: 0, moveSplit: 'STATUS' })).toBe(0)
  })

  it('uses a DIFFERENT threshold from its own onCrit half', () => {
    // onPriority is power <= 25; onCrit is power <= 50 (src/abilities.cc:3839).
    // Same ability, two thresholds -- a port that shared one constant would be
    // wrong for exactly this band.
    expect(withAbility('ABILITY_PERFECTIONIST', { movePower: 40 })).toBe(0)
  })
})

describe('Temporal Rupture', () => {
  it('cancels Roar of Time own negative priority rather than adding a boost', () => {
    // Returns -gBattleMoves[MOVE_ROAR_OF_TIME].priority. Roar of Time is -6 in
    // this build, so the delta is +6 and the move resolves at 0, not +6.
    expect(withAbility('ABILITY_TEMPORAL_RUPTURE', { moveId: 'MOVE_ROAR_OF_TIME', movePriority: -6 })).toBe(6)
  })

  it('does nothing for any other move', () => {
    expect(withAbility('ABILITY_TEMPORAL_RUPTURE', { moveId: 'MOVE_TACKLE', movePriority: 0 })).toBe(0)
  })
})

describe('the dispatch itself', () => {
  it('returns 0 for a battler with no abilities', () => {
    expect(computeAbilityPriorityBonus(inputs())).toBe(0)
  })

  it('ACCUMULATES across slots instead of stopping at the first hit', () => {
    // ON_ABILITY at battle_main.c:4264 is `priority += ...` inside the loop, not
    // a first-wins hook. A Flying status move at full HP with both Prankster and
    // Gale Wings gets +2.
    const total = computeAbilityPriorityBonus(
      inputs({
        holderSlots: { ability: 'ABILITY_PRANKSTER', innates: ['ABILITY_GALE_WINGS', null, null] },
        moveSplit: 'STATUS',
        moveType: 'FLYING',
      }),
    )
    expect(total).toBe(2)
  })

  it('reads innate slots, not just the chosen ability', () => {
    const total = computeAbilityPriorityBonus(
      inputs({ holderSlots: { ability: null, innates: [null, 'ABILITY_PRANKSTER', null] }, moveSplit: 'STATUS' }),
    )
    expect(total).toBe(1)
  })

  it('ignores an ability with no onPriority hook', () => {
    expect(withAbility('ABILITY_ADAPTABILITY', { moveSplit: 'STATUS' })).toBe(0)
  })
})

describe('the remaining list', () => {
  it('names the 10 not ported, with no duplicates', () => {
    expect(REMAINING_ON_PRIORITY).toHaveLength(10)
    expect(new Set(REMAINING_ON_PRIORITY.map((r) => r.id)).size).toBe(10)
  })

  it('none of them contributes anything yet', () => {
    for (const r of REMAINING_ON_PRIORITY) {
      // Fed the most permissive inputs available; an unported ability must still
      // be silent rather than accidentally picking up another entry's hook.
      expect(withAbility(r.id, { moveSplit: 'STATUS', movePower: 0, targetHp: 1, holderHp: 100 })).toBe(0)
    }
  })
})
