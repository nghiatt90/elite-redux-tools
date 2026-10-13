import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ACCURACY_PRIORITY, ACCURACY_STAGE_RATIOS, UNPORTED_ACCURACY_ABILITIES, getTotalAccuracy } from './accuracy'
import type { AccuracyInputs } from './accuracy'
import type { AbilitySlots } from '../abilities/dispatch'

// Real-id verification, per this batch's own discipline: every move/ability
// id a test asserts on below is checked against the committed snapshot
// first, so a typo reads as a loud failure here rather than a silently
// passing test against a nonexistent id.
const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const moveIds = new Set(snapshot<Array<{ id: string }>>('moves.json').map((m) => m.id))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
function requireMove(id: string): string {
  if (!moveIds.has(id)) throw new Error(`moves.json has no ${id}`)
  return id
}
function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

describe('real ids used below exist in the snapshot', () => {
  it('moves', () => {
    for (const id of [
      'MOVE_TACKLE',
      'MOVE_SHEER_COLD',
      'MOVE_BLIZZARD',
      'MOVE_EERIE_SPELL',
      'MOVE_VEXING_VOID',
      'MOVE_THUNDER',
      'MOVE_HURRICANE',
      'MOVE_SING',
      'MOVE_HYPNOSIS',
      'MOVE_FOCUS_BLAST',
    ])
      requireMove(id)
  })
  it('abilities, including every UNPORTED_ACCURACY_ABILITIES entry', () => {
    for (const id of UNPORTED_ACCURACY_ABILITIES) requireAbility(id)
    requireAbility('ABILITY_UNAWARE')
    requireAbility('ABILITY_AURORA_BOREALIS')
  })
})

const NO_SLOTS: AbilitySlots = { ability: null, innates: [null, null, null] }

/** Neutral inputs: no statuses, no items, no weather, a 100-accuracy Normal
 * move on a Normal attacker vs. a Normal defender, stages neutral. Every test
 * overrides only the fields its branch reads. */
function baseInputs(overrides: Partial<AccuracyInputs> = {}): AccuracyInputs {
  return {
    moveId: requireMove('MOVE_TACKLE'),
    moveAccuracy: 100,
    moveEffect: null,
    moveType: 'NORMAL',
    moveFlagStatStagesIgnored: false,
    moveFlagDmgInAir: false,
    moveFlagDmgTwoXInAir: false,
    moveFlagDmgUnderground: false,
    moveFlagDmgUnderwater: false,

    attackerTypes: ['NORMAL'],
    attackerTrepidationNonzero: false,
    attackerHoldEffect: null,
    attackerHoldEffectParam: 0,
    attackerAccStage: 6,
    attackerAbilitySlots: NO_SLOTS,
    attackerActsAfterDefender: false,
    attackerUsedMicleBerry: false,
    myceliumMightActive: false,

    defenderHoldEffect: null,
    defenderHoldEffectParam: 0,
    defenderEvasionStage: 6,
    defenderHasForesight: false,
    defenderHasAlwaysHits: false,
    battlerWithSureHitIsAttacker: false,
    defenderHasTelekinesis: false,
    defenderIsGrounded: true,
    defenderHasPhantomForce: false,
    defenderIsOnAir: false,
    defenderIsUnderground: false,
    defenderIsUnderwater: false,
    defenderSmokescreenActive: false,
    defenderAbilitySlots: NO_SLOTS,

    weather: 'NONE',
    gravityActive: false,
    ...overrides,
  }
}

/** The IsStatDropBlocked gap (see accuracy.ts's header) is unconditional --
 * every result carries it. Tests that don't care about the exact gap list
 * strip it first so their own assertions read as the branch under test, not
 * as a repeat of this one structural fact. */
const STAT_DROP_BLOCKED_GAP = {
  field: 'attackerAccuracyDropBlockedSpecific',
  reason: 'NO_SOURCE',
  detail: 'IsStatDropBlocked(battlerAtk, STAT_ACC, FALSE) == STAT_DROP_BLOCK_SPECIFIC needs the onBlockStatDrops ability hook chain, which has no type, dispatch or registry entry anywhere in web/src/engine/abilities/; treated as false',
}
function otherGaps(gaps: { field: string }[]) {
  return gaps.filter((g) => g.field !== 'attackerAccuracyDropBlockedSpecific')
}

describe('AccuracyPriority ladder ordering, include/abilities.hh:74-81', () => {
  it('is six values in the C-declared order', () => {
    expect(ACCURACY_PRIORITY).toEqual({
      NO_RESULT: 0,
      MULTIPLICATIVE: 1,
      ADDITIVE: 2,
      HITS_IF_POSSIBLE: 3,
      ALWAYS_MISSES: 4,
      ALWAYS_HITS: 5,
    })
  })
})

