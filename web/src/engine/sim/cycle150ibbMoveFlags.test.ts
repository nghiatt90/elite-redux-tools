/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ib slice 2: DoesMoveMatchFlag's ability-grant fallback reaches five more
// damaging multipliers -- Iron Fist, Mega Launcher, Hammer Fist, Liquid Voice and
// Punk Rock (both halves).
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the move's own static flag bit wins
//   outright; only if unset does it ask every ability on the given battler via
//   onModifyMoveFlags. `moveType` is the caller's, not the move's.
// - Iron Fist (src/abilities.cc:1534): IsIronFistBoosted(battler, move), i.e.
//   DoesMoveMatchFlag(battler, move, TYPE_NORMAL, MOVE_FLAG_PUNCH)
//   (src/battle_util.c:9375) -> MUL(1.3). Mega Launcher (:2441) is the same with
//   MOVE_FLAG_MEGA_LAUNCHER (:9373). Both pass a literal TYPE_NORMAL dummy.
// - Hammer Fist (:11529): DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_PUNCH)
//   || gBattleMoves[move].hammerBased -> MUL(1.25) -- the REAL move type here.
// - Liquid Voice (:2793): IsSoundMove(battler, move) -> MUL(1.2). Its onMoveType half
//   (:2795-2799) tests the RAW sound flag, not IsSoundMove, so it is left alone.
// - Punk Rock (:3307,3311): IsSoundMove(battler, move) -> MUL(1.3) offensively and
//   IsSoundMove(attacker, move) -> MUL(0.5) defensively; the defensive scan is over
//   the ATTACKER's slots. `.breakable = TRUE`. Amplifier/Bass Boosted/Sludgy Mix
//   alias these hooks and pass the ctx through unchanged (10-aliases.ts).
//
// All scenarios are Garchomp (level 100, neutral nature, 31 IV/0 EV) against a pure
// Normal Snorlax, with no items/weather/field, so type effectiveness is 1x for every
// move except High Jump Kick (Fighting vs Normal = 2x). Garchomp is Dragon/Ground, so
// the two Dragon moves below also get a 1.5x STAB.
//
// Raw stats (calcStat: floor((2*base+31)*level/100)+5):
//   Garchomp atk 296, spatk 196; Snorlax def 166, spdef 256.
// Core (:7524-7533): dmg = floor(level*2/5)+2 = 42; *power; *atk; /def; /50+2.
// CalcFinalDmg folds typeEff, abilityMultiplier and STAB into ONE UQ_4_12 modifier
// (finalDamage.ts: #2 typeEff, #3 ability, #8 STAB) and applies it once:
// applyModifier(m, dmg) = floor((m*dmg+512)/1024), mulModifier(a,b) =
// floor((a*b+512)/1024), uq(n) = trunc(n*1024): uq(1.3)=1331, uq(1.25)=1280,
// uq(1.2)=1228, uq(0.5)=512, uq(1.5)=1536. The 16 rolls are
// floor(best.dmg*(100-roll)/100) with index 0 = roll 15 (85%) and index 15 = roll 0
// (100%).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { calcStat } from '../stats'
import type { AbilitySlots } from '../abilities/dispatch'

const DATA_DIR = new URL('../../../../data/v2.65beta/', import.meta.url)
const species = JSON.parse(readFileSync(fileURLToPath(new URL('species.json', DATA_DIR)), 'utf-8'))
const movesData = JSON.parse(readFileSync(fileURLToPath(new URL('moves.json', DATA_DIR)), 'utf-8'))
const typeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('types.json', DATA_DIR)), 'utf-8'))
const inverseTypeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('typesInverse.json', DATA_DIR)), 'utf-8'))
const moveBehaviors: MoveBehaviors = JSON.parse(readFileSync(fileURLToPath(new URL('moveBehaviors.json', DATA_DIR)), 'utf-8')).behaviors
const battleConstants: BattleConstants = JSON.parse(readFileSync(fileURLToPath(new URL('natures.json', DATA_DIR)), 'utf-8'))

