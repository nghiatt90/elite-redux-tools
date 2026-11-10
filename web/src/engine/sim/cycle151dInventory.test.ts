/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  handledScriptOpcodes,
  loadMoveBehaviors,
  loadMoveEffectConsumerSource,
  loadMoves,
  loadProductionSource,
  parseScripts,
  runInventory,
  type MoveRecord,
} from './driver/moveInventory'

const moves = loadMoves()
const behaviors = loadMoveBehaviors()
const REAL_CONSUMER = loadMoveEffectConsumerSource()
const scripts = parseScripts()

/** A synthetic qualifying test block: `executeTurn` plus the named identifiers. */
function block(...names: string[]): string {
  return `it('synthetic', () => { executeTurn(); ${names.map((name) => `void '${name}'`).join('; ')} })`
}

/** Runs one synthetic legacy script bound to a ported effect (EFFECT_ERUPTION). */
function runSyntheticScript(label: string, commands: string[], moveId: string) {
  const synthetic = parseScripts([
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
    scripts: synthetic,
    allowlist: [],
  })
}

// ---------------------------------------------------------------------------
// Item 1: a label inside a dead `.if` branch is not the definition
// ---------------------------------------------------------------------------
//
// `BattleScript_EffectBeatUp` is defined twice: the dead `B_BEAT_UP_DMG < GEN_5`
// body at :5743 and the live `.else` body at :5775 (data/battle_scripts_1.s:5742-5780).
// `B_BEAT_UP_DMG` is `GEN_8` (include/constants/battle_config.h:24).