describe('gAccuracyStageRatios, battle_script_commands.c:651-664', () => {
  it('has 13 entries, -6 (index 0) matching the C table', () => {
    expect(ACCURACY_STAGE_RATIOS).toHaveLength(13)
    expect(ACCURACY_STAGE_RATIOS[0]).toEqual([1, 3])
    expect(ACCURACY_STAGE_RATIOS[12]).toEqual([3, 1])
    expect(ACCURACY_STAGE_RATIOS[6]).toEqual([1, 1])
  })
})

describe('the 101 sentinel branches, :1262-1265', () => {
  it('Lock-On (ALWAYS_HITS) against the battler that used it: 101', () => {
    const result = getTotalAccuracy(baseInputs({ defenderHasAlwaysHits: true, battlerWithSureHitIsAttacker: true }))
    expect(result.accuracy).toBe(101)
  })

  it('STATUS3_ALWAYS_HITS set but NOT against this attacker: no sentinel (Lock-On is battler-specific)', () => {
    const result = getTotalAccuracy(baseInputs({ defenderHasAlwaysHits: true, battlerWithSureHitIsAttacker: false }))
    expect(result.accuracy).not.toBe(101)
  })

  it('Telekinesis on an ungrounded defender: 101', () => {
    const result = getTotalAccuracy(baseInputs({ defenderHasTelekinesis: true, defenderIsGrounded: false }))
    expect(result.accuracy).toBe(101)
  })

  it('Telekinesis on a GROUNDED defender: no sentinel', () => {
    const result = getTotalAccuracy(baseInputs({ defenderHasTelekinesis: true, defenderIsGrounded: true }))
    expect(result.accuracy).not.toBe(101)
  })

  it('Toxic from a Poison-type attacker: 101 (B_TOXIC_NEVER_MISS, fixed config)', () => {
    const result = getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_TOXIC', attackerTypes: ['POISON'] }))
    expect(result.accuracy).toBe(101)
  })

  it('Toxic from a non-Poison attacker: no sentinel', () => {
    const result = getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_TOXIC', attackerTypes: ['NORMAL'] }))
    expect(result.accuracy).not.toBe(101)
  })

  it('Mycelium Might active: 101', () => {
    const result = getTotalAccuracy(baseInputs({ myceliumMightActive: true }))
    expect(result.accuracy).toBe(101)
  })
})

describe('semi-invulnerability, :1267-1275 (moveState == NULL -> ACCURACY_ALWAYS_MISSES -> 0)', () => {
  it('Phantom Force: always 0, no flag can bypass it', () => {
    const result = getTotalAccuracy(baseInputs({ defenderHasPhantomForce: true, moveFlagDmgInAir: true, moveFlagDmgTwoXInAir: true }))
    expect(result.accuracy).toBe(0)
  })

  it('on-air defender, move with NEITHER air flag: 0', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsOnAir: true }))
    expect(result.accuracy).toBe(0)
  })

  it('on-air defender, move with ONLY FLAG_DMG_IN_AIR (e.g. Thunder): still 0 -- the C ORs two independently-negated clauses, so having one flag but not the other does not bypass', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsOnAir: true, moveFlagDmgInAir: true, moveFlagDmgTwoXInAir: false }))
    expect(result.accuracy).toBe(0)
  })

  it('on-air defender, move with ONLY FLAG_DMG_2X_IN_AIR (e.g. Gust): still 0, same reasoning', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsOnAir: true, moveFlagDmgInAir: false, moveFlagDmgTwoXInAir: true }))
    expect(result.accuracy).toBe(0)
  })

  it('on-air defender, move with BOTH air flags: bypasses the always-miss (falls through to normal accuracy math)', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsOnAir: true, moveFlagDmgInAir: true, moveFlagDmgTwoXInAir: true }))
    expect(result.accuracy).toBe(100)
  })

  it('underground defender, move without FLAG_DMG_UNDERGROUND: 0', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsUnderground: true }))
    expect(result.accuracy).toBe(0)
  })

  it('underground defender, move WITH FLAG_DMG_UNDERGROUND (e.g. Earthquake): bypasses', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsUnderground: true, moveFlagDmgUnderground: true }))
    expect(result.accuracy).toBe(100)
  })

  it('underwater defender, move without FLAG_DMG_UNDERWATER: 0', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsUnderwater: true }))
    expect(result.accuracy).toBe(0)
  })

  it('underwater defender, move WITH FLAG_DMG_UNDERWATER (e.g. Surf): bypasses', () => {
    const result = getTotalAccuracy(baseInputs({ defenderIsUnderwater: true, moveFlagDmgUnderwater: true }))
    expect(result.accuracy).toBe(100)
  })
})

