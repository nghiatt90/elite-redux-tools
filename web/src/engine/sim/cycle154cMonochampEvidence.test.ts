/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MONOCHAMP_RULE_SPECS,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  runInventory,
  type SourceFile,
} from './driver/environmentInventory'
import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction, type TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimMoveData } from './dataContext'

const LOAD_SIM_DATA = 'web/src/engine/sim/driver/loadSimData.ts'
const OWN_FILE = 'web/src/engine/sim/cycle154cMonochampEvidence.test.ts'

const productionFiles = loadEngineProductionFiles()
const testFiles = loadEngineTestFiles()

/**
 * The eight sites whose branch the sim already implements. The other 19 have no
 * sim port, so a synthetic driver feed must not flip them.
 */
const CONDITIONAL_PORT_KEYS: readonly string[] = [
  'monochamp:battle_util.c:2238',
  'monochamp:battle_util.c:4850',
  'monochamp:battle_util.c:6656',
  'monochamp:battle_util.c:8672',
  'monochamp:battle_util.c:8710',
  'monochamp:battle_main.c:4205',
  'monochamp:abilities.cc:5211',
  'monochamp:battle_script_commands.c:8344',
]
const UNMODELLED_KEYS: readonly string[] = MONOCHAMP_RULE_SPECS.map((spec) => spec.key).filter(
  (key) => !CONDITIONAL_PORT_KEYS.includes(key),
)
const WATER_KEYS: readonly string[] = [
  'monochamp:battle_util.c:2238',
  'monochamp:battle_script_commands.c:8344',
]

const monochampUnits = (files: SourceFile[], tests: SourceFile[] = testFiles) =>
  runInventory({ productionFiles: files, testSources: tests }).units.filter(
    (unit) => unit.kind === 'map-setup' && unit.key.startsWith('monochamp:'),
  )

/** The real loadSimData.ts with the hard-coded null replaced by a driver feed. */
function feedAssigned(): SourceFile[] {
  const loadSimData = productionFiles.find((file) => file.file.endsWith(LOAD_SIM_DATA))
  if (!loadSimData) throw new Error('loadSimData.ts is missing from the engine corpus')
  const source = loadSimData.source.replace(
    /monotypeChampType\s*:\s*null,/,
    'monotypeChampType: pickType(row),',
  )
  return productionFiles.map((file) =>
    file.file === loadSimData.file ? { file: file.file, source } : file,
  )
}

function siteOf(key: string): { file: string; pattern: RegExp } {
  const spec = MONOCHAMP_RULE_SPECS.find((candidate) => candidate.key === key)
  const site = spec?.evidence?.alsoRequires?.[0]
  if (!site) throw new Error(`${key} has no production site evidence`)
  return site
}

/** feed assigned, but the site that implements this branch is stripped out. */
function withoutSite(key: string): SourceFile[] {
  const site = siteOf(key)
  const pattern = new RegExp(site.pattern.source, 'g')
  return feedAssigned().map((file) =>
    file.file === site.file ? { file: file.file, source: file.source.replace(pattern, 'null') } : file,
  )
}

const NULL_FIXTURE: SourceFile[] = [
  { file: 'web/src/engine/sim/syntheticNil.test.ts', source: 'const grounding = { monotypeChampType: null }' },
]
const WATER_FIXTURE: SourceFile[] = [
  { file: 'web/src/engine/sim/syntheticWater.test.ts', source: "const grounding = { monotypeChampType: 'WATER' }" },
]

describe('cycle 154c Monotype Champion per-site evidence', () => {
  it('keeps every unmodelled site unported after a synthetic driver feed', () => {
    const units = monochampUnits(feedAssigned())
    for (const key of UNMODELLED_KEYS) {
      expect(units.find((unit) => unit.key === key)?.status, key).toBe('unported')
    }
    expect(units.filter((unit) => unit.status === 'ported').map((unit) => unit.key).sort()).toEqual(
      [...CONDITIONAL_PORT_KEYS].sort(),
    )
  })

  it('requires the site evidence, not only the feed, for each conditional port', () => {
    const fed = monochampUnits(feedAssigned())
    for (const key of CONDITIONAL_PORT_KEYS) {
      expect(fed.find((unit) => unit.key === key)?.status, key).toBe('ported')
      expect(monochampUnits(withoutSite(key)).find((unit) => unit.key === key)?.status, key).toBe(
        'unported',
      )
    }
  })

  it('rejects a null champion type and only accepts the unit own type', () => {
    expect(monochampUnits(feedAssigned(), NULL_FIXTURE).every((unit) => unit.status === 'unported')).toBe(
      true,
    )
    expect(
      monochampUnits(feedAssigned(), WATER_FIXTURE)
        .filter((unit) => unit.status === 'ported')
        .map((unit) => unit.key)
        .sort(),
    ).toEqual([...WATER_KEYS].sort())
    for (const unit of monochampUnits(productionFiles)) {
      expect(unit.testFile, unit.key).not.toBe('web/src/engine/sim/absorb.test.ts')
    }
  })

  it('reports which real test file carries each conditional unit type', () => {
    const expected: Record<string, string> = {
      'monochamp:battle_util.c:2238': OWN_FILE,
      'monochamp:battle_util.c:4850': 'web/src/engine/sim/escape.test.ts',
      'monochamp:battle_util.c:6656': 'web/src/engine/sim/turn.test.ts',
      'monochamp:battle_util.c:8672': 'web/src/engine/sim/turnOrder.test.ts',
      'monochamp:battle_util.c:8710': 'web/src/engine/sim/bridge.test.ts',
      'monochamp:battle_main.c:4205': 'web/src/engine/sim/turnOrder.test.ts',
      'monochamp:abilities.cc:5211': 'web/src/engine/sim/cycle96Abilities.test.ts',
      'monochamp:battle_script_commands.c:8344': OWN_FILE,
    }
    const fed = monochampUnits(feedAssigned())
    for (const key of CONDITIONAL_PORT_KEYS) {
      expect(fed.find((unit) => unit.key === key)?.testFile, key).toBe(expected[key])
    }
  })
})

