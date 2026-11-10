/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildConsumptionIndex,
  loadMoveBehaviors,
  loadMoves,
  buildTestEvidence,
  handledScriptOpcodes,
  loadMoveEffectConsumerSource,
  loadProductionSource,
  loadQualifyingTestSource,
  parseScripts,
  runInventory,
  type MoveRecord,
  type MoveUnit,
  type MoveUnitStatus,
} from './driver/moveInventory'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SIM_DIR = join(REPO_ROOT, 'web/src/engine/sim')

const moves = loadMoves()
const behaviors = loadMoveBehaviors()
const scripts = parseScripts()
const REAL_CONSUMER = loadMoveEffectConsumerSource()

function moveById(id: string): MoveRecord {
  const move = moves.find((candidate) => candidate.id === id)
  if (!move) throw new Error(`missing move ${id}`)
  return move
}

/** A synthetic qualifying test block: `executeTurn` plus the named identifiers. */
function block(...names: string[]): string {
  return `it('synthetic', () => { executeTurn(); ${names.map((name) => `void '${name}'`).join('; ')} })`
}

function effectUnitFor(move: MoveRecord, consumerSource: string, testSource = ''): MoveUnit {
  const result = runInventory([move], behaviors, { consumerSource, testSource, scripts, allowlist: [] })
  const unit = result.units.find((candidate) => candidate.kind === 'move-effect' && candidate.moveId === move.id)
  if (!unit) throw new Error(`missing move-effect unit for ${move.id}`)
  return unit
}

function statusOf(move: MoveRecord, consumerSource: string, testSource = ''): MoveUnitStatus {
  return effectUnitFor(move, consumerSource, testSource).status
}