const speciesById: Record<string, any> = Object.fromEntries(species.map((s: any) => [s.id, s]))
const moveById: Record<string, any> = Object.fromEntries(movesData.map((m: any) => [m.id, m]))

function bareTypes(types: string[]): string[] {
  return types.map((t) => t.replace('TYPE_', ''))
}

function condition(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
  return {
    speciesId: 'SPECIES_PIKACHU',
    baseSpeciesId: 'SPECIES_PIKACHU',
    heads: 1,
    isMegaEvolved: false,
    itemId: null,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: new Set(),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
    isConfused: false,
    isEnraged: false,
    wasDamagedThisTurnBy: 'none',
    recentlyFainted: false,
    hp: 100,
    maxHp: 100,
    weight: 60,
    speed: 100,
    positiveStatStageCount: 0,
    negativeStatStageCount: 0,
    usedMovePpRemaining: null,
    helpingHand: false,
    ghastlyEcho: false,
    chargedUp: false,
    meFirst: false,
    fear: false,
    safePassage: false,
    itemResolvedHoldEffectStrength: null,
    lastMoveFailed: false,
    ...overrides,
  }
}

/** A level-100, neutral-nature, 0 EV / 31 IV battler built from real species.json
 * base stats -- copied from calculate.test.ts's own helper (via slice 1's file). */
function battler(speciesId: string, overrides: Partial<BattlerBattleState> = {}): BattlerBattleState {
  const s = speciesById[speciesId]
  const level = 100
  const nature = 'NATURE_HARDY' // neutral
  const rawStats = {
    atk: calcStat(s.baseStats.atk, 31, 0, level, nature, 'atk', battleConstants.natureStatTable),
    def: calcStat(s.baseStats.def, 31, 0, level, nature, 'def', battleConstants.natureStatTable),
    spatk: calcStat(s.baseStats.spatk, 31, 0, level, nature, 'spatk', battleConstants.natureStatTable),
    spdef: calcStat(s.baseStats.spdef, 31, 0, level, nature, 'spdef', battleConstants.natureStatTable),
    spe: calcStat(s.baseStats.spe, 31, 0, level, nature, 'spe', battleConstants.natureStatTable),
  }
  return {
    condition: condition({ speciesId, baseSpeciesId: speciesId, hp: 999, maxHp: 999 }),
    types: bareTypes(s.types),
    isGrounded: true,
    semiInvulnerable: 'NONE',
    abilityOn: false,
    gender: 'MALE',
    boostedStat: null,
    alliesFainted: 0,
    slowStartTimer: 5,
    level,
    nature,
    rawStats,
    statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: null,
    holdEffectType: null,
    naturalGift: null,
    hiddenPowerType: null,
    isTransformed: false,
    canEvolveStrict: false,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    abilitySlots: { ability: null, innates: [null, null, null] },
    hasMiracleEye: false,
    ...overrides,
  }
}

function fieldState(overrides: Partial<FieldBattleState> = {}): FieldBattleState {
  return {
    gravityActive: false,
    terrain: null,
    weather: 'NONE',
    sides: {
      attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
      defender: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
    },
    isDoubleBattle: false,
    isInverseRoomActive: false,
    isInverseBattleFlagSet: false,
    isWonderRoomActive: false,
    ...overrides,
  }
}

