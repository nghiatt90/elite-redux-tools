/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { drainQueuedExtraAttacks, executeTurn, type ActionOutcome } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applyBattleStartPass, applySwitchInAbilities } from './switchInAbility'
import {
  BATTLE_TYPE_TRAINER,
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS2_POWDER,
  STATUS3_TELEKINESIS,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { ChosenAction, TurnOrder, TurnOrderMoveView } from './turnOrder'
import type { MoveData } from '../calculate'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle148cEntryMoves.test.ts.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: String(m.type).replace('TYPE_', ''),
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    split: m.split as MoveData['split'],
    effectChance: m.effectChance as number,
    splitFlag: m.splitFlag as string | undefined,
    effect: m.effect as string | null,
    customBehavior: m.customBehavior,
    crit: m.crit as MoveData['crit'],
    flags: (m.flags as Record<string, true>) ?? {},
    priority: m.priority as number,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
  }
}

function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
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
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
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
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
  battleTypeFlags = 0,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 100,
            spatk: s.spatk ?? 100,
            spdef: s.spdef ?? 100,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
    battleTypeFlags,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      isCriticalHit,
      effectiveness: 'NORMAL',
      rolls: [amount],
      unmodelled: [],
    }),
  }
}

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  replacement?: ReplacementDeps,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

const realBridge: BridgeDeps = {
  grounding: GROUNDING,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
}

function realResolverDeps(random: RandomSource): BridgeDamageResolverDeps {
  return {
    ...realBridge,
    moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
    typeChart: typeChart as never,
    inverseTypeChart: inverseTypeChart as never,
    moveBehaviors,
    battleConstants,
    random,
  }
}

function realTestDeps(random: RandomSource, replacement?: ReplacementDeps): TurnLoopDeps {
  return testDeps(createBridgeDamageResolver(realResolverDeps(random)), GROUNDING, replacement)
}

