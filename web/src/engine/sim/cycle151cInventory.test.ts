/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildConsumptionIndex,
  isScriptFrameOpcode,
  loadCommandHandlerLines,
  loadMoveBehaviors,
  loadMoveEffectConsumerSource,
  loadMoves,
  parseScripts,
  runInventory,
  scriptBehaviourCommands,
  type MoveRecord,
} from './driver/moveInventory'

const moves = loadMoves()
const behaviors = loadMoveBehaviors()
const REAL_CONSUMER = loadMoveEffectConsumerSource()

/** A synthetic qualifying test block: `executeTurn` plus the named identifiers. */
function block(...names: string[]): string {
  return `it('synthetic', () => { executeTurn(); ${names.map((name) => `void '${name}'`).join('; ')} })`
}

/** Runs one synthetic legacy script bound to a ported effect (EFFECT_ERUPTION). */
function runSyntheticScript(label: string, commands: string[], moveId: string) {
  const scripts = parseScripts([
    {
      repoRelative: 'memory/battle_scripts.s',
      lines: [label + '::', ...commands.map((command) => `\t${command}`), '\tend'],
    },
  ])
  const move: MoveRecord = {
    id: moveId,
    effect: 'EFFECT_ERUPTION',
    customBehavior: { legacyConfig: label },
  }
  return runInventory([move], behaviors, {
    consumerSource: REAL_CONSUMER,
    testSource: block(moveId),
    scripts,
    allowlist: [],
  })
}

// ---------------------------------------------------------------------------
// Item 1: presentation opcodes are frame opcodes
// ---------------------------------------------------------------------------
//
// Each C body only emits a controller animation / icon update or writes animation
// arguments (battle_script_commands.c lines cited in the SCRIPT_FRAME_OPCODES doc comment).
const PRESENTATION_COMMANDS: Array<[string, string]> = [
  ['playanimation', 'playanimation BS_ATTACKER, B_ANIM_STATS_CHANGE, sB_ANIM_ARG1'],
  ['setgraphicalstatchangevalues', 'setgraphicalstatchangevalues'],
  ['playstatchangeanimation', 'playstatchangeanimation BS_ATTACKER, BIT_ATK | BIT_DEF, 0'],
  ['status2animation', 'status2animation BS_TARGET, STATUS2_INFATUATION'],
  ['updatestatusicon', 'updatestatusicon BS_ATTACKER'],
]

describe('cycle 151c item 1: presentation opcodes are frame opcodes', () => {
  for (const [opcode, command] of PRESENTATION_COMMANDS) {
    it(`${opcode} carries no behaviour command`, () => {
      const parsed = parseScripts([
        {
          repoRelative: 'memory/battle_scripts.s',
          lines: [
            'BattleScript_TestPresentation::',
            '\tattackcanceler',
            `\t${command}`,
            '\tdamagecalc',
            '\tend',
          ],
        },
      ])
      const record = parsed.get('BattleScript_TestPresentation')
      expect(record).toBeDefined()
      expect(isScriptFrameOpcode(opcode)).toBe(true)
      expect(scriptBehaviourCommands(record!)).toEqual([])
    })

    it(`${opcode} does not hide a neighbouring behaviour opcode`, () => {
      const parsed = parseScripts([
        {
          repoRelative: 'memory/battle_scripts.s',
          lines: [
            'BattleScript_TestPresentationNeighbour::',
            `\t${command}`,
            '\tsetstatchanger BS_TARGET, STAT_ATK, 1',
            '\tend',
          ],
        },
      ])
      const record = parsed.get('BattleScript_TestPresentationNeighbour')
      expect(record).toBeDefined()
      expect(scriptBehaviourCommands(record!)).toEqual(['setstatchanger BS_TARGET, STAT_ATK, 1'])
    })
  }
})

// ---------------------------------------------------------------------------
// Item 2: `setmoveeffect` modifier bits are not effects
// ---------------------------------------------------------------------------