describe('Trepidation, :1277-1282', () => {
  it('trepidation nonzero + Psychic-type move: 0', () => {
    const result = getTotalAccuracy(baseInputs({ attackerTrepidationNonzero: true, moveType: 'PSYCHIC' }))
    expect(result.accuracy).toBe(0)
  })

  it('trepidation nonzero + a non-Psychic move: no effect', () => {
    const result = getTotalAccuracy(baseInputs({ attackerTrepidationNonzero: true, moveType: 'NORMAL' }))
    expect(result.accuracy).toBe(100)
  })

  it('no trepidation + Psychic move: no effect', () => {
    const result = getTotalAccuracy(baseInputs({ attackerTrepidationNonzero: false, moveType: 'PSYCHIC' }))
    expect(result.accuracy).toBe(100)
  })
})

describe('ACCURACY_HITS_IF_POSSIBLE exceptions, :1286-1331', () => {
  it('moveAccuracy 0 (e.g. Swift-class): 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveAccuracy: 0 })).accuracy).toBe(101)
  })

  it('EFFECT_THUNDER in rain: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_THUNDER'), moveEffect: 'EFFECT_THUNDER', weather: 'RAIN_TEMPORARY' })).accuracy).toBe(101)
  })

  it('EFFECT_THUNDER without rain: not the sentinel', () => {
    expect(getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_THUNDER'), moveEffect: 'EFFECT_THUNDER', weather: 'NONE' })).accuracy).not.toBe(101)
  })

  it('EFFECT_LEECH_SEED from a Grass-type attacker: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_LEECH_SEED', attackerTypes: ['GRASS'] })).accuracy).toBe(101)
  })

  it('EFFECT_WILL_O_WISP from a Fire-type attacker: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_WILL_O_WISP', attackerTypes: ['FIRE'] })).accuracy).toBe(101)
  })

  it('EFFECT_PARALYZE from an Electric-type attacker: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_PARALYZE', attackerTypes: ['ELECTRIC'] })).accuracy).toBe(101)
  })

  it('EFFECT_FROSTBITE from an Ice-type attacker: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_FROSTBITE', attackerTypes: ['ICE'] })).accuracy).toBe(101)
  })

  it('EFFECT_TOXIC from a Poison attacker is unreachable here -- it already returned 101 at the :1264 early branch before this switch runs', () => {
    // Covered by the "101 sentinel" describe block above; this test documents
    // WHY there's no separate assertion for the :1300-1301 case arm.
    const result = getTotalAccuracy(baseInputs({ moveEffect: 'EFFECT_TOXIC', attackerTypes: ['POISON'] }))
    expect(result.accuracy).toBe(101)
  })

  it('MOVE_SHEER_COLD in hail: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_SHEER_COLD'), moveAccuracy: 30, weather: 'HAIL' })).accuracy).toBe(101)
  })

  it('MOVE_SHEER_COLD without hail: not the sentinel', () => {
    expect(getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_SHEER_COLD'), moveAccuracy: 30, weather: 'NONE' })).accuracy).not.toBe(101)
  })

  it('MOVE_BLIZZARD without hail but attacker holds Aurora Borealis: 101 (HasAuroraBorealis, battle_util.c:9345-9348)', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_AURORA_BOREALIS'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_BLIZZARD'), moveAccuracy: 70, weather: 'NONE', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('MOVE_BLIZZARD: Aurora Borealis on the DEFENDER does not trigger it (the C checks battlerAtk only)', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_AURORA_BOREALIS'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_BLIZZARD'), moveAccuracy: 70, weather: 'NONE', defenderAbilitySlots: slots }))
    expect(result.accuracy).not.toBe(101)
  })

  it('MOVE_EERIE_SPELL in fog: 101', () => {
    expect(getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_EERIE_SPELL'), moveAccuracy: 100, weather: 'FOG' })).accuracy).toBe(101)
  })
})

describe('Thunder/Hurricane/Eerie Spell/Vexing Void accuracy drop to 50 in sun, :1349-1352', () => {
  it('EFFECT_HURRICANE in sun becomes moveAcc=50 before the stage math', () => {
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_HURRICANE'), moveEffect: 'EFFECT_HURRICANE', moveAccuracy: 70, weather: 'SUN_PERMANENT' }))
    // Neutral stages (ratio 1:1) and no other multiplier -> the forced 50 passes through unchanged.
    expect(result.accuracy).toBe(50)
  })

  it('EFFECT_HURRICANE without sun keeps its own accuracy', () => {
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_HURRICANE'), moveEffect: 'EFFECT_HURRICANE', moveAccuracy: 70, weather: 'NONE' }))
    expect(result.accuracy).toBe(70)
  })
})

