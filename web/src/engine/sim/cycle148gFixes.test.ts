/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { applyBattleStartPass } from './switchInAbility'
import { DEFAULT_STAT_STAGE, STAT_ATK } from './constants'
import { MOVE_EFFECT_AFFECTS_USER, MOVE_EFFECT_CERTAIN, STAT_BUFF_NOT_PROTECT_AFFECTED, changeStatBuffs } from './statBuffs'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle148fFixes.test.ts.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))

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

const { isBattlerGrounded: _grounded, ...ORDER_CONTEXT } = NEUTRAL_TURN_ORDER_CONTEXT

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
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  itemId?: string | null
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
            spatk: 100,
            spdef: 100,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          itemId: s.itemId ?? null,
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
    id: 'TRAINER_CYCLE148G',
    trainerNum: 9997,
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

function playerLead(species: string, ability: string, moves: (string | null)[] = ['MOVE_TACKLE', null, null, null]): PlayerMonSpec {
  return {
    species,
    level: 50,
    nature: 'NATURE_HARDY',
    ability,
    item: null,
    moves,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cycle 148g Fixes', () => {
  describe('Item 1: replacement re-runs the rest of the battle-start sequence', () => {
    it('drains the replacement entry move and runs a second cleanup (battle_main.c:3413-3414 -> re-entry)', () => {
      const data = loadSimData()
      // Slot 0 is fainted (as if it died to a battle-start switch-in); slot 1 is the
      // replacement. Low Blow queues Feint Attack from its switch-in pass.
      const party = buildPlayerParty(
        [
          playerLead('SPECIES_CHANSEY_REDUX', 'ABILITY_FIGHT_SPIRIT'),
          playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW'),
        ],
        50,
        data,
      )
      party[0]!.hp = 0
      const session = createSession({
        data,
        playerParty: party,
        // Mudkip does not act, so the only entry move is the replacement's.
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_TYRANITAR')
      // :3320-3322 drains the replacement's queued entry attack on the re-entry.
      expect(session.state.queuedExtraAttacks).toHaveLength(0)
      // The second TurnValuesCleanUp(FALSE) (:3406) decrements isFirstTurn: the
      // replacement was set to 2 by its switch-in (:2899) and lands on 1; the foe
      // that survived the first pass goes 2 -> 1 -> 0.
      expect(session.state.battlers[0]!.volatiles.isFirstTurn).toBe(1)
      expect(session.state.battlers[1]!.volatiles.isFirstTurn).toBe(0)
      // Tyranitar Atk 180 (Juggernaut blends 20% of Def 130 into Atk 154), Level 50,
      // Feint Attack at Low Blow's entry power 40 against Mudkip Def 70:
      // floor(2*50/5+2)=22; floor(22*40*180/70/50)+2 = floor(45.25)+2 = 47;
      // Dark STAB 1.5 -> 70.5, which CalcFinalDmg's UQ_4_12 applyModifier rounds
      // (floor((6144*47 + 2048)/4096)) to 71. Mudkip maxHP 130 -> 59.
      expect(session.state.battlers[1]!.mon.maxHp).toBe(130)
      expect(session.state.battlers[1]!.mon.hp).toBe(59)
    })

    it('negative: with no fainted lead there is exactly one cleanup, unchanged', () => {
      const data = loadSimData()
      const party = buildPlayerParty(
        [
          playerLead('SPECIES_CHANSEY_REDUX', 'ABILITY_FIGHT_SPIRIT'),
          playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW'),
        ],
        50,
        data,
      )
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(foeMon()),
        rng: scriptedRng([0, 1, 0]),
      })

      expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_CHANSEY_REDUX')
      expect(session.state.queuedExtraAttacks).toHaveLength(0)
      expect(session.state.battlers[0]!.volatiles.isFirstTurn).toBe(1)
      expect(session.state.battlers[1]!.volatiles.isFirstTurn).toBe(1)
    })
  })

  describe('Item 4(a): the pre-loop ABILITYEFFECT_REACTIVE has an observable effect', () => {
    it('answers a pending stat change before the lead loop adds a second one (Mirror Herb)', () => {
      const rng = scriptedRng([0])
      const state = battle([
        { spe: 100, abilities: { ability: 'ABILITY_INTREPID_SWORD', innates: [null, null, null] } },
        { spe: 50, itemId: 'ITEM_MIRROR_HERB' },
      ], rng)

      // Seed one pending Atk raise as ChangeStatBuffs itself records it
      // (battle_script_commands.c:9937-9940). The pre-loop :3356 reactive must answer
      // it before the lead loop runs Intrepid Sword's own +1: Mirror Herb copies the
      // seeded raise and eats the item, so the later raise is not copied.
      changeStatBuffs(
        state,
        0,
        0,
        0,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: DATA_CONTEXT, grounding: GROUNDING },
        [],
      )
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

      applyBattleStartPass(
        state,
        { grounding: GROUNDING, dataContext: DATA_CONTEXT, turnOrder: ORDER_CONTEXT, statStageRatios: RATIOS },
        [],
      )

      // Without the pre-loop reactive the seeded +1 and Intrepid Sword's +1 are both
      // pending when the lead loop's trailing reactive runs, so Mirror Herb copies +2.
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    })
  })

  describe('Item 4(c): the post-switch reactive+drain loop', () => {
    // This call cannot be shown to matter with real state, so no test here goes red when
    // it alone is deleted (mutation recorded in REPORT.md). Two reasons:
    //  - its attack drain duplicates drainQueuedSwitches' `redrain` (turn.ts, porting
    //    battle_util.c:775-783), which re-empties gQueuedAttackCount after the last
    //    queued switch because createSession always passes the drain context;
    //  - its ABILITYEFFECT_REACTIVE (battle_main.c:3356) is re-run at the end of every
    //    switch-in (switchInAbility.ts, battle_script_commands.c:5517) and at both ends
    //    of every drained entry move's move-end (moveEnd.ts, battle_script_commands.c:4330),
    //    and those calls already consume any armed reactive bit / stat-change check.
    // The test below still pins the observable contract of the sequence: the incoming
    // mon's entry move runs during createSession, not on turn 1. It goes red when both
    // the call and drainQueuedSwitches' redrain argument are removed.
    it('drains the incoming mon entry move during createSession (redrain path)', () => {
      const data = loadSimData()
      // Tyranitar's Low Blow entry Feint Attack drops Emergency Exit Chansey below half,
      // which queues a switch; the incoming Mudkip also has Low Blow and its switch-in
      // pass queues a second Feint Attack.
      const party = buildPlayerParty([playerLead('SPECIES_TYRANITAR', 'ABILITY_LOW_BLOW')], 50, data)
      const session = createSession({
        data,
        playerParty: party,
        opponentTrainer: trainerWith(
          foeMon({ species: 'SPECIES_CHANSEY_REDUX', ability: 'ABILITY_EMERGENCY_EXIT' }),
          [foeMon({ species: 'SPECIES_MUDKIP', ability: 'ABILITY_LOW_BLOW' })],
        ),
        // accuracy 0, no crit, max damage roll; replacement draw 1 picks party slot 1;
        // then the incoming Feint Attack: accuracy 0, no crit, max damage roll.
        rng: scriptedRng([0, 1, 0, 1, 0, 1, 0]),
      })

      expect(session.state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
      expect(session.state.queuedExtraAttacks).toHaveLength(0)
      // The incoming Mudkip's Feint Attack landed during createSession:
      // Mudkip Atk 95 (buildOpponentParty, level 50, IVs 31) vs Tyranitar Def 130,
      // power 40 (UseEntryMove, battle_util.c:3994-4019): 22*40*95/130 -> 643/50 -> 12,
      // +2 = 14; Feint Attack is Dark and Tyranitar is Rock/Dark (0.5x) -> 7.
      // Tyranitar maxHP 175 -> 168.
      expect(session.state.battlers[0]!.mon.maxHp).toBe(175)
      expect(session.state.battlers[0]!.mon.hp).toBe(168)
    })
  })
})
