/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  classifyPair,
  extractBlockStatDropAbilities,
  extractSwitchInAbilities,
  extractSwitchOutAbilities,
  extractTrapAbilities,
  generateInventoryDoc,
  isDirectlyPorted,
  runInventory,
  NOTE_ONLY_PAIRS,
  type AbilityHookRecord,
  type AllowlistEntry,
} from './driver/abilityHookInventory'
import { createBattleState, createBattlerState } from './create'
import { dispatchMoveEndAttackerAbilities, ON_RECOIL_ABILITIES } from './moveEnd'
import { dispatchSwitchOutAbilities } from './turn'
import { runReactiveAbilityEffects } from './statBuffs'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BattleState, SimBattleMon } from './state'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TurnLoopDeps } from './turn'
import {
  STATUS3_CHARGED_UP,
  setFlag,
} from './constants'

const HOOKS_PATH = fileURLToPath(new URL('../../../../data/v2.65beta/abilityHooks.json', import.meta.url))
const ENGINE_DIR = fileURLToPath(new URL('../', import.meta.url))
const DATA_DIR = fileURLToPath(new URL('../../../../data/v2.65beta', import.meta.url))

const abilityHooks: Record<string, AbilityHookRecord> = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'))

const snapshot = <T>(name: string): T => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawSpecies = snapshot<Array<SimSpeciesData>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id, s]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: (m.power as number) ?? 0,
    type: (m.type as string | null) ?? 'NORMAL',
    split: (m.split as SimMoveData['split']) ?? 'PHYSICAL',
    effect: (m.effect as string | null) ?? null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: (m.accuracy as number) ?? 100,
    hitsAir: (m.hitsAir as SimMoveData['hitsAir']) ?? undefined,
  }
}

const mockDataContext: SimDataContext = {
  move: (id: string) => requireMove(id),
  item: (id: string) => itemsById.get(id),
  species: (id: string) => speciesById.get(id),
}

const mockGrounding = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const mockDeps: TurnLoopDeps = {
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  grounding: mockGrounding,
  statStageRatios: [],
  dataContext: mockDataContext,
  damage: {
    resolve: () => {
      throw new Error('unused in inventory test')
    },
    typeEffectiveness: () => ({ multiplier: 1, effectiveness: 1, unmodelled: [] }),
  },
}

