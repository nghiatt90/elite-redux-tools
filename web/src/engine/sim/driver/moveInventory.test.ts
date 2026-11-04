/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST,
  MOVE_INVENTORY_DOC_PATH,
  buildEliteTrainerIndex,
  buildUnportedGroups,
  formatUnportedGroup,
  generateMoveInventoryDoc,
  flagHasTestEvidence,
  loadFlagMetadata,
  loadMoveBehaviors,
  loadMoves,
  parseScripts,
  runInventory,
  stripComments,
  type InventoryAllowlistEntry,
  type MoveRecord,
  type TrainerRecord,
} from './moveInventory'

const moves = loadMoves()
const behaviors = loadMoveBehaviors()
const scripts = parseScripts()
const result = runInventory(moves, behaviors, { scripts })

const MOVE_EFFECT_PAIRS = 888
const SECONDARY_EFFECT_PAIRS = 314
const FLAG_PAIRS = 2099
const LEGACY_SCRIPT_PAIRS = 600
const DISTINCT_SCRIPTS = 322
const DISTINCT_FLAG_KEYS = 42

/** Pinned today -- this number should only go DOWN. */
export const UNPORTED_PAIR_COUNT = 2296

/** Pinned today -- this number should only go DOWN. */
export const REGISTERED_UNTESTED_PAIR_COUNT = 2016

/** Pinned today at 0 -- this number should only go DOWN. */
export const UNCLASSIFIED_PAIR_COUNT = 0

