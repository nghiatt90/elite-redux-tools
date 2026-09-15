// Loads the real committed data snapshot, same pattern as speciesJoin.test.ts --
// this report is only meaningful against real trainer/species/move data, not a hand
// rolled fixture. TRAINER_SAWYER_1 is the plan's own recommended oracle target (a
// 4-5 mon ace party, not the full-size TRAINER_OLDPLAYER/TRAINER_MAGIKARP_GUY
// exception -- see the plan's Section C.2), used here only as "some real trainer
// with a real moveset", not for anything AI-decision-related.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MoveBehaviors } from '../engine/basePower'
import {
  buildEnemyBattlerState,
  buildMatchupReport,
  MATCHUP_REPORT_CAVEATS,
  SPEED_TIER_CAVEAT,
  TRICK_ROOM_SPEED_TIER_NOTE,
  movesForMon,
  neutralField,
  resolveEnemyLevel,
  resolveParty,
  speedTiers,
  type MatchupContext,
} from './matchupReport'
import type { BattleConstants, Encounters, Item, Move, MoveBehaviorsFile, Species, Trainer, TrainerMon, TypeChart } from './types'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', 'data', 'v2.65beta')
const load = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T

const species = load<Species[]>('species.json')
const items = load<Item[]>('items.json')
const moves = load<Move[]>('moves.json')
const natures = load<BattleConstants>('natures.json')
const typeChart = load<TypeChart>('types.json')
const inverseTypeChart = load<TypeChart>('typesInverse.json')
const moveBehaviorsFile = load<MoveBehaviorsFile>('moveBehaviors.json')
const trainers = load<Trainer[]>('trainers.json')
const encounters = load<Encounters>('encounters.json')

const speciesById = new Map(species.map((s) => [s.id, s]))
const itemsById = new Map(items.map((i) => [i.id, i]))
const movesById = new Map(moves.map((m) => [m.id, m]))

const ctx: MatchupContext = {
  speciesById,
  itemsById,
  movesById,
  natures,
  typeChart,
  inverseTypeChart,
  // MoveBehaviorsFile.behaviors is deliberately loosely typed (see lib/types.ts's own
  // doc) -- this is the one cast site, same as features/damageCalc/scenario.ts's
  // buildScenario.
  moveBehaviors: moveBehaviorsFile.behaviors as unknown as MoveBehaviors,
  fieldEffects: encounters.fieldEffects,
  inverseBattles: encounters.inverseBattles,
}

const sawyer = trainers.find((t) => t.id === 'TRAINER_SAWYER_1')!
const marowak = sawyer.parties.ace.find((m) => m.species === 'SPECIES_MAROWAK')!

