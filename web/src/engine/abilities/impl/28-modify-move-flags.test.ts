import { describe, expect, it } from 'vitest'
import { MODIFY_MOVE_FLAGS_ABILITIES } from './28-modify-move-flags'
import { ALIAS_ABILITIES } from './10-aliases'
import type { AbilityImpl, OnModifyMoveFlagsContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = [...MODIFY_MOVE_FLAGS_ABILITIES, ...ALIAS_ABILITIES].find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found`)
  return entry
}

function ctx(overrides: Partial<OnModifyMoveFlagsContext> = {}): OnModifyMoveFlagsContext {
  return { flag: 'sound', moveType: 'NORMAL', moveFlags: {}, moveSplit: 'PHYSICAL', ...overrides }
}

function grants(id: string, overrides: Partial<OnModifyMoveFlagsContext> = {}): boolean {
  return findAbility(id).onModifyMoveFlags?.(ctx(overrides)) ?? false
}

describe('modify move flags batch AB', () => {
  it('Backstreet Boy cross-swaps Kick <-> Dance', () => {
    expect(grants('ABILITY_BACKSTREET_BOY', { flag: 'kickBased', moveFlags: { dance: true } })).toBe(true)
    expect(grants('ABILITY_BACKSTREET_BOY', { flag: 'dance', moveFlags: { kickBased: true } })).toBe(true)
    expect(grants('ABILITY_BACKSTREET_BOY', { flag: 'kickBased', moveFlags: {} })).toBe(false)
    expect(grants('ABILITY_BACKSTREET_BOY', { flag: 'sound', moveFlags: { dance: true } })).toBe(false)
  })

  it('Brawling Wyvern grants Punch to Dragon-type moves only', () => {
    expect(grants('ABILITY_BRAWLING_WYVERN', { flag: 'punchBased', moveType: 'DRAGON' })).toBe(true)
    expect(grants('ABILITY_BRAWLING_WYVERN', { flag: 'punchBased', moveType: 'NORMAL' })).toBe(false)
    expect(grants('ABILITY_BRAWLING_WYVERN', { flag: 'kickBased', moveType: 'DRAGON' })).toBe(false)
  })

  it('Chestnut Axe grants Keen Edge to Grass-type moves only', () => {
    expect(grants('ABILITY_CHESTNUT_AXE', { flag: 'sliceBased', moveType: 'GRASS' })).toBe(true)
    expect(grants('ABILITY_CHESTNUT_AXE', { flag: 'sliceBased', moveType: 'WATER' })).toBe(false)
  })

  it('Festivities cross-swaps Dance <-> Sound', () => {
    expect(grants('ABILITY_FESTIVITIES', { flag: 'dance', moveFlags: { sound: true } })).toBe(true)
    expect(grants('ABILITY_FESTIVITIES', { flag: 'sound', moveFlags: { dance: true } })).toBe(true)
    expect(grants('ABILITY_FESTIVITIES', { flag: 'dance', moveFlags: {} })).toBe(false)
  })

  it('Gunman grants Mega Launcher to status moves only', () => {
    expect(grants('ABILITY_GUNMAN', { flag: 'bulletBased', moveSplit: 'STATUS' })).toBe(true)
    expect(grants('ABILITY_GUNMAN', { flag: 'bulletBased', moveSplit: 'PHYSICAL' })).toBe(false)
  })

  it('Junshi Sanda cross-swaps Punch <-> Kick', () => {
    expect(grants('ABILITY_JUNSHI_SANDA', { flag: 'punchBased', moveFlags: { kickBased: true } })).toBe(true)
    expect(grants('ABILITY_JUNSHI_SANDA', { flag: 'kickBased', moveFlags: { punchBased: true } })).toBe(true)
    expect(grants('ABILITY_JUNSHI_SANDA', { flag: 'punchBased', moveFlags: {} })).toBe(false)
  })

  it('Mixed Martial Arts grants Punch or Kick to Normal-type moves only', () => {
    expect(grants('ABILITY_MIXED_MARTIAL_ARTS', { flag: 'punchBased', moveType: 'NORMAL' })).toBe(true)
    expect(grants('ABILITY_MIXED_MARTIAL_ARTS', { flag: 'kickBased', moveType: 'NORMAL' })).toBe(true)
    expect(grants('ABILITY_MIXED_MARTIAL_ARTS', { flag: 'sound', moveType: 'NORMAL' })).toBe(false)
    expect(grants('ABILITY_MIXED_MARTIAL_ARTS', { flag: 'punchBased', moveType: 'FIRE' })).toBe(false)
  })

  it('Musical Notes grants Sound to status moves only', () => {
    expect(grants('ABILITY_MUSICAL_NOTES', { flag: 'sound', moveSplit: 'STATUS' })).toBe(true)
    expect(grants('ABILITY_MUSICAL_NOTES', { flag: 'sound', moveSplit: 'PHYSICAL' })).toBe(false)
  })

  it('Reverbate grants Sound to Normal-type moves only', () => {
    expect(grants('ABILITY_REVERBATE', { flag: 'sound', moveType: 'NORMAL' })).toBe(true)
    expect(grants('ABILITY_REVERBATE', { flag: 'sound', moveType: 'FIRE' })).toBe(false)
  })

  it('Taekkyeon grants Dance to non-status moves only', () => {
    expect(grants('ABILITY_TAEKKYEON', { flag: 'dance', moveSplit: 'PHYSICAL' })).toBe(true)
    expect(grants('ABILITY_TAEKKYEON', { flag: 'dance', moveSplit: 'STATUS' })).toBe(false)
  })

  it('every entry cites a src line', () => {
    for (const ability of MODIFY_MOVE_FLAGS_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
