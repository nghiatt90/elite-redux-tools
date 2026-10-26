// session is imported first on purpose: through the driver's import order the stat MOVE_EFFECT_* constants used to be
// undefined when SECONDARY_MOVE_EFFECT_MAP was built (an import cycle through statBuffs), so every stat-change
// secondary effect raised "not modelled" and did nothing.
import './session'
import { expect, it } from 'vitest'
import { SECONDARY_MOVE_EFFECT_MAP } from '../moveEffects'

it('every SECONDARY_MOVE_EFFECT_MAP value is a number under the driver import order', () => {
  const missing = Object.entries(SECONDARY_MOVE_EFFECT_MAP)
    .filter(([, value]) => typeof value !== 'number')
    .map(([name]) => name)
  expect(missing).toEqual([])
})