describe('stat stages, :1333-1347 -- both ends of the table and the neutral point', () => {
  it('neutral vs neutral (index 6, ratio 1:1): accuracy unchanged', () => {
    expect(getTotalAccuracy(baseInputs({ attackerAccStage: 6, defenderEvasionStage: 6 })).accuracy).toBe(100)
  })

  it('max accuracy stage (+6, index 12) vs neutral evasion: buff clamps to the table max, ratio 3:1', () => {
    // buff = accStage(12) + 6 - evasion(6) = 12 -- already the table's last index (12), so no clamping happens here; asserts the top end directly.
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 30, attackerAccStage: 12, defenderEvasionStage: 6 }))
    expect(result.accuracy).toBe(90) // 30 * 3/1 = 90
  })

  it('min accuracy stage (0, i.e. -6) vs neutral evasion: ratio 1:3', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 0, defenderEvasionStage: 6 }))
    expect(result.accuracy).toBe(30) // 90 * 1/3 = 30
  })

  it('buff below 0 clamps to index 0 (a defender-evasion-heavy scenario driving accStage+6-evasion negative)', () => {
    // accStage(0) + 6 - evasion(12) = -6 -> clamps to 0 (ratio 1:3), matching the min-stage case above exactly.
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 0, defenderEvasionStage: 12 }))
    expect(result.accuracy).toBe(30)
  })

  it('buff above 12 clamps to index 12 (an accuracy-heavy attacker against negative defender evasion)', () => {
    // accStage(12) + 6 - evasion(0) = 18 -> clamps to 12 (ratio 3:1), matching the max-stage case above exactly.
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 30, attackerAccStage: 12, defenderEvasionStage: 0 }))
    expect(result.accuracy).toBe(90)
  })
})

describe('Foresight bypasses evasion entirely, STATUS4_FORESIGHT :1341-1344', () => {
  it('Foresight set: only the attacker accuracy stage is used, evasion stage is ignored outright', () => {
    // buff = accStage(0) alone = 0 -> ratio 1:3, even though defender evasion is maxed at 12.
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 0, defenderEvasionStage: 12, defenderHasForesight: true }))
    expect(result.accuracy).toBe(30)
  })
})

describe('evasion clamping, :1336-1339', () => {
  it('FLAG_STAT_STAGES_IGNORED (e.g. Aerial Ace) clamps a POSITIVE evasion boost down to neutral', () => {
    // Without the flag: accStage(6)+6-evasion(12) = 0 -> ratio 1:3 -> 90*1/3=30.
    // With the flag: evasion clamped to 6 -> buff = 6 -> ratio 1:1 -> 90.
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 6, defenderEvasionStage: 12, moveFlagStatStagesIgnored: true }))
    expect(result.accuracy).toBe(90)
  })

  it('FLAG_STAT_STAGES_IGNORED does NOT raise a NEGATIVE evasion stage -- min() only ever clamps down', () => {
    // accStage(6)+6-evasion(0)=12 -> ratio 3:1 -> 30*3/1=90, same with or without the flag (min(0,6)=0, unchanged).
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 30, attackerAccStage: 6, defenderEvasionStage: 0, moveFlagStatStagesIgnored: true }))
    expect(result.accuracy).toBe(90)
  })

  it('attacker Unaware (real port, abilities/dispatchCalc.hasFlag) also clamps evasion to neutral', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_UNAWARE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 6, defenderEvasionStage: 12, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(90)
  })

  it('a battler WITHOUT Unaware gets no such clamp', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 90, attackerAccStage: 6, defenderEvasionStage: 12, attackerAbilitySlots: NO_SLOTS }))
    expect(result.accuracy).toBe(30)
  })
})

describe('defender hold effects, :1376', () => {
  it('HOLD_EFFECT_EVASION_UP reduces accuracy by its param percent', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, defenderHoldEffect: 'HOLD_EFFECT_EVASION_UP', defenderHoldEffectParam: 10 }))
    expect(result.accuracy).toBe(90) // 100 * (100-10)/100
  })
})

describe('attacker hold effects, :1378-1381', () => {
  it('HOLD_EFFECT_WIDE_LENS boosts accuracy by its param percent, unconditionally', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 80, attackerHoldEffect: 'HOLD_EFFECT_WIDE_LENS', attackerHoldEffectParam: 10, attackerActsAfterDefender: false }))
    expect(result.accuracy).toBe(88) // 80 * 110/100
  })

  it('HOLD_EFFECT_ZOOM_LENS boosts accuracy only when the attacker acts AFTER the defender', () => {
    const acting = getTotalAccuracy(baseInputs({ moveAccuracy: 80, attackerHoldEffect: 'HOLD_EFFECT_ZOOM_LENS', attackerHoldEffectParam: 10, attackerActsAfterDefender: true }))
    expect(acting.accuracy).toBe(88)
    const notActing = getTotalAccuracy(baseInputs({ moveAccuracy: 80, attackerHoldEffect: 'HOLD_EFFECT_ZOOM_LENS', attackerHoldEffectParam: 10, attackerActsAfterDefender: false }))
    expect(notActing.accuracy).toBe(80)
  })
})

