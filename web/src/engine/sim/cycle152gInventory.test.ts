/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  AI_TRIGGER_FILES,
  HOLD_TRIGGER_FILES,
  loadItems,
  runInventory,
  type ItemInventoryResult,
  type ItemUnit,
} from './driver/itemInventory'

const items = loadItems()

function unitFor(
  result: ItemInventoryResult,
  kind: ItemUnit['kind'],
  effect: string,
  site: string,
): ItemUnit | undefined {
  return result.units.find((unit) => unit.kind === kind && unit.unit === effect && unit.site === site)
}

describe('cycle 152g - battle_ai_ability.c is an AI trigger file', () => {
  it('lists battle_ai_ability.c only under AI_TRIGGER_FILES', () => {
    expect(HOLD_TRIGGER_FILES).not.toContain('battle_ai_ability.c')
    expect(AI_TRIGGER_FILES).toContain('battle_ai_ability.c')
  })

  it('classifies both Booster Energy ScoreSwitchInAbility sites as ai-trigger', () => {
    const result = runInventory(items)

    const proto = unitFor(result, 'ai-trigger', 'HOLD_EFFECT_BOOSTER_ENERGY', 'ScoreSwitchInAbility:1070')
    expect(proto).toBeDefined()
    expect(proto?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_ai_ability.c:1070',
    )

    const quark = unitFor(result, 'ai-trigger', 'HOLD_EFFECT_BOOSTER_ENERGY', 'ScoreSwitchInAbility:1076')
    expect(quark).toBeDefined()
    expect(quark?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_ai_ability.c:1076',
    )

    const strayHold = result.units.filter(
      (unit) => unit.kind === 'hold-trigger' && unit.file.endsWith('battle_ai_ability.c'),
    )
    expect(strayHold).toEqual([])
  })

  it('keeps the CanFling citation on the definition line, not the comment above it', () => {
    const result = runInventory(items)
    const canFling = unitFor(result, 'fling', 'CanFling', 'CanFling')
    expect(canFling?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:8414')
  })
})
