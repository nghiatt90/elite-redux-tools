import { describe, expect, it } from 'vitest'

import { createRoundState, createSideTimerState, createVolatileState } from './create'
import {
  battlerFear,
  damagedBy,
  extraStatLevels,
  hasDefenseCurl,
  hasEmbargo,
  hasGhastlyEcho,
  hasHelpingHand,
  hasMeFirst,
  hasMiracleEye,
  hasSafePassage,
  isChargedUp,
  isConfused,
  isEnraged,
  isInfatuated,
  isInfatuatedWith,
  isPhantomForce,
  isTransformed,
  recentlyFainted,
  retaliateTimerActive,
  rolloutCounter,
  semiInvulnerableState,
  slowStartTimer,
} from './unpack'
import {
  STATUS2_CONFUSION,
  STATUS2_INFATUATION,
  STATUS2_DEFENSE_CURL,
  STATUS2_ENRAGED,
  STATUS2_TRANSFORMED,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_ME_FIRST,
  STATUS3_MIRACLE_EYED,
  STATUS3_ON_AIR,
  STATUS3_PHANTOM_FORCE,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS4_FEAR,
  STATUS4_GHASTLY_ECHO,
  setCounter,
  statusInfatuatedWith,
} from './constants'

/**
 * Asserts a predicate reads EXACTLY one bit position.
 *
 * What the neighbour assertions actually buy, stated correctly: an off-by-one
 * MASK is already caught by the first assertion, since the predicate would
 * return false for its own bit. The neighbours catch the other two shapes --
 * an over-broad mask (`STATUS3_UNDERGROUND | STATUS3_MINIMIZED`, say) and a
 * predicate that tests the whole word for nonzero instead of masking at all.
 * Both of those pass a true-case-only test.
 *
 * WHAT THIS CANNOT CATCH: a wrong CONSTANT. The bit is imported and handed
 * straight back to the predicate, so if the constant itself sat one position
 * out, every assertion here would still pass -- the true case, both neighbours
 * and the empty word. That makes constants.ts a single point of failure this
 * helper is structurally blind to, which is why `the constants themselves` below
 * asserts literal positions against the header instead of importing them.
 */
function expectExactlyBit(predicate: (word: number) => boolean, bit: number, label: string): void {
  expect(predicate(bit), `${label}: the bit itself`).toBe(true)
  expect(predicate((bit >>> 1) >>> 0), `${label}: one position LOWER must not match`).toBe(false)
  expect(predicate((bit << 1) >>> 0), `${label}: one position HIGHER must not match`).toBe(false)
  expect(predicate(0), `${label}: empty word`).toBe(false)
}

describe('the constants themselves', () => {
  // Every OTHER test here imports a constant and hands it to the predicate that
  // reads it, so the constant is on both sides of the assertion and a wrong one
  // is invisible. This table is the only thing in the suite that is not
  // self-referential: it asserts LITERAL bit positions, transcribed from
  // include/constants/battle.h with the line of each, so a constant that drifts
  // fails here even though every predicate still agrees with it.
  //
  // Values are written as `1 << n` rather than hex so the POSITION is what the
  // reader checks against the header, which is what actually matters.
  const EXPECTED: [string, number, number, string][] = [
    // name, value, header line, note
    ['STATUS2_CONFUSION', 0x7, 149, '3-bit counter at bit 0'],
    ['STATUS2_ENRAGED', 1 << 29, 173, ''],
    ['STATUS2_TRANSFORMED', 1 << 21, 165, ''],
    ['STATUS2_DEFENSE_CURL', 1 << 30, 174, ''],
    ['STATUS2_INFATUATION', 0xf0000, 162, '4-bit mask at bit 16'],
    ['STATUS3_ON_AIR', 1 << 6, 215, ''],
    ['STATUS3_UNDERGROUND', 1 << 7, 216, ''],
    ['STATUS3_CHARGED_UP', 1 << 9, 218, ''],
    ['STATUS3_EMBARGO', 1 << 17, 226, ''],
    ['STATUS3_UNDERWATER', 1 << 18, 227, ''],
    ['STATUS3_ME_FIRST', 1 << 22, 231, ''],
    ['STATUS3_PHANTOM_FORCE', 1 << 24, 233, ''],
    ['STATUS3_MIRACLE_EYED', 1 << 25, 234, ''],
    ['STATUS4_GHASTLY_ECHO', 1 << 4, 284, ''],
    ['STATUS4_FEAR', 1 << 7, 287, 'NOT the VolatileStruct field of the same name'],
  ]

  const ACTUAL: Record<string, number> = {
    STATUS2_CONFUSION,
    STATUS2_ENRAGED,
    STATUS2_TRANSFORMED,
    STATUS2_DEFENSE_CURL,
    STATUS2_INFATUATION,
    STATUS3_ON_AIR,
    STATUS3_UNDERGROUND,
    STATUS3_CHARGED_UP,
    STATUS3_EMBARGO,
    STATUS3_UNDERWATER,
    STATUS3_ME_FIRST,
    STATUS3_PHANTOM_FORCE,
    STATUS3_MIRACLE_EYED,
    STATUS4_GHASTLY_ECHO,
    STATUS4_FEAR,
  }

  it.each(EXPECTED)('%s is the value at constants/battle.h:%d', (name, value) => {
    expect(ACTUAL[name]).toBe(value)
  })

  it('the semi-invulnerable bits are adjacent, which is why an off-by-one is plausible', () => {
    // ON_AIR 6, UNDERGROUND 7, MINIMIZED 8. Asserting the relationship as well
    // as the values documents WHY this table earns its keep.
    expect(STATUS3_UNDERGROUND).toBe(STATUS3_ON_AIR << 1)
  })
})