describe('cycle 151d item 1: file-level `.if` labels', () => {
  it('resolves BattleScript_EffectBeatUp to the live `.else` body', () => {
    const beatUp = scripts.get('BattleScript_EffectBeatUp')
    expect(beatUp).toBeDefined()
    expect(beatUp?.line).toBe(5775)
    expect(beatUp?.commands).toContain('addbyte gBattleCommunication, 1')
    expect(beatUp?.commands).not.toContain('manipulatedamage DMG_DOUBLED')
    expect(beatUp?.commands.join('\n')).not.toContain('trydobeatup')
  })

  it('a dead branch label loses to the live `.else` body of the same name', () => {
    const parsed = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          '.if B_BEAT_UP_DMG < GEN_5',
          'BattleScript_DuplicateLabel::',
          '\tmanipulatedamage DMG_DOUBLED',
          '\tend',
          '.else',
          'BattleScript_DuplicateLabel::',
          '\taddbyte gBattleCommunication, 1',
          '\tend',
          '.endif',
        ],
      },
    ])
    const record = parsed.get('BattleScript_DuplicateLabel')
    expect(record?.line).toBe(6)
    expect(record?.commands).toEqual(['addbyte gBattleCommunication, 1', 'end'])
  })

  it('a label in a live `.if` branch is registered at its own line', () => {
    const parsed = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          '.if B_BEAT_UP_DMG >= GEN_5',
          'BattleScript_LiveBranchLabel::',
          '\taddbyte gBattleCommunication, 1',
          '\tend',
          '.endif',
        ],
      },
    ])
    const record = parsed.get('BattleScript_LiveBranchLabel')
    expect(record?.line).toBe(2)
    expect(record?.commands).toEqual(['addbyte gBattleCommunication, 1', 'end'])
  })

  it('a label inside a dead `.if` with no `.else` is absent', () => {
    const parsed = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          '.if B_BEAT_UP_DMG < GEN_5',
          'BattleScript_DeadOnlyLabel::',
          '\taddbyte gBattleCommunication, 1',
          '\tend',
          '.endif',
        ],
      },
    ])
    expect(parsed.has('BattleScript_DeadOnlyLabel')).toBe(false)
  })

  it('a nested `.if` inside a dead branch stays dead', () => {
    const parsed = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          '.if B_BEAT_UP_DMG < GEN_5',
          '.if B_BEAT_UP_DMG >= GEN_5',
          'BattleScript_NestedDeadLabel::',
          '\taddbyte gBattleCommunication, 1',
          '\tend',
          '.endif',
          '.endif',
        ],
      },
    ])
    expect(parsed.has('BattleScript_NestedDeadLabel')).toBe(false)
  })

  it('.elseif after a taken branch stays inactive (and the `.else` does not re-open it)', () => {
    const parsed = parseScripts([
      {
        repoRelative: 'memory/battle_scripts.s',
        lines: [
          '.if B_BEAT_UP_DMG >= GEN_5',
          'BattleScript_ElseifOne::',
          '\taddbyte gBattleCommunication, 1',
          '\tend',
          '.elseif B_BEAT_UP_DMG >= GEN_5',
          'BattleScript_ElseifTwo::',
          '\tend',
          '.else',
          'BattleScript_ElseifThree::',
          '\tend',
          '.endif',
        ],
      },
    ])
    // The `.if` body is the live branch; `end` terminates its command list but the label
    // itself is registered.
    expect(parsed.get('BattleScript_ElseifOne')?.commands).toEqual(['addbyte gBattleCommunication, 1', 'end'])
    expect(parsed.has('BattleScript_ElseifTwo')).toBe(false)
    expect(parsed.has('BattleScript_ElseifThree')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item 2: `manipulatedamage` operands are individual handlers
// ---------------------------------------------------------------------------
//
// Cmd_manipulatedamage switches on the operand (battle_script_commands.c:9357-9413).
// Each entry below is the operand itself plus a distinctive production line. The operands
// left without an entry (DMG_CHANGE_SIGN heal paths, DMG_DOUBLED in the dead Beat Up body)
// are reported in REPORT.md, not silenced.

const REAL_HANDLER_SOURCE = loadProductionSource()

const OPERAND_HANDLERS: Array<[string, string]> = [
  ['DMG_TO_HP_FROM_MOVE', 'let drainHp = argument !== 0 ? Math.floor((hpDealt * argument) / 100) : Math.floor(hpDealt / 2)'],
  ['DMG_BIG_ROOT', "seederItem?.resolvedHoldEffect === 'HOLD_EFFECT_BIG_ROOT'"],
  [
    'DMG_TO_HP_FROM_ABILITY',
    "if (deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_BIG_ROOT') heal = Math.trunc((heal * 3) / 2)",
  ],
  ['DMG_RECOIL_FROM_MISS', 'let crashDamage = Math.floor(attackerBattler.mon.maxHp / 2)'],
]

describe('cycle 151d item 2: manipulatedamage operand handlers', () => {
  for (const [operand, productionLine] of OPERAND_HANDLERS) {
    it(`${operand} is handled only while its production line exists`, () => {
      const key = `manipulatedamage ${operand}`
      expect(handledScriptOpcodes(REAL_HANDLER_SOURCE).has(key)).toBe(true)

      // The probe is load-bearing: delete the production line and the operand is unhandled.
      const withoutSite = REAL_HANDLER_SOURCE.replace(productionLine, '')
      expect(withoutSite).not.toBe(REAL_HANDLER_SOURCE)
      expect(handledScriptOpcodes(withoutSite).has(key)).toBe(false)

      const handled = runSyntheticScript(
        `BattleScript_Test${operand}`,
        [`manipulatedamage ${operand}`],
        `MOVE_TEST_${operand}`,
      )
      expect(handled.units.find((unit) => unit.kind === 'legacy-script')?.status).toBe('ported')
    })
  }

  it('an operand the sim does not port stays unhandled and is named with its operand', () => {
    const result = runSyntheticScript(
      'BattleScript_TestUnportedOperand',
      ['manipulatedamage DMG_1_8_TARGET_HP'],
      'MOVE_TEST_UNPORTED_OPERAND',
    )
    const script = result.units.find((unit) => unit.kind === 'legacy-script')
    expect(script?.status).toBe('unported')
    const command = result.unhandledScriptCommands.find(
      (candidate) => candidate.opcode === 'manipulatedamage',
    )
    expect(command?.command).toBe('manipulatedamage DMG_1_8_TARGET_HP')
  })

  it('a ported operand does not bless a different operand of the same opcode', () => {
    // DMG_TO_HP_FROM_MOVE is ported, DMG_1_8_TARGET_HP is not: the key must be per operand.
    expect(handledScriptOpcodes(REAL_HANDLER_SOURCE).has('manipulatedamage DMG_TO_HP_FROM_MOVE')).toBe(true)
    expect(handledScriptOpcodes(REAL_HANDLER_SOURCE).has('manipulatedamage DMG_1_8_TARGET_HP')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item 3: the inventory units these fixes unblock
// ---------------------------------------------------------------------------

describe('cycle 151d item 3: inventory units', () => {
  const result = runInventory(moves, behaviors, { scripts })

  it('BattleScript_EffectBeatUp is ported for MOVE_BEAT_UP', () => {
    const unit = result.units.find(
      (candidate) => candidate.kind === 'legacy-script' && candidate.moveId === 'MOVE_BEAT_UP',
    )
    expect(unit?.unit).toBe('BattleScript_EffectBeatUp')
    expect(unit?.status).toBe('ported')
  })

  it('BattleScript_EffectAbsorb is ported for a drain move (MOVE_GIGA_DRAIN)', () => {
    // `MOVE_ABSORB` is EFFECT_CLEAR_SMOG in Elite Redux; Giga Drain carries EFFECT_ABSORB.
    // Qualifying tests name MOVE_GIGA_DRAIN / EFFECT_ABSORB (cycle82MoveEffects.test.ts:316).
    const unit = result.units.find(
      (candidate) => candidate.kind === 'legacy-script' && candidate.moveId === 'MOVE_GIGA_DRAIN',
    )
    expect(unit?.unit).toBe('BattleScript_EffectAbsorb')
    expect(unit?.status).toBe('ported')
  })
})