function makeMon(abilityId: string | null = null, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: abilityId, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function makeBattle(mons: SimBattleMon[]): BattleState {
  return createBattleState({
    battlers: mons.map((m, i) => createBattlerState(i, m, 0)),
    rng: { random16: () => 0 },
  })
}

describe('Cycle 150b ability hook inventory classifier fixes', () => {
  describe('(2) Note-only pairs classify as unported', () => {
    it('all 11 note-only pairs classify as unported', () => {
      expect(NOTE_ONLY_PAIRS).toHaveLength(11)
      for (const { ability, hook } of NOTE_ONLY_PAIRS) {
        const status = classifyPair(ability, hook, abilityHooks)
        expect(status, `${ability}:${hook} should classify as unported`).toBe('unported')
      }
    })

    it('control pair with a real handler stays ported (Thundercall onAttacker)', () => {
      const status = classifyPair('ABILITY_THUNDERCALL', 'onAttacker', abilityHooks)
      expect(status).toBe('ported')
    })

    it('source-text check: every NOTE_ONLY_PAIR cites a real not-modelled note site', () => {
      const moveEndContent = readFileSync(join(ENGINE_DIR, 'sim/moveEnd.ts'), 'utf-8')
      const turnContent = readFileSync(join(ENGINE_DIR, 'sim/turn.ts'), 'utf-8')
      const statBuffsContent = readFileSync(join(ENGINE_DIR, 'sim/statBuffs.ts'), 'utf-8')

      const contentByFile: Record<string, string> = {
        'web/src/engine/sim/moveEnd.ts': moveEndContent,
        'web/src/engine/sim/turn.ts': turnContent,
        'web/src/engine/sim/statBuffs.ts': statBuffsContent,
      }

      for (const entry of NOTE_ONLY_PAIRS) {
        const [filePath] = entry.site.split(':')
        const content = contentByFile[filePath]
        expect(content, `File not found for site: ${entry.site}`).toBeDefined()
        expect(
          content.includes(entry.ability),
          `${entry.ability} must be mentioned in ${filePath}`,
        ).toBe(true)
      }
    })

    it('source-text check: no other UseAttackerFollowUpMove or switch-out not-modelled note exists without a table entry', () => {
      const moveEndContent = readFileSync(join(ENGINE_DIR, 'sim/moveEnd.ts'), 'utf-8')
      const turnContent = readFileSync(join(ENGINE_DIR, 'sim/turn.ts'), 'utf-8')

      // Check moveEnd.ts for UseAttackerFollowUpMove notes
      const followupRegex = /"([^"]*UseAttackerFollowUpMove[^"]*is not modelled)"/g
      let match: RegExpExecArray | null
      const followupNotes: string[] = []
      while ((match = followupRegex.exec(moveEndContent)) !== null) {
        followupNotes.push(match[1])
      }

      // Expected followups: Aftershock, Blade Dance, High Tide, Purple Haze, Volcano Rage
      const tableAbilities = new Set(NOTE_ONLY_PAIRS.map((p) => p.ability))
      for (const note of followupNotes) {
        const found = [
          'ABILITY_AFTERSHOCK',
          'ABILITY_BLADE_DANCE',
          'ABILITY_HIGH_TIDE',
          'ABILITY_PURPLE_HAZE',
          'ABILITY_VOLCANO_RAGE',
        ].some((ab) => tableAbilities.has(ab))
        expect(found, `Note '${note}' must belong to an ability in NOTE_ONLY_PAIRS`).toBe(true)
      }

      // Check turn.ts for switch-out notes
      const switchOutRegex = /`([^`]*switch-out\s+([^`\s]+)[^`]*is not modelled)`/g
      while ((match = switchOutRegex.exec(turnContent)) !== null) {
        const abilityName = `ABILITY_${match[2].toUpperCase()}`
        expect(
          tableAbilities.has(abilityName),
          `Switch-out note '${match[1]}' for ${abilityName} must be in NOTE_ONLY_PAIRS`,
        ).toBe(true)
      }
    })

    it('minimal scenario tests: attacker followup note-only abilities raise their not-modelled note', () => {
      const cases: Array<{ ability: string; move: string; expectedSnippet: string }> = [
        {
          ability: 'ABILITY_AFTERSHOCK',
          move: 'MOVE_EARTHQUAKE',
          expectedSnippet: "Aftershock's followup move",
        },
        {
          ability: 'ABILITY_BLADE_DANCE',
          move: 'MOVE_SWORDS_DANCE',
          expectedSnippet: "Blade Dance's followup move",
        },
        {
          ability: 'ABILITY_HIGH_TIDE',
          move: 'MOVE_WATERFALL',
          expectedSnippet: "High Tide's followup move",
        },
        {
          ability: 'ABILITY_PURPLE_HAZE',
          move: 'MOVE_SLUDGE_BOMB',
          expectedSnippet: "Purple Haze's followup move",
        },
        {
          ability: 'ABILITY_VOLCANO_RAGE',
          move: 'MOVE_FLAMETHROWER',
          expectedSnippet: "Volcano Rage's followup move",
        },
      ]

      for (const { ability, move, expectedSnippet } of cases) {
        const state = makeBattle([makeMon(ability), makeMon(null)])

        const unmodelled: string[] = []
        dispatchMoveEndAttackerAbilities({
          state,
          attackerId: 0,
          targetId: 1,
          moveId: move,
          moveData: requireMove(move),
          targetDamage: 50,
          fainted: [],
          deps: mockDeps,
          unmodelled,
        })

        expect(
          unmodelled.some((n) => n.includes(expectedSnippet)),
          `Expected note snippet '${expectedSnippet}' in [${unmodelled.join(', ')}]`,
        ).toBe(true)
      }
    })

    it('minimal scenario tests: onExit note-only abilities raise switch-out notes', () => {
      // 1. Generator and Energized: require chargedUp status3
      for (const ability of ['ABILITY_GENERATOR', 'ABILITY_ENERGIZED']) {
        const state = makeBattle([makeMon(ability)])
        const battler = state.battlers[0]!
        battler.statuses3 = setFlag(battler.statuses3, STATUS3_CHARGED_UP)

        const unmodelled: string[] = []
        dispatchSwitchOutAbilities(state, 0, undefined, mockDeps, unmodelled)
        expect(unmodelled.some((n) => n.includes('switch-out') && n.includes('is not modelled'))).toBe(true)
      }

      // 2. Retriever: hp > 0 and itemId === null
      {
        const state = makeBattle([makeMon('ABILITY_RETRIEVER')])
        const battler = state.battlers[0]!
        battler.mon.itemId = null

        const unmodelled: string[] = []
        dispatchSwitchOutAbilities(state, 0, undefined, mockDeps, unmodelled)
        expect(unmodelled.some((n) => n.includes('Retriever') && n.includes('is not modelled'))).toBe(true)
      }
    })

    it('minimal scenario tests: onReactive note-only abilities raise reactive notes', () => {
      // Retribution Blow: opponent stat increase
      const state = makeBattle([makeMon('ABILITY_RETRIBUTION_BLOW'), makeMon(null)])
      state.statStageCheckState = 1 // STAT_STAGE_CHECK_NEEDED
      state.statChangesToCheck = [
        [0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0], // STAT_ATK increased on battler 1
      ]

      const unmodelled: string[] = []
      runReactiveAbilityEffects(state, mockDeps, unmodelled)
      expect(unmodelled.some((n) => n.includes('Retribution Blow'))).toBe(true)
    })
  })

  describe('(3) Aliases are not followed without explicit resolver allowance', () => {
    it('Flame Bubble onPriority and Bloodlust onReactive classify as unported', () => {
      expect(classifyPair('ABILITY_FLAME_BUBBLE', 'onPriority', abilityHooks)).toBe('unported')
      expect(classifyPair('ABILITY_BLOODLUST', 'onReactive', abilityHooks)).toBe('unported')
    })

    it('Flaming Soul onPriority and Blood Bath onReactive stay ported', () => {
      expect(classifyPair('ABILITY_FLAMING_SOUL', 'onPriority', abilityHooks)).toBe('ported')
      expect(classifyPair('ABILITY_BLOOD_BATH', 'onReactive', abilityHooks)).toBe('ported')
    })
  })

  describe('(4) onRecoil sim checks', () => {
    it('all five ON_RECOIL_ABILITIES classify as ported', () => {
      expect(ON_RECOIL_ABILITIES).toHaveLength(5)
      for (const id of ON_RECOIL_ABILITIES) {
        expect(classifyPair(id, 'onRecoil', abilityHooks)).toBe('ported')
      }
    })

    it('fabricated onRecoil ability without handler classifies as unported', () => {
      const fabricated: Record<string, AbilityHookRecord> = {
        ABILITY_FABRICATED_RECOIL: {
          id: 'ABILITY_FABRICATED_RECOIL',
          sourceLine: 1,
          hooks: { onRecoil: { form: 'lambda' } },
        },
      }
      expect(classifyPair('ABILITY_FABRICATED_RECOIL', 'onRecoil', fabricated)).toBe('unported')
    })
  })

  describe('(1) Dispatcher branch evidence instead of census list membership', () => {
    it('fabricated ID in census lists does not make a pair ported', () => {
      const fabricatedId = 'ABILITY_SYNTHETIC_CENSUS_ONLY'
      const customHooksData: Record<string, AbilityHookRecord> = {
        [fabricatedId]: {
          id: fabricatedId,
          sourceLine: 1,
          hooks: {
            onEntry: { form: 'lambda' },
            onBlockStatDrops: { form: 'lambda' },
            onStatLowered: { form: 'lambda' },
            onStatusImmune: { form: 'lambda' },
            onTrap: { form: 'lambda' },
          },
        },
      }

      // Assert that synthetic id alone is NOT directly ported for any of these
      expect(isDirectlyPorted(fabricatedId, 'onEntry')).toBe(false)
      expect(isDirectlyPorted(fabricatedId, 'onBlockStatDrops')).toBe(false)
      expect(isDirectlyPorted(fabricatedId, 'onStatLowered')).toBe(false)
      expect(isDirectlyPorted(fabricatedId, 'onStatusImmune')).toBe(false)
      expect(isDirectlyPorted(fabricatedId, 'onTrap')).toBe(false)

      expect(classifyPair(fabricatedId, 'onEntry', customHooksData)).toBe('unported')
      expect(classifyPair(fabricatedId, 'onBlockStatDrops', customHooksData)).toBe('unported')
      expect(classifyPair(fabricatedId, 'onStatLowered', customHooksData)).toBe('unported')
      expect(classifyPair(fabricatedId, 'onStatusImmune', customHooksData)).toBe('unported')
      expect(classifyPair(fabricatedId, 'onTrap', customHooksData)).toBe('unported')
    })
  })

  describe('(7) Ported sets are derived from dispatcher source, not hand-typed lists', () => {
    it('onTrap set comes from the onTrap switch and matches the classifier', () => {
      const trap = extractTrapAbilities()
      expect(trap.size).toBeGreaterThan(0)
      expect(trap.has('ABILITY_SHADOW_TAG')).toBe(true)
      expect(trap.has('ABILITY_FABRICATED_DISPATCH')).toBe(false)
      expect(isDirectlyPorted('ABILITY_SHADOW_TAG', 'onTrap')).toBe(true)
      expect(isDirectlyPorted('ABILITY_FABRICATED_DISPATCH', 'onTrap')).toBe(false)
    })

    it('onBlockStatDrops set comes from statDropBlockForAbility and matches the classifier', () => {
      const block = extractBlockStatDropAbilities()
      expect(block.size).toBeGreaterThan(0)
      expect(block.has('ABILITY_CLEAR_BODY')).toBe(true)
      expect(block.has('ABILITY_FABRICATED_DISPATCH')).toBe(false)
      expect(isDirectlyPorted('ABILITY_CLEAR_BODY', 'onBlockStatDrops')).toBe(true)
      expect(isDirectlyPorted('ABILITY_FABRICATED_DISPATCH', 'onBlockStatDrops')).toBe(false)
    })

    it('onExit set comes from dispatchSwitchOutAbilities, with note-only branches still unported', () => {
      const exit = extractSwitchOutAbilities()
      expect(exit.size).toBeGreaterThan(0)
      expect(exit.has('ABILITY_REGENERATOR')).toBe(true)
      expect(exit.has('ABILITY_FABRICATED_DISPATCH')).toBe(false)
      expect(isDirectlyPorted('ABILITY_REGENERATOR', 'onExit')).toBe(true)
      expect(isDirectlyPorted('ABILITY_FABRICATED_DISPATCH', 'onExit')).toBe(false)
      // Generator is a real switch case, but its branch only pushes a note.
      expect(exit.has('ABILITY_GENERATOR')).toBe(true)
      expect(isDirectlyPorted('ABILITY_GENERATOR', 'onExit')).toBe(false)
    })

    it('onEntry set comes from applySwitchInAbilities maps and literals, not the census', () => {
      const entry = extractSwitchInAbilities()
      expect(entry.size).toBeGreaterThan(0)
      expect(entry.has('ABILITY_INTIMIDATE')).toBe(true) // INTIMIDATE_CLONE_MAP
      expect(entry.has('ABILITY_DRIZZLE')).toBe(true) // WEATHER_SETTER_MAP
      expect(entry.has('ABILITY_SUPERCELL')).toBe(true) // literal branch in the dispatcher body
      expect(entry.has('ABILITY_FABRICATED_DISPATCH')).toBe(false)
      expect(isDirectlyPorted('ABILITY_INTIMIDATE', 'onEntry')).toBe(true)
      expect(isDirectlyPorted('ABILITY_FABRICATED_DISPATCH', 'onEntry')).toBe(false)
    })
  })

  describe('(6) Allowlist quality and generateInventoryDoc error handling', () => {
    it('allowlisted pair is reported separately from ported', () => {
      const allowlist: AllowlistEntry[] = [
        {
          ability: 'ABILITY_FAKE_ALLOWLIST',
          hook: 'onStat',
          citation: 'src/abilities.cc:1',
        },
      ]
      const fakeData: Record<string, AbilityHookRecord> = {
        ABILITY_FAKE_ALLOWLIST: {
          id: 'ABILITY_FAKE_ALLOWLIST',
          sourceLine: 1,
          hooks: { onStat: { form: 'lambda' } },
        },
      }

      const result = runInventory(fakeData, new Set(), allowlist)
      expect(result.totalUnported).toBe(0)
      expect(result.totalAllowlisted).toBe(1)
      expect(result.totalPorted).toBe(0)
      expect(result.classifications[0]?.status).toBe('allowlisted')
    })

    it('stale allowlist test: detects entries not in data or already ported', () => {
      const staleAllowlist: AllowlistEntry[] = [
        {
          ability: 'ABILITY_NOT_IN_DATA',
          hook: 'onStat',
          citation: 'src/abilities.cc:1',
        },
        {
          // Already ported ability
          ability: 'ABILITY_THUNDERCALL',
          hook: 'onAttacker',
          citation: 'src/abilities.cc:2',
        },
      ]

      for (const entry of staleAllowlist) {
        const inData = Boolean(abilityHooks[entry.ability]?.hooks?.[entry.hook])
        const alreadyPorted = inData && isDirectlyPorted(entry.ability, entry.hook as any)
        const isStale = !inData || alreadyPorted
        expect(isStale).toBe(true)
      }
    })

    it('generateInventoryDoc throws when sources.lock.json is unreadable', () => {
      const fakeResult = runInventory({}, new Set(), [])
      expect(() =>
        generateInventoryDoc(fakeResult, {}, '/nonexistent/path/sources.lock.json'),
      ).toThrow()
    })
  })
})
