/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT, type TurnOrder } from './turnOrder'
import type { ActionOutcome, DamageResolver, TurnLoopDeps } from './turn'
import { drainQueuedExtraAttacks, roundStructsClear } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applyBattleStartPass, getSingleUseAbilityCounter } from './switchInAbility'
import { STATUS2_SUBSTITUTE, hasFlag, setFlag } from './constants'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import type { MoveData } from '../calculate'
import { buildMoveAction, createSession, stepTurn } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'

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
  })
}

function scriptedRng(values: number[] = [0], fallback = 0): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? fallback
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function foeMon(overrides: Partial<TrainerMonData> = {}): TrainerMonData {
  return {
    species: 'SPECIES_MUDKIP',
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability: 'ABILITY_SWIFT_SWIM',
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves: ['MOVE_TACKLE'],
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
    ...overrides,
  }
}

function trainerWith(lead: TrainerMonData, bench: TrainerMonData[] = []): TrainerData {
  const party = [lead, ...bench]
  return {
    id: 'TRAINER_CYCLE148F',
    trainerNum: 9999,
    name: 'CYCLE',
    gender: 'MALE',
    forcedDouble: false,
    risky: false,
    preferStatus: false,
    preferStall: false,
    noSwitching: false,
    class: 'TRAINER_CLASS_HIKER',
    parties: { ace: party, elite: party, hell: party },
  }
}

function playerLead(species: string, ability: string): PlayerMonSpec {
  return {
    species,
    level: 50,
    nature: 'NATURE_HARDY',
    ability,
    item: null,
    moves: ['MOVE_TACKLE', null, null, null],
  }
}

