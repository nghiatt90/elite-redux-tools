/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST,
  MOVE_INVENTORY_DOC_PATH,
  buildEliteTrainerIndex,
  buildUnportedGroups,
  formatUnportedGroup,
  generateMoveInventoryDoc,
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
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const result = runInventory(moves, behaviors, { scripts })

const MOVE_EFFECT_PAIRS = 888
const SECONDARY_EFFECT_PAIRS = 314
const LEGACY_SCRIPT_PAIRS = 600
const EFFECT_LESS_PAIRS = 143
const TOTAL_PAIRS = 1945
const DISTINCT_SCRIPTS = 322

/**
 * Pinned today -- this number should only go DOWN.
 *
 * Cycle 151c: 1530 -> 1456. Two classifier defects were fixed with no sim change:
 *   - five presentation-only opcodes (`playanimation` :4066, `setgraphicalstatchangevalues`
 *     :4138, `playstatchangeanimation` :4263 -> `PlayStatChangeAnimation` :4172,
 *     `status2animation` :5928, `updatestatusicon` :10431) now count as frame opcodes;
 *   - `MOVE_EFFECT_AFFECTS_USER` / `MOVE_EFFECT_CERTAIN` no longer count as effects of a
 *     `setmoveeffect` (they are modifier bits, `MoveEffectGenerator.kt:21-22`), so Close
 *     Combat's `MOVE_EFFECT_DEF_SPDEF_DOWN | ...` is handled.
 * 74 legacy-script pairs (54 distinct script labels) became ported. Three labels that were
 * non-skeleton opcode gaps instead became registered-but-untested -- all their commands are
 * now handled, but no qualifying block names them: `BattleScript_EffectCalmMind`,
 * `BattleScript_EffectMistyTerrain`, `BattleScript_EffectPsychicTerrain`.
 *
 * Cycle 151b rework 2: 132 -> 1535. The rise is measurement, not a regression. The old
 * classifier let a script's non-skeleton commands ride on the owning effect's production
 * path (`if (effectImplemented) continue`), hiding every opcode the sim does not execute;
 * it also counted a flag as tested whenever a block merely ran any move carrying it. The
 * script now needs every non-skeleton opcode at an opcode-specific site
 * (`SCRIPT_OPCODE_HANDLERS`) and a flag needs the flag read (key or reading ability/effect)
 * in the block, so the genuine gaps show: `openpartyscreen` / `makeinvisible`, the
 * explicitly unmodelled `manipulatedamage` / `tryroomservice` / `trytoclearprimalweather`,
 * and the argument/word plumbing (`argumenttomoveeffect`, `copyword`, `callifability`)
 * plus the still-unported attack/move/item micro-ops listed in the generated doc. Most of
 * the delta is flag pairs: tests that run one carrier move no longer prove a flag.
 *
 * Cycle 151d: 1456 -> 1442. `parseScripts` no longer takes a label inside a dead `.if`
 * branch as the definition (`BattleScript_EffectBeatUp` resolves to the live :5775 body),
 * and `manipulatedamage` is handled per operand (DMG_TO_HP_FROM_MOVE / DMG_BIG_ROOT /
 * DMG_TO_HP_FROM_ABILITY / DMG_RECOIL_FROM_MISS). 14 legacy-script pairs became ported:
 * Beat Up plus the 13 `BattleScript_EffectAbsorb` drain moves.
 *
 * Cycle 151e: the `flag` unit kind was removed. A flag is a data attribute read by other
 * units' mechanics (abilities, effects), which are inventoried already; text-matching flag
 * evidence was the noisiest part of the inventory (2099 of 4044 pairs), so the kind, its
 * classifier and its pins are gone. `TOTAL_PAIRS` and both unported counts drop accordingly:
 * 1442 -> 239 unported (the flag kind contributed 1203 unported pairs), with 1945 pairs total.
 *
 * Cycle 150ibcd3: 237 -> 236. The flag-consumer sweep's Leafage block in
 * `cycle150ibcd3FlagConsumers.test.ts` (Chestnut Axe grants KEEN_EDGE, so Sinister Claws
 * drops the target's SpD) names an effect-less move, so its pair became ported.
 */
