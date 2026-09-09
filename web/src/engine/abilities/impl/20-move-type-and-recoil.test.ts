import { describe, expect, it } from 'vitest'
import { MOVE_TYPE_AND_RECOIL_ABILITIES } from './20-move-type-and-recoil'
import type { AbilityImpl, OnMoveTypeContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = MOVE_TYPE_AND_RECOIL_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

describe('move type + recoil batch R', () => {
  it('Cosmic Wings converts Flying to Fairy without setting ateBoost', () => {
    const ctx: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_AIR_SLASH', moveType: 'FLYING', ateBoost: false, moveFlags: {} }
    findAbility('ABILITY_COSMIC_WINGS').onMoveType!(ctx)
    expect(ctx.moveType).toBe('FAIRY')
    expect(ctx.ateBoost).toBe(false)

    const nonFlying: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {} }
    findAbility('ABILITY_COSMIC_WINGS').onMoveType!(nonFlying)
    expect(nonFlying.moveType).toBe('NORMAL')
  })

  it('Super Strain returns quarter damage recoil, minimum 1', () => {
    expect(findAbility('ABILITY_SUPER_STRAIN').onRecoil!({ battlerId: 'x', damage: 100, moveType: 'NORMAL' })).toBe(25)
    expect(findAbility('ABILITY_SUPER_STRAIN').onRecoil!({ battlerId: 'x', damage: 2, moveType: 'NORMAL' })).toBe(1)
    expect(findAbility('ABILITY_SUPER_STRAIN').onRecoil!({ battlerId: 'x', damage: 0, moveType: 'NORMAL' })).toBe(1)
  })

  it('Victory Bomb converts Explosion (and only Explosion) to Fire', () => {
    const explosion: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_EXPLOSION', moveType: 'NORMAL', ateBoost: false, moveFlags: {} }
    findAbility('ABILITY_VICTORY_BOMB').onMoveType!(explosion)
    expect(explosion.moveType).toBe('FIRE')

    const otherMove: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {} }
    findAbility('ABILITY_VICTORY_BOMB').onMoveType!(otherMove)
    expect(otherMove.moveType).toBe('NORMAL')
  })

  it('every entry cites a src line', () => {
    for (const ability of MOVE_TYPE_AND_RECOIL_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