describe('Cycle 148f Fixes', () => {
  describe('Item 1: Coward restore after the battle-start cleanup', () => {
    it('restores MOVE_PROTECT wiped by TurnValuesCleanUp (battle_main.c:3407-3411)', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_WOBBUFFET', 'ABILITY_COWARD')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      // Coward's onEntry (abilities.cc:5441-5451) counted itself off and armed
      // gRoundStructs[battler].protectMove; TurnValuesCleanUp(FALSE) (:3406) zeroed
      // the round struct, and the :3407-3411 loop puts the protect back for turn 1.
      expect(getSingleUseAbilityCounter(session.state, 0, 'ABILITY_COWARD', data.dataContext)).toBe(1)
      expect(session.state.battlers[0]!.round.protectMove).toBe('MOVE_PROTECT')
      expect(session.state.battlers[1]!.round.protectMove).toBeNull()
    })

    it('blocks the foe\'s turn-1 Tackle; the same setup without Coward takes damage', () => {
      const data = loadSimData()
      const run = (ability: string) => {
        const party = buildPlayerParty([playerLead('SPECIES_WOBBUFFET', ability)], 50, data)
        const session = createSession({
          data,
          playerParty: party,
          opponentTrainer: trainerWith(foeMon()),
          // Accuracy 0 -> hits, crit roll 1 -> no crit, damage roll 0 -> 100%.
          rng: scriptedRng([0, 1, 0, 0, 1, 0]),
        })
        const before = session.state.battlers[0]!.mon.hp
        stepTurn(
          session,
          buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'),
          buildMoveAction(session.state, data, 1, 'MOVE_TACKLE'),
        )
        return { before, after: session.state.battlers[0]!.mon.hp }
      }

      // The Mudkip (Speed 50) moves before Wobbuffet (Speed 33). IsBattlerProtected is
      // checked before Cmd_accuracycheck (turn.ts:3447, battle_util.c:6571-6645), so the
      // protected Tackle never reaches the damage path.
      const coward = run('ABILITY_COWARD')
      expect(coward.after).toBe(coward.before)
      // Control: the identical turn without the :3407-3411 restore must land the Tackle,
      // so this test fails if the protect is dropped.
      const plain = run('ABILITY_SHADOW_TAG')
      expect(plain.after).toBeLessThan(plain.before)
    })

    it('negative: a lead without Coward gets no protectMove', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_WOBBUFFET', 'ABILITY_SHADOW_TAG')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      // :3407-3411 only restores for a battler holding Coward; the counter is -1 here
      // (GetSingleUseAbilityCounter, battle_util.c:3954-3958, returns -1 when the ability
      // is not in any slot), so TurnValuesCleanUp's zeroing of gRoundStructs stands.
      expect(session.state.battlers[0]!.round.protectMove).toBeNull()
    })

    it('negative: a fainted Coward lead gets no protectMove', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_WOBBUFFET', 'ABILITY_COWARD')], 50, data)
      // A lead already at 0 HP when turn 1 setup runs (the fainted-lead replacement case is
      // Item 2(b)); with no reserve it is still there at :3407.
      party[0]!.hp = 0
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      // `if (!IsBattlerAlive(i)) continue;` (:3408) skips it. Its Coward counter is also 0
      // because HandleSwitchInAbility (:3354-3382) skips fainted leads, so this covers both
      // halves of the guard -- a living Coward's counter is latched to 1 by onEntry
      // (abilities.cc:5441-5451) well before :3407 and nothing in between decrements it.
      expect(getSingleUseAbilityCounter(session.state, 0, 'ABILITY_COWARD', data.dataContext)).toBe(0)
      expect(session.state.battlers[0]!.round.protectMove).toBeNull()
    })
  })

  describe('Item 2(a): queued battle-start switches drain before the cleanup', () => {
    it('switches out a lead that Emergency Exit drops to half HP, before turn 1', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(
          foeMon({ species: 'SPECIES_CHANSEY_REDUX', ability: 'ABILITY_EMERGENCY_EXIT' }),
          [foeMon({ species: 'SPECIES_MUDKIP' })],
        ),
        // accuracy 0, no crit, max damage roll, then the replacement draw picks
        // party slot 1 (chooseRandomSwitchReplacement, battle_script_commands.c:10176-10180).
        rng: scriptedRng([0, 1, 0], 1),
      })

      // Tyranitar's innate Juggernaut (abilities.cc:4168-4179) blends 20% of the
      // user's Def (130) into Atk for this contact move: 154 + 26 = 180. Feint
      // Attack at the entry move's power 40 (:4009-4016) against Def 30 is a base
      // of 107; Dark vs Fighting 0.5 then STAB 1.5 -> 80. 110 - 80 = 30 <= 110 / 2,
      // so Wimp Out's onDefender (abilities.cc:2608-2647) queues a SWITCH_ABILITY
      // entry. It must wait for canProcessSwitches (battle_main.c:3392), so the
      // lead loop leaves it queued and createSession's own drain performs the switch.
      expect(session.state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
      expect(session.state.battlers[1]!.mon.hp).toBe(session.state.battlers[1]!.mon.maxHp)
      expect(session.state.queuedSwitches).toHaveLength(0)
    })

    it('negative: the same hit above half HP leaves the lead in place', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(
          foeMon({
            species: 'SPECIES_CHANSEY_REDUX',
            ability: 'ABILITY_EMERGENCY_EXIT',
            evs: { hp: 252, atk: 0, def: 252, spatk: 0, spdef: 4, spe: 0 },
          }),
          [foeMon({ species: 'SPECIES_MUDKIP' })],
        ),
        rng: scriptedRng([0, 1, 0]),
      })

      // Same Atk 180, but Def 62 (252 EVs): 53 base, 0.5 type, 1.5 STAB -> 39.75,
      // which CalcFinalDmg rounds to 40. 142 - 40 = 102 > 142 / 2, so
      // CheckHalfHpAbility (battle_util.c:9043-9048) fails.
      expect(session.state.battlers[1]!.mon.speciesId).toBe('SPECIES_CHANSEY_REDUX')
      expect(session.state.battlers[1]!.mon.hp).toBe(102)
      expect(session.state.queuedSwitches).toHaveLength(0)
    })
  })

  describe('Item 2(b): fainted leads are replaced after TurnStructsClear', () => {
    it('replaces a lead that is fainted when turn 1 setup runs (battle_main.c:3413-3414)', () => {
      const data = loadSimData()
      const party = buildPlayerParty(
        [
          playerLead('SPECIES_CHANSEY_REDUX', 'ABILITY_FIGHT_SPIRIT'),
          playerLead('SPECIES_MUDKIP', 'ABILITY_SWIFT_SWIM'),
        ],
        50,
        data,
      )
      // Entry moves are queued with falseSwipe: TRUE (battle_util.c:4016), so they can
      // never faint a lead; a lead still fainted at this point is the case
      // HandleFaintedMonActions must replace -- e.g. one that died to a battle-start
      // switch-in's hazards. The state is identical, so start the slot at 0 HP.
      party[0]!.hp = 0
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
      expect(session.state.battlers[0]!.mon.hp).toBe(session.state.battlers[0]!.mon.maxHp)
    })
  })

  describe('Item 2(c): the reactive check re-runs after each queued-attack drain', () => {
    it('lets Acid Reflux answer the entry attack before the next lead', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon({ species: 'SPECIES_MUDKIP', ability: 'ABILITY_ACID_REFLUX' })),
        rng: scriptedRng([0, 1, 0, 0]),
      })

      // Tyranitar is faster (61 > 40): its Feint Attack drains inside its slot of the
      // lead loop and sets the foe's gRoundStructs.damaged. The re-entry after that
      // drain runs ABILITYEFFECT_REACTIVE (battle_main.c:3356), which queues Acid
      // Reflux's 20-power Acid; the next re-entry drains it before turn 1. Acid is
      // 0.5x into Rock/Dark: 7 base -> 3.5, rounded to 4, so 175 - 4 = 171.
      expect(session.state.queuedExtraAttacks).toHaveLength(0)
      expect(session.state.battlers[0]!.mon.hp).toBe(171)
    })
  })

  describe('Item 2(d): the drain gets the sorted order at index 0', () => {
    it('BattleStartDeps.drainQueuedExtraAttacks receives the speed-sorted order', () => {
      const rng = scriptedRng([0, 1, 0, 0])
      const state = battle(
        [
          // battler 0 is the slower lead, and the one carrying the entry move
          { spe: 50, abilities: { ability: 'ABILITY_LOW_BLOW', innates: [null, null, null] } },
          { spe: 100, hp: 100, maxHp: 100 },
        ],
        rng,
      )
      const outcomes: ActionOutcome[] = []
      let seenOrder: TurnOrder | null = null
      applyBattleStartPass(
        state,
        {
          grounding: GROUNDING,
          dataContext: DATA_CONTEXT,
          drainQueuedExtraAttacks: (order) => {
            seenOrder = order
            drainQueuedExtraAttacks(state, 0, order, realTestDeps(rng), outcomes)
          },
        },
        [],
      )

      // RecalculateMoveOrder (:3361) put battler 1 first, so the callback sees the
      // live gBattlerByTurnOrder, not an identity array.
      expect(seenOrder!.battlerByTurnOrder).toEqual([1, 0])
      // gCurrentTurnActionNumber is still 0 during battle start (:3413 is its first
      // write), so the extra attack runs in slot 0 rather than the lead's loop index.
      expect(outcomes[0]!.turnOrderIndex).toBe(0)
    })

    it('session: the slower lead\'s entry move does not read the faster lead as having acted (Analytic)', () => {
      const data = loadSimData()
      const party = buildPlayerParty([playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW')], 50, data)
      party[0]!.abilities.innates = ['ABILITY_ANALYTIC', null, null]
      const session = createSession({
        data,
        playerParty: party,
        // Chansey-redux (175 speed) leads the loop and sits at order slot 0.
        opponentTrainer: trainerWith(foeMon({ species: 'SPECIES_CHANSEY_REDUX', ability: 'ABILITY_FIGHT_SPIRIT' })),
        rng: scriptedRng([0, 1, 0]),
      })

      // 92 base; Dark vs Fighting 0.5 -> 46; STAB 1.5 -> 69, so 110 - 69 = 41.
      // At the old identity order with the lead's loop index (1), the target's slot
      // 0 would read as already acted (turn.ts:3172) and Analytic would add 1.3x.
      expect(session.state.battlers[1]!.mon.hp).toBe(41)
    })
  })

  describe('Item 6: TurnValuesCleanUp substitute and parentalBondOn lines', () => {
    it('clears STATUS2_SUBSTITUTE only when substituteHP is 0 (battle_main.c:4500)', () => {
      const state = battle([{ status2: STATUS2_SUBSTITUTE }, {}])
      state.battlers[0]!.volatiles.substituteHp = 0
      state.battlers[1]!.volatiles.substituteHp = 10
      state.battlers[1]!.mon.status2 = setFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)

      roundStructsClear(state)

      expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
    })

    it('zeroes parentalBondOn (battle_main.c:4502)', () => {
      const state = battle([{}, {}])
      state.battlers[0]!.turn.parentalBondOn = 2
      state.battlers[1]!.turn.parentalBondOn = 1

      roundStructsClear(state)

      expect(state.battlers[0]!.turn.parentalBondOn).toBe(0)
      expect(state.battlers[1]!.turn.parentalBondOn).toBe(0)
    })
  })
})
