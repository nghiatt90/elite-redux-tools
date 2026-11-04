/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ABILITY_HOOK_ALLOWLIST,
  classifyPair,
  extractBlockStatDropAbilities,
  extractSwitchInAbilities,
  extractSwitchOutAbilities,
  extractTrapAbilities,
  generateInventoryDoc,
  isDirectlyPorted,
  loadTestMentionedAbilities,
  runInventory,
  PORTED_BLOCK_STAT_DROP_ABILITIES_SET,
  PORTED_STAT_LOWERED_ABILITIES,
  PORTED_STATUS_IMMUNE_ABILITIES,
  PORTED_SWITCH_IN_ABILITIES,
  PORTED_SWITCH_OUT_ABILITIES_SET,
  PORTED_TRAP_ABILITIES_SET,
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

    // The site lines and the "no unlisted note-only branch" direction are asserted in
    // cycle150dInventory.test.ts by re-discovering every raise site from the sim source text.

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
    it('fabricated ID flips the classifier only while it is inside a real ported set', () => {
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

      // The classifier must actually consult these sets. A fabricated id that exists only in test
      // data (the old test) proves nothing; inserting it into the exported set must flip the answer.
      const cases = [
        { hook: 'onEntry' as const, set: PORTED_SWITCH_IN_ABILITIES },
        { hook: 'onBlockStatDrops' as const, set: PORTED_BLOCK_STAT_DROP_ABILITIES_SET },
        { hook: 'onStatLowered' as const, set: PORTED_STAT_LOWERED_ABILITIES },
        { hook: 'onStatusImmune' as const, set: PORTED_STATUS_IMMUNE_ABILITIES },
        { hook: 'onTrap' as const, set: PORTED_TRAP_ABILITIES_SET },
      ]

      for (const { hook, set } of cases) {
        expect(isDirectlyPorted(fabricatedId, hook), `${fabricatedId}:${hook} before insertion`).toBe(false)
        set.add(fabricatedId)
        try {
          expect(isDirectlyPorted(fabricatedId, hook), `${fabricatedId}:${hook} in the ported set`).toBe(true)
          expect(classifyPair(fabricatedId, hook, customHooksData)).toBe('ported')
        } finally {
          set.delete(fabricatedId)
        }
        expect(isDirectlyPorted(fabricatedId, hook), `${fabricatedId}:${hook} after removal`).toBe(false)
        expect(classifyPair(fabricatedId, hook, customHooksData)).toBe('unported')
      }
    })
  })

  describe('(7) Ported sets are derived from dispatcher source, not hand-typed lists', () => {
    /** Deletes exactly one source line, so the mutated text is not a valid program but is still parseable by the extractor. */
    const dropLineContaining = (source: string, needle: string): string => {
      const lines = source.split('\n')
      const kept = lines.filter((line) => !line.includes(needle))
      expect(kept.length, `expected exactly one line containing ${needle}`).toBe(lines.length - 1)
      return kept.join('\n')
    }

    it('onTrap: deleting the Shadow Tag case label removes it from a fresh extraction', () => {
      const source = readFileSync(join(ENGINE_DIR, 'sim/escape.ts'), 'utf-8')
      expect(extractTrapAbilities(source)).toEqual(PORTED_TRAP_ABILITIES_SET)
      expect(PORTED_TRAP_ABILITIES_SET.has('ABILITY_SHADOW_TAG')).toBe(true)
      const mutated = dropLineContaining(source, "case 'ABILITY_SHADOW_TAG':")
      expect(extractTrapAbilities(mutated).has('ABILITY_SHADOW_TAG')).toBe(false)
    })

    it('onBlockStatDrops: deleting the Clear Body case label removes it from a fresh extraction', () => {
      const source = readFileSync(join(ENGINE_DIR, 'sim/statBuffs.ts'), 'utf-8')
      expect(extractBlockStatDropAbilities(source)).toEqual(PORTED_BLOCK_STAT_DROP_ABILITIES_SET)
      expect(PORTED_BLOCK_STAT_DROP_ABILITIES_SET.has('ABILITY_CLEAR_BODY')).toBe(true)
      const mutated = dropLineContaining(source, "case 'ABILITY_CLEAR_BODY':")
      expect(extractBlockStatDropAbilities(mutated).has('ABILITY_CLEAR_BODY')).toBe(false)
    })

    it('onExit: deleting the Regenerator case label removes it, while note-only branches stay unported', () => {
      const source = readFileSync(join(ENGINE_DIR, 'sim/turn.ts'), 'utf-8')
      expect(extractSwitchOutAbilities(source)).toEqual(PORTED_SWITCH_OUT_ABILITIES_SET)
      expect(PORTED_SWITCH_OUT_ABILITIES_SET.has('ABILITY_REGENERATOR')).toBe(true)
      // Generator is a real switch case, but its branch only pushes a note.
      expect(PORTED_SWITCH_OUT_ABILITIES_SET.has('ABILITY_GENERATOR')).toBe(true)
      expect(isDirectlyPorted('ABILITY_GENERATOR', 'onExit')).toBe(false)
      const mutated = dropLineContaining(source, "case 'ABILITY_REGENERATOR':")
      expect(extractSwitchOutAbilities(mutated).has('ABILITY_REGENERATOR')).toBe(false)
    })

    it('onEntry: deleting the Wind Rider branch head removes it from a fresh extraction', () => {
      const source = readFileSync(join(ENGINE_DIR, 'sim/switchInAbility.ts'), 'utf-8')
      expect(extractSwitchInAbilities(source)).toEqual(PORTED_SWITCH_IN_ABILITIES)
      expect(PORTED_SWITCH_IN_ABILITIES.has('ABILITY_WIND_RIDER')).toBe(true)
      // The Air Blower Tailwind call still passes the id as an argument; that literal is not evidence.
      const mutated = dropLineContaining(source, "if (abilityId === 'ABILITY_WIND_RIDER') {")
      expect(mutated).toContain("disableSwitchInAbility(state, battlerId, 'ABILITY_WIND_RIDER', deps.dataContext)")
      expect(extractSwitchInAbilities(mutated).has('ABILITY_WIND_RIDER')).toBe(false)
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

    it('stale allowlist: an entry that grants nothing is reported by runInventory', () => {
      const staleAllowlist: AllowlistEntry[] = [
        {
          ability: 'ABILITY_NOT_IN_DATA',
          hook: 'onStat',
          citation: 'src/abilities.cc:1',
        },
        {
          // Already ported: allowlisting it hides nothing, so it is stale too.
          ability: 'ABILITY_THUNDERCALL',
          hook: 'onAttacker',
          citation: 'src/abilities.cc:2',
        },
      ]

      const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
      expect(runInventory(abilityHooks, mentioned, ABILITY_HOOK_ALLOWLIST).staleAllowlist).toEqual([])
      const result = runInventory(abilityHooks, mentioned, staleAllowlist)
      expect(result.staleAllowlist.map((e) => `${e.ability}:${e.hook}`).sort()).toEqual([
        'ABILITY_NOT_IN_DATA:onStat',
        'ABILITY_THUNDERCALL:onAttacker',
      ])
      // Neither entry hides a real gap: the ported pair stays ported, the absent one never existed.
      expect(result.totalAllowlisted).toBe(0)
      expect(classifyPair('ABILITY_THUNDERCALL', 'onAttacker', abilityHooks)).toBe('ported')
    })

    it('generateInventoryDoc throws when sources.lock.json is unreadable', () => {
      const fakeResult = runInventory({}, new Set(), [])
      expect(() =>
        generateInventoryDoc(fakeResult, {}, '/nonexistent/path/sources.lock.json'),
      ).toThrow()
    })
  })
})