function moveData(id: string): MoveData {
  const m = moveById[id]
  return {
    id: m.id,
    power: m.power,
    type: m.type ? m.type.replace('TYPE_', '') : null,
    type2: m.type2 ? m.type2.replace('TYPE_', '') : null,
    split: m.split,
    effectChance: m.effectChance,
    splitFlag: m.splitFlag,
    effect: m.effect,
    customBehavior: m.customBehavior,
    crit: m.crit,
    hitsAir: m.hitsAir,
    flags: m.flags ?? {},
    changeTypeHoldEffect: m.effect === 'EFFECT_CHANGE_TYPE_ON_ITEM' && m.argument?.kind === 'other' ? m.argument.value : null,
    miscEffect: m.effect === 'EFFECT_MISC_HIT' && m.argument?.kind === 'misc' ? m.argument.misc : null,
    multiHitArgument: m.effect === 'EFFECT_DOUBLE_HIT' && m.argument?.kind === 'int' ? m.argument.value : null,
  }
}

function scenario(overrides: Partial<DamageCalcScenario> = {}): DamageCalcScenario {
  return {
    move: moveData('MOVE_TACKLE'),
    attacker: battler('SPECIES_GARCHOMP'),
    defender: battler('SPECIES_SNORLAX'),
    field: fieldState(),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    hitCount: 3,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: 80,
    beatUpHitCount: 5,
    defenderUsedGlaiveRush: false,
    ...overrides,
  }
}

function slots(ability: string | null): AbilitySlots {
  return { ability, innates: [null, null, null] }
}

/** Slice 2 needs two abilities on one battler (e.g. Iron Fist + Mixed Martial Arts). */
function slotsWith(ability: string | null, innates: [string | null, string | null, string | null]): AbilitySlots {
  return { ability, innates }
}

function damageWith(moveId: string, attackerSlots: AbilitySlots, defenderSlots: AbilitySlots = slots(null)) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: attackerSlots }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: defenderSlots }),
    }),
  )
}

function damage(moveId: string, attackerAbility: string | null, defenderAbility: string | null = null) {
  return damageWith(moveId, slots(attackerAbility), slots(defenderAbility))
}

describe('Cycle 150ibb -- Iron Fist grants reach the punch multiplier', () => {
  it('Iron Fist + Mixed Martial Arts + Flamethrower: 1.3x via MMA\'s NORMAL-only grant', () => {
    // Flamethrower (special 90): 42*90=3780; *196=740,880; /256=2894; /50=57; +2=59.
    // TypeEff Fire vs Normal = 1x, no STAB. Mixed Martial Arts (:9872) grants PUNCH
    // when the caller's moveType argument is TYPE_NORMAL -- exactly Iron Fist's dummy
    // (battle_util.c:9375). finalModifier = uq(1.3)=1331:
    // applyModifier(1331,59) = floor((78429+512)/1024) = 77.
    // rolls: 100% 59 -> 77; 85% floor(59*.85)=50 -> floor(77*.85)=65.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const mma = damageWith('MOVE_FLAMETHROWER', slotsWith('ABILITY_IRON_FIST', ['ABILITY_MIXED_MARTIAL_ARTS', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(mma.rolls[15]).toBe(77)
    expect(mma.rolls[0]).toBe(65)
  })

  it('Iron Fist alone + Flamethrower: no boost (negative)', () => {
    // No grant and Flamethrower has no punch flag.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const iron = damage('MOVE_FLAMETHROWER', 'ABILITY_IRON_FIST')
    expect(neutral.rolls[15]).toBe(59)
    expect(iron.rolls).toEqual(neutral.rolls)
  })

  it('Iron Fist + Thunder Punch (static punch flag): 1.3x', () => {
    // Thunder Punch (physical 85): 42*85=3570; *296=1,056,720; /166=6365; /50=127; +2=129.
    // TypeEff Electric vs Normal = 1x, no STAB. applyModifier(1331,129)=168;
    // 85% floor(129*.85)=109 -> floor(168*.85)=142.
    const neutral = damage('MOVE_THUNDER_PUNCH', null)
    const iron = damage('MOVE_THUNDER_PUNCH', 'ABILITY_IRON_FIST')
    expect(neutral.rolls[15]).toBe(129)
    expect(iron.rolls[15]).toBe(168)
    expect(iron.rolls[0]).toBe(142)
  })
})