// The two WATER conditional ports had no test that assigned the champion type,
// so their direct site tests live here (the brief's fallback). Both numbers are
// hand-derived from the C cited by the unit.
const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((move) => [move.id as string, move]))
const MOVE_COURT_CHANGE = requireMove('MOVE_COURT_CHANGE')

function requireMove(id: string): SimMoveData {
  const move = movesById.get(id)
  if (!move) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: move.power as number,
    type: move.type as string | null,
    split: move.split as SimMoveData['split'],
    effect: move.effect as string | null,
    target: move.target as string | undefined,
    priority: move.priority as number | undefined,
    flags: (move.flags as Record<string, true>) ?? {},
    accuracy: move.accuracy as number,
    hitsAir: move.hitsAir as SimMoveData['hitsAir'],
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: () => undefined,
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(specs: { spe: number }[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((spec, i) =>
      createBattlerState(
        i,
        mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: spec.spe } }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(): RandomSource {
  return { random16: () => 0 }
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function dummyDamage(): DamageResolver {
  return { resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }) }
}

function testDeps(monotypeChampType: string | null): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: { ...GROUNDING, monotypeChampType },
    damage: dummyDamage(),
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
  }
}

describe('cycle 154c WATER conditional site tests', () => {
  it('fieldEndTurn.ts:906 -- WATER champion (player side) skips the swamp tick, opponent still ticks', () => {
    // battle_util.c:2238 `!(getMonotypeChampType() == TYPE_WATER && side == B_SIDE_PLAYER) && --swampTimer`.
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.timers.swampTimer = 3
    state.sides[1]!.timers.swampTimer = 2
    executeTurn(state, [null, null], testDeps('WATER'))
    expect(state.sides[0]!.timers.swampTimer).toBe(3)
    expect(state.sides[1]!.timers.swampTimer).toBe(1)

    const plain = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    plain.sides[0]!.timers.swampTimer = 3
    plain.sides[1]!.timers.swampTimer = 2
    executeTurn(plain, [null, null], testDeps(null))
    expect(plain.sides[0]!.timers.swampTimer).toBe(2)
    expect(plain.sides[1]!.timers.swampTimer).toBe(1)
  })

  it('moveEffects.ts:8806 -- WATER champion leaves Court Change from swapping the swamp timer', () => {
    // battle_script_commands.c:8344 `if (!(getMonotypeChampType() == TYPE_WATER)) SWAP(... swampTimer ...)`.
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.battlers[0]!.mon.moves = ['MOVE_COURT_CHANGE', null, null, null]
    state.battlers[0]!.mon.pp = [MOVE_COURT_CHANGE.pp ?? 10, 0, 0, 0]
    state.sides[0]!.timers.swampTimer = 3
    state.sides[1]!.timers.swampTimer = 5
    executeTurn(state, [useMove(0, MOVE_COURT_CHANGE), null], testDeps('WATER'))
    // no swap, and the player side also skips the :2238 end-turn tick
    expect(state.sides[0]!.timers.swampTimer).toBe(3)
    expect(state.sides[1]!.timers.swampTimer).toBe(4)

    const plain = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    plain.battlers[0]!.mon.moves = ['MOVE_COURT_CHANGE', null, null, null]
    plain.battlers[0]!.mon.pp = [MOVE_COURT_CHANGE.pp ?? 10, 0, 0, 0]
    plain.sides[0]!.timers.swampTimer = 3
    plain.sides[1]!.timers.swampTimer = 5
    executeTurn(plain, [useMove(0, MOVE_COURT_CHANGE), null], testDeps(null))
    // swapped 3 <-> 5, then both sides tick once at end of turn
    expect(plain.sides[0]!.timers.swampTimer).toBe(4)
    expect(plain.sides[1]!.timers.swampTimer).toBe(2)
  })
})
