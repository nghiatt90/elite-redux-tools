import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baseTypeEffectiveness, calcTypeEffectiveness, distinctDefendingTypes, getTypeModifier, type TypeChart, type TypeModifierInputs } from './typeEffectiveness'
import { uq } from './fixed'

const TYPES_PATH = fileURLToPath(new URL('../../../data/v2.65beta/types.json', import.meta.url))
const chart: TypeChart = JSON.parse(readFileSync(TYPES_PATH, 'utf-8'))
const INVERSE_TYPES_PATH = fileURLToPath(new URL('../../../data/v2.65beta/typesInverse.json', import.meta.url))
const inverseChart: TypeChart = JSON.parse(readFileSync(INVERSE_TYPES_PATH, 'utf-8'))

describe('baseTypeEffectiveness', () => {
  it('reads the real chart', () => {
    expect(chart['FIRE']['GRASS']).toBe(2.0)
    expect(baseTypeEffectiveness('FIRE', 'GRASS', chart)).toBe(uq(2.0))
  })

  it('neutral is 1.0', () => {
    expect(baseTypeEffectiveness('NORMAL', 'NORMAL', chart)).toBe(uq(1.0))
  })

  it('immunity is 0', () => {
    expect(chart['NORMAL']['GHOST']).toBe(0)
    expect(baseTypeEffectiveness('NORMAL', 'GHOST', chart)).toBe(0)
  })
})

describe('distinctDefendingTypes', () => {
  it('single-type defender', () => {
    expect(distinctDefendingTypes(['FIRE'])).toEqual(['FIRE'])
  })

  it('dual-type defender', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING'])).toEqual(['FIRE', 'FLYING'])
  })

  it('drops a duplicate second type', () => {
    expect(distinctDefendingTypes(['FIRE', 'FIRE'])).toEqual(['FIRE'])
  })

  it('a real third type is kept when distinct from the first two', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING', 'DRAGON'])).toEqual(['FIRE', 'FLYING', 'DRAGON'])
  })

  it('MYSTERY (no third type) is dropped', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING', 'MYSTERY'])).toEqual(['FIRE', 'FLYING'])
  })
})

describe('calcTypeEffectiveness', () => {
  it('single-type: matches the chart directly', () => {
    expect(calcTypeEffectiveness('WATER', ['FIRE'], chart)).toBe(uq(2.0))
  })

  it('dual-type: three separate rounding steps, not one product -- Ground vs Steel/Flying', () => {
    // Ground is 2x vs Steel, 0x vs Flying -- an immune combination regardless of order.
    expect(chart['GROUND']['STEEL']).toBe(2.0)
    expect(chart['GROUND']['FLYING']).toBe(0)
    expect(calcTypeEffectiveness('GROUND', ['STEEL', 'FLYING'], chart)).toBe(0)
  })

  it('dual-type 4x case folds through two mulModifier calls', () => {
    // Fire is 2x vs Grass and 2x vs Bug (e.g. vs a Grass/Bug defender) -> 4x overall.
    expect(chart['FIRE']['GRASS']).toBe(2.0)
    expect(chart['FIRE']['BUG']).toBe(2.0)
    expect(calcTypeEffectiveness('FIRE', ['GRASS', 'BUG'], chart)).toBe(uq(4.0))
  })

  it('a Ground move whiffs on a non-grounded defender even if the chart says otherwise', () => {
    // Ground vs pure Normal is neutral (1x) on the chart, but a non-grounded Normal
    // defender (hypothetically airborne/Levitate) is still immune to Ground moves --
    // src/battle_util.c:7973-7977, applied after the chart fold.
    expect(chart['GROUND']['NORMAL']).toBe(1.0)
    expect(calcTypeEffectiveness('GROUND', ['NORMAL'], chart, false)).toBe(0)
  })

  it('grounded defenders are unaffected by the levitation check', () => {
    expect(calcTypeEffectiveness('GROUND', ['NORMAL'], chart, true)).toBe(uq(1.0))
  })

  it('non-Ground moves ignore groundedness entirely', () => {
    expect(calcTypeEffectiveness('WATER', ['FIRE'], chart, false)).toBe(uq(2.0))
  })

  it('unspecified opposing pairs default to neutral, matching the chart lookup fallback', () => {
    // every real (attack, defense) pair is present in the emitted chart, but the
    // fallback exists for robustness against a malformed/partial chart at runtime.
    expect(baseTypeEffectiveness('NOT_A_TYPE', 'ALSO_NOT_A_TYPE', chart)).toBe(uq(1.0))
  })

  it("Ring Target neutralizes only the IMMUNE component, keeping the other type's own multiplier (not a flat neutral)", () => {
    // Electric vs Ground/Flying: 0 (immune) * 2.0 (super effective) = 0 without Ring
    // Target. With it, the Ground component alone is forced to 1.0 -- the fold
    // continues as 1.0 * 2.0 = 2.0 (still super effective), not flattened to 1.0.
    expect(calcTypeEffectiveness('ELECTRIC', ['GROUND', 'FLYING'], chart)).toBe(0)
    expect(calcTypeEffectiveness('ELECTRIC', ['GROUND', 'FLYING'], chart, true, true)).toBe(uq(2.0))
  })

  it('Ring Target does nothing when nothing was immune in the first place', () => {
    expect(calcTypeEffectiveness('FIRE', ['GRASS', 'BUG'], chart, true, true)).toBe(uq(4.0))
  })

  it("Ring Target does not affect the SEPARATE non-grounded Ground-move immunity check", () => {
    expect(calcTypeEffectiveness('GROUND', ['NORMAL'], chart, false, true)).toBe(0)
  })
})