describe('Micle Berry, :1383-1389', () => {
  it('used: +20% (the non-Ripen branch -- HasRipenEffect has no port) and reports the Ripen gap', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 50, attackerUsedMicleBerry: true }))
    expect(result.accuracy).toBe(60) // 50 * 120/100
    expect(otherGaps(result.gaps)).toContainEqual({
      field: 'attackerUsedMicleBerry',
      reason: 'NO_SOURCE',
      detail: "HasRipenEffect(battlerAtk) needs the `ripen` ability flag, which AbilityFlags does not declare; Micle Berry's boost was computed as +20% (no Ripen) rather than the +40% Ripen would give",
    })
  })

  it('not used: no boost, no Ripen gap', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 50, attackerUsedMicleBerry: false }))
    expect(result.accuracy).toBe(50)
    expect(otherGaps(result.gaps).some((g) => g.field === 'attackerUsedMicleBerry')).toBe(false)
  })
})

describe('Gravity, :1391', () => {
  it('multiplies accuracy by 5/3, truncating', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 60, gravityActive: true }))
    expect(result.accuracy).toBe(100) // min(60*5/3, 100) = min(100,100)
  })

  it('truncates toward zero rather than rounding', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 59, gravityActive: true }))
    expect(result.accuracy).toBe(Math.trunc((59 * 5) / 3)) // 98, not 98.33
  })
})

describe('Smokescreen (side timer), :1393', () => {
  it('multiplies accuracy by 0.75', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, defenderSmokescreenActive: true }))
    expect(result.accuracy).toBe(75)
  })
})

describe('final cap, :1395', () => {
  it('never exceeds 100 even when every boost stacks', () => {
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 100,
        attackerAccStage: 12,
        defenderEvasionStage: 0,
        attackerHoldEffect: 'HOLD_EFFECT_WIDE_LENS',
        attackerHoldEffectParam: 50,
      }),
    )
    expect(result.accuracy).toBe(100)
  })
})

describe('gap cases -- IsStatDropBlocked, structural and unconditional', () => {
  it('every call carries the IsStatDropBlocked gap exactly once', () => {
    const result = getTotalAccuracy(baseInputs())
    expect(result.gaps).toEqual([STAT_DROP_BLOCKED_GAP])
  })
})

describe('gap cases -- unported onAccuracy abilities, :1354-1362', () => {
  it('an unported ability on defender (Commander) is named in a gap', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_COMMANDER'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ defenderAbilitySlots: slots }))
    expect(otherGaps(result.gaps)).toContainEqual({
      field: 'defenderAbilitySlots',
      reason: 'NO_SOURCE',
      detail: "ABILITY_COMMANDER's onAccuracy hook has no port",
    })
  })

  it('an unported ability on attacker (Commander) is named in a gap', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_COMMANDER'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ attackerAbilitySlots: slots }))
    expect(otherGaps(result.gaps)).toContainEqual({
      field: 'attackerAbilitySlots',
      reason: 'NO_SOURCE',
      detail: "ABILITY_COMMANDER's onAccuracy hook has no port",
    })
  })

  it('an ability with NO onAccuracy hook (Torrent) produces no ability gap', () => {
    const slots: AbilitySlots = { ability: 'ABILITY_TORRENT', innates: [null, null, null] }
    expect(abilityIds.has('ABILITY_TORRENT')).toBe(true)
    const result = getTotalAccuracy(baseInputs({ attackerAbilitySlots: slots }))
    expect(otherGaps(result.gaps)).toEqual([])
  })

  it('an innate slot (not just the chosen ability) is scanned for unported abilities', () => {
    const slots: AbilitySlots = { ability: null, innates: [requireAbility('ABILITY_COMMANDER'), null, null] }
    const result = getTotalAccuracy(baseInputs({ defenderAbilitySlots: slots }))
    expect(otherGaps(result.gaps)).toContainEqual({
      field: 'defenderAbilitySlots',
      reason: 'NO_SOURCE',
      detail: "ABILITY_COMMANDER's onAccuracy hook has no port",
    })
  })

  it('UNPORTED_ACCURACY_ABILITIES has no duplicate ids', () => {
    expect(new Set(UNPORTED_ACCURACY_ABILITIES).size).toBe(UNPORTED_ACCURACY_ABILITIES.length)
  })
})