function trainerMon(overrides: Partial<TrainerMon> = {}): TrainerMon {
  return {
    species: 'SPECIES_SNORLAX',
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability: 'ABILITY_THICK_FAT',
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves: ['MOVE_BODY_SLAM', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'],
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
    ...overrides,
  }
}

describe('resolveEnemyLevel', () => {
  it("is the player's own highest party level, unchanged -- battle_main.c:1819-1827", () => {
    expect(resolveEnemyLevel(57)).toBe(57)
    expect(resolveEnemyLevel(100)).toBe(100)
  })
})

describe('resolveParty', () => {
  const base: Trainer = {
    id: 'TRAINER_TEST',
    trainerNum: 1,
    name: 'Test',
    gender: 'MALE',
    hasTrainerFlag: false,
    forcedDouble: false,
    risky: false,
    preferStatus: false,
    preferStall: false,
    noSwitching: false,
    class: null,
    pic: null,
    music: null,
    parties: { ace: [trainerMon({ species: 'SPECIES_ACE' })], elite: [], hell: [] },
  }

  it('returns the ace party for the ace tier', () => {
    expect(resolveParty(base, 'ace').map((m) => m.species)).toEqual(['SPECIES_ACE'])
  })

  it('falls back elite to ace when the textproto elite tier is empty', () => {
    expect(resolveParty(base, 'elite').map((m) => m.species)).toEqual(['SPECIES_ACE'])
  })

  it('falls back hell to the RESOLVED elite (itself already ace), not straight to ace', () => {
    // Same outcome either way for THIS trainer, but exercises the fallback path
    // lib/types.ts's TrainerParties doc calls out specifically.
    expect(resolveParty(base, 'hell').map((m) => m.species)).toEqual(['SPECIES_ACE'])
  })

  it('uses a real elite tier when the textproto actually sets one', () => {
    const withElite: Trainer = { ...base, parties: { ...base.parties, elite: [trainerMon({ species: 'SPECIES_ELITE' })] } }
    expect(resolveParty(withElite, 'elite').map((m) => m.species)).toEqual(['SPECIES_ELITE'])
    // hell still has none of its own -> falls back to the real elite, not ace.
    expect(resolveParty(withElite, 'hell').map((m) => m.species)).toEqual(['SPECIES_ELITE'])
  })
})

describe('buildEnemyBattlerState', () => {
  it('forces every IV to 31 except Speed under ironPill, per CLAUDE.md', () => {
    const level = 50
    const normal = buildEnemyBattlerState(trainerMon({ ironPill: false }), level, ctx)
    const ironPilled = buildEnemyBattlerState(trainerMon({ ironPill: true }), level, ctx)

    // Every OTHER stat is identical -- only Speed's IV changed.
    expect(ironPilled.rawStats.atk).toBe(normal.rawStats.atk)
    expect(ironPilled.condition.maxHp).toBe(normal.condition.maxHp)
    expect(ironPilled.rawStats.spe).toBeLessThan(normal.rawStats.spe)
  })

  it('resolves the ability slot verbatim (already-resolved game truth, not an index to re-derive)', () => {
    const battler = buildEnemyBattlerState(trainerMon({ ability: 'ABILITY_INTIMIDATE' }), 50, ctx)
    expect(battler.abilitySlots.ability).toBe('ABILITY_INTIMIDATE')
    // Species' own 3 innates ride along on top, per TrainerMon.ability's own doc.
    const snorlax = speciesById.get('SPECIES_SNORLAX')!
    expect(battler.abilitySlots.innates).toEqual([snorlax.innates[0] ?? null, snorlax.innates[1] ?? null, snorlax.innates[2] ?? null])
  })

  it('is healthy and unboosted turn one', () => {
    const battler = buildEnemyBattlerState(trainerMon(), 50, ctx)
    expect(battler.condition.hp).toBe(battler.condition.maxHp)
    expect(battler.statStages).toEqual({ atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 })
    expect(battler.condition.status1.size).toBe(0)
  })
})

describe('movesForMon', () => {
  it('drops MOVE_NONE slots and resolves the rest to MoveData', () => {
    const result = movesForMon(trainerMon({ moves: ['MOVE_BODY_SLAM', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
    expect(result.map((m) => m.id)).toEqual(['MOVE_BODY_SLAM'])
  })
})

describe('speedTiers', () => {
  it('sorts fastest-first and labels the player row "You"', () => {
    const player = buildEnemyBattlerState(trainerMon({ species: 'SPECIES_SLOWPOKE' }), 50, ctx)
    const fast = buildEnemyBattlerState(trainerMon({ species: 'SPECIES_ELECTRODE' }), 50, ctx)
    const tiers = speedTiers(player, [{ speciesId: 'SPECIES_ELECTRODE', battler: fast }], false)
    expect(tiers[0]).toEqual({ label: 'SPECIES_ELECTRODE', speed: fast.condition.speed })
    expect(tiers[1]).toEqual({ label: 'You', speed: player.condition.speed })
  })

  it('reverses the order under Trick Room -- lower Speed acts first', () => {
    const player = buildEnemyBattlerState(trainerMon({ species: 'SPECIES_SLOWPOKE' }), 50, ctx)
    const fast = buildEnemyBattlerState(trainerMon({ species: 'SPECIES_ELECTRODE' }), 50, ctx)
    const tiers = speedTiers(player, [{ speciesId: 'SPECIES_ELECTRODE', battler: fast }], true)
    expect(tiers[0]).toEqual({ label: 'You', speed: player.condition.speed })
    expect(tiers[1]).toEqual({ label: 'SPECIES_ELECTRODE', speed: fast.condition.speed })
  })
})

describe('buildMatchupReport', () => {
  const playerBattler = buildEnemyBattlerState(
    trainerMon({ species: 'SPECIES_SNORLAX', item: 'ITEM_CHILAN_BERRY', ability: 'ABILITY_THICK_FAT' }),
    57,
    ctx,
  )
  const playerMoves = movesForMon(trainerMon({ moves: ['MOVE_BODY_SLAM', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)

  it('reports a status move as having no direct damage, matching AI_CalcDamage\'s own power-gate (battle_ai_util.c:665)', () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    const carbink = report.mons.find((m) => m.speciesId === 'SPECIES_CARBINK')!
    const reflect = carbink.itsMoves.find((m) => m.moveId === 'MOVE_REFLECT')!
    expect(reflect.maxRollDamage).toBeNull()
    expect(reflect.aiEstimatedDamage).toBeNull()
    // A genuinely powerless move has nothing wrong to warn about -- unlike a
    // dynamic-damage effect's null (see the test below), which DOES carry a note.
    expect(reflect.unmodelled).toEqual([])
  })

  it(
    "reports a move using one of AI_CalcDamage's own dynamic-damage effects as having " +
      'no direct damage, even though this ER data declares its power as 1, not 0 -- a ' +
      "power-only gate would have missed this and silently run the ordinary formula " +
      'on power=1 (battle_ai_util.c:684-703)',
    () => {
      // Re-measured directly (see matchupReport.ts's DYNAMIC_DAMAGE_EFFECTS doc):
      // MOVE_SUPER_FANG, MOVE_ENDEAVOR and MOVE_FINAL_GAMBIT all declare power 1.
      expect(movesById.get('MOVE_SUPER_FANG')?.power).toBe(1)
      expect(movesById.get('MOVE_SUPER_FANG')?.effect).toBe('EFFECT_SUPER_FANG')

      const superFangMoves = movesForMon(trainerMon({ moves: ['MOVE_SUPER_FANG', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: superFangMoves },
        trainer: sawyer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
      const superFang = marowakReport.yourMoves.find((m) => m.moveId === 'MOVE_SUPER_FANG')!
      expect(superFang.maxRollDamage).toBeNull()
      // Review finding: without this, Super Fang read exactly like a harmless status
      // move (both a bare null, no warning) instead of like the real engine gap it is.
      expect(superFang.unmodelled).toEqual(['EFFECT_SUPER_FANG: not modelled'])
    },
  )

  it(
    'nulls the true-damage column for Counter/Mirror Coat/Bide/Seismic Toss (no engine port, ' +
      "unlike Sky Drop -- but keeps the AI-belief column, since AI_CalcDamage doesn't " +
      'special-case any of the three effects either (battle_ai_util.c:650-765)',
    () => {
      // Re-measured directly: all four declare power 1, and Seismic Toss shares
      // EFFECT_SKY_DROP with the real, power=60 MOVE_SKY_DROP -- so the exclusion
      // for Seismic Toss has to be by move id, not by effect.
      for (const id of ['MOVE_COUNTER', 'MOVE_MIRROR_COAT', 'MOVE_BIDE', 'MOVE_SEISMIC_TOSS']) {
        expect(movesById.get(id)?.power).toBe(1)
      }
      expect(movesById.get('MOVE_SKY_DROP')?.effect).toBe('EFFECT_SKY_DROP')
      expect(movesById.get('MOVE_SKY_DROP')?.power).toBeGreaterThan(1)

      const trainer: Trainer = {
        id: 'TRAINER_TEST_COUNTER',
        trainerNum: 2,
        name: 'Test',
        gender: 'MALE',
        hasTrainerFlag: false,
        forcedDouble: false,
        risky: false,
        preferStatus: false,
        preferStall: false,
        noSwitching: false,
        class: null,
        pic: null,
        music: null,
        parties: {
          ace: [
            trainerMon({
              species: 'SPECIES_SNORLAX',
              moves: ['MOVE_COUNTER', 'MOVE_MIRROR_COAT', 'MOVE_BIDE', 'MOVE_SEISMIC_TOSS'],
            }),
          ],
          elite: [],
          hell: [],
        },
      }

      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
        trainer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      const mon = report.mons[0]
      for (const moveId of ['MOVE_COUNTER', 'MOVE_MIRROR_COAT', 'MOVE_BIDE', 'MOVE_SEISMIC_TOSS']) {
        const entry = mon.itsMoves.find((m) => m.moveId === moveId)!
        expect(entry.maxRollDamage, `${moveId} maxRollDamage`).toBeNull()
        expect(entry.aiEstimatedDamage, `${moveId} aiEstimatedDamage`).not.toBeNull()
      }
    },
  )

  it('does NOT null Sky Drop\'s real damage just because it shares an effect with Seismic Toss', () => {
    const skyDropMoves = movesForMon(trainerMon({ moves: ['MOVE_SKY_DROP', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: skyDropMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
    const skyDrop = marowakReport.yourMoves.find((m) => m.moveId === 'MOVE_SKY_DROP')!
    expect(skyDrop.maxRollDamage).not.toBeNull()
    expect(skyDrop.maxRollDamage).toBeGreaterThan(0)
  })

  it("does not compute an AI-belief column for the player's own moves -- there is no AI on that side", () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
    for (const entry of marowakReport.yourMoves) expect(entry.aiEstimatedDamage).toBeNull()
  })

  it(
    "SetBattlerData zeroes the player's held item inside the AI's own damage estimate " +
      '(battle_ai_util.c:538, only while BATTLE_HISTORY->itemEffects is still 0, always true turn one) -- ' +
      "so the AI's belief about Double Edge overstates the real, Chilan-Berry-reduced max roll",
    () => {
      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
        trainer: sawyer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
      const doubleEdge = marowakReport.itsMoves.find((m) => m.moveId === 'MOVE_DOUBLE_EDGE')!

      expect(doubleEdge.maxRollDamage).not.toBeNull()
      expect(doubleEdge.aiEstimatedDamage).not.toBeNull()
      // Chilan Berry halves a Normal-type hit unconditionally -- the AI's estimate,
      // which never sees the berry (it hasn't triggered yet), should sit close to
      // DOUBLE the real max-roll figure (crit-blending moves it slightly further).
      expect(doubleEdge.aiEstimatedDamage!).toBeGreaterThan(doubleEdge.maxRollDamage! * 1.8)
    },
  )

  it('carries the priority-ignoring caveat on the result itself, next to the speed table it qualifies', () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.speedTierNote).toBe(SPEED_TIER_CAVEAT)
  })

  it('every enemy mon is reported at the derived enemy level, not a stored one', () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 63,
      ctx,
    })
    expect(report.enemyLevel).toBe(63)
    for (const mon of report.mons) expect(mon.level).toBe(63)
  })

  it('falls back elite/hell to ace for a real trainer whose textproto leaves them empty', () => {
    // CLAUDE.md/trainers.py: common for both tiers to be empty in the raw textproto.
    const emptyTierTrainer = trainers.find((t) => t.parties.elite.length === 0 && t.parties.hell.length === 0)!
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: emptyTierTrainer,
      tier: 'hell',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.mons.map((m) => m.speciesId)).toEqual(emptyTierTrainer.parties.ace.map((m) => m.species))
  })

  // Three real trainers, covering every combination this data actually has (see
  // docs/battle-sim/encounters-guard-field-semantics.md's flag census): both effects,
  // Trick Room alone, and neither -- confirming resolveTrickRoomActive/
  // resolveInverseBattleActive are wired into buildMatchupReport correctly rather
  // than just unit-testable in isolation.
  it('TRAINER_TATE_AND_LIZA_1: Trick Room, Inverse Battle, AND forced-double, all wired through', () => {
    const tateAndLiza1 = trainers.find((t) => t.id === 'TRAINER_TATE_AND_LIZA_1')!
    // Re-measured directly rather than assumed once the trainer data was checked
    // for it: Gym 7 is itself a forced double, so the report's own singles-only
    // reading of it is unreliable regardless of the other two effects.
    expect(tateAndLiza1.forcedDouble).toBe(true)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: tateAndLiza1,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.isTrickRoomActive).toBe(true)
    expect(report.isInverseBattleActive).toBe(true)
    expect(report.isForcedDouble).toBe(true)
    expect(report.speedTierNote).toBe(TRICK_ROOM_SPEED_TIER_NOTE)
    // Ascending (lowest Speed first), not descending -- confirms buildMatchupReport
    // actually threads isTrickRoomActive into speedTiers's own reversal, not just
    // that the flag and the note are set independently of the ordering.
    for (let i = 1; i < report.speedTiers.length; i++) {
      expect(report.speedTiers[i].speed).toBeGreaterThanOrEqual(report.speedTiers[i - 1].speed)
    }
  })

  it(
    'TRAINER_TATE_AND_LIZA_1: the damage comparison guards the engine call itself, not just the flag -- ' +
      'a field whose isInverseBattleFlagSet is set correctly but never reaches calculateMoveDamage would still ' +
      'pass every isInverseBattleActive/isTrickRoomActive assertion above and below; only the maxRollDamage ' +
      'comparison at the end of this test would catch that disconnection',
    () => {
      const tateAndLiza1 = trainers.find((t) => t.id === 'TRAINER_TATE_AND_LIZA_1')!
      const lunatone = tateAndLiza1.parties.ace.find((m) => m.species === 'SPECIES_LUNATONE')!
      expect(lunatone).toBeDefined()
      // Re-measured directly rather than assumed: Body Slam is TYPE_NORMAL, Lunatone
      // is ROCK/PSYCHIC, and TYPE_NORMAL->TYPE_ROCK is 0.5 forward (types.json) and
      // 2.0 inverse (typesInverse.json) -- an unambiguous, easily-checked direction.
      expect(movesById.get('MOVE_BODY_SLAM')?.type).toBe('TYPE_NORMAL')
      expect(speciesById.get('SPECIES_LUNATONE')?.types).toEqual(['TYPE_ROCK', 'TYPE_PSYCHIC'])
      expect(typeChart.NORMAL.ROCK).toBe(0.5)
      expect(inverseTypeChart.NORMAL.ROCK).toBe(2.0)

      const withRealField = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
        trainer: tateAndLiza1,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      // A caller-supplied field takes the place of the encounters.json lookup
      // entirely (MatchupReportInput.field's own doc) -- passing a plain neutral
      // field here is exactly what a caller that skipped the inverse lookup would
      // produce, and isInverseBattleActive must read FALSE for it (matchupReport.ts's
      // buildMatchupReport: the flag is read back off the field actually used, not
      // re-derived from encounters.json independently -- otherwise the banner would
      // claim an inversion these numbers don't have).
      const withNeutralField = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
        trainer: tateAndLiza1,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
        field: neutralField(),
      })
      expect(withRealField.isInverseBattleActive).toBe(true)
      expect(withNeutralField.isInverseBattleActive).toBe(false)

      const lunatoneInverse = withRealField.mons.find((m) => m.speciesId === 'SPECIES_LUNATONE')!
      const lunatoneNeutral = withNeutralField.mons.find((m) => m.speciesId === 'SPECIES_LUNATONE')!
      const bodySlamInverse = lunatoneInverse.yourMoves.find((m) => m.moveId === 'MOVE_BODY_SLAM')!
      const bodySlamNeutral = lunatoneNeutral.yourMoves.find((m) => m.moveId === 'MOVE_BODY_SLAM')!

      expect(bodySlamInverse.maxRollDamage).not.toBeNull()
      expect(bodySlamNeutral.maxRollDamage).not.toBeNull()
      // The load-bearing assertion: the SAME move against the SAME mon produces a
      // HIGHER max roll once the inverse chart is actually wired into the engine
      // call, not just reflected in the flag.
      expect(bodySlamInverse.maxRollDamage!).toBeGreaterThan(bodySlamNeutral.maxRollDamage!)
    },
  )

  it('TRAINER_TATE_AND_LIZA_3 (the rematch): Trick Room AND forced-double, no Inverse Battle', () => {
    // The rematch is still a double (forcedDouble is per-trainer, unrelated to which
    // field effects that trainer's own script happens to set) -- confirming this
    // combination exists in real data, not just the all-three case above and the
    // ordinary-trainer case below.
    const rematch = trainers.find((t) => t.id === 'TRAINER_TATE_AND_LIZA_3')!
    expect(rematch.forcedDouble).toBe(true)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: rematch,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.isTrickRoomActive).toBe(true)
    expect(report.isInverseBattleActive).toBe(false)
    expect(report.isForcedDouble).toBe(true)
  })

  it('an ordinary trainer (TRAINER_SAWYER_1): neither effect active, not a forced double', () => {
    expect(sawyer.forcedDouble).toBe(false)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.isTrickRoomActive).toBe(false)
    expect(report.isInverseBattleActive).toBe(false)
    expect(report.isForcedDouble).toBe(false)
    expect(report.speedTierNote).toBe(SPEED_TIER_CAVEAT)
  })

  it('isForcedDouble is a general trainer-data passthrough, not special-cased to Gym 7', () => {
    // Measured directly rather than special-cased: 78 of 932 trainers carry
    // forcedDouble, and 74 of those have at least one non-empty party tier (932-37
    // all-tiers-empty trainers = 895 usable; matches the plan's own "895 ace
    // parties" figure). Spot-check one unrelated forced-double trainer to confirm
    // this isn't wired to Tate & Liza specifically.
    const forcedDoubleTrainers = trainers.filter((t) => t.forcedDouble)
    expect(forcedDoubleTrainers.length).toBe(78)
    const usable = (t: Trainer) => t.parties.ace.length > 0 || t.parties.elite.length > 0 || t.parties.hell.length > 0
    expect(forcedDoubleTrainers.filter(usable).length).toBe(74)

    const gabbyAndTy = trainers.find((t) => t.id === 'TRAINER_GABBY_AND_TY_1')!
    expect(gabbyAndTy.forcedDouble).toBe(true)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: gabbyAndTy,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    expect(report.isForcedDouble).toBe(true)
  })
})

describe('neutralField / MATCHUP_REPORT_CAVEATS', () => {
  it('starts from a neutral, turn-one field', () => {
    const field = neutralField()
    expect(field.weather).toBe('NONE')
    expect(field.isInverseRoomActive).toBe(false)
    expect(field.isWonderRoomActive).toBe(false)
  })

  it('is a non-empty, printable list -- the plan requires caveats on the page, not buried in a comment', () => {
    expect(MATCHUP_REPORT_CAVEATS.length).toBeGreaterThan(0)
    for (const c of MATCHUP_REPORT_CAVEATS) expect(typeof c).toBe('string')
  })
})

// Sanity check on the fixture itself, so a future data regeneration that changes
// TRAINER_SAWYER_1's roster fails loudly here instead of silently invalidating the
// Double Edge/Chilan Berry test above.
describe('fixture sanity', () => {
  it('TRAINER_SAWYER_1 still has a Marowak with Double Edge', () => {
    expect(marowak).toBeDefined()
    expect(marowak.moves).toContain('MOVE_DOUBLE_EDGE')
    expect(movesById.get('MOVE_DOUBLE_EDGE')?.type).toBe('TYPE_NORMAL')
  })
})