/** Replaces the brace body of the n-th `declaration` occurrence (strings skipped). */
function replaceFunctionBody(source: string, declaration: string, body: string): string {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`missing declaration ${declaration}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      i++
      while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source[i] === quote) break
        else i++
      }
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return `${source.slice(0, open)}{ ${body} }${source.slice(i + 1)}`
    }
  }
  throw new Error(`unbalanced body for ${declaration}`)
}

const realResult = runInventory(moves, behaviors, { scripts })
const statusByEffect = new Map<string, MoveUnitStatus>()
for (const unit of realResult.units) {
  if (unit.kind === 'move-effect') statusByEffect.set(unit.unit, unit.status)
}

describe('cycle 151b: a real port counts and a stub does not', () => {
  it('deleting a real HANDLERS entry makes its effect unported', () => {
    const rest = moveById('MOVE_REST')
    expect(statusOf(rest, REAL_CONSUMER)).toBe('ported')
    const mutated = REAL_CONSUMER.replace(/^\s*EFFECT_REST: handleRest,\n/m, '')
    expect(mutated).not.toBe(REAL_CONSUMER)
    const unit = effectUnitFor(rest, mutated)
    expect(unit.status).toBe('unported')
    expect(unit.registeredUntested).toBe(false)
  })

  it('a note-only handler makes its effect unported', () => {
    const taunt = moveById('MOVE_TAUNT')
    expect(statusOf(taunt, REAL_CONSUMER)).toBe('ported')
    const mutated = replaceFunctionBody(
      REAL_CONSUMER,
      'function handleTaunt(',
      "unmodelled.push('taunt not modelled')",
    )
    const unit = effectUnitFor(taunt, mutated)
    expect(unit.status).toBe('unported')
    expect(unit.registeredUntested).toBe(false)
  })

  it('no-op handlers make EFFECT_SPIKES and EFFECT_FUTURE_SIGHT unported', () => {
    const spikes = moveById('MOVE_SPIKES')
    const futureSight = moveById('MOVE_FUTURE_SIGHT')
    const futureTest = block('EFFECT_FUTURE_SIGHT')
    expect(statusOf(spikes, REAL_CONSUMER)).toBe('ported')
    expect(statusOf(futureSight, REAL_CONSUMER, futureTest)).toBe('ported')
    const noSpikes = replaceFunctionBody(REAL_CONSUMER, 'function handleSpikes(', '')
    expect(statusOf(spikes, noSpikes)).toBe('unported')
    const noFutureSight = replaceFunctionBody(REAL_CONSUMER, 'function handleFutureSight(', '')
    const unit = effectUnitFor(futureSight, noFutureSight, futureTest)
    expect(unit.status).toBe('unported')
    expect(unit.registeredUntested).toBe(false)
  })

  it('deleting a dispatched case label makes its effect unported', () => {
    const venoshock = moveById('MOVE_VENOSHOCK')
    const test = block('EFFECT_DOUBLE_DMG_IF_STATUS1')
    expect(statusOf(venoshock, REAL_CONSUMER, test)).toBe('ported')
    // Venoshock is a plain hit too, so the routing-chain entry is a production site as
    // well as basePower.ts's case. Remove both: no production site may remain.
    const mutated = REAL_CONSUMER.replace(
      "case 'EFFECT_DOUBLE_DMG_IF_STATUS1':",
      "case 'EFFECT_DOUBLE_DMG_IF_STATUS1_REMOVED':",
    ).replace("moveEffect === 'EFFECT_DOUBLE_DMG_IF_STATUS1' ||", "moveEffect === 'EFFECT_DOUBLE_DMG_IF_STATUS1_REMOVED' ||")
    expect(mutated).not.toBe(REAL_CONSUMER)
    expect(statusOf(venoshock, mutated, test)).toBe('unported')
  })

  it('a dead `&& false` comparison is not a consumption (Weather Ball)', () => {
    const ball = moveById('MOVE_WEATHER_BALL')
    const test = block('EFFECT_WEATHER_BALL')
    expect(statusOf(ball, REAL_CONSUMER, test)).toBe('ported')
    let mutated = REAL_CONSUMER.replace(
      "if (moveEffect === 'EFFECT_WEATHER_BALL') {",
      "if (moveEffect === 'EFFECT_WEATHER_BALL' && false) {",
    )
    mutated = mutated.replace(
      "moveData.effect === 'EFFECT_WEATHER_BALL'",
      "moveData.effect === 'EFFECT_WEATHER_BALL' && false",
    )
    // Weather Ball is plain-hit routed (`calculate.ts` carries its type rule); the chain
    // entry is a production site, so remove it too.
    mutated = mutated.replace(
      "moveEffect === 'EFFECT_WEATHER_BALL' ||",
      "moveEffect === 'EFFECT_WEATHER_BALL_REMOVED' ||",
    )
    expect(mutated).not.toBe(REAL_CONSUMER)
    expect(statusOf(ball, mutated, test)).toBe('unported')
  })

  it('an effect named only in a predicate helper stays unported', () => {
    const move: MoveRecord = { id: 'MOVE_TEST_HEAL', effect: 'EFFECT_TEST_HEAL', customBehavior: {} }
    const predicateOnly = [
      'export function isHealingMoveEffect(effect: string): boolean {',
      "  return effect === 'EFFECT_TEST_HEAL'",
      '}',
    ].join('\n')
    const result = runInventory([move], {}, { consumerSource: predicateOnly, testSource: '', scripts, allowlist: [] })
    const unit = result.units.find((candidate) => candidate.kind === 'move-effect')
    expect(unit?.status).toBe('unported')
    expect(unit?.registeredUntested).toBe(false)
  })

  it('test evidence needs a qualifying block: comments, sentinels and negative assertions do not count', () => {
    const venoshock = moveById('MOVE_VENOSHOCK')
    const sources: Array<[string, string]> = [
      ['comment only', `it('x', () => { executeTurn(); /* EFFECT_DOUBLE_DMG_IF_STATUS1 */ })`],
      [
        'no entry point',
        `it('x', () => { expect('EFFECT_DOUBLE_DMG_IF_STATUS1').toBe('EFFECT_DOUBLE_DMG_IF_STATUS1') })`,
      ],
      [
        'negative assertion',
        `it('x', () => { executeTurn(); expect(notes).not.toContain('secondary effect of EFFECT_DOUBLE_DMG_IF_STATUS1 not modelled') })`,
      ],
      [
        'data sentinel',
        `it('x', () => { executeTurn(); if (move.effect !== 'EFFECT_DOUBLE_DMG_IF_STATUS1') throw new Error('changed') })`,
      ],
    ]
    for (const [label, source] of sources) {
      const unit = effectUnitFor(venoshock, REAL_CONSUMER, source)
      expect(unit.status, label).toBe('unported')
      expect(unit.registeredUntested, label).toBe(true)
    }
  })

  it('AI scoring tests are not evidence: Sucker Punch comes from cycle82/cycle111', () => {
    const sucker = moveById('MOVE_SUCKER_PUNCH')
    const cycle82 = readFileSync(join(SIM_DIR, 'cycle82MoveEffects.test.ts'), 'utf-8')
    const cycle111 = readFileSync(join(SIM_DIR, 'cycle111Chains.test.ts'), 'utf-8')
    const ai = readFileSync(join(SIM_DIR, 'ai/aiCheckBadMove.test.ts'), 'utf-8')
    expect(statusOf(sucker, REAL_CONSUMER, cycle82)).toBe('ported')
    expect(statusOf(sucker, REAL_CONSUMER, cycle111)).toBe('ported')
    const aiUnit = effectUnitFor(sucker, REAL_CONSUMER, ai)
    expect(aiUnit.status).toBe('unported')
    expect(aiUnit.registeredUntested).toBe(true)
  })

  it('loadQualifyingTestSource excludes web/src/engine/sim/ai/', () => {
    expect(loadQualifyingTestSource()).not.toContain('gapped ' + 'unreachable')
  })

  it('declarative behaviour artefacts are not unported', () => {
    const exemplars = [
      'EFFECT_ERUPTION', // CUSTOM_MOVE_DAMAGE + attack.damage
      'EFFECT_LOW_KICK', // CUSTOM_MOVE_DAMAGE + attack.damage
      'EFFECT_GYRO_BALL', // CUSTOM_MOVE_DAMAGE + attack.damage
      'EFFECT_RECOIL_33', // attack.recoilFraction
      'EFFECT_IGNORE_TYPE_IMMUNITY', // attack.ignoreTypeImmunity
      'EFFECT_ATTACK_DOWN_HIT', // attack.secondaryEffects
    ]
    for (const effect of exemplars) expect(statusByEffect.get(effect), effect).toBe('ported')
  })

  it('lunarBased stays unported (no production read; abilities.cc is not the sim)', () => {
    const lunar = realResult.units.find((unit) => unit.kind === 'flag' && unit.unit === 'lunarBased')
    expect(lunar?.status).toBe('unported')
  })

  it('legacy scripts map independently of their owning move effect', () => {
    const fabricated = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          'BattleScript_TestPlain::',
          '\tattackcanceler',
          '\tprintstring STRINGID_EMPTYSTRING3',
          '\tend',
          'BattleScript_TestSecondary::',
          '\tsetmoveeffect MOVE_EFFECT_FLINCH',
          '\tend',
        ],
      },
    ])
    const plainMove: MoveRecord = {
      id: 'MOVE_TEST_LEGACY_PLAIN',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestPlain' },
    }
    const plain = runInventory([plainMove], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: block('MOVE_TEST_LEGACY_PLAIN'),
      scripts: fabricated,
      allowlist: [],
    })
    expect(plain.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('ported')
    const legacy = plain.units.find((unit) => unit.kind === 'legacy-script')
    // Cycle 151b rework: a skeleton-only script is the shared hit frame. Once its owning
    // effect is ported (EFFECT_ERUPTION, CUSTOM_MOVE_DAMAGE) the damage path executes it.
    expect(legacy?.status).toBe('ported')
    expect(legacy?.registeredUntested).toBe(false)

    const index = buildConsumptionIndex(REAL_CONSUMER, moves, behaviors)
    const consumed = [...index.secondaryEffects].sort()[0]
    const consumedScripts = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: ['BattleScript_TestSecondary::', `\tsetmoveeffect ${consumed}`, '\tend'],
      },
    ])
    const secondaryMove: MoveRecord = {
      id: 'MOVE_TEST_LEGACY_SECONDARY',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestSecondary' },
    }
    const secondary = runInventory([secondaryMove], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: block('MOVE_TEST_LEGACY_SECONDARY'),
      scripts: consumedScripts,
      allowlist: [],
    })
    expect(secondary.units.find((unit) => unit.kind === 'legacy-script')?.status).toBe('ported')
  })

  it('a skeleton-only script follows its effect; an unhandled non-skeleton command does not', () => {
    const skeleton = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: ['BattleScript_TestSkeleton::', '\tattackcanceler', '\tdamagecalc', '\tend'],
      },
    ])
    const skeletonMove: MoveRecord = {
      id: 'MOVE_TEST_SKELETON',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestSkeleton' },
    }
    const skeletonResult = runInventory([skeletonMove], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: block('MOVE_TEST_SKELETON'),
      scripts: skeleton,
      allowlist: [],
    })
    expect(skeletonResult.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('ported')
    expect(skeletonResult.units.find((unit) => unit.kind === 'legacy-script')?.status).toBe('ported')

    const gap = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: ['BattleScript_TestGap::', '\tattackcanceler', '\tfrobnicate', '\tend'],
      },
    ])
    const gapMove: MoveRecord = {
      id: 'MOVE_TEST_GAP',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestGap' },
    }
    const gapResult = runInventory([gapMove], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: block('MOVE_TEST_GAP'),
      scripts: gap,
      allowlist: [],
    })
    expect(gapResult.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('ported')
    const gapScript = gapResult.units.find((unit) => unit.kind === 'legacy-script')
    expect(gapScript?.status).toBe('unported')
    expect(gapScript?.registeredUntested).toBe(false)
    expect(gapResult.unhandledScriptCommands.map((command) => command.opcode)).toContain('frobnicate')
  })

  it('a non-skeleton opcode the sim does not execute keeps a ported effect script unported', () => {
    const gap = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          'BattleScript_TestAnimationGap::',
          '\tattackcanceler',
          '\tplayanimation BS_ATTACKER, B_ANIM_STATS_CHANGE, sB_ANIM_ARG1',
          '\tend',
        ],
      },
    ])
    const move: MoveRecord = {
      id: 'MOVE_TEST_ANIMATION_GAP',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestAnimationGap' },
    }
    const result = runInventory([move], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: block('MOVE_TEST_ANIMATION_GAP'),
      scripts: gap,
      allowlist: [],
    })
    // The owning effect is ported, but that says nothing about playanimation.
    expect(result.units.find((unit) => unit.kind === 'move-effect')?.status).toBe('ported')
    const script = result.units.find((unit) => unit.kind === 'legacy-script')
    expect(script?.status).toBe('unported')
    expect(script?.registeredUntested).toBe(false)
    expect(result.unhandledScriptCommands.map((command) => command.opcode)).toContain('playanimation')
  })

  it('an opcode-specific handler is required: deleting its production site makes the opcode unhandled', () => {
    const handledScripts = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: ['BattleScript_TestHandledOpcode::', '\tattackcanceler', '\tsetoctolock BS_TARGET, BattleScript_MoveEndTryFaintTarget', '\tend'],
      },
    ])
    const move: MoveRecord = {
      id: 'MOVE_TEST_HANDLED_OPCODE',
      effect: 'EFFECT_ERUPTION',
      customBehavior: { legacyConfig: 'BattleScript_TestHandledOpcode' },
    }
    const realSource = loadProductionSource()
    expect(handledScriptOpcodes(realSource).has('setoctolock')).toBe(true)
    const handled = runInventory([move], behaviors, {
      consumerSource: REAL_CONSUMER,
      productionSource: realSource,
      testSource: block('MOVE_TEST_HANDLED_OPCODE'),
      scripts: handledScripts,
      allowlist: [],
    })
    expect(handled.units.find((unit) => unit.kind === 'legacy-script')?.status).toBe('ported')

    // Remove the only `settaunt` setter from the comment-stripped production text.
    const withoutSite = realSource.replace('targetBattler.volatiles.octolock = true', '')
    expect(handledScriptOpcodes(withoutSite).has('setoctolock')).toBe(false)
    const mutated = runInventory([move], behaviors, {
      consumerSource: REAL_CONSUMER,
      productionSource: withoutSite,
      testSource: block('MOVE_TEST_HANDLED_OPCODE'),
      scripts: handledScripts,
      allowlist: [],
    })
    expect(mutated.units.find((unit) => unit.kind === 'legacy-script')?.status).toBe('unported')
    expect(mutated.unhandledScriptCommands.map((command) => command.opcode)).toContain('setoctolock')
  })

  it('a qualifying block needs the flag read, not just a carrier move (cycle 151b rework 2)', () => {
    const bite = moveById('MOVE_BITE')
    // Production read of biteBased inside an ability object: the reader token is what a
    // block must name when it does not name the flag key itself.
    const flagSource = [
      'const READER = {',
      "  id: 'ABILITY_STRONG_JAW',",
      '  onOffensiveMultiplier: (ctx) => {',
      '    if (ctx.moveFlags.biteBased) return 1.5',
      '  },',
      '}',
    ].join('\n')
    const flagUnit = (testSource: string, productionSource = flagSource) => {
      const result = runInventory([bite], behaviors, {
        consumerSource: REAL_CONSUMER,
        productionSource,
        testSource,
        scripts,
        allowlist: [],
      })
      return result.units.find((unit) => unit.kind === 'flag' && unit.unit === 'biteBased')
    }
    // A carrier move id alone is no longer evidence: the flag's read is not under test.
    const moveIdOnly = flagUnit(block('MOVE_BITE'))
    expect(moveIdOnly?.status).toBe('unported')
    expect(moveIdOnly?.registeredUntested).toBe(true)

    // Rule (b): the block names the reading ability and runs a carrier.
    expect(flagUnit(block('MOVE_BITE', 'ABILITY_STRONG_JAW'))?.status).toBe('ported')
    // The flag key itself in the block is enough.
    expect(flagUnit(block('MOVE_BITE', 'hasMoveFlag(move, "biteBased")'))?.status).toBe('ported')

    // A module-scope fixture (the cycle98 sentinel pattern) is not inside any it() block.
    const moduleScope = [
      "const fixture = requireMove('MOVE_BITE')",
      'if (!fixture.flags?.biteBased) throw new Error("changed")',
      block(),
    ].join('\n')
    const moduleUnit = flagUnit(moduleScope)
    expect(moduleUnit?.status).toBe('unported')
    expect(moduleUnit?.registeredUntested).toBe(true)

    // A `flags: { biteBased: true }` literal in a test that never runs a move is not evidence.
    const forged = [
      "it('forged', () => {",
      '  const mon = { flags: { biteBased: true } }',
      '  expect(mon.flags.biteBased).toBe(true)',
      '})',
    ].join('\n')
    const forgedUnit = flagUnit(forged)
    expect(forgedUnit?.status).toBe('unported')
    expect(forgedUnit?.registeredUntested).toBe(true)
  })

  it('a carrier-only block does not prove drillBased; the key or the reading ability does', () => {
    const drill = moveById('MOVE_DRILL_RUN')
    const flagUnit = (testSource: string) => {
      const result = runInventory([drill], behaviors, {
        consumerSource: REAL_CONSUMER,
        testSource,
        scripts,
        allowlist: [],
      })
      return result.units.find((unit) => unit.kind === 'flag' && unit.unit === 'drillBased')
    }
    // Production reads it under ABILITY_MEGA_DRILL, and five moves carry it -- nothing
    // in a Tackle-only block exercises the flag.
    expect(flagUnit(block('MOVE_TACKLE'))?.status).toBe('unported')
    expect(flagUnit(block('MOVE_DRILL_RUN'))?.status).toBe('unported')
    // Naming the flag key is evidence.
    expect(flagUnit(block('MOVE_DRILL_RUN', 'hasMoveFlag(move, "drillBased")'))?.status).toBe('ported')
    // So is running the drill move together with the ability that reads the flag.
    expect(flagUnit(block('MOVE_DRILL_RUN', 'ABILITY_MEGA_DRILL'))?.status).toBe('ported')
  })

  it('the cycle98 module-scope flag sentinel is outside every qualifying block', () => {
    const lines = readFileSync(join(SIM_DIR, 'cycle98AiState.test.ts'), 'utf-8').split('\n')
    expect(lines[149]).toContain('MOVE_HYPER_VOICE')
    expect(lines[149]).toContain('flags?.sound')
    const header = lines.slice(0, 150).join('\n')
    expect(buildTestEvidence(header).blocks).toHaveLength(0)
    const hyperVoice = moveById('MOVE_HYPER_VOICE')
    const result = runInventory([hyperVoice], behaviors, {
      consumerSource: REAL_CONSUMER,
      testSource: header,
      scripts,
      allowlist: [],
    })
    const sound = result.units.find((unit) => unit.kind === 'flag' && unit.unit === 'sound')
    expect(sound?.status).toBe('unported')
    expect(sound?.registeredUntested).toBe(true)
  })

  it('a block calling a file-local wrapper over executeTurn is evidence; an uncalled wrapper is not', () => {
    const facade = moveById('MOVE_FACADE')
    const wrapperDefinition = 'function fire(moveId: string) { return executeTurn({ moveId }) }'
    const called = [wrapperDefinition, "it('wrapped', () => { fire('MOVE_FACADE') })"].join('\n')
    expect(statusOf(facade, REAL_CONSUMER, called)).toBe('ported')

    const uncalled = [wrapperDefinition, "it('not called', () => { void 'MOVE_FACADE' })"].join('\n')
    const unit = effectUnitFor(facade, REAL_CONSUMER, uncalled)
    expect(unit.status).toBe('unported')
    expect(unit.registeredUntested).toBe(true)

    // The real suite exercises these four through file-local helpers (cycle87's `fire`).
    for (const effect of [
      'EFFECT_FACADE',
      'EFFECT_FLAIL',
      'EFFECT_SYNCHRONOISE',
      'EFFECT_POLTERGEIST',
    ]) {
      expect(statusByEffect.get(effect), effect).toBe('ported')
    }
  })

  it('the five plain-hit effects are ported through the routing chain, and die with their entry', () => {
    const cases: Array<[string, string, string]> = [
      ['MOVE_DRAGON_DASH', 'EFFECT_HIT', "moveEffect === 'EFFECT_HIT' ||"],
      ['MOVE_GUST', 'EFFECT_GUST', "moveEffect === 'EFFECT_GUST' ||"],
      [
        'MOVE_DECORATE',
        'EFFECT_DECORATE',
        "(moveEffect === 'EFFECT_DECORATE' || moveEffect === 'EFFECT_HIT_ENEMY_HEAL_ALLY')",
      ],
      [
        'MOVE_JUDGMENT',
        'EFFECT_CHANGE_TYPE_ON_ITEM',
        "moveEffect === 'EFFECT_CHANGE_TYPE_ON_ITEM' ||",
      ],
      [
        'MOVE_POLLEN_PUFF',
        'EFFECT_HIT_ENEMY_HEAL_ALLY',
        "(moveEffect === 'EFFECT_DECORATE' || moveEffect === 'EFFECT_HIT_ENEMY_HEAL_ALLY')",
      ],
    ]
    for (const [moveId, effect, needle] of cases) {
      const move = moveById(moveId)
      const test = block(effect)
      expect(statusOf(move, REAL_CONSUMER, test), effect).toBe('ported')
      const renamed = needle.replace(/EFFECT_[A-Z0-9_]+/g, (name) => `${name}_MUTATED`)
      const mutated = REAL_CONSUMER.replace(needle, renamed)
      expect(mutated, effect).not.toBe(REAL_CONSUMER)
      expect(statusOf(move, mutated, test), effect).toBe('unported')
    }
  })

  it('script parser keeps only the live `.if` branch and expands `call` one level', () => {
    const rapid = scripts.get('BattleScript_EffectRapidSpin')
    expect(rapid?.commands).toContain('damagecalc')
    expect(rapid?.commands).toContain('setgraphicalstatchangevalues')
    expect(rapid?.commands[0]).toBe('attackcanceler')
    expect(rapid?.commands.some((command) => command.startsWith('.'))).toBe(false)

    const calls = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          'BattleScript_Caller::',
          '\tcall BattleScript_Callee',
          '\tend',
          'BattleScript_Callee::',
          '\tdamagecalc',
          '\treturn',
        ],
      },
    ])
    expect(calls.get('BattleScript_Caller')?.commands).toContain('damagecalc')
    expect(calls.get('BattleScript_Caller')?.hasDamageStep).toBe(true)
  })
})