describe('UNPORTED_ACCURACY_ABILITIES oracle -- data/v2.65beta/abilityHooks.json', () => {
  const abilityHooks = snapshot<Record<string, { hooks?: Record<string, unknown> }>>('abilityHooks.json')

  // Abilities this module genuinely ports a real onAccuracy check for
  // (plus Aurora Borealis's check in the Hail exceptions path).
  const GENUINELY_PORTED = new Set([
    'ABILITY_ANGELS_WRATH',
    'ABILITY_ARTILLERY',
    'ABILITY_AURORA_BOREALIS',
    'ABILITY_BAD_LUCK',
    'ABILITY_BRAWLING_WYVERN',
    'ABILITY_CHANDELIER',
    'ABILITY_COMPOUND_EYES',
    'ABILITY_DEADEYE',
    'ABILITY_DEADLY_PRECISION',
    'ABILITY_DEPTH_EXPLORER',
    'ABILITY_ECHOLOCATION',
    'ABILITY_ENLIGHTENED',
    'ABILITY_FATAL_PRECISION',
    'ABILITY_FINAL_BLOW',
    'ABILITY_FLAWLESS_PRECISION',
    'ABILITY_GIFTED_MIND',
    'ABILITY_GLACIAL_GHOST',
    'ABILITY_GRIP_PINCER',
    'ABILITY_HUNTERS_MARK',
    'ABILITY_HUSTLE',
    'ABILITY_HYPNOTIC_TRANCE',
    'ABILITY_HYPNOTIST',
    'ABILITY_ILLUMINATE',
    'ABILITY_INNER_FOCUS',
    'ABILITY_IRON_BARRAGE',
    'ABILITY_KEEN_EYE',
    'ABILITY_LULLABY',
    'ABILITY_LUNAR_ECLIPSE',
    'ABILITY_MACH_3',
    'ABILITY_NO_GUARD',
    'ABILITY_OLE',
    'ABILITY_PIXIE_POWER',
    'ABILITY_PLASMA_LAMP',
    'ABILITY_QIGONG',
    'ABILITY_RADIANCE',
    'ABILITY_RAIN_SHROUD',
    'ABILITY_REFRIGERATOR',
    'ABILITY_ROUNDHOUSE',
    'ABILITY_SAND_VEIL',
    'ABILITY_SHINY_LIGHTNING',
    'ABILITY_SIGHTING_SYSTEM',
    'ABILITY_SMOKEY_MANEUVERS',
    'ABILITY_SNOW_CLOAK',
    'ABILITY_SUPER_SCOPE',
    'ABILITY_SWEEPING_EDGE',
    'ABILITY_SWEEPING_EDGE_PLUS',
    'ABILITY_UNLOCKED_POTENTIAL',
    'ABILITY_VICTORY_STAR',
    'ABILITY_WAY_OF_PRECISION',
    'ABILITY_WORLD_SERPENT',
  ])

  it('every ability declaring an onAccuracy hook is genuinely ported or in UNPORTED_ACCURACY_ABILITIES, and nothing extra is listed', () => {
    const withOnAccuracy = Object.entries(abilityHooks)
      .filter(([, entry]) => entry.hooks && 'onAccuracy' in entry.hooks)
      .map(([id]) => id)
      .sort()

    const expected = withOnAccuracy.filter((id) => !GENUINELY_PORTED.has(id))
    const actual = [...UNPORTED_ACCURACY_ABILITIES].sort()

    expect(actual).toEqual(expected)
  })
})

describe('Compound Eyes (1.3x multiplier), :663-666', () => {
  it('multiplies base move accuracy by 1.3: 70 * 1.3 = 91', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_COMPOUND_EYES'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(91)
  })

  it('multiplies base move accuracy by 1.3: 80 * 1.3 = 104, capped at 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_COMPOUND_EYES'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 80, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })
})

describe('onAccuracy loop order and suppression (battle_script_commands.c:1354-1362)', () => {
  const eyes: AbilitySlots = { ability: requireAbility('ABILITY_COMPOUND_EYES'), innates: [null, null, null] }
  const badLuck: AbilitySlots = { ability: requireAbility('ABILITY_BAD_LUCK'), innates: [null, null, null] }

  it('runs the lower battler index first: attacker first gives trunc(70*1.3)-5 = 86, defender first trunc(65*1.3) = 84', () => {
    const attackerFirst = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: eyes, defenderAbilitySlots: badLuck, attackerIndexFirst: true }))
    const defenderFirst = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: eyes, defenderAbilitySlots: badLuck, attackerIndexFirst: false }))
    expect(attackerFirst.accuracy).toBe(86)
    expect(defenderFirst.accuracy).toBe(84)
  })

  it('skips an ability IsSuppressed reports (Gastro Acid / Neutralizing Gas)', () => {
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: eyes, isAbilitySuppressed: () => true }))
    expect(result.accuracy).toBe(70)
  })
})