describe('cycle 151c item 2: setmoveeffect modifier bits', () => {
  const index = buildConsumptionIndex(REAL_CONSUMER, moves, behaviors)
  const consumed = [...index.secondaryEffects].sort()[0]
  const withBits = (effect: string): string =>
    `setmoveeffect ${effect} | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN`

  it('a consumed effect plus both modifier bits is handled', () => {
    expect(index.secondaryEffects.has(consumed)).toBe(true)
    const result = runSyntheticScript(
      'BattleScript_TestSetMoveEffectBits',
      [withBits(consumed)],
      'MOVE_TEST_SETMOVEFFECT_BITS',
    )
    const script = result.units.find((unit) => unit.kind === 'legacy-script')
    expect(script?.status).toBe('ported')
    expect(result.unhandledScriptCommands.map((command) => command.opcode)).not.toContain('setmoveeffect')
  })

  it('a real effect the dispatch does not consume stays unhandled behind the modifier bits', () => {
    // MOVE_EFFECT_CHARGING exists but `applySecondaryMoveEffects` never consumes it.
    expect(index.secondaryEffects.has('MOVE_EFFECT_CHARGING')).toBe(false)
    const result = runSyntheticScript(
      'BattleScript_TestSetMoveEffectUnconsumed',
      [withBits('MOVE_EFFECT_CHARGING')],
      'MOVE_TEST_SETMOVEFFECT_UNCONSUMED',
    )
    const script = result.units.find((unit) => unit.kind === 'legacy-script')
    expect(script?.status).toBe('unported')
    expect(result.unhandledScriptCommands.map((command) => command.opcode)).toContain('setmoveeffect')
  })

  it('the modifier-bit filter is load-bearing: removed, the first case would be unhandled', () => {
    // What `unhandledScriptCommands` sees before the filter: all three names, of which the
    // two modifier bits are not consumed. Without `SETMOVEEFFECT_MODIFIER_BITS` the `some`
    // below is true, so the command in the first test would be reported unhandled.
    const rawNames = withBits(consumed).match(/MOVE_EFFECT_[A-Z0-9_]+/g) ?? []
    expect(rawNames).toEqual([consumed, 'MOVE_EFFECT_AFFECTS_USER', 'MOVE_EFFECT_CERTAIN'])
    // `secondaryIsConsumed` = membership in `secondaryEffects` OR a numeric range hit;
    // neither modifier bit is in the set and 0x4000/0x8000 fall outside every range.
    const consumedByRange = (value: number): boolean =>
      index.secondaryRanges.some(([low, high]) => value >= low && value <= high)
    expect(index.secondaryEffects.has('MOVE_EFFECT_AFFECTS_USER')).toBe(false)
    expect(index.secondaryEffects.has('MOVE_EFFECT_CERTAIN')).toBe(false)
    expect(consumedByRange(0x4000)).toBe(false)
    expect(consumedByRange(0x8000)).toBe(false)
    expect(rawNames.some((name) => !index.secondaryEffects.has(name))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Item 4: handler line numbers must be definitions, not prototypes
// ---------------------------------------------------------------------------

describe('cycle 151c item 4: loadCommandHandlerLines matches definitions', () => {
  it('cites the attackcanceler definition, not its forward declaration', () => {
    const map = loadCommandHandlerLines()
    expect(map.get('attackcanceler')).toBe(1046)
    // The whole forward-declaration block ends at :273; every real body is after it.
    for (const line of map.values()) expect(line).toBeGreaterThan(273)
  })

  it('accepts a same-line brace and a brace on the next line, and rejects prototypes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'move-inventory-'))
    const path = join(dir, 'battle_script_commands.c')
    writeFileSync(
      path,
      [
        'static void Cmd_fakecommand(void);',
        'static void Cmd_spannedcommand(void)  // comment before the body brace',
        '{',
        '}',
        'static void Cmd_fakecommand(void) {',
        '}',
        'static void Cmd_onlyprototype(void);',
      ].join('\n'),
      'utf-8',
    )
    try {
      const map = loadCommandHandlerLines(path, true)
      // The definition wins over the prototype on line 1.
      expect(map.get('fakecommand')).toBe(5)
      // Commented definitions keep the `Cmd_` line, not the brace line.
      expect(map.get('spannedcommand')).toBe(2)
      expect(map.has('onlyprototype')).toBe(false)
      // A fresh read must not poison the module cache for later callers.
      expect(loadCommandHandlerLines().get('attackcanceler')).toBe(1046)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