describe('status2', () => {
  it('reads confusion as a nonzero COUNTER, not a single bit', () => {
    // STATUS2_CONFUSION is 3 bits at position 0. Every value 1..7 is confused;
    // 0 is not. A single-bit read would call a counter of 2 or 4 unconfused.
    expect(isConfused(0)).toBe(false)
    for (let turns = 1; turns <= 7; turns++) {
      expect(isConfused(setCounter(0, STATUS2_CONFUSION, turns)), `${turns} turns`).toBe(true)
    }
    // Bit 3 is the NEXT field (FLINCHED), and must not read as confusion.
    expect(isConfused(1 << 3)).toBe(false)
  })

  it('reads enraged, transformed and defense curl from their exact bits', () => {
    expectExactlyBit(isEnraged, STATUS2_ENRAGED, 'STATUS2_ENRAGED')
    expectExactlyBit(isTransformed, STATUS2_TRANSFORMED, 'STATUS2_TRANSFORMED')
    expectExactlyBit(hasDefenseCurl, STATUS2_DEFENSE_CURL, 'STATUS2_DEFENSE_CURL')
  })

  it('reads infatuation as a 4-bit mask, any battler', () => {
    expect(isInfatuated(0)).toBe(false)
    for (let b = 0; b < 4; b++) expect(isInfatuated(statusInfatuatedWith(b)), `battler ${b}`).toBe(true)
    // Bit 15 is below the mask and bit 20 (FOCUS_ENERGY) above it; neither counts.
    expect(isInfatuated(1 << 15)).toBe(false)
    expect(isInfatuated(1 << 20)).toBe(false)
  })

  it('distinguishes WHICH battler the infatuation is with', () => {
    const withTwo = statusInfatuatedWith(2)
    expect(isInfatuatedWith(withTwo, 2)).toBe(true)
    expect(isInfatuatedWith(withTwo, 1)).toBe(false)
    expect(isInfatuatedWith(withTwo, 3)).toBe(false)
  })
})

describe('gStatuses3', () => {
  it('reads miracle eye, charged up, me first and embargo from their exact bits', () => {
    expectExactlyBit(hasMiracleEye, STATUS3_MIRACLE_EYED, 'STATUS3_MIRACLE_EYED')
    expectExactlyBit(isChargedUp, STATUS3_CHARGED_UP, 'STATUS3_CHARGED_UP')
    expectExactlyBit(hasMeFirst, STATUS3_ME_FIRST, 'STATUS3_ME_FIRST')
    expectExactlyBit(hasEmbargo, STATUS3_EMBARGO, 'STATUS3_EMBARGO')
  })

  it('maps each semi-invulnerable bit to its own state', () => {
    expect(semiInvulnerableState(0)).toBe('NONE')
    expect(semiInvulnerableState(STATUS3_UNDERGROUND)).toBe('UNDERGROUND')
    expect(semiInvulnerableState(STATUS3_UNDERWATER)).toBe('UNDERWATER')
    expect(semiInvulnerableState(STATUS3_ON_AIR)).toBe('AIRBORNE')
  })

  it('does not confuse the three semi-invulnerable bits with their neighbours', () => {
    // ON_AIR is bit 6, UNDERGROUND bit 7, MINIMIZED bit 8. Off-by-one here would
    // read a minimized battler as underground.
    expect(semiInvulnerableState(1 << 5)).toBe('NONE')
    expect(semiInvulnerableState(1 << 8)).toBe('NONE')
    expect(semiInvulnerableState(1 << 17)).toBe('NONE')
    expect(semiInvulnerableState(1 << 19)).toBe('NONE')
  })

  it('reads Phantom Force as NONE for damage, but reports it separately', () => {
    // It is in STATUS3_SEMI_INVULNERABLE but has no FLAG_DMG_* counterpart
    // (battle_util.c:7643-7645), so the damage path sees nothing.
    expect(semiInvulnerableState(STATUS3_PHANTOM_FORCE)).toBe('NONE')
    expectExactlyBit(isPhantomForce, STATUS3_PHANTOM_FORCE, 'STATUS3_PHANTOM_FORCE')
  })
})

