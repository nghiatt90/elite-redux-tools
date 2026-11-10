/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 152d3: Enigma Berry special cases. Under FREE_ENIGMA_BERRY
// (include/global.h:96) the runtime holdEffect/holdEffectParam are zeroed
// (battle_main.c:721-735), so GetBattlerHoldEffect (:6533-6534) and
// GetBattlerHoldEffectParam (:6548-6549) return 0. The sim reads the item data
// instead of a runtime table, and items.json resolves ITEM_ENIGMA_BERRY to
// HOLD_EFFECT_NONE, so no Unmodelled note is due. CanBattlerGetOrLoseItem
// (:8255-8256) forbids removing the item outright.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { STATUS2_MULTIPLETURNS, hasFlag } from './constants'
import { consumeBerryWithOverride } from './moveEffects'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction, type TurnOrderMoveView } from './turnOrder'
import {
  DEFAULT_ALLOWLIST,
  ENIGMA_BERRY_SITES,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadItems,
  runInventory,
  validateAllowlist,
  type ItemInventoryResult,
  type ItemUnit,
  type SourceFile,
} from './driver/itemInventory'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors: simData.moveBehaviors,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function actionOf(out: ReturnType<typeof executeTurn>, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

// ---------------------------------------------------------------------------
// 1. Power Herb charge path (twoturnmoveacceleratecheck)
// ---------------------------------------------------------------------------
describe('cycle 152d3 - Enigma Berry is not Power Herb', () => {
  it('does not accelerate Solar Beam, keeps the item and raises no Enigma note (battle_util.c:6533-6534)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        moves: ['MOVE_SOLAR_BEAM', null, null, null],
        pp: [10, 0, 0, 0],
        itemId: 'ITEM_ENIGMA_BERRY',
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )

    const out = executeTurn(state, [useMove(1, 'MOVE_SOLAR_BEAM'), null], loopDeps(state, fixedDamage(40)))
    const attacker = state.battlers[0]!

    // Charge turn: no damage, PP paid once, locked into the move.
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(attacker.mon.pp[0]).toBe(9)
    expect(hasFlag(attacker.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(state.lockedMoves[0]).toBe('MOVE_SOLAR_BEAM')
    // The item is not consumed.
    expect(attacker.mon.itemId).toBe('ITEM_ENIGMA_BERRY')
    expect(actionOf(out, 0).unmodelled.some((note) => /Enigma/.test(note))).toBe(false)
  })

  it('positive control: Power Herb fires the same move on turn 1 and is consumed', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        moves: ['MOVE_SOLAR_BEAM', null, null, null],
        pp: [10, 0, 0, 0],
        itemId: 'ITEM_POWER_HERB',
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )

    executeTurn(state, [useMove(1, 'MOVE_SOLAR_BEAM'), null], loopDeps(state, fixedDamage(40)))

    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END) berry trigger
// ---------------------------------------------------------------------------
describe('cycle 152d3 - Enigma Berry does not trigger as a healing berry', () => {
  it('at 40/100 HP Enigma is neither healed nor consumed, while Sitrus heals 25 and is consumed', () => {
    const enigma = battle(monFor('SPECIES_MUDKIP', { hp: 40, itemId: 'ITEM_ENIGMA_BERRY' }), monFor('SPECIES_MUDKIP'), countRng())
    const enigmaNotes: string[] = []
    consumeBerryWithOverride(enigma, 0, 0, 'MOVE_TACKLE', loopDeps(enigma, fixedDamage(0)), enigmaNotes, [], false)
    expect(enigma.battlers[0]!.mon.hp).toBe(40)
    expect(enigma.battlers[0]!.mon.itemId).toBe('ITEM_ENIGMA_BERRY')
    expect(enigmaNotes.some((note) => /Enigma/.test(note))).toBe(false)

    const sitrus = battle(monFor('SPECIES_MUDKIP', { hp: 40, itemId: 'ITEM_SITRUS_BERRY' }), monFor('SPECIES_MUDKIP'), countRng())
    consumeBerryWithOverride(sitrus, 0, 0, 'MOVE_TACKLE', loopDeps(sitrus, fixedDamage(0)), [], [], false)
    expect(sitrus.battlers[0]!.mon.hp).toBe(65)
    expect(sitrus.battlers[0]!.mon.itemId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. CanBattlerGetOrLoseItem (:8255-8256)
// ---------------------------------------------------------------------------
describe('cycle 152d3 - Thief cannot steal an Enigma Berry', () => {
  it('leaves Enigma with its holder, but the Choice Band positive control is stolen', () => {
    const enigma = battle(
      monFor('SPECIES_MUDKIP'),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_ENIGMA_BERRY' }),
      countRng(),
    )
    executeTurn(enigma, [useMove(1, 'MOVE_THIEF'), null], loopDeps(enigma, fixedDamage(30)))
    expect(enigma.battlers[0]!.mon.itemId).toBeNull()
    expect(enigma.battlers[1]!.mon.itemId).toBe('ITEM_ENIGMA_BERRY')

    const band = battle(
      monFor('SPECIES_MUDKIP'),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_BAND' }),
      countRng(),
    )
    executeTurn(band, [useMove(1, 'MOVE_THIEF'), null], loopDeps(band, fixedDamage(30)))
    expect(band.battlers[0]!.mon.itemId).toBe('ITEM_CHOICE_BAND')
    expect(band.battlers[1]!.mon.itemId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Inventory: one unit per Enigma site
// ---------------------------------------------------------------------------
const items = loadItems()

function enigmaUnit(result: ItemInventoryResult, site: string): ItemUnit | undefined {
  return result.units.find(
    (candidate) => candidate.kind === 'hold-trigger' && candidate.unit === 'ITEM_ENIGMA_BERRY' && candidate.site === site,
  )
}

function stubProductionFile(fileToStub: string, token: string, replacement: string): SourceFile[] {
  return loadEngineProductionFiles().map((file) =>
    file.file === fileToStub
      ? { file: file.file, source: file.source.split(token).join(replacement) }
      : file,
  )
}

/**
 * No test evidence at all: drop every test file naming the item id or the two
 * bridge fields it resolves to. The older mentions in bridge.test.ts /
 * moveEnd.test.ts are generic item-data assertions, not per-site Enigma tests,
 * so removing only this cycle's file would leave them counting as evidence.
 */
function testSourcesWithoutEnigmaEvidence(): SourceFile[] {
  const tokens = ['ITEM_ENIGMA_BERRY', 'resolvedHoldEffect', 'itemResolvedHoldEffectStrength']
  return loadEngineTestFiles().filter((file) => !tokens.some((token) => file.source.includes(token)))
}

describe('cycle 152d3 - Enigma Berry inventory units', () => {
  it('defines one unit per C site, with the pinned citation and status', () => {
    const result = runInventory(items)
    expect(result.units.filter((unit) => unit.kind === 'hold-trigger' && unit.unit === 'ITEM_ENIGMA_BERRY')).toHaveLength(
      ENIGMA_BERRY_SITES.length,
    )

    const portedSites = new Set(['GetBattlerHoldEffect', 'GetBattlerHoldEffectParam', 'CanBattlerGetOrLoseItem'])
    for (const site of ENIGMA_BERRY_SITES) {
      const unit = enigmaUnit(result, site.site)
      expect(unit, site.site).toBeDefined()
      expect(unit!.citation, site.site).toBe(`${site.file}:${site.line}`)
      expect(unit!.effect, site.site).toBe('ITEM_ENIGMA_BERRY')
      if (portedSites.has(site.site)) {
        expect(unit!.status, site.site).toBe('ported')
      } else {
        expect(unit!.status, site.site).toBe('allowlisted')
      }
    }

    // The seven pokemon.c reads are all non-battle and allowlisted.
    const pokemonSites = ENIGMA_BERRY_SITES.filter((site) => site.file.endsWith('/pokemon.c'))
    expect(pokemonSites).toHaveLength(7)
    for (const site of pokemonSites) {
      expect(enigmaUnit(result, site.site)!.status).toBe('allowlisted')
    }

    expect(validateAllowlist(DEFAULT_ALLOWLIST)).toEqual([])
  })

  it('flips each ported unit to unported when its production branch token is stubbed', () => {
    const holdEffect = runInventory(items, {
      productionFiles: stubProductionFile('web/src/engine/sim/bridge.ts', 'resolvedHoldEffect', 'STUBBED_HOLD_EFFECT'),
    })
    expect(enigmaUnit(holdEffect, 'GetBattlerHoldEffect')?.status).toBe('unported')
    expect(enigmaUnit(holdEffect, 'GetBattlerHoldEffect')?.registeredUntested).toBe(false)

    const holdEffectParam = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/sim/bridge.ts',
        'itemResolvedHoldEffectStrength',
        'STUBBED_ITEM_STRENGTH',
      ),
    })
    expect(enigmaUnit(holdEffectParam, 'GetBattlerHoldEffectParam')?.status).toBe('unported')

    const canGetOrLose = stubProductionFile(
      'web/src/engine/sim/moveEffects.ts',
      'ITEM_ENIGMA_BERRY',
      'ITEM_STUBBED_ENIGMA_BERRY',
    ).map((file) =>
      file.file === 'web/src/engine/sim/moveEnd.ts'
        ? { file: file.file, source: file.source.split('ITEM_ENIGMA_BERRY').join('ITEM_STUBBED_ENIGMA_BERRY') }
        : file,
    )
    const canGetOrLoseResult = runInventory(items, { productionFiles: canGetOrLose })
    expect(enigmaUnit(canGetOrLoseResult, 'CanBattlerGetOrLoseItem')?.status).toBe('unported')
  })

  it('flips ported units to registeredUntested when no test names the item', () => {
    const result = runInventory(items, { testSources: testSourcesWithoutEnigmaEvidence() })
    for (const site of ['GetBattlerHoldEffect', 'GetBattlerHoldEffectParam', 'CanBattlerGetOrLoseItem']) {
      const unit = enigmaUnit(result, site)
      expect(unit?.status, site).toBe('unported')
      expect(unit?.registeredUntested, site).toBe(true)
      expect(unit?.testFile, site).toBeNull()
    }
  })

  it('counts: +15 hold-trigger units, 3 ported, 0 unported, 12 allowlisted, totals re-pinned', () => {
    const result = runInventory(items)
    const enigma = result.units.filter((unit) => unit.kind === 'hold-trigger' && unit.unit === 'ITEM_ENIGMA_BERRY')
    expect(enigma).toHaveLength(15)
    expect(enigma.filter((unit) => unit.status === 'ported')).toHaveLength(3)
    expect(enigma.filter((unit) => unit.status === 'unported')).toHaveLength(0)
    expect(enigma.filter((unit) => unit.status === 'allowlisted')).toHaveLength(12)

    // Cycle 152d2 totals + the 14 Enigma units: 237 + 14 = 251 hold-trigger,
    // 352 + 14 = 366 defined, 131 + 3 = 134 ported, unported unchanged at 216,
    // allowlisted 5 + 11 = 16, registered-untested unchanged at 28.
    // Cycle 152d4: +270 mega stones (266 ported + 4 allowlisted) = 636 defined, 400 ported, 20 allowlisted.
    // Cycle 156: Binding Band (`battle_util.c:2682`) gained a test, so ported 400 -> 401,
    // unported 216 -> 215 and registered-untested 28 -> 27.
    // Cycle 152f: Natural Gift GetMovePriority ported, ported 401 -> 402, unported 215 -> 214.
    // Cycle 152g: -2 hold-trigger, the two Booster Energy `ScoreSwitchInAbility`
    // units (`battle_ai_ability.c:1070`, `:1076`) moved to ai-trigger when that
    // file was reclassified as an AI source. 251 is the pre-152g count above.
    // Cycle 152h: Bug Bite / Pluck EatTargetBerry ported (battle_script_commands.c:13221-13234), ported 402 -> 403, unported 214 -> 213.
    // Cycle 152i: +1 Enigma ShouldUseItem:1127 allowlisted unit (battle_ai_switch_items.c:1127) = 250 hold-trigger, 637 defined, 21 allowlisted.
    expect(result.units.filter((unit) => unit.kind === 'hold-trigger')).toHaveLength(250)
    expect(result.totalDefined).toBe(637)
    expect(result.totalPorted).toBe(403)
    expect(result.totalUnported).toBe(213)
    expect(result.totalAllowlisted).toBe(21)
    expect(result.totalRegisteredUntested).toBe(27)
  })
})