describe('getTypeModifier', () => {
  const noToggles: TypeModifierInputs = { isInverseRoomActive: false, isInverseBattleFlagSet: false, attackerHasMiracleEye: false, defenderHasMiracleEye: false }

  it('with nothing active, matches the forward chart', () => {
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, noToggles)).toBe(uq(2.0))
  })

  it('Inverse Room alone selects the inverse chart', () => {
    expect(chart['FIRE']['GRASS']).toBe(2.0)
    expect(inverseChart['FIRE']['GRASS']).toBe(0.5)
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, isInverseRoomActive: true })).toBe(uq(0.5))
  })

  it('B_FLAG_INVERSE_BATTLE alone also selects the inverse chart', () => {
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, isInverseBattleFlagSet: true })).toBe(uq(0.5))
  })

  it('Inverse Room AND the battle flag together XOR back to the forward chart (not stacking to double-inverse)', () => {
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, isInverseRoomActive: true, isInverseBattleFlagSet: true })).toBe(uq(2.0))
  })

  it("either battler's Miracle Eye alone also flips to the inverse chart", () => {
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, attackerHasMiracleEye: true })).toBe(uq(0.5))
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, defenderHasMiracleEye: true })).toBe(uq(0.5))
  })

  it('BOTH battlers having Miracle Eye XORs back to the forward chart', () => {
    expect(getTypeModifier('FIRE', 'GRASS', chart, inverseChart, { ...noToggles, attackerHasMiracleEye: true, defenderHasMiracleEye: true })).toBe(uq(2.0))
  })

  it('Dark vs Psychic is forced to 0 whenever EITHER battler has Miracle Eye, regardless of the resulting inversion state', () => {
    // Forward chart: Dark is 2x vs Psychic. Inverse chart: 0.5x. Miracle Eye forces a
    // flat 0 in EITHER case -- battle_util.c:8035, ported verbatim even though this
    // looks backwards for what Miracle Eye conventionally does.
    expect(chart['DARK']['PSYCHIC']).toBe(2.0)
    expect(inverseChart['DARK']['PSYCHIC']).toBe(0.5)
    expect(getTypeModifier('DARK', 'PSYCHIC', chart, inverseChart, { ...noToggles, attackerHasMiracleEye: true })).toBe(0)
    expect(getTypeModifier('DARK', 'PSYCHIC', chart, inverseChart, { ...noToggles, defenderHasMiracleEye: true, isInverseRoomActive: true })).toBe(0)
  })

  it('the Dark/Psychic special case does not apply without Miracle Eye, even under Inverse Room', () => {
    expect(getTypeModifier('DARK', 'PSYCHIC', chart, inverseChart, { ...noToggles, isInverseRoomActive: true })).toBe(uq(0.5))
  })

  it('the Dark/Psychic special case is direction-specific -- Psychic attacking Dark is untouched by it', () => {
    // Psychic is a flat 0 (immune) vs Dark on the forward chart but 2.0 on the
    // inverse one -- attackerHasMiracleEye still flips the chart selection via the
    // XOR (Miracle Eye isn't ONLY the special-case gate), so the expected value here
    // is the INVERSE chart's own Psychic-vs-Dark entry, not 0 -- proving the special
    // case itself (which only fires for atkType===DARK) never kicks in for this
    // attack/defend order.
    expect(chart['PSYCHIC']['DARK']).toBe(0)
    expect(inverseChart['PSYCHIC']['DARK']).toBe(2.0)
    expect(getTypeModifier('PSYCHIC', 'DARK', chart, inverseChart, { ...noToggles, attackerHasMiracleEye: true })).toBe(uq(2.0))
  })
})
