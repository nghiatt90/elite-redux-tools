/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  generateMoveInventoryDoc,
  loadMoveBehaviors,
  loadMoves,
  parseScripts,
  runInventory,
  type MoveRecord,
} from './driver/moveInventory'

const moves = loadMoves()
const behaviors = loadMoveBehaviors()
const scripts = parseScripts()
const result = runInventory(moves, behaviors, { scripts })

describe('cycle 151e: the flag unit kind is gone', () => {
  it('the real inventory has no flag unit and no flag summary row', () => {
    expect(result.units.some((unit) => (unit.kind as string) === 'flag')).toBe(false)
    expect(result.summaries.some((summary) => (summary.kind as string) === 'flag')).toBe(false)
    expect(result.units.filter((unit) => (unit.kind as string) === 'flag')).toHaveLength(0)
  })

  it('a synthetic move flag produces no unit: only its effect pair is inventoried', () => {
    const move: MoveRecord = {
      id: 'MOVE_CYCLE151E_FLAG',
      effect: 'EFFECT_CYCLE151E_FLAG',
      flags: { drillBased: true },
    }
    const synthetic = runInventory([move], {}, {
      // Production source that reads the flag exactly as the old classifier looked for.
      productionSource: 'if (ctx.moveFlags.drillBased) return true',
      testSource: "it('x', () => { calculateMoveDamage('EFFECT_CYCLE151E_FLAG') })",
      scripts,
      allowlist: [],
    })
    const own = synthetic.units.filter((unit) => unit.moveId === 'MOVE_CYCLE151E_FLAG')
    expect(own).toHaveLength(1)
    expect(own[0].kind).toBe('move-effect')
    expect(own[0].unit).toBe('EFFECT_CYCLE151E_FLAG')
    expect(synthetic.units.some((unit) => (unit.kind as string) === 'flag')).toBe(false)
    expect(synthetic.summaries.some((summary) => (summary.kind as string) === 'flag')).toBe(false)
  })

  it('the generated doc carries the two known gaps and no flag group section', () => {
    const doc = generateMoveInventoryDoc(result)
    expect(doc).toContain('Known Gaps')
    expect(doc).toContain('lunarBased')
    for (const moveId of [
      'MOVE_BLOOD_MOON',
      'MOVE_BLUE_MOON',
      'MOVE_LUNAR_BLESSING',
      'MOVE_LUNAR_DANCE',
      'MOVE_MOONBLAST',
      'MOVE_MOONGEIST_BEAM',
      'MOVE_MOONLIGHT',
    ]) {
      expect(doc).toContain(moveId)
    }
    expect(doc).toContain('abilities.cc:8855-8859')
    expect(doc).toContain('noKingsRock')
    expect(doc).not.toContain('Unported Flag Groups')
    expect(doc).not.toContain('### 3. **flag**')
    expect(doc).not.toContain('3. **flag**')
  })
})