describe('No Guard (ALWAYS_HITS as attacker and defender, bypasses semi-invulnerability), :1611-1614', () => {
  it('attacker with No Guard returns 101 for a 70 accuracy move', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_NO_GUARD'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('attacker with No Guard hits semi-invulnerable target (defender on-air): prio 5 beats prio 4 -> returns 101', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_NO_GUARD'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderIsOnAir: true, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('defender with No Guard returns 101 when attacked with a 70 accuracy move', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_NO_GUARD'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('defender with No Guard on air still gets hit (returns 101)', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_NO_GUARD'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderIsOnAir: true, defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })
})

describe('Hustle (0.9x multiplier on physical and special damaging moves, exempts status), :1201-1204', () => {
  it('penalizes physical damaging moves: 100 * 0.9 = 90', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_HUSTLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveSplit: 'PHYSICAL', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(90)
  })

  it('ER deviation: penalizes special damaging moves too (CHECK_NOT(IS_MOVE_STATUS(move))): 100 * 0.9 = 90', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_HUSTLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveSplit: 'SPECIAL', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(90)
  })

  it('status moves are exempt from Hustle penalty: accuracy remains 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_HUSTLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveSplit: 'STATUS', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })
})

describe('Sand Veil (1.25x division in sandstorm, applies only on defender), :600-605', () => {
  it('defender with Sand Veil in sandstorm reduces 100 accuracy move to Math.trunc(100 / 1.25) = 80', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_SAND_VEIL'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'SANDSTORM', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(80)
  })

  it('defender with Sand Veil outside sandstorm does not reduce accuracy: 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_SAND_VEIL'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'NONE', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })

  it('attacker with Sand Veil does NOT reduce its own move accuracy (APPLY_ON_TARGET flag): 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_SAND_VEIL'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'SANDSTORM', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })
})

describe('Keen Eye (1.2x multiplier, does not ignore evasion stat boosts in onAccuracy), :1142-1145', () => {
  it('attacker with Keen Eye gets 1.2x accuracy boost: 70 * 1.2 = 84', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_KEEN_EYE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(84)
  })

  it('Keen Eye onAccuracy hook does NOT ignore defender evasion stage (+2 evasion -> ratio 2/3): Math.trunc(84 * 2 / 3) = 56', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_KEEN_EYE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderEvasionStage: 8, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(56)
  })
})

describe('Mold Breaker vs breakable defender abilities and Ability Shield, battle_util.c:9254-9261', () => {
  it('attacker with Mold Breaker bypasses breakable Sand Veil in sandstorm: 100 instead of 80', () => {
    const defSlots: AbilitySlots = { ability: requireAbility('ABILITY_SAND_VEIL'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 100,
        weather: 'SANDSTORM',
        attackerHasMoldBreaker: true,
        defenderAbilitySlots: defSlots,
      }),
    )
    expect(result.accuracy).toBe(100)
  })

  it('defender with Ability Shield blocks Mold Breaker suppression: Sand Veil still applies (80)', () => {
    const defSlots: AbilitySlots = { ability: requireAbility('ABILITY_SAND_VEIL'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 100,
        weather: 'SANDSTORM',
        attackerHasMoldBreaker: true,
        defenderHoldEffect: 'HOLD_EFFECT_ABILITY_SHIELD',
        defenderAbilitySlots: defSlots,
      }),
    )
    expect(result.accuracy).toBe(80)
  })

  it('attacker with Mold Breaker does NOT bypass No Guard (No Guard is not breakable): returns 101', () => {
    const defSlots: AbilitySlots = { ability: requireAbility('ABILITY_NO_GUARD'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 70,
        attackerHasMoldBreaker: true,
        defenderAbilitySlots: defSlots,
      }),
    )
    expect(result.accuracy).toBe(101)
  })

  it('attacker with Mold Breaker does NOT bypass Olé (Olé is not breakable): 100 * 0.8 = 80', () => {
    const defSlots: AbilitySlots = { ability: requireAbility('ABILITY_OLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 100,
        moveTarget: 'SELECTED',
        attackerHasMoldBreaker: true,
        defenderAbilitySlots: defSlots,
      }),
    )
    expect(result.accuracy).toBe(80)
  })
})

describe('Olé (0.8x multiplier against single-target moves, not breakable), :7557-7569', () => {
  it('defender with Olé penalizes single-target move accuracy: 100 * 0.8 = 80', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_OLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveTarget: 'SELECTED', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(80)
  })

  it('defender with Olé does NOT penalize spread moves (moveTarget: BOTH): 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_OLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveTarget: 'BOTH', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })

  it('attacker with Olé does NOT penalize its own accuracy (APPLY_ON_TARGET flag): 100', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_OLE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, moveTarget: 'SELECTED', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })
})

describe('Grip Pincer (ALWAYS_HITS when defender is wrapped), :4707-4710', () => {
  it('returns 101 when defender is wrapped', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_GRIP_PINCER'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderIsWrapped: true, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('does not trigger when defender is not wrapped: returns 70', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_GRIP_PINCER'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, defenderIsWrapped: false, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(70)
  })
})

