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
import { buildFormIndex } from './formResolution'
import {
  buildEnemyBattlerState,
  buildMatchupReport,
  MATCHUP_REPORT_CAVEATS,
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
  formIndex: buildFormIndex(species),
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

  it(
    "2026-09-15: Metal Burst/Comeuppance (power=0, the EARLY-RETURN branch) carry the same real-damage-not-modelled " +
      "note as Counter/Mirror Coat/Bide above, not a bare unexplained dash -- the exact divergence a review caught " +
      "between this file and basePower.ts after that file added EFFECT_METAL_BURST to its own sets first",
    () => {
      // Re-measured directly: Metal Burst/Comeuppance declare power 0, so they take
      // evaluateMoveEntry's `!move.power` early-return branch, unlike the power=1
      // moves above.
      for (const id of ['MOVE_METAL_BURST', 'MOVE_COMEUPPANCE']) expect(movesById.get(id)?.power).toBe(0)

      const trainer: Trainer = {
        id: 'TRAINER_TEST_METAL_BURST',
        trainerNum: 3,
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
              moves: ['MOVE_METAL_BURST', 'MOVE_COMEUPPANCE', 'MOVE_SQUALL_HAMMER', 'MOVE_NONE'],
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
      for (const moveId of ['MOVE_METAL_BURST', 'MOVE_COMEUPPANCE']) {
        const entry = mon.itsMoves.find((m) => m.moveId === moveId)!
        expect(entry.maxRollDamage, `${moveId} maxRollDamage`).toBeNull()
        expect(entry.unmodelled, `${moveId} unmodelled`).toContain(
          `${moveId}: real damage not modelled (unported battle-script effect -- see matchupReport.ts's TRUE_DAMAGE_UNAVAILABLE_* doc)`,
        )
      }

      // Squall Hammer is NOT in TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS -- its real
      // damage is a script-confirmed ZERO (EFFECT_DEFOG), not "exists but
      // uncomputed", so "real damage not modelled" would be the exact mislabel
      // a review caught and had already been removed from basePower.ts's own
      // calculator warning. It's gated instead through the imported
      // ZERO_DAMAGE_BASE_POWER_MOVE_IDS, and its note comes from the ENGINE's
      // own result.unmodelled (calculateMoveDamage actually ran, power=95 took
      // the normal path, not the early return) rather than a report-level
      // append -- so no "TRUE_DAMAGE_UNAVAILABLE_*" text appears for it at all.
      const squallHammer = mon.itsMoves.find((m) => m.moveId === 'MOVE_SQUALL_HAMMER')!
      expect(squallHammer.maxRollDamage, 'MOVE_SQUALL_HAMMER maxRollDamage').toBeNull()
      // Keyed by MOVE ID, not effect (ZERO_DAMAGE_BASE_POWER_MOVE_IDS, not
      // ZERO_DAMAGE_BASE_POWER_EFFECTS -- EFFECT_DEFOG itself stays out of the
      // effect-keyed set specifically so Defog isn't caught by it), so the
      // message names the move, not the effect.
      expect(squallHammer.unmodelled, 'MOVE_SQUALL_HAMMER unmodelled').toContain('MOVE_SQUALL_HAMMER: its battle script deals no damage in this build')
      expect(squallHammer.unmodelled.join(' ')).not.toContain('TRUE_DAMAGE_UNAVAILABLE')
    },
  )

  it(
    'MOVE_AIRBORNE_SLAM and MOVE_FETCH (power=0, the early-return branch) carry the SAME zero-damage note the ' +
      "engine's own calculateMoveDamage call would produce for them -- built inline since that branch never calls " +
      'calculateMoveDamage at all, so there is no result.unmodelled to draw the message from',
    () => {
      for (const id of ['MOVE_AIRBORNE_SLAM', 'MOVE_FETCH']) expect(movesById.get(id)?.power).toBe(0)
      const moves = movesForMon(trainerMon({ moves: ['MOVE_AIRBORNE_SLAM', 'MOVE_FETCH', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves },
        trainer: sawyer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
      for (const moveId of ['MOVE_AIRBORNE_SLAM', 'MOVE_FETCH']) {
        const entry = marowakReport.yourMoves.find((m) => m.moveId === moveId)!
        const expectedEffect = movesById.get(moveId)?.effect
        expect(entry.maxRollDamage, `${moveId} maxRollDamage`).toBeNull()
        expect(entry.unmodelled, `${moveId} unmodelled`).toContain(`${expectedEffect}: its battle script deals no damage in this build`)
      }
    },
  )

  it(
    "MOVE_SEISMIC_TOSS carries exactly ONE unmodelled note, not two saying the same thing -- it's in BOTH this " +
      "file's TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS and basePower.ts's own UNMODELLED_BASE_POWER_MOVE_IDS, so the " +
      "engine's calculateMoveDamage call already pushes 'MOVE_SEISMIC_TOSS: not modelled' into result.unmodelled " +
      "before this file's own extra append would otherwise duplicate it",
    () => {
      const seismicTossMoves = movesForMon(trainerMon({ moves: ['MOVE_SEISMIC_TOSS', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: seismicTossMoves },
        trainer: sawyer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
      const seismicToss = marowakReport.yourMoves.find((m) => m.moveId === 'MOVE_SEISMIC_TOSS')!
      expect(seismicToss.maxRollDamage).toBeNull()
      // Unrelated ability-coverage notes (Marowak's own abilities not in the
      // manifest) also legitimately ride along in this array -- the load-bearing
      // check is that the "not modelled" text for THIS move appears exactly
      // once, not that the array is empty of anything else.
      const seismicTossNotes = seismicToss.unmodelled.filter((u) => u.includes('MOVE_SEISMIC_TOSS'))
      expect(seismicTossNotes).toEqual(['MOVE_SEISMIC_TOSS: not modelled'])
    },
  )

  it('does NOT null Defog\'s real damage (it has none -- STATUS, power 0) just because it shares an effect with Squall Hammer', () => {
    const defogMoves = movesForMon(trainerMon({ moves: ['MOVE_DEFOG', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: defogMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 57,
      ctx,
    })
    const marowakReport = report.mons.find((m) => m.speciesId === 'SPECIES_MAROWAK')!
    const defog = marowakReport.yourMoves.find((m) => m.moveId === 'MOVE_DEFOG')!
    // A genuine STATUS move: no direct damage AND nothing to warn about, same as
    // the Reflect case above -- the move-id-keyed set can't spill onto it the way
    // an effect-keyed entry would have.
    expect(defog.maxRollDamage).toBeNull()
    expect(defog.unmodelled).toEqual([])
  })

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

  // The empty-party combination (double banner + "no configured party" message,
  // per the corrected handoff note's table) couldn't be reached in a browser pass --
  // a search-input focus issue, unrelated to this batch -- so confirmed here instead,
  // cheaply: TRAINER_TATE_AND_LIZA_4 and _5 both carry forcedDouble AND have every
  // party tier empty (re-measured directly against trainers.json). This asserts the
  // two INPUTS those two render branches each read (isForcedDouble and mons === []),
  // not the render itself -- MatchupReportView.tsx's own conditionals are what turn
  // those into the double banner and the empty-party message.
  it('TRAINER_TATE_AND_LIZA_4/_5 are forced-double AND have an empty party in every tier -- the two inputs the double-banner and empty-party render branches each read', () => {
    for (const id of ['TRAINER_TATE_AND_LIZA_4', 'TRAINER_TATE_AND_LIZA_5']) {
      const trainer = trainers.find((t) => t.id === id)!
      expect(trainer.forcedDouble, `${id}.forcedDouble`).toBe(true)
      expect(trainer.parties.ace.length, `${id}.parties.ace`).toBe(0)
      expect(trainer.parties.elite.length, `${id}.parties.elite`).toBe(0)
      expect(trainer.parties.hell.length, `${id}.parties.hell`).toBe(0)

      const report = buildMatchupReport({
        player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
        trainer,
        tier: 'ace',
        playerHighestLevel: 57,
        ctx,
      })
      expect(report.isForcedDouble, `${id}.isForcedDouble`).toBe(true)
      expect(report.mons, `${id}.mons`).toEqual([])
    }
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

// Battle-sim plan step 2 (docs/battle-sim/plan.md) -- TRAINER_ARCHIE's Elite party is
// one of the real 70 mega/primal-holding slots in docs/battle-sim/boss-fight-coverage.md
// (Kyogre + Blue Orb -> Kyogre Primal), so this exercises the real reverse lookup
// through buildMatchupReport end to end, not a synthetic fixture.
describe('MatchupMonReport.itemId / transformsInto', () => {
  const archie = trainers.find((t) => t.id === 'TRAINER_ARCHIE')!
  const playerBattler = buildEnemyBattlerState(
    trainerMon({ species: 'SPECIES_SNORLAX', item: 'ITEM_CHILAN_BERRY', ability: 'ABILITY_THICK_FAT' }),
    100,
    ctx,
  )
  const playerMoves = movesForMon(trainerMon({ moves: ['MOVE_BODY_SLAM', 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'] }), movesById)

  it('reports the held item verbatim and the form a real Primal Orb resolves to', () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: archie,
      tier: 'elite',
      playerHighestLevel: 100,
      ctx,
    })
    const kyogre = report.mons.find((m) => m.speciesId === 'SPECIES_KYOGRE')!
    expect(kyogre.itemId).toBe('ITEM_BLUE_ORB')
    expect(kyogre.transformsInto).toEqual({ formId: 'SPECIES_KYOGRE_PRIMAL', kind: 'primal' })

    // The same party also carries Garchomp Redux + Garchompite R -> Garchomp Mega
    // Redux, whose base Speed genuinely differs from its mega's (110 vs. 140,
    // re-measured directly against species.json) -- unlike Kyogre/Kyogre Primal,
    // which happen to share the same base Speed and so can't tell a base-form
    // computation apart from a transformed one. This is the real regression guard for
    // "changes no number": the reported Speed must match a battler built from
    // Garchomp Redux's OWN stats, not one built as if it already were the mega,
    // since turn one is before the transformation happens (MATCHUP_REPORT_CAVEATS).
    const garchompMon = archie.parties.elite.find((m) => m.species === 'SPECIES_GARCHOMP_REDUX')!
    const garchomp = report.mons.find((m) => m.speciesId === 'SPECIES_GARCHOMP_REDUX')!
    expect(garchomp.transformsInto).toEqual({ formId: 'SPECIES_GARCHOMP_MEGA_REDUX', kind: 'mega' })
    const baseFormBattler = buildEnemyBattlerState(garchompMon, 100, ctx)
    const megaFormBattler = buildEnemyBattlerState({ ...garchompMon, species: 'SPECIES_GARCHOMP_MEGA_REDUX' }, 100, ctx)
    expect(baseFormBattler.condition.speed).not.toBe(megaFormBattler.condition.speed)
    expect(garchomp.speed).toBe(baseFormBattler.condition.speed)
  })

  it('reports null for an ordinary held item, and for ITEM_NONE', () => {
    const report = buildMatchupReport({
      player: { speciesId: 'SPECIES_SNORLAX', battler: playerBattler, moves: playerMoves },
      trainer: sawyer,
      tier: 'ace',
      playerHighestLevel: 100,
      ctx,
    })
    for (const mon of report.mons) {
      if (mon.transformsInto !== null) throw new Error(`unexpected transform for ${mon.speciesId}`)
    }
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

  // The one regression worth guarding after the 2026-09-15 browser-review color
  // split (see TRICK_ROOM_SPEED_TIER_NOTE's own doc): the priority sentence getting
  // merged back into this neutral, applied-fact-only note, which is exactly the
  // mixed-color bug that split fixed. SPEED_TIER_CAVEAT is the one that's allowed to
  // mention priority -- it's rendered unconditionally, right below this note.
  it('TRICK_ROOM_SPEED_TIER_NOTE does not re-merge the priority caveat', () => {
    expect(TRICK_ROOM_SPEED_TIER_NOTE.toLowerCase()).not.toContain('priority')
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