function useMove(target: number, moveId: string): ChosenAction {
  const moveData = requireMove(moveId)
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: (moveData.type ?? 'NORMAL').replace(/^TYPE_/, ''),
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const holderAbility = (ability: string, ...innates: Array<string | null>): SimBattleMon['abilities'] => ({
  ability,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

/** A full 8-entry stat-stage array (constants.ts's internal 0..12 scale). */
function stages(overrides: Record<number, number> = {}): number[] {
  const out = new Array<number>(8).fill(DEFAULT_STAT_STAGE)
  for (const [stat, value] of Object.entries(overrides)) out[Number(stat)] = value
  return out
}

const WATER: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']

/**
 * Runs TryDoEventsBeforeFirstTurn exactly as driver/session.ts wires it: the same
 * identity TurnOrder and the same drainQueuedExtraAttacks callback, so a lead's
 * entry move runs before the next lead's switch-in abilities
 * (battle_main.c:3380, :3320-3322).
 */
function battleStart(state: BattleState, deps: TurnLoopDeps): { outcomes: ActionOutcome[]; unmodelled: string[] } {
  const { isBattlerGrounded: _isBattlerGrounded, ...turnOrder } = NEUTRAL_TURN_ORDER_CONTEXT
  const order: TurnOrder = {
    battlerByTurnOrder: Array.from({ length: state.battlersCount }, (_, i) => i),
    actionsByTurnOrder: new Array<ChosenAction['action']>(state.battlersCount).fill('USE_MOVE'),
  }
  const outcomes: ActionOutcome[] = []
  const unmodelled: string[] = []
  applyBattleStartPass(
    state,
    {
      grounding: GROUNDING,
      dataContext: DATA_CONTEXT,
      turnOrder,
      statStageRatios: RATIOS,
      drainQueuedExtraAttacks: () => drainQueuedExtraAttacks(state, 0, order, deps, outcomes),
    },
    unmodelled,
  )
  return { outcomes, unmodelled }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 148d - UseEntryMove review fixes', () => {
  describe('item 1: a lead entry move drains before the next lead abilities', () => {
    it('Intimidate on the slower lead applies AFTER the faster lead queued Feint Attack', () => {
      // Level 50, atk 100, def 100 (scaffolding defaults). Low Blow queues MOVE_FEINT_ATTACK
      // (declared power 80) with movePower 40, which Cmd_damagecalc passes as fixedBasePower
      // (battle_script_commands.c:1598-1611) and CalcMoveBasePowerAfterModifiers substitutes for
      // the base power (battle_util.c:6969):
      //   floor(2 * 50 / 5) + 2 = 22; 22 * 40 = 880; 880 * 100 / 100 = 880; 880 / 50 = 17; +2 = 19.
      // Damage roll 0 keeps 100% (battle_util.c:7790-7795: dmg *= 100 - roll): 19 damage -> 81 HP.
      // Draws: accuracy (always drawn, battle_script_commands.c:1433; a 0-accuracy move resolves
      // to 101 via HITS_IF_POSSIBLE so 0 can never miss), crit (1 % 24 != 0), damage roll (0).
      // Before the fix Intimidate ran first: atk stage 5 -> floor(100 * 2 / 3) = 66 ->
      // 22 * 40 * 66 / 100 / 50 = 11 (truncated) + 2 = 13 -> 87 HP.
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [
          { spe: 100, types: WATER, abilities: holderAbility('ABILITY_LOW_BLOW') },
          { spe: 50, types: WATER, abilities: holderAbility('ABILITY_INTIMIDATE') },
        ],
        rng,
      )

      const { outcomes } = battleStart(state, realTestDeps(rng))

      expect(outcomes).toHaveLength(1)
      expect(state.battlers[1]!.mon.hp).toBe(81)
      // Intimidate still lands, just after the entry attack.
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.queuedExtraAttacks).toEqual([])
    })

    it('two entry-move leads run in speed order: fast Tickle before slow Spectral Thief', () => {
      // Battler 0 (spe 100) Monkey Business queues MOVE_TICKLE: target Atk -1, Def -1.
      // Battler 1 (spe 50) Phantom Thief queues MOVE_SPECTRAL_THIEF at fixed power 40 (declared 90).
      // With Tickle first, battler 1 attacks with Atk stage 5 -> floor(100 * 2 / 3) = 66:
      //   22 * 40 * 66 / 100 = 580 (truncated); 580 / 50 = 11; +2 = 13 -> battler 0 at 87 HP.
      // The pre-fix LIFO drain ran Spectral Thief first at full Atk 100:
      //   22 * 40 * 100 / 100 / 50 = 17; +2 = 19 -> battler 0 at 81 HP.
      // Draws: Tickle accuracy, Spectral Thief accuracy, crit (1), damage roll (0), then the
      // EFFECT_SPECTRAL_THIEF secondary roll (0 < 100 applies; it steals no boosts either way).
      const rng = scriptedRng([0, 0, 1, 0, 0])
      const state = battle(
        [
          { spe: 100, types: WATER, abilities: holderAbility('ABILITY_MONKEY_BUSINESS') },
          { spe: 50, types: WATER, abilities: holderAbility('ABILITY_PHANTOM_THIEF') },
        ],
        rng,
      )

      const { outcomes } = battleStart(state, realTestDeps(rng))

      // C order: the fast lead's queued move, then the slow lead's (battle_main.c:3380).
      expect(outcomes.map((o) => o.battlerId)).toEqual([0, 1])
      expect(state.battlers[0]!.mon.hp).toBe(87)
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.queuedExtraAttacks).toEqual([])
    })
  })

  describe('item 2: the fixed power override must not reach Technician', () => {
    it('Technician does not boost Low Blow queued Feint Attack (declared 80, override 40)', () => {
      // Damage without any boost: 22 * 40 * 100 / 100 / 50 = 17; +2 = 19 -> 81 HP.
      // The old resolver replaced move.power with 40, so Technician (abilities.cc:1626-1630,
      // ctx.basePower <= 60) multiplied 19 by 1.5: applyModifier(6144, 19) =
      // floor((6144 * 19 + 2048) / 4096) = 29 -> 71 HP. CalcFinalDmg hands
      // CalculateAbilityMultipliers CalcMoveBasePower's own result (battle_util.c:7503-7505),
      // i.e. the DECLARED 80, so no boost.
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [{ types: WATER, abilities: holderAbility('ABILITY_TECHNICIAN', 'ABILITY_LOW_BLOW') }, { types: WATER }],
        rng,
      )

      applySwitchInAbilities(state, 0, testDeps(), [])
      expect(state.queuedExtraAttacks).toHaveLength(1)
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(81)
    })

    it('control: the same queued attack without Technician deals the same 19 damage', () => {
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [{ types: WATER, abilities: { ability: null, innates: ['ABILITY_LOW_BLOW', null, null] } }, { types: WATER }],
        rng,
      )

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(81)
    })

    it('positive control: Technician still boosts a declared power-40 queued move (Cheap Tactics)', () => {
      // MOVE_SCRATCH declares 40, so Technician sees basePower 40 <= 60:
      // 22 * 40 * 100 / 100 / 50 = 17; +2 = 19; applyModifier(6144, 19) = 29 -> 71 HP.
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        [{ types: WATER, abilities: holderAbility('ABILITY_TECHNICIAN', 'ABILITY_CHEAP_TACTICS') }, { types: WATER }],
        rng,
      )

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(71)
    })

    for (const alias of ['ABILITY_BANDIT', 'ABILITY_KUNOICHI_BLADE']) {
      it(`${alias} (Technician alias) does not boost the override either`, () => {
        const rng = scriptedRng([0, 1, 0])
        const state = battle(
          [{ types: WATER, abilities: holderAbility(alias, 'ABILITY_LOW_BLOW') }, { types: WATER }],
          rng,
        )

        applySwitchInAbilities(state, 0, testDeps(), [])
        executeTurn(state, [null, null], realTestDeps(rng))

        expect(state.battlers[1]!.mon.hp).toBe(81)
      })
    }
  })

  describe('item 3: an entry move queued by a queued switch drains immediately', () => {
    // CanBattlerBeForceSwitched requires BATTLE_TYPE_TRAINER (abilities.cc:2608-2616), which is
    // also why the battle carries the flag here.
    function emergencyExitParties() {
      return {
        lead: partyMon({ hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_EMERGENCY_EXIT') }),
        reserve: partyMon({ hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_TELEKINETIC') }),
      }
    }

    it('non-last action slot: the switched-in entry move runs before the next action', () => {
      // Battler 0 (spe 100) Tackles the Emergency Exit holder for 60: 100 -> 40 HP, crossing half
      // (CheckHalfHpAbility, battle_util.c:9043-9048) and queueing the switch. The reserve has
      // Telekinetic, whose entry move is MOVE_TELEKINESIS. Draws: Tackle accuracy (0) only -- no
      // Random() runs on BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500), so the
      // replacement comes from deps.replacement and selects party slot 1.
      const rng = scriptedRng([0])
      const { lead, reserve } = emergencyExitParties()
      const state = battle(
        [
          { spe: 100, types: WATER },
          { spe: 50, hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_EMERGENCY_EXIT') },
        ],
        rng,
        undefined,
        [lead, reserve],
        BATTLE_TYPE_TRAINER,
      )

      const res = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), useMove(0, 'MOVE_TACKLE')], testDeps(fixedDamage(60), GROUNDING, { chooseReplacement: () => 1 }))

      expect(state.battlers[1]!.partyIndex).toBe(1)
      // Tackle (slot 0), then the switch-in entry move at that same slot, then battler 1's action.
      expect(res.actions.map((a) => `${a.battlerId}@${a.turnOrderIndex}`)).toEqual(['0@0', '1@0', '1@1'])
      // Telekinesis landed before end-of-turn: 3 from Cmd_settelekinesis (battle_script_commands.c:13033-13034)
      // minus ENDTURN_TELEKINESIS's one decrement (battle_util.c:2886-2894).
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_TELEKINESIS)).toBe(true)
      expect(state.battlers[0]!.volatiles.telekinesisTimer).toBe(2)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(state.queuedSwitches).toEqual([])
    })

    it('last action slot: the switched-in entry move runs before end-of-turn effects', () => {
      // Battler 1 (spe 100) holds Emergency Exit; battler 0 (spe 50) attacks LAST.
      // Same damage arithmetic as above. Telekinesis is queued after the final action; with the
      // fix it runs before the end-of-turn ladders, so ENDTURN_TELEKINESIS still decrements 3 -> 2.
      // Without it, the attack would sit in the queue until the post-end-turn drain
      // (battle_main.c:3483), leaving the timer at 3.
      const rng = scriptedRng([0])
      const { lead, reserve } = emergencyExitParties()
      const state = battle(
        [
          { spe: 50, types: WATER },
          { spe: 100, hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_EMERGENCY_EXIT') },
        ],
        rng,
        undefined,
        [lead, reserve],
        BATTLE_TYPE_TRAINER,
      )

      const res = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], testDeps(fixedDamage(60), GROUNDING, { chooseReplacement: () => 1 }))

      expect(state.battlers[1]!.partyIndex).toBe(1)
      expect(res.actions.map((a) => `${a.battlerId}@${a.turnOrderIndex}`)).toEqual(['1@0', '0@1', '1@1'])
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_TELEKINESIS)).toBe(true)
      expect(state.battlers[0]!.volatiles.telekinesisTimer).toBe(2)
      expect(state.queuedExtraAttacks).toEqual([])
      expect(state.queuedSwitches).toEqual([])
    })

    it('negative: a queued switch whose new mon has no entry-move ability leaves the queues empty', () => {
      const rng = scriptedRng([0])
      const lead = partyMon({ hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_EMERGENCY_EXIT') })
      const reserve = partyMon({ hp: 100, maxHp: 100, types: WATER })
      const state = battle(
        [
          { spe: 100, types: WATER },
          { spe: 50, hp: 100, maxHp: 100, types: WATER, abilities: holderAbility('ABILITY_EMERGENCY_EXIT') },
        ],
        rng,
        undefined,
        [lead, reserve],
        BATTLE_TYPE_TRAINER,
      )

      const res = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], testDeps(fixedDamage(60), GROUNDING, { chooseReplacement: () => 1 }))

      expect(state.battlers[1]!.partyIndex).toBe(1)
      // Tackle, then the blank slot battler 1 still consumes -- but no entry-move outcome at index 0.
      expect(res.actions.map((a) => `${a.battlerId}@${a.turnOrderIndex}`)).toEqual(['0@0', '1@1'])
      expect(state.queuedExtraAttacks).toEqual([])
      expect(state.queuedSwitches).toEqual([])
    })
  })

  describe('item 4: executeTurn coverage for the remaining entry-move abilities', () => {
    it('Trickster queues Disable: the foe last move is disabled for 4 turns (3 after end of turn)', () => {
      // Cmd_disablelastusedattack (battle_script_commands.c:10706-10737) sets disableTimer = 4
      // (B_DISABLE_TURNS, GEN_7); ENDTURN_DISABLE (:2774-2791) decrements once at turn end.
      // Draws: the one accuracycheck (battle_scripts_1.s:4627).
      const rng = scriptedRng([0])
      const state = battle([{ types: WATER, abilities: holderAbility('ABILITY_TRICKSTER') }, { types: WATER }], rng)
      state.battlers[1]!.lastMove = 'MOVE_TACKLE'

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
      expect(state.battlers[1]!.volatiles.disableTimer).toBe(3)
    })

    it('Trickster negative: a foe with no last move is not disabled', () => {
      const rng = scriptedRng([0])
      const state = battle([{ types: WATER, abilities: holderAbility('ABILITY_TRICKSTER') }, { types: WATER }], rng)

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.volatiles.disabledMove).toBeNull()
      expect(state.battlers[1]!.volatiles.disableTimer).toBe(0)
    })

    it('Telekinetic queues Telekinesis: STATUS3_TELEKINESIS with the timer set for 3 turns', () => {
      // Cmd_settelekinesis (battle_script_commands.c:13028-13037) sets the status and timer 3;
      // ENDTURN_TELEKINESIS (battle_util.c:2886-2894) decrements to 2 at the end of this turn.
      const rng = scriptedRng([0])
      const state = battle([{ types: WATER, abilities: holderAbility('ABILITY_TELEKINETIC') }, { types: WATER }], rng)

      applySwitchInAbilities(state, 0, testDeps(), [])
      const res = executeTurn(state, [null, null], realTestDeps(rng))

      // The pre-loop drain's Telekinesis outcome comes first, then the two blank slots.
      expect(res.actions).toHaveLength(3)
      expect(res.actions[0]!.battlerId).toBe(0)
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(true)
      expect(state.battlers[1]!.volatiles.telekinesisTimer).toBe(2)
    })

    it('Powder Burst: a powdered foe is hurt for maxHp/4 when it uses a Fire move', () => {
      // CANCELLER_POWDER_STATUS (battle_util.c:3468-3480): a Fire move by a STATUS2_POWDER attacker
      // is cancelled and gBattleMoveDamage = maxHP / 4 (Magic Guard aside) -> 100 / 4 = 25.
      // ENDTURN_POWDER then clears the status. Ember is cancelled before its accuracy check, so
      // the only draw is Powder's NO_ACC_CALC_CHECK_LOCK_ON (which draws nothing).
      const rng = scriptedRng([0])
      const state = battle(
        [
          { spe: 100, types: WATER, abilities: holderAbility('ABILITY_POWDER_BURST') },
          { spe: 50, types: WATER, moves: ['MOVE_EMBER', null, null, null] },
        ],
        rng,
      )

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, useMove(0, 'MOVE_EMBER')], realTestDeps(rng))

      expect(state.battlers[0]!.mon.hp).toBe(100)
      expect(state.battlers[1]!.mon.hp).toBe(75)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_POWDER)).toBe(false)
    })

    it('Phantom Thief queues Spectral Thief at fixed power 40 and steals the foe positive boosts', () => {
      // Spectral Thief declares 90 but the queued attack passes 40 (battle_script_commands.c:1598-1611):
      // 22 * 40 * 100 / 100 / 50 = 17; +2 = 19 -> 81 HP. MOVE_EFFECT_SPECTRAL_THIEF
      // (battle_script_commands.c:2892-2922) moves the target's +2 Atk (stage 8) to the attacker.
      // Draws: accuracy, crit (1), damage roll (0), secondary roll (0 < 100).
      const rng = scriptedRng([0, 1, 0, 0])
      const state = battle(
        [
          { types: WATER, abilities: holderAbility('ABILITY_PHANTOM_THIEF') },
          { types: WATER },
        ],
        rng,
      )
      // createBattlerState rebuilds statStages (create.ts:375), so the pre-battle boost is set here.
      state.battlers[1]!.mon.statStages = stages({ [STAT_ATK]: DEFAULT_STAT_STAGE + 2 })

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(81)
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    })

    it('Cheap Tactics queues Scratch at fixed power 40 for 19 damage', () => {
      // 22 * 40 * 100 / 100 / 50 = 17; +2 = 19 -> 81 HP. Draws: accuracy, crit (1), damage roll (0).
      const rng = scriptedRng([0, 1, 0])
      const state = battle([{ types: WATER, abilities: holderAbility('ABILITY_CHEAP_TACTICS') }, { types: WATER }], rng)

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.mon.hp).toBe(81)
    })

    it('Monster Mash negative case: Trick-or-Treat on an existing Ghost still sets trickOrTreat', () => {
      // VARIOUS_TRY_THIRD_TYPE (battle_script_commands.c:7768-7781) fails an already-typed target
      // EXCEPT Trick-or-Treat's Ghost, which sets trickOrTreat and type3 = GHOST. (The review note
      // claimed the C fails here; the C does not.)
      const rng = scriptedRng([0])
      const state = battle(
        [
          { types: WATER, abilities: holderAbility('ABILITY_MONSTER_MASH') },
          { types: ['GHOST', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(state.battlers[1]!.volatiles.trickOrTreat).toBe(true)
      expect(state.battlers[1]!.mon.types[2]).toBe('GHOST')
    })

    it('Monkey Business negative case: Tickle fails at -6 Atk and Def without drawing accuracy', () => {
      // BattleScript_EffectTickle (battle_scripts_1.s:6610-6618) runs the two jumpifstat checks
      // BEFORE accuracycheck, so both stats at MIN_STAT_STAGE fail the move with no Random().
      const rng = scriptedRng([])
      const state = battle(
        [
          { types: WATER, abilities: holderAbility('ABILITY_MONKEY_BUSINESS') },
          { types: WATER },
        ],
        rng,
      )
      // createBattlerState rebuilds statStages (create.ts:375), so the floor stages are set here.
      state.battlers[1]!.mon.statStages = stages({ [STAT_ATK]: MIN_STAT_STAGE, [STAT_DEF]: MIN_STAT_STAGE })

      applySwitchInAbilities(state, 0, testDeps(), [])
      executeTurn(state, [null, null], realTestDeps(rng))

      expect(rng.calls).toBe(0)
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE)
    })
  })
})