describe('move completeness inventory', () => {
  it('loads moves.json (excluding MOVE_NONE) and enumerates every unit kind', () => {
    expect(moves).toHaveLength(1031)
    expect(moves.some((move) => move.id === 'MOVE_NONE')).toBe(false)

    const count = (kind: string) => result.units.filter((unit) => unit.kind === kind).length
    expect(count('move-effect')).toBe(MOVE_EFFECT_PAIRS)
    expect(count('secondary-effect')).toBe(SECONDARY_EFFECT_PAIRS)
    expect(count('flag')).toBe(FLAG_PAIRS)
    expect(count('legacy-script')).toBe(LEGACY_SCRIPT_PAIRS)

    expect(result.scripts).toHaveLength(DISTINCT_SCRIPTS)
    expect(new Set(result.units.filter((unit) => unit.kind === 'flag').map((unit) => unit.unit)).size).toBe(
      DISTINCT_FLAG_KEYS,
    )
  })

  it('every (move, unit) pair is classified exactly once as ported / unported / unclassified / allowlisted', () => {
    expect(result.totalDefined).toBe(result.units.length)
    expect(
      result.totalPorted + result.totalUnported + result.totalUnclassified + result.totalAllowlisted,
    ).toBe(result.totalDefined)
    for (const unit of result.units) {
      expect(['ported', 'unported', 'unclassified', 'allowlisted']).toContain(unit.status)
      if (unit.status === 'unported') {
        // registered-but-untested is a sub-count of unported, never a separate status.
        expect(typeof unit.registeredUntested).toBe('boolean')
      } else {
        expect(unit.registeredUntested).toBe(false)
      }
    }
    for (const summary of result.summaries) {
      expect(summary.ported + summary.unported + summary.unclassified + summary.allowlisted).toBe(summary.defined)
      expect(summary.registeredUntested).toBeLessThanOrEqual(summary.unported)
    }
  })

  it('reports the current unported pair count -- this number should only go DOWN', () => {
    expect(result.totalUnported).toBe(UNPORTED_PAIR_COUNT)
  })

  it('reports the current registered-but-untested pair count -- this number should only go DOWN', () => {
    expect(result.totalRegisteredUntested).toBe(REGISTERED_UNTESTED_PAIR_COUNT)
  })

  it('reports the current unclassified pair count -- this number should only go DOWN', () => {
    expect(result.totalUnclassified).toBe(UNCLASSIFIED_PAIR_COUNT)
  })

  it('validates every allowlist citation format and that allowlisted pairs cite upstream code', () => {
    const citationRegex = /\.(?:c|cc|h|s|pory|inc):\d+/
    for (const entry of DEFAULT_ALLOWLIST) {
      expect(entry.citation).toMatch(citationRegex)
    }
    const allowlisted = result.units.filter((unit) => unit.status === 'allowlisted')
    expect(allowlisted.length).toBeGreaterThan(0)
    for (const unit of allowlisted) {
      expect(unit.citation).toMatch(citationRegex)
    }
  })

  it('synthetic allowlist: an allowlisted fabricated effect is excluded from unported and counted as allowlisted', () => {
    const fabricatedMove: MoveRecord = {
      id: 'MOVE_FABRICATED_ALLOWLIST',
      effect: 'EFFECT_FABRICATED_ALLOWLIST',
      power: 10,
      customBehavior: { legacyConfig: 'BattleScript_EffectHit' },
    }
    const baseline = runInventory([fabricatedMove], {}, {
      productionSource: '',
      testSource: '',
      scripts,
      allowlist: [],
    })
    expect(baseline.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('unported')

    const syntheticAllowlist: InventoryAllowlistEntry[] = [
      {
        kind: 'move-effect',
        unit: 'EFFECT_FABRICATED_ALLOWLIST',
        citation: 'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:9999',
      },
    ]
    const allowlisted = runInventory([fabricatedMove], {}, {
      productionSource: '',
      testSource: '',
      scripts,
      allowlist: syntheticAllowlist,
    })
    const effectUnit = allowlisted.units.find((unit) => unit.kind === 'move-effect')
    expect(effectUnit?.status).toBe('allowlisted')
    expect(effectUnit?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:9999',
    )
    // The legacy-script unit mirrors its owning effect, so both become allowlisted.
    expect(allowlisted.totalAllowlisted).toBe(2)
    expect(allowlisted.totalUnported).toBe(baseline.totalUnported - 2)
  })

  it('negative cases: unknown effect, secondary effect and flag are unported', () => {
    const fabricated: MoveRecord[] = [
      {
        id: 'MOVE_FABRICATED_UNKNOWN',
        effect: 'EFFECT_FABRICATED_UNKNOWN',
        power: 10,
        flags: { fabricatedFlag: true },
        customBehavior: {
          legacyConfig: 'BattleScript_EffectHit',
          attack: { secondaryEffects: [{ effect: 'MOVE_EFFECT_FABRICATED_UNKNOWN' }] },
        },
      },
    ]
    const fabricatedResult = runInventory(fabricated, {}, {
      productionSource: '',
      testSource: '',
      scripts,
      allowlist: [],
    })
    for (const kind of ['move-effect', 'secondary-effect', 'flag', 'legacy-script']) {
      const unit = fabricatedResult.units.find((candidate) => candidate.kind === kind)
      expect(unit?.status).toBe('unported')
    }
    expect(fabricatedResult.totalUnclassified).toBe(0)
  })

  it('negative cases: registered-but-untested, ported, comment-only and unread flags (D3)', () => {
    const move: MoveRecord = {
      id: 'MOVE_D3_REGISTERED',
      effect: 'EFFECT_D3_REGISTERED',
      customBehavior: { legacyConfig: 'BattleScript_EffectHit' },
    }
    const registeredSource = "switch (effect) { case 'EFFECT_D3_REGISTERED': break }"

    // 1. Registered in production source, named in no test -> unported + registeredUntested.
    const untested = runInventory([move], {}, {
      productionSource: registeredSource,
      testSource: '',
      scripts,
      allowlist: [],
    })
    const untestedEffect = untested.units.find((unit) => unit.kind === 'move-effect')
    expect(untestedEffect?.status).toBe('unported')
    expect(untestedEffect?.registeredUntested).toBe(true)
    expect(untested.totalRegisteredUntested).toBeGreaterThan(0)
    expect(untested.totalUnported).toBeGreaterThan(0)

    // 2. Named in both -> ported.
    const both = runInventory([move], {}, {
      productionSource: registeredSource,
      testSource: 'calculateMoveDamage(EFFECT_D3_REGISTERED)',
      scripts,
      allowlist: [],
    })
    expect(both.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('ported')

    // 3. Named only inside a comment -> not ported. `runInventory` receives the already
    // stripped text; `stripComments` is the pure helper that removes the mention.
    const commented = stripComments(
      "// case 'EFFECT_D3_REGISTERED':\n/* === 'EFFECT_D3_REGISTERED' */\nconst unrelated = 1",
    )
    expect(commented).not.toContain('EFFECT_D3_REGISTERED')
    const commentOnly = runInventory([move], {}, {
      productionSource: commented,
      testSource: '',
      scripts,
      allowlist: [],
    })
    const commentOnlyEffect = commentOnly.units.find((unit) => unit.kind === 'move-effect')
    expect(commentOnlyEffect?.status).toBe('unported')
    expect(commentOnlyEffect?.registeredUntested).toBe(false)

    // 4. A flag read in production but never named in a test -> registeredUntested;
    // a flag never read -> unported with no production path.
    const flagMove: MoveRecord = {
      id: 'MOVE_D3_FLAG',
      effect: 'EFFECT_D3_FLAG',
      flags: { d3SyntheticFlag: true },
    }
    const readFlag = runInventory([flagMove], {}, {
      productionSource: 'if (move.flags.d3SyntheticFlag) return true',
      testSource: '',
      scripts,
      allowlist: [],
    })
    const readUnit = readFlag.units.find((unit) => unit.kind === 'flag')
    expect(readUnit?.status).toBe('unported')
    expect(readUnit?.registeredUntested).toBe(true)

    const unreadFlag = runInventory([flagMove], {}, {
      productionSource: 'const unrelated = 1',
      testSource: '',
      scripts,
      allowlist: [],
    })
    const unreadUnit = unreadFlag.units.find((unit) => unit.kind === 'flag')
    expect(unreadUnit?.status).toBe('unported')
    expect(unreadUnit?.registeredUntested).toBe(false)
  })

  it('flags need property/helper test evidence, not a bare quoted mention (D5)', () => {
    expect(flagHasTestEvidence('sound', 'const move = { flags: { sound: true } }')).toBe(true)
    expect(flagHasTestEvidence('sound', 'if (move.flags.sound) {')).toBe(true)
    expect(flagHasTestEvidence('sound', "hasMoveFlag(mon, 'sound')")).toBe(true)
    expect(flagHasTestEvidence('sound', "a description that says 'sound' in prose")).toBe(false)
  })

  it('anchors the four hand-derived move behaviors (D2)', () => {
    // 1. EFFECT_SLEEP's legacy script.
    expect(behaviors.EFFECT_SLEEP?.legacyConfig).toBe('BattleScript_EffectSleep')

    // 2. EFFECT_BURN_HIT: one attack block whose only secondary is MOVE_EFFECT_BURN,
    // generated as `setmoveeffect MOVE_EFFECT_BURN; goto BattleScript_EffectHit`
    // (MoveScriptGenerator.kt:76-82).
    const burnHitSecondaries = behaviors.EFFECT_BURN_HIT?.attack?.secondaryEffects ?? []
    expect(burnHitSecondaries.map((secondary) => secondary.effect)).toEqual(['MOVE_EFFECT_BURN'])

    // 3. EFFECT_HIT is plain damage: no attack secondaryEffects, BattleScript_EffectHit,
    // and no move with EFFECT_HIT produces a secondary-effect unit.
    expect(behaviors.EFFECT_HIT?.attack?.secondaryEffects).toBeUndefined()
    expect(behaviors.EFFECT_HIT?.legacyConfig).toBe('BattleScript_EffectHit')
    const hitMoves = moves.filter((move) => move.effect === 'EFFECT_HIT')
    expect(hitMoves.length).toBeGreaterThan(0)
    for (const move of hitMoves) {
      expect(
        result.units.some((unit) => unit.kind === 'secondary-effect' && unit.moveId === move.id),
      ).toBe(false)
    }

    // 4. MOVE_ACID's inline customBehavior overrides its effect's behavior; the only
    // secondary-effect unit is MOVE_EFFECT_SP_DEF_MINUS_1.
    const acid = moves.find((move) => move.id === 'MOVE_ACID')
    expect(acid?.effect ?? null).toBeNull()
    expect(acid?.customBehavior?.attack?.secondaryEffects?.map((secondary) => secondary.effect)).toEqual([
      'MOVE_EFFECT_SP_DEF_MINUS_1',
    ])
    const acidSecondaries = result.units.filter(
      (unit) => unit.kind === 'secondary-effect' && unit.moveId === 'MOVE_ACID',
    )
    expect(acidSecondaries.map((unit) => unit.unit)).toEqual(['MOVE_EFFECT_SP_DEF_MINUS_1'])
  })

  it('groups unported units and reports elite-tier trainers, collapsing lists (D1)', () => {
    const syntheticMoves: MoveRecord[] = Array.from({ length: 20 }, (_, index) => ({
      id: `MOVE_SYNTH_${String(index).padStart(2, '0')}`,
      effect: 'EFFECT_SYNTH_GROUP',
      customBehavior: { legacyConfig: 'BattleScript_EffectHit' },
    }))
    const syntheticResult = runInventory(syntheticMoves, {}, {
      productionSource: '',
      testSource: '',
      scripts,
      allowlist: [],
    })
    const trainers: TrainerRecord[] = [
      {
        id: 'TRAINER_SYNTH_B',
        parties: { elite: [{ moves: ['MOVE_SYNTH_00', 'MOVE_SYNTH_01'] }], ace: [{ moves: ['MOVE_SYNTH_00'] }] },
      },
      { id: 'TRAINER_SYNTH_A', parties: { elite: [{ moves: ['MOVE_SYNTH_19'] }] } },
      { id: 'TRAINER_SYNTH_ACE_ONLY', parties: { ace: [{ moves: ['MOVE_SYNTH_02'] }] } },
    ]
    const groups = buildUnportedGroups(syntheticResult, buildEliteTrainerIndex(trainers))
    const group = groups.find((candidate) => candidate.kind === 'move-effect' && candidate.unit === 'EFFECT_SYNTH_GROUP')
    expect(group?.moveIds).toHaveLength(20)
    expect(group?.trainerIds).toEqual(['TRAINER_SYNTH_A', 'TRAINER_SYNTH_B'])
    expect(group?.trainerIds).not.toContain('TRAINER_SYNTH_ACE_ONLY')

    const line = formatUnportedGroup(group!)
    expect(line).toContain('20 moves (first 15)')
    expect(line).toContain('MOVE_SYNTH_14')
    expect(line).not.toContain('MOVE_SYNTH_15')
    expect(line).toContain('2 elite-tier trainers')
    expect(line).toContain('TRAINER_SYNTH_A')
  })

  it('script parser detects direct and delegated damage steps', () => {
    const effectHit = scripts.get('BattleScript_EffectHit')
    expect(effectHit?.hasDamageStep).toBe(true)
    expect(effectHit?.commands).toContain('damagecalc')

    // No local damage command: delegates with `goto BattleScript_EffectHit`.
    const argumentHit = scripts.get('BattleScript_EffectArgumentHit')
    expect(argumentHit?.commands.some((command) => command.startsWith('goto BattleScript_EffectHit'))).toBe(true)
    expect(argumentHit?.hasDamageStep).toBe(true)

    // `typecalc` is a damage step in its own right.
    expect(scripts.get('BattleScript_EffectRecoilIfMiss')?.hasDamageStep).toBe(true)

    // Defog's script never damages; the power>1 warning relies on this being false.
    expect(scripts.get('BattleScript_EffectDefog')?.hasDamageStep).toBe(false)
  })

  it('flags moves with power above 1 whose script has no damage step', () => {
    expect(result.powerWarnings.map((warning) => warning.moveId).sort()).toEqual([
      'MOVE_DOOM_DESIRE',
      'MOVE_FUTURE_SIGHT',
      'MOVE_SQUALL_HAMMER',
    ])
    for (const warning of result.powerWarnings) {
      expect(warning.power).toBeGreaterThan(1)
      expect(warning.script).toBeTruthy()
    }
  })

  it('anchors known ported / allowlisted / unported classifications', () => {
    const effectUnit = (moveId: string) =>
      result.units.find((unit) => unit.kind === 'move-effect' && unit.moveId === moveId)
    expect(effectUnit('MOVE_REST')?.unit).toBe('EFFECT_REST')
    expect(effectUnit('MOVE_REST')?.status).toBe('ported')
    expect(effectUnit('MOVE_HELPING_HAND')?.status).toBe('allowlisted')
    expect(effectUnit('MOVE_ASSURANCE')?.status).toBe('unported')

    const flagUnit = (moveId: string, flag: string) =>
      result.units.find((unit) => unit.kind === 'flag' && unit.moveId === moveId && unit.unit === flag)
    expect(flagUnit('MOVE_BITE', 'biteBased')?.status).toBe('ported')
    expect(flagUnit('MOVE_HYPER_VOICE', 'sound')?.status).toBe('ported')
    expect(flagUnit('MOVE_BLOOD_MOON', 'lunarBased')?.status).toBe('unported')

    const secondary = result.units.find(
      (unit) => unit.kind === 'secondary-effect' && unit.moveId === 'MOVE_CORROSIVE_GAS',
    )
    expect(secondary?.unit).toBe('MOVE_EFFECT_KNOCK_OFF')
    expect(secondary?.status).toBe('ported')

    const flagMetadata = loadFlagMetadata()
    expect(flagMetadata.get('ignoresStatStages')?.citation).toContain(
      'pipeline/.upstream/eliteredux-source/include/constants/pokemon.h:',
    )
    expect(flagMetadata.get('ignoresStatStages')?.citation).toContain(
      'pipeline/.upstream/er-config/MoveList.proto:',
    )
  })

  it('legacy-script units always mirror their owning move effect status', () => {
    const effectStatusByMove = new Map(
      result.units
        .filter((unit) => unit.kind === 'move-effect')
        .map((unit) => [unit.moveId, unit.status]),
    )
    for (const unit of result.units.filter((candidate) => candidate.kind === 'legacy-script')) {
      expect(unit.status).toBe(effectStatusByMove.get(unit.moveId))
    }
  })

  it('generates deterministic markdown and compares it with the committed doc (or writes with SIM_INVENTORY_WRITE=1)', () => {
    const generated = generateMoveInventoryDoc(result)
    expect(generateMoveInventoryDoc(result)).toBe(generated)

    if (process.env.SIM_INVENTORY_WRITE === '1') {
      writeFileSync(MOVE_INVENTORY_DOC_PATH, generated, 'utf-8')
      console.log(`Wrote move inventory doc to ${MOVE_INVENTORY_DOC_PATH}`)
    }

    expect(existsSync(MOVE_INVENTORY_DOC_PATH)).toBe(true)
    expect(readFileSync(MOVE_INVENTORY_DOC_PATH, 'utf-8')).toBe(generated)
  })
})