describe('Cycle 150ibb -- Iron Fist reaches a Junshi Sanda kick grant', () => {
  it('Iron Fist + Junshi Sanda + High Jump Kick: 1.3x; Junshi Sanda alone: none', () => {
    // High Jump Kick (physical 130): 42*130=5460; *296=1,616,160; /166=9735; /50=194;
    // +2=196. TypeEff Fighting vs Normal = 2x. Junshi Sanda (:7586) grants PUNCH to a
    // kick-flagged move with no moveType condition, so the dummy is irrelevant.
    // finalModifier = mulModifier(2048,uq(1.3)) = mulModifier(2048,1331) = 2662:
    // applyModifier(2662,196)=510. Without the ability it stays 2048 -> 392.
    const neutral = damage('MOVE_HIGH_JUMP_KICK', null)
    const both = damageWith('MOVE_HIGH_JUMP_KICK', slotsWith('ABILITY_IRON_FIST', ['ABILITY_JUNSHI_SANDA', null, null]))
    const sandaOnly = damage('MOVE_HIGH_JUMP_KICK', 'ABILITY_JUNSHI_SANDA')
    expect(neutral.rolls[15]).toBe(392)
    expect(both.rolls[15]).toBe(510)
    expect(both.rolls[0]).toBe(433)
    expect(sandaOnly.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 150ibb -- Mega Launcher grant/static bullet path', () => {
  it('Mega Launcher + Water Pulse (bulletBased): 1.3x', () => {
    // Water Pulse (special 80, flags.bulletBased == FLAG_MEGA_LAUNCHER_BOOST):
    // 42*80=3360; *196=658,560; /256=2572; /50=51; +2=53. Water vs Normal = 1x.
    // applyModifier(1331,53)=floor((70543+512)/1024)=69; 85% 45 -> 58.
    const neutral = damage('MOVE_WATER_PULSE', null)
    const ml = damage('MOVE_WATER_PULSE', 'ABILITY_MEGA_LAUNCHER')
    expect(neutral.rolls[15]).toBe(53)
    expect(ml.rolls[15]).toBe(69)
    expect(ml.rolls[0]).toBe(58)
  })

  it('Mega Launcher + Flamethrower (not bulletBased): no boost (negative)', () => {
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const ml = damage('MOVE_FLAMETHROWER', 'ABILITY_MEGA_LAUNCHER')
    expect(neutral.rolls[15]).toBe(59)
    expect(ml.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 150ibb -- Hammer Fist passes the real move type', () => {
  it('Hammer Fist + Brawling Wyvern + Dragon Pulse: 1.25x (real-type grant)', () => {
    // Dragon Pulse (special 90, Dragon, bulletBased but not hammer/punch):
    // core 59. Dragon vs Normal = 1x, Garchomp STAB 1.5x. Neutral finalModifier =
    // mulModifier(1024,1536)=1536 -> applyModifier(1536,59)=89. Brawling Wyvern
    // (:7575) grants PUNCH only for DRAGON, which Hammer Fist passes (real type):
    // mulModifier(1536,1280)=1920 -> applyModifier(1920,59)=111; 85% 75 -> 94.
    const neutral = damage('MOVE_DRAGON_PULSE', null)
    const both = damageWith('MOVE_DRAGON_PULSE', slotsWith('ABILITY_HAMMER_FIST', ['ABILITY_BRAWLING_WYVERN', null, null]))
    expect(neutral.rolls[15]).toBe(89)
    expect(both.rolls[15]).toBe(111)
    expect(both.rolls[0]).toBe(94)
  })

  it('Hammer Fist + Brawling Wyvern + a non-Dragon move: no boost', () => {
    // Flamethrower is Fire, so the DRAGON-only grant never fires (and no hammer flag).
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const both = damageWith('MOVE_FLAMETHROWER', slotsWith('ABILITY_HAMMER_FIST', ['ABILITY_BRAWLING_WYVERN', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(both.rolls).toEqual(neutral.rolls)
  })

  it('Hammer Fist + Dragon Hammer (hammerBased): 1.25x', () => {
    // Dragon Hammer (physical 100, Dragon, hammerBased):
    // 42*100=4200; *296=1,243,200; /166=7489; /50=149; +2=151. STAB 1.5x.
    // Neutral 1536 -> 227; with 1.25x, 1920 -> 283; 85% 192 -> 240.
    const neutral = damage('MOVE_DRAGON_HAMMER', null)
    const hammer = damage('MOVE_DRAGON_HAMMER', 'ABILITY_HAMMER_FIST')
    expect(neutral.rolls[15]).toBe(227)
    expect(hammer.rolls[15]).toBe(283)
    expect(hammer.rolls[0]).toBe(240)
  })
})

describe('Cycle 150ibb -- Punk Rock offensive half', () => {
  it('Punk Rock + Reverbate + Flamethrower: 1.3x via the NORMAL-only sound grant', () => {
    // Reverbate (:10628) grants SOUND when the caller's moveType argument is NORMAL,
    // and Punk Rock's IsSoundMove passes that TYPE_NORMAL dummy (:3307). base 59 ->
    // applyModifier(1331,59)=77; 85% 50 -> 65.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const both = damageWith('MOVE_FLAMETHROWER', slotsWith('ABILITY_PUNK_ROCK', ['ABILITY_REVERBATE', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(both.rolls[15]).toBe(77)
    expect(both.rolls[0]).toBe(65)
  })

  it('Punk Rock alone + a non-sound move: no boost (negative)', () => {
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const pr = damage('MOVE_FLAMETHROWER', 'ABILITY_PUNK_ROCK')
    expect(neutral.rolls[15]).toBe(59)
    expect(pr.rolls).toEqual(neutral.rolls)
  })

  it('Punk Rock + a static sound move (Hyper Voice): 1.3x', () => {
    // Hyper Voice (special 95): 42*95=3990; *196=782,040; /256=3054; /50=61; +2=63.
    // Normal vs Normal = 1x, no STAB. applyModifier(1331,63)=82; 85% 53 -> 69.
    const neutral = damage('MOVE_HYPER_VOICE', null)
    const pr = damage('MOVE_HYPER_VOICE', 'ABILITY_PUNK_ROCK')
    expect(neutral.rolls[15]).toBe(63)
    expect(pr.rolls[15]).toBe(82)
    expect(pr.rolls[0]).toBe(69)
  })
})

describe('Cycle 150ibb -- Punk Rock defensive half scans the ATTACKER', () => {
  it('a static sound move is halved (0.5x)', () => {
    // IsSoundMove(attacker, move) (:3311). Hyper Voice base 63;
    // applyModifier(512,63)=floor((32256+512)/1024)=32; 85% 53 -> 27.
    const neutral = damage('MOVE_HYPER_VOICE', null)
    const walled = damage('MOVE_HYPER_VOICE', null, 'ABILITY_PUNK_ROCK')
    expect(neutral.rolls[15]).toBe(63)
    expect(walled.rolls[15]).toBe(32)
    expect(walled.rolls[0]).toBe(27)
  })

  it('a non-sound move is not halved (negative)', () => {
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const walled = damage('MOVE_FLAMETHROWER', null, 'ABILITY_PUNK_ROCK')
    expect(neutral.rolls[15]).toBe(59)
    expect(walled.rolls).toEqual(neutral.rolls)
  })

  it('a Reverbate grant on the ATTACKER makes a non-sound move count as sound (0.5x)', () => {
    // Reverbate is on the attacker, so IsSoundMove(attacker, move) sees the grant.
    // Flamethrower base 59 -> applyModifier(512,59)=30; 85% 50 -> 25.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const walled = damageWith('MOVE_FLAMETHROWER', slots('ABILITY_REVERBATE'), slots('ABILITY_PUNK_ROCK'))
    expect(neutral.rolls[15]).toBe(59)
    expect(walled.rolls[15]).toBe(30)
    expect(walled.rolls[0]).toBe(25)
  })

  it('Reverbate on the DEFENDER does not count', () => {
    // The defender holds Punk Rock AND Reverbate, but the scan is over the attacker's
    // slots (empty), so the sound grant is never seen.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const notWalled = damageWith('MOVE_FLAMETHROWER', slots(null), slotsWith('ABILITY_PUNK_ROCK', ['ABILITY_REVERBATE', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(notWalled.rolls).toEqual(neutral.rolls)
  })

  it('Mold Breaker on the attacker suppresses the breakable defensive half', () => {
    // Punk Rock is `.breakable = TRUE`; the defensive loop's ON_ABILITY call passes
    // checkMoldBreaker=TRUE, so the 0.5x never runs. Neutral Hyper Voice is 63.
    const neutral = damage('MOVE_HYPER_VOICE', null)
    const broken = damage('MOVE_HYPER_VOICE', 'ABILITY_MOLD_BREAKER', 'ABILITY_PUNK_ROCK')
    expect(neutral.rolls[15]).toBe(63)
    expect(broken.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 150ibb -- Liquid Voice sound grant', () => {
  it('Liquid Voice + Festivities + Fiery Dance: 1.2x via the dance->sound grant', () => {
    // Festivities (:10168) grants SOUND to a dance-flagged move; Liquid Voice's
    // IsSoundMove passes the TYPE_NORMAL dummy. Fiery Dance (special 80, Fire, dance):
    // 42*80=3360; *196=658,560; /256=2572; /50=51; +2=53. Fire vs Normal = 1x.
    // finalModifier = uq(1.2)=1228 -> applyModifier(1228,53)=64; 85% 45 -> 54.
    const neutral = damage('MOVE_FIERY_DANCE', null)
    const both = damageWith('MOVE_FIERY_DANCE', slotsWith('ABILITY_LIQUID_VOICE', ['ABILITY_FESTIVITIES', null, null]))
    expect(neutral.rolls[15]).toBe(53)
    expect(both.rolls[15]).toBe(64)
    expect(both.rolls[0]).toBe(54)
  })

  it('Liquid Voice + a non-sound non-dance move: no boost (negative)', () => {
    // Flamethrower has neither flag, so the grant scan finds nothing. Its onMoveType
    // half is also inert (the raw sound flag is unset, and the type is not NORMAL).
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const lv = damage('MOVE_FLAMETHROWER', 'ABILITY_LIQUID_VOICE')
    expect(neutral.rolls[15]).toBe(59)
    expect(lv.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 150ibb -- defender-held offensive multipliers stay inert', () => {
  it('a Mega Launcher defender does not boost a bullet move (applyOn gate)', () => {
    // The offensive hook loop gates a defender-held ability with APPLY_ON_SELF
    // relative to the move's user, mirroring slice 1's Chestnut Axe defender case.
    const neutral = damage('MOVE_WATER_PULSE', null)
    const defenderOnly = damage('MOVE_WATER_PULSE', null, 'ABILITY_MEGA_LAUNCHER')
    expect(neutral.rolls[15]).toBe(53)
    expect(defenderOnly.rolls).toEqual(neutral.rolls)
  })

  it('an Iron Fist defender does not boost a punch move (applyOn gate)', () => {
    const neutral = damage('MOVE_THUNDER_PUNCH', null)
    const defenderOnly = damage('MOVE_THUNDER_PUNCH', null, 'ABILITY_IRON_FIST')
    expect(neutral.rolls[15]).toBe(129)
    expect(defenderOnly.rolls).toEqual(neutral.rolls)
  })
})
