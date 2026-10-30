/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { candidateMoves, defaultSet, neighbours, UTILITY_MOVES } from './driver/solver'
import { isEligibleMove, isGatedMove, VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'

const data = loadSimData()
const LEVEL = 50

function learnable(speciesId: string, level = LEVEL): Set<string> {
  const ls = data.speciesById.get(speciesId)?.learnset as
    | { levelUp?: Array<{ level: number; moves: string[] }>; tutor?: string[] }
    | undefined
  const out = new Set<string>()
  for (const e of ls?.levelUp ?? []) if (e.level <= level) for (const m of e.moves) out.add(m)
  for (const m of ls?.tutor ?? []) out.add(m)
  return out
}

const move = (id: string) => data.dataContext.move(id)!
const gated = (id: string): boolean => isGatedMove(move(id))
const effectOf = (id: string): string => move(id).effect ?? 'NONE'

async function withVerified<T>(effects: string[], fn: () => T): Promise<T> {
  try {
    for (const e of effects) VERIFIED_MOVE_EFFECTS.set(e, 'x.test.ts')
    return fn()
  } finally {
    for (const e of effects) VERIFIED_MOVE_EFFECTS.delete(e)
  }
}

const GARDEVOIR = 'SPECIES_GARDEVOIR'
const CALM_MIND = 'MOVE_CALM_MIND'

describe('cycle 112 wide pool gate', () => {
  it('starts with nothing verified', () => {
    expect(VERIFIED_MOVE_EFFECTS.size).toBe(0)
  })

  it('default pool is unchanged and keeps every learnable whitelist move', () => {
    for (const sp of [GARDEVOIR, 'SPECIES_GARCHOMP', 'SPECIES_BLISSEY']) {
      const learn = learnable(sp)
      const pool = candidateMoves(data, sp, LEVEL)
      expect(pool.length).toBeGreaterThan(0)
      expect(candidateMoves(data, sp, LEVEL, 40, { wide: false })).toEqual(pool)
      for (const m of learn) {
        if (UTILITY_MOVES.has(m) && data.dataContext.move(m)) expect(pool).toContain(m)
      }
      const tail = pool.slice(pool.length - [...learn].filter((m) => UTILITY_MOVES.has(m) && data.dataContext.move(m)).length)
      expect(tail.every((m) => UTILITY_MOVES.has(m))).toBe(true)
    }
  })

  it('wide with nothing verified drops gated whitelist moves but keeps damaging ones', () => {
    expect(learnable(GARDEVOIR).has(CALM_MIND)).toBe(true)
    expect(gated(CALM_MIND)).toBe(true)
    const narrow = candidateMoves(data, GARDEVOIR, LEVEL)
    const wide = candidateMoves(data, GARDEVOIR, LEVEL, 40, { wide: true })
    expect(narrow).toContain(CALM_MIND)
    expect(wide).not.toContain(CALM_MIND)
    const damaging = narrow.filter((m) => !gated(m))
    expect(damaging.length).toBeGreaterThan(0)
    for (const m of damaging) expect(wide).toContain(m)
    expect(wide.every((m) => !gated(m))).toBe(true)
  })

  it('a verified effect admits the move after every damaging non-whitelist move', async () => {
    const effect = effectOf(CALM_MIND)
    const wide = await withVerified([effect], () => candidateMoves(data, GARDEVOIR, LEVEL, 40, { wide: true }))
    expect(wide).toContain(CALM_MIND)
    const at = wide.indexOf(CALM_MIND)
    wide.forEach((m, i) => {
      if (!gated(m) && !UTILITY_MOVES.has(m)) expect(i).toBeLessThan(at)
    })
    expect(new Set(wide).size).toBe(wide.length)
    const eligibleGated = wide.filter((m) => gated(m))
    expect(eligibleGated.every((m) => effectOf(m) === effect)).toBe(true)
  })

  it('an unverified effect stays out while another effect is verified', async () => {
    const effect = effectOf(CALM_MIND)
    const other = [...learnable(GARDEVOIR)].find(
      (m) => data.dataContext.move(m) && gated(m) && effectOf(m) !== effect && !UTILITY_MOVES.has(m),
    )
    expect(other).toBeDefined()
    const wide = await withVerified([effect], () => candidateMoves(data, GARDEVOIR, LEVEL, 40, { wide: true }))
    expect(wide).not.toContain(other)
    expect(wide).toContain(CALM_MIND)
  })

  it('a null-effect gated move is keyed NONE', async () => {
    const nullEffect = [...data.movesById.values()].filter((m) => !m.effect && (!m.power || m.power <= 1))
    expect(nullEffect.length).toBeGreaterThan(0)
    const target = nullEffect.find((m) => {
      for (const sp of data.speciesById.keys()) if (learnable(sp, 100).has(m.id)) return true
      return false
    })
    const obj = move((target ?? nullEffect[0]).id)
    expect(isGatedMove(obj)).toBe(true)
    expect(isEligibleMove(obj)).toBe(false)
    await withVerified(['NONE'], () => expect(isEligibleMove(obj)).toBe(true))
    expect(isEligibleMove(obj)).toBe(false)

    if (target) {
      let species = ''
      for (const sp of data.speciesById.keys()) {
        if (learnable(sp, 100).has(target.id) && !UTILITY_MOVES.has(target.id)) {
          species = sp
          break
        }
      }
      if (species) {
        expect(candidateMoves(data, species, 100, 40, { wide: true })).not.toContain(target.id)
        const wide = await withVerified(['NONE'], () => candidateMoves(data, species, 100, 40, { wide: true }))
        expect(wide).toContain(target.id)
      }
    }
  })

  it('damaging moves are never gated, even with a null effect', () => {
    const dmgNull = [...data.movesById.values()].filter((m) => !m.effect && m.power > 1)
    expect(dmgNull.length).toBeGreaterThan(0)
    for (const m of dmgNull) {
      expect(isGatedMove(move(m.id))).toBe(false)
      expect(isEligibleMove(move(m.id))).toBe(true)
    }
    const wide = candidateMoves(data, GARDEVOIR, LEVEL, 40, { wide: true })
    for (const m of learnable(GARDEVOIR)) {
      const d = data.dataContext.move(m)
      if (d && !d.effect && d.power > 1 && !UTILITY_MOVES.has(m)) {
        const narrow = candidateMoves(data, GARDEVOIR, LEVEL)
        if (narrow.includes(m)) expect(wide).toContain(m)
      }
    }
  })

  it('power 1 is gated and power 2 is not', () => {
    expect(isGatedMove({ power: 1, effect: 'EFFECT_X' })).toBe(true)
    expect(isGatedMove({ power: 2, effect: null })).toBe(false)
    expect(isGatedMove({ power: 0, effect: null })).toBe(true)
  })

  it('neighbours only differ under wide by the dropped whitelist status moves', () => {
    const stones = new Set<string>()
    const team = [defaultSet(data, GARDEVOIR, LEVEL, stones)]
    expect(defaultSet(data, GARDEVOIR, LEVEL, stones, true)).toEqual(team[0])
    const base = neighbours(data, team, 0, stones)
    expect(neighbours(data, team, 0, stones, false).length).toBe(base.length)
    const pool = candidateMoves(data, GARDEVOIR, LEVEL)
    const dropped = pool.filter((m) => gated(m) && !team[0].moves.includes(m)).length
    expect(dropped).toBeGreaterThan(0)
    expect(neighbours(data, team, 0, stones, true).length).toBe(base.length - dropped * 4)
  })

  // replaced by the auditAllowlist.ts import in cycle 136
  const ALLOWLISTED_EFFECTS = new Set<string>()

  it.skip('every gated move effect key is verified or allowlisted', () => {
    const missing = new Set<string>()
    for (const m of data.movesById.values()) {
      if (m.power && m.power > 1) continue
      const key: string = m.effect ?? 'NONE'
      if (!VERIFIED_MOVE_EFFECTS.has(key) && !ALLOWLISTED_EFFECTS.has(key)) missing.add(key)
    }
    expect([...missing]).toEqual([])
  })
})