describe('gStatuses4', () => {
  it('reads ghastly echo from its exact bit', () => {
    expectExactlyBit(hasGhastlyEcho, STATUS4_GHASTLY_ECHO, 'STATUS4_GHASTLY_ECHO')
  })
})

describe('gVolatileStructs', () => {
  it('reads fear from the STRUCT FIELD, which is not STATUS4_FEAR', () => {
    // battle_util.c:7062 reads gVolatileStructs[battlerDef].fear. STATUS4_FEAR
    // is a different thing that none of the three consumers of this read. The
    // unpacker takes a VolatileState, so it cannot accidentally be handed a
    // status word -- that is the point of its signature.
    const v = createVolatileState()
    expect(battlerFear(v)).toBe(false)
    v.fear = true
    expect(battlerFear(v)).toBe(true)
  })

  it('returns slowStartTimer as a number, since Lethargy reads its exact value', () => {
    const v = createVolatileState()
    expect(slowStartTimer(v)).toBe(0)
    v.slowStartTimer = 3
    expect(slowStartTimer(v)).toBe(3)
  })

  it('maps the five extra stat levels to their own keys', () => {
    const v = createVolatileState()
    v.extraAttackLevel = 1
    v.extraDefenseLevel = 2
    v.extraSpAttackLevel = 3
    v.extraSpDefenseLevel = 4
    v.extraSpeedLevel = 5
    // A transposition here would be invisible without naming each one.
    expect(extraStatLevels(v)).toEqual({ atk: 1, def: 2, spatk: 3, spdef: 4, spe: 5 })
  })

  it('returns the rollout counter as a value, not a boolean', () => {
    const v = createVolatileState()
    v.rolloutCounter = 2
    expect(rolloutCounter(v)).toBe(2)
  })
})

describe('gRoundStructs', () => {
  it('reads helping hand and safe passage', () => {
    const r = createRoundState()
    expect(hasHelpingHand(r)).toBe(false)
    expect(hasSafePassage(r)).toBe(false)
    r.helpingHand = true
    r.safePassage = true
    expect(hasHelpingHand(r)).toBe(true)
    expect(hasSafePassage(r)).toBe(true)
  })

  it('requires the damaged flag, not just a recorded battler id', () => {
    // script_conditions.cc:44 -- `if (!damaged) return FALSE` comes first, so a
    // stale battler id with the flag clear is not "damaged by" anyone.
    const r = createRoundState()
    r.physicalBattlerId = 1
    expect(damagedBy(r).damaged).toBe(false)
    expect(damagedBy(r).byBattlerIds).toEqual([])
  })

  it('reports BOTH recorded battler ids, which the 3-way enum cannot', () => {
    // :46 checks physicalBattlerId OR specialBattlerId. Two different attackers
    // is reachable in doubles.
    const r = createRoundState()
    r.damaged = true
    r.physicalBattlerId = 1
    r.specialBattlerId = 3
    expect(damagedBy(r).byBattlerIds).toEqual([1, 3])
  })

  it('deduplicates when one battler did both', () => {
    const r = createRoundState()
    r.damaged = true
    r.physicalBattlerId = 1
    r.specialBattlerId = 1
    expect(damagedBy(r).byBattlerIds).toEqual([1])
  })
})

describe('gSideTimers: the retaliate timer has two different predicates', () => {
  it('RecentFainted is EXACTLY one, not "running"', () => {
    // script_conditions.cc:110. The timer is 2 on the turn of the faint, 1 on
    // the next, 0 after -- so Retaliate fires the turn AFTER, and a `> 0` test
    // would fire it a turn early.
    const t = createSideTimerState()
    t.retaliateTimer = 0
    expect(recentlyFainted(t)).toBe(false)
    t.retaliateTimer = 1
    expect(recentlyFainted(t)).toBe(true)
    t.retaliateTimer = 2
    expect(recentlyFainted(t), 'the turn of the faint is NOT recentlyFainted').toBe(false)
  })

  it('the ability predicate on the same field is plain nonzero, and differs at 2', () => {
    // abilities.cc:3881 uses `if (retaliateTimer)`. The two consumers genuinely
    // disagree about the same field on the turn of the faint.
    const t = createSideTimerState()
    t.retaliateTimer = 2
    expect(retaliateTimerActive(t)).toBe(true)
    expect(recentlyFainted(t)).toBe(false)
  })
})
