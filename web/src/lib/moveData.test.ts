import { describe, expect, it } from 'vitest'
import { bareType, toMoveData } from './moveData'
import type { Move } from './types'

function move(overrides: Partial<Move> = {}): Move {
  return {
    id: 'MOVE_TACKLE',
    name: 'Tackle',
    shortName: 'Tackle',
    description: '',
    shortDescription: '',
    type: 'TYPE_NORMAL',
    type2: null,
    power: 40,
    accuracy: 100,
    pp: 35,
    priority: 0,
    effectChance: 0,
    split: 'PHYSICAL',
    target: null,
    effect: null,
    customBehavior: null,
    flags: {},
    ...overrides,
  }
}

describe('bareType', () => {
  it('strips the TYPE_ prefix', () => {
    expect(bareType('TYPE_FIRE')).toBe('FIRE')
  })
})

describe('toMoveData', () => {
  it('strips TYPE_ from both declared types and passes the rest through', () => {
    const data = toMoveData(move({ type: 'TYPE_WATER', type2: 'TYPE_FLYING' }))
    expect(data.type).toBe('WATER')
    expect(data.type2).toBe('FLYING')
    expect(data.power).toBe(40)
    expect(data.split).toBe('PHYSICAL')
  })

  it('narrows changeTypeHoldEffect only for EFFECT_CHANGE_TYPE_ON_ITEM with an "other" argument', () => {
    const judgment = toMoveData(
      move({ id: 'MOVE_JUDGMENT', effect: 'EFFECT_CHANGE_TYPE_ON_ITEM', argument: { kind: 'other', value: 'HOLD_EFFECT_PLATE' } }),
    )
    expect(judgment.changeTypeHoldEffect).toBe('HOLD_EFFECT_PLATE')

    const other = toMoveData(move({ effect: 'EFFECT_CHANGE_TYPE_ON_ITEM', argument: { kind: 'int', value: 3 } }))
    expect(other.changeTypeHoldEffect).toBeNull()
  })

  it('narrows multiHitArgument only for EFFECT_DOUBLE_HIT with an "int" argument', () => {
    const tripleHit = toMoveData(move({ effect: 'EFFECT_DOUBLE_HIT', argument: { kind: 'int', value: 3 } }))
    expect(tripleHit.multiHitArgument).toBe(3)

    const noArgument = toMoveData(move({ effect: 'EFFECT_DOUBLE_HIT' }))
    expect(noArgument.multiHitArgument).toBeNull()
  })
})