describe('Inner Focus (ALWAYS_HITS for Focus Blast), :1003-1006', () => {
  it('returns 101 when using Focus Blast', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_INNER_FOCUS'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_FOCUS_BLAST'), moveAccuracy: 70, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('does not trigger for other moves: returns normal accuracy (100)', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_INNER_FOCUS'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveId: requireMove('MOVE_TACKLE'), moveAccuracy: 100, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(100)
  })
})

describe('Artillery and Deadeye (HITS_IF_POSSIBLE for Mega Launcher / arrow moves), :4770-4791', () => {
  it('Artillery returns 101 for a move with moveFlagMegaLauncher', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_ARTILLERY'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, moveFlagMegaLauncher: true, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })

  it('Artillery does not trigger without moveFlagMegaLauncher: returns 70', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_ARTILLERY'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, moveFlagMegaLauncher: false, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(70)
  })

  it('Deadeye returns 101 for an arrow move with moveFlagArrowBased', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_DEADEYE'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, moveFlagArrowBased: true, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })
})

describe('Fatal Precision (HITS_IF_POSSIBLE for damaging super-effective moves), :4398-4402', () => {
  it('returns 101 for a super-effective damaging move', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_FATAL_PRECISION'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 70,
        moveSplit: 'PHYSICAL',
        isSuperEffective: true,
        attackerAbilitySlots: slots,
      }),
    )
    expect(result.accuracy).toBe(101)
  })

  it('does not trigger when the move is not super effective: returns 70', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_FATAL_PRECISION'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 70,
        moveSplit: 'PHYSICAL',
        isSuperEffective: false,
        attackerAbilitySlots: slots,
      }),
    )
    expect(result.accuracy).toBe(70)
  })

  it('does not trigger for status moves even if isSuperEffective flag is true: returns 70', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_FATAL_PRECISION'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveAccuracy: 70,
        moveSplit: 'STATUS',
        isSuperEffective: true,
        attackerAbilitySlots: slots,
      }),
    )
    expect(result.accuracy).toBe(70)
  })
})

describe('Lullaby and Hypnotist (1.5x multiplier for Sing / Hypnosis), :4221-4225, 9583-9587', () => {
  it('Lullaby boosts Sing from 55 to Math.trunc(55 * 1.5) = 82', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_LULLABY'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveId: requireMove('MOVE_SING'),
        moveAccuracy: 55,
        attackerAbilitySlots: slots,
      }),
    )
    expect(result.accuracy).toBe(82)
  })

  it('Hypnotist boosts Hypnosis from 60 to Math.trunc(60 * 1.5) = 90', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_HYPNOTIST'), innates: [null, null, null] }
    const result = getTotalAccuracy(
      baseInputs({
        moveId: requireMove('MOVE_HYPNOSIS'),
        moveAccuracy: 60,
        attackerAbilitySlots: slots,
      }),
    )
    expect(result.accuracy).toBe(90)
  })
})

describe('Weather evasion and accuracy abilities: Snow Cloak, Rain Shroud, Smokey Maneuvers, Echolocation', () => {
  it('Snow Cloak in Hail reduces 100 accuracy move to Math.trunc(100 / 1.25) = 80', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_SNOW_CLOAK'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'HAIL', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(80)
  })

  it('Rain Shroud in rain reduces 100 accuracy move to Math.trunc(100 / 1.25) = 80', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_RAIN_SHROUD'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'RAIN_TEMPORARY', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(80)
  })

  it('Smokey Maneuvers in fog reduces 100 accuracy move to Math.trunc(100 / 1.25) = 80', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_SMOKEY_MANEUVERS'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, weather: 'FOG', defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(80)
  })

  it('Echolocation in fog makes attacker always hit (returns 101)', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_ECHOLOCATION'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 70, weather: 'FOG', attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(101)
  })
})

describe('Bad Luck (additive -5 accuracy), :4304-4307', () => {
  it('defender with Bad Luck reduces 100 accuracy move to 95', () => {
    const slots: AbilitySlots = { ability: requireAbility('ABILITY_BAD_LUCK'), innates: [null, null, null] }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 100, defenderAbilitySlots: slots }))
    expect(result.accuracy).toBe(95)
  })
})

describe('Reverse slot iteration order, battle_util.h:269-275', () => {
  it('runs innate 0 before ability: 50 * 1.3 = 65, then 65 * 1.2 = 78', () => {
    const slots: AbilitySlots = {
      ability: requireAbility('ABILITY_ILLUMINATE'),
      innates: [requireAbility('ABILITY_COMPOUND_EYES'), null, null],
    }
    const result = getTotalAccuracy(baseInputs({ moveAccuracy: 50, attackerAbilitySlots: slots }))
    expect(result.accuracy).toBe(78)
  })
})