export const UNPORTED_PAIR_COUNT = 236

/**
 * Pinned today -- this number should only go DOWN. Cycle 151b rework 2: 124 -> 1315. The
 * flag rule now requires the flag key or a reading ability/effect, so the 2099 flag pairs
 * are mostly registered-but-untested: production reads the flag, but no qualifying block
 * names the key or the reader. The rest are effect-less damage moves and the legacy scripts
 * whose commands are all handled but which no test names. Cycle 151c: 1310 -> 1314 -- the
 * three legacy-script labels above (`BattleScript_EffectCalmMind`, `...MistyTerrain`,
 * `...PsychicTerrain`) moved from opcode gaps to registered-but-untested. Cycle 151e removes
 * the flag kind and its 2099 pairs, so the pin drops to the non-flag remainder: 1314 -> 119
 * (the flag kind contributed 1195 registered-but-untested pairs). Cycle 150ibcd3: 117 -> 116 --
 * the new Leafage block above is the only change, leaving the `<effect-less>` list at 85.
 */
export const REGISTERED_UNTESTED_PAIR_COUNT = 116

/** Pinned today at 0 -- this number should only go DOWN. */
export const UNCLASSIFIED_PAIR_COUNT = 0

describe('move completeness inventory', () => {
  it('loads moves.json (excluding MOVE_NONE) and enumerates every unit kind', () => {
    expect(moves).toHaveLength(1031)
    expect(moves.some((move) => move.id === 'MOVE_NONE')).toBe(false)

    const count = (kind: string) => result.units.filter((unit) => unit.kind === kind).length
    expect(count('move-effect')).toBe(MOVE_EFFECT_PAIRS)
    expect(count('secondary-effect')).toBe(SECONDARY_EFFECT_PAIRS)
    expect(count('legacy-script')).toBe(LEGACY_SCRIPT_PAIRS)
    expect(count('effect-less')).toBe(EFFECT_LESS_PAIRS)
    expect(result.units).toHaveLength(TOTAL_PAIRS)
    expect(result.summaries.map((summary) => summary.kind)).toEqual([
      'move-effect',
      'secondary-effect',
      'legacy-script',
      'effect-less',
    ])

    expect(result.scripts).toHaveLength(DISTINCT_SCRIPTS)
    expect(result.units.some((unit) => (unit.kind as string) === 'flag')).toBe(false)
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

  it('every citation names an existing upstream file and a line inside it', () => {
    const citations = new Set<string>()
    for (const unit of result.units) if (unit.citation) citations.add(unit.citation)
    for (const entry of DEFAULT_ALLOWLIST) citations.add(entry.citation)
    const lineCounts = new Map<string, number>()
    const countLines = (file: string): number => {
      const cached = lineCounts.get(file)
      if (cached !== undefined) return cached
      const count = readFileSync(file, 'utf-8').split('\n').length
      lineCounts.set(file, count)
      return count
    }
    for (const citation of citations) {
      for (const part of citation.split('; ')) {
        const match = part.match(/^(pipeline\/\.upstream\/.+):(\d+)$/)
        expect(match, part).not.toBeNull()
        const file = resolve(REPO_ROOT, match![1])
        const line = Number(match![2])
        expect(existsSync(file), file).toBe(true)
        expect(line).toBeGreaterThanOrEqual(1)
        expect(line, `${file}:${line}`).toBeLessThanOrEqual(countLines(file))
      }
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

  it('negative cases: unknown effect and secondary effect are unported, and a fabricated flag yields no unit', () => {
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
    for (const kind of ['move-effect', 'secondary-effect', 'legacy-script']) {
      const unit = fabricatedResult.units.find((candidate) => candidate.kind === kind)
      expect(unit?.status).toBe('unported')
    }
    // A fabricated flag produces no unit at all: the `flag` kind was removed in cycle 151e.
    expect(fabricatedResult.units.some((candidate) => (candidate.kind as string) === 'flag')).toBe(false)
    expect(fabricatedResult.units.filter((candidate) => candidate.moveId === 'MOVE_FABRICATED_UNKNOWN')).toHaveLength(3)
    expect(fabricatedResult.totalUnclassified).toBe(0)
  })

  it('negative cases: registered-but-untested, ported and comment-only (D3)', () => {
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
      // A qualifying block: `it(...)` whose body calls the move pipeline and names the effect.
      testSource: "it('d3', () => { calculateMoveDamage('EFFECT_D3_REGISTERED') })",
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
    // Declarative `attack.damage` behaviour (field, not an `EFFECT_*` key) counts as a port.
    expect(effectUnit('MOVE_ASSURANCE')?.status).toBe('ported')
    // Belch's script is cased in hitScripts.ts (runLegacyPreHit), so the effect has its own
    // port; the plain-hit chain is only the site for effects with no extra step (item 1).
    expect(effectUnit('MOVE_BELCH')?.status).toBe('ported')

    const secondary = result.units.find(
      (unit) => unit.kind === 'secondary-effect' && unit.moveId === 'MOVE_CORROSIVE_GAS',
    )
    expect(secondary?.unit).toBe('MOVE_EFFECT_KNOCK_OFF')
    expect(secondary?.status).toBe('ported')

    // Argument-driven: MOVE_INCITE's `argument.effect` is MOVE_EFFECT_ENRAGE, dispatched by
    // handleThirdType through applyPrimaryStatusEffect's explicit case (every carrier served).
    const incite = result.units.find(
      (unit) => unit.kind === 'secondary-effect' && unit.moveId === 'MOVE_INCITE',
    )
    expect(incite?.unit).toBe('MOVE_EFFECT_ENRAGE')
    expect(incite?.status).toBe('ported')
  })

  it('legacy-script units map independently of their owning move effect', () => {
    const effectStatusByMove = new Map(
      result.units
        .filter((unit) => unit.kind === 'move-effect')
        .map((unit) => [unit.moveId, unit.status]),
    )
    const scripts = result.units.filter((unit) => unit.kind === 'legacy-script')
    const diverging = scripts.filter((unit) => unit.status !== effectStatusByMove.get(unit.moveId))
    // A script is not a mirror. `BattleScript_EffectRest` is a real port (handleRest
    // follows the script command by command), so the divergence is Calm Mind: its effect is
    // tested by name (`EFFECT_CALM_MIND` in a qualifying block) while its script is only
    // registered-but-untested. Cycle 151c moved `playstatchangeanimation` to the frame set
    // (presentation only), so the script no longer has an opcode gap; what remains is the
    // absence of a qualifying block naming `BattleScript_EffectCalmMind`.
    expect(diverging.length).toBeGreaterThan(0)
    const calmMindScript = scripts.find((unit) => unit.moveId === 'MOVE_CALM_MIND')
    expect(calmMindScript?.unit).toBe('BattleScript_EffectCalmMind')
    expect(calmMindScript?.status).toBe('unported')
    expect(calmMindScript?.registeredUntested).toBe(true)
    expect(effectStatusByMove.get('MOVE_CALM_MIND')).toBe('ported')
    // Scripts are still classified on their own: 446 of the 600 legacy-script pairs are
    // ported today, so the divergence above is not an artefact of scripts being ignored.
    expect(scripts.some((unit) => unit.status === 'ported')).toBe(true)
  })

  it('every move id appears somewhere in result.units', () => {
    const moveIds = new Set(result.units.map((unit) => unit.moveId))
    expect(moves.filter((move) => !moveIds.has(move.id)).map((move) => move.id)).toEqual([])
    // MOVE_TEMPEST_STORM has `effect: null`; it used to yield zero units (cycle 151 report).
    expect(result.units.filter((unit) => unit.moveId === 'MOVE_TEMPEST_STORM').map((unit) => unit.kind)).toContain(
      'effect-less',
    )
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
