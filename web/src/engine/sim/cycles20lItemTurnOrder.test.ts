/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20l: held items (and the Quick Claw / Quick Draw rolls) in turn order.
//
// Until this cycle the turn-order context used by real battles was
// NEUTRAL_TURN_ORDER_CONTEXT, whose holdEffectOf answers null, so every item speed
// modifier was dead. Part A binds the state's live hold effect through session.ts's
// turnOrderFor(data, state) -- the existing port of GetBattlerHoldEffect(b, TRUE),
// battle_util.c:6526-6537, which is null under Embargo / Klutz -- and part B ports the
// start-of-turn rolls from SetActionsAndBattlersTurnOrder, battle_main.c:4400-4414.
//
// Every expected number is hand-derived from the C:
//   - Choice Scarf   speed = speed * 150 / 100  (battle_main.c:4220)
//   - Iron Ball / Macho Brace / power item   speed /= 2  (:4216-4219)
//   - Quick Powder   speed *= 2, Ditto and untransformed only  (:4221-4222)
//   - Lagging Tail / Full Incense  goesLastNegation (:4320)
//   - Quick Draw  (Random() % 100) < 30  (:4407)
//   - Quick Claw  (Random() % 100) < GetBattlerHoldEffectParam(i)  (:4409)
// Draws happen in battler id order, then per move: accuracy, secondary, ability rolls.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildFightSetup } from './driver/policyComparison'
import { outspeeds } from './driver/rolePolicy'
import { buildMoveAction, createSession, stepTurn, type BattleSession, type StepResult } from './driver/session'
import { STAT_SPEED, STATUS2_TRANSFORMED, STATUS3_EMBARGO } from './constants'
import type { RandomSource } from './state'
import { buildTurnOrderContext } from './turn'
import { TOTAL_SPEED_FULL, getBattlerTotalSpeedStat } from './turnOrder'

const data = loadSimData()

const mon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
  ...overrides,
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(playerMons: PlayerMonSpec[], foeMons: TrainerMonData[], rng: RandomSource = constantRng(0)): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons),
    rng,
  })
}

/** Set the RAW Speed stat (battler's live mon and the party copy), so every expected
 * total below follows only from the item lines in GetBattlerTotalSpeedStat. */
function setRawSpeed(s: BattleSession, battlerId: number, spe: number): void {
  s.state.battlers[battlerId]!.mon.rawStats.spe = spe
  const party = s.state.sides[battlerId & 1].party[s.state.battlers[battlerId]!.partyIndex]
  if (party) party.rawStats.spe = spe
}

/** getBattlerTotalSpeedStat with the session's own (now bound) turn-order context --
 * never a hand-built holdEffectOf. */
function totalSpeed(s: BattleSession, battlerId: number): number {
  return getBattlerTotalSpeedStat(
    s.state,
    battlerId,
    TOTAL_SPEED_FULL,
    null,
    buildTurnOrderContext(s.state, s.turnDeps),
    s.data.statStageRatios,
  )
}

/** A RandomSource that returns one fixed u16 forever. */
function constantRng(value: number): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return value
    },
  }
  return r
}

/** A RandomSource that returns the queued values in order, then 0. */
function queueRng(values: number[]): RandomSource & { calls: number } {
  let index = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[index++] ?? 0
    },
  }
  return r
}

/** A RandomSource whose value can be changed between turns. */
function mutableRng(value: number): RandomSource & { value: number } {
  const r = {
    value,
    random16: () => r.value,
  }
  return r
}

function moveAction(s: BattleSession, battlerId: number, moveId: string) {
  return buildMoveAction(s.state, s.data, battlerId, moveId)
}

/** Who acted first: the first recorded action, not just the speed number. */
function firstToAct(result: StepResult): number | undefined {
  return result.outcome.actions[0]?.battlerId
}

function play(s: BattleSession, playerMove = 'MOVE_TACKLE', foeMove = 'MOVE_TACKLE'): StepResult {
  return stepTurn(s, moveAction(s, 0, playerMove), moveAction(s, 1, foeMove))
}

const tackleFoe = () => mon('SPECIES_MUDKIP', ['MOVE_TACKLE'])

describe('s20l A - GetBattlerTotalSpeedStat item effects', () => {
  it('Choice Scarf: 100 * 150 / 100 = 150 outruns a 140 foe; without it 100 moves second', () => {
    // battle_main.c:4220 `speed = (speed * 150) / 100`.
    const scarfed = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(scarfed, 0, 100)
    setRawSpeed(scarfed, 1, 140)
    expect(totalSpeed(scarfed, 0)).toBe(150)
    expect(totalSpeed(scarfed, 1)).toBe(140)
    expect(firstToAct(play(scarfed))).toBe(0)

    // The same fixture without the item: 100 < 140, so the holder moves second.
    const bare = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(bare, 0, 100)
    setRawSpeed(bare, 1, 140)
    expect(totalSpeed(bare, 0)).toBe(100)
    expect(firstToAct(play(bare))).toBe(1)
  })

  it('Iron Ball, Macho Brace and a power item halve Speed; the holder moves second', () => {
    // battle_main.c:4216-4218: Macho Brace / power item and Iron Ball each `speed /= 2`.
    for (const item of ['ITEM_IRON_BALL', 'ITEM_MACHO_BRACE', 'ITEM_POWER_WEIGHT']) {
      const s = session([{ species: 'SPECIES_MUDKIP', level: 50, item, moves: ['MOVE_TACKLE'] }], [tackleFoe()])
      setRawSpeed(s, 0, 100)
      setRawSpeed(s, 1, 80)
      expect(totalSpeed(s, 0)).toBe(50)
      expect(totalSpeed(s, 1)).toBe(80)
      expect(firstToAct(play(s))).toBe(1)
    }
  })

  it('Lagging Tail and Full Incense go last in the priority bracket, but not against +1 priority', () => {
    // battle_main.c:4320 `goesLastNegation = holdEffect == HOLD_EFFECT_LAGGING_TAIL`;
    // priority occupies bits 20-23, goesLastNegation bits 16-17 (turnOrder.ts:9-15),
    // so a higher-priority move still outranks it.
    for (const item of ['ITEM_LAGGING_TAIL', 'ITEM_FULL_INCENSE']) {
      const s = session(
        [{ species: 'SPECIES_MUDKIP', level: 50, item, moves: ['MOVE_TACKLE', 'MOVE_QUICK_ATTACK'] }],
        [tackleFoe()],
      )
      setRawSpeed(s, 0, 100)
      setRawSpeed(s, 1, 80)
      expect(totalSpeed(s, 0)).toBe(100)
      // Same priority: the faster holder still goes last.
      expect(firstToAct(play(s, 'MOVE_TACKLE'))).toBe(1)
      // Quick Attack is priority +1, which outranks the goesLastNegation field.
      expect(firstToAct(play(s, 'MOVE_QUICK_ATTACK'))).toBe(0)
    }
  })

  it('Quick Powder doubles an untransformed Ditto only', () => {
    // battle_main.c:4221-4222: `holdEffect == HOLD_EFFECT_QUICK_POWDER &&
    // species == SPECIES_DITTO && !(status2 & STATUS2_TRANSFORMED)` -> `speed *= 2`.
    const ditto = session(
      [{ species: 'SPECIES_DITTO', level: 50, item: 'ITEM_QUICK_POWDER', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(ditto, 0, 100)
    setRawSpeed(ditto, 1, 150)
    expect(totalSpeed(ditto, 0)).toBe(200)
    expect(firstToAct(play(ditto))).toBe(0)

    const transformed = session(
      [{ species: 'SPECIES_DITTO', level: 50, item: 'ITEM_QUICK_POWDER', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(transformed, 0, 100)
    setRawSpeed(transformed, 1, 150)
    transformed.state.battlers[0]!.mon.status2 |= STATUS2_TRANSFORMED
    expect(totalSpeed(transformed, 0)).toBe(100)
    expect(firstToAct(play(transformed))).toBe(1)

    const otherSpecies = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_QUICK_POWDER', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(otherSpecies, 0, 100)
    setRawSpeed(otherSpecies, 1, 150)
    expect(totalSpeed(otherSpecies, 0)).toBe(100)
    expect(firstToAct(play(otherSpecies))).toBe(1)
  })
})

describe('s20l A - hold effect negation (GetBattlerHoldEffect(b, TRUE), battle_util.c:6520-6537)', () => {
  it('Klutz and Embargo each switch the Scarf off', () => {
    const klutz = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', ability: 'ABILITY_KLUTZ', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(klutz, 0, 100)
    setRawSpeed(klutz, 1, 140)
    expect(totalSpeed(klutz, 0)).toBe(100)
    expect(firstToAct(play(klutz))).toBe(1)

    const embargoed = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(embargoed, 0, 100)
    setRawSpeed(embargoed, 1, 140)
    embargoed.state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(totalSpeed(embargoed, 0)).toBe(100)
    expect(firstToAct(play(embargoed))).toBe(1)
  })

  it('a real Knock Off removes the Scarf; the order reverts on the next turn', () => {
    const s = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', moves: ['MOVE_TACKLE'] }],
      [mon('SPECIES_MUDKIP', ['MOVE_KNOCK_OFF'])],
    )
    setRawSpeed(s, 0, 100)
    setRawSpeed(s, 1, 140)
    // Turn 1: the Scarf still applies, so 150 > 140 and the holder moves first.
    expect(totalSpeed(s, 0)).toBe(150)
    const turn1 = play(s, 'MOVE_TACKLE', 'MOVE_KNOCK_OFF')
    expect(firstToAct(turn1)).toBe(0)
    expect(s.state.battlers[0]!.mon.itemId).toBeNull()
    // Turn 2: no item, 100 < 140, so the holder moves second.
    expect(totalSpeed(s, 0)).toBe(100)
    expect(firstToAct(play(s, 'MOVE_TACKLE', 'MOVE_KNOCK_OFF'))).toBe(1)
  })

  it('Neutralizing Gas suppressing Klutz makes the item work again', () => {
    // IsSuppressed (battle_util.c:9253-9261) blanks the Klutz slot while
    // gFieldTimers.neutralizingGas is set, so IsItemNegated stops seeing it.
    const s = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', ability: 'ABILITY_KLUTZ', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(s, 0, 100)
    setRawSpeed(s, 1, 140)
    expect(totalSpeed(s, 0)).toBe(100)
    s.state.field.timers.neutralizingGas = true
    expect(totalSpeed(s, 0)).toBe(150)
    expect(firstToAct(play(s))).toBe(0)
  })

  it('Magic Room does NOT negate hold effects in this build', () => {
    // GetBattlerHoldEffect / IsItemNegated never read isMagicRoomActive
    // (battle_util.c:8698 is used only elsewhere), so the Scarf still applies.
    const s = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
    )
    setRawSpeed(s, 0, 100)
    setRawSpeed(s, 1, 140)
    s.state.field.timers.magicRoomTimer = 5
    expect(totalSpeed(s, 0)).toBe(150)
    expect(firstToAct(play(s))).toBe(0)
  })
})

describe('s20l B - start-of-turn rolls (SetActionsAndBattlersTurnOrder, battle_main.c:4400-4414)', () => {
  it('Quick Claw: roll 19 moves the slower holder first, roll 20 does not', () => {
    // :4409 `(Random() % 100) < GetBattlerHoldEffectParam(i)`; ITEM_QUICK_CLAW's
    // holdEffectStrength is 20 (items.json).
    for (const [roll, expected] of [[19, 0], [20, 1]] as const) {
      const s = session(
        [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_QUICK_CLAW', moves: ['MOVE_TACKLE'] }],
        [tackleFoe()],
        constantRng(roll),
      )
      setRawSpeed(s, 0, 100)
      setRawSpeed(s, 1, 140)
      expect(firstToAct(play(s))).toBe(expected)
      // Quick Claw is not consumed (the :4446 removal is Custap-only).
      expect(s.state.battlers[0]!.mon.itemId).toBe('ITEM_QUICK_CLAW')
    }
  })

  it('a Klutz holder draws no Quick Claw roll at all', () => {
    // GetBattlerHoldEffect(b, TRUE) is null under Klutz, so the `&&` short-circuits
    // before Random() -- one fewer draw than the same fixture with a live item.
    const holderRng = constantRng(0)
    const holder = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_QUICK_CLAW', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
      holderRng,
    )
    setRawSpeed(holder, 0, 100)
    setRawSpeed(holder, 1, 140)
    expect(firstToAct(play(holder))).toBe(0)

    const klutzRng = constantRng(0)
    const klutz = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_QUICK_CLAW', ability: 'ABILITY_KLUTZ', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
      klutzRng,
    )
    setRawSpeed(klutz, 0, 100)
    setRawSpeed(klutz, 1, 140)
    expect(firstToAct(play(klutz))).toBe(1)
    expect(klutzRng.calls).toBe(holderRng.calls - 1)
  })

  it('Quick Draw: roll 29 succeeds, roll 30 fails', () => {
    // :4407 `BattlerHasAbility(i, ABILITY_QUICK_DRAW, TRUE) && (Random() % 100) < 30`.
    // SPECIES_SLOWBRO_GALARIAN's innate slot 1 is ABILITY_QUICK_DRAW (data/v2.65beta).
    for (const [roll, expected] of [[29, 0], [30, 1]] as const) {
      const s = session(
        [{ species: 'SPECIES_SLOWBRO_GALARIAN', level: 50, moves: ['MOVE_TACKLE'] }],
        [tackleFoe()],
        constantRng(roll),
      )
      setRawSpeed(s, 0, 100)
      setRawSpeed(s, 1, 140)
      expect(firstToAct(play(s))).toBe(expected)
    }
  })

  it('a holder of both draws Quick Draw first, then Quick Claw', () => {
    // The C is an else-if chain: a Quick Draw SUCCESS never reaches the Quick Claw
    // branch, a FAILURE falls through and draws a second number.
    const lead: PlayerMonSpec = {
      species: 'SPECIES_SLOWBRO_GALARIAN',
      level: 50,
      item: 'ITEM_QUICK_CLAW',
      moves: ['MOVE_TACKLE'],
    }
    // Quick Draw consumes 25 -> success, so Quick Claw's roll is never drawn and the
    // holder goes first. Were Quick Claw checked first, 25 would fail (< 20 is false)
    // and Quick Draw would then get 35 and fail, leaving the holder second.
    const firstDraw = session([lead], [tackleFoe()], queueRng([25, 35]))
    setRawSpeed(firstDraw, 0, 100)
    setRawSpeed(firstDraw, 1, 140)
    expect(firstToAct(play(firstDraw))).toBe(0)

    // Quick Draw 35 fails, then Quick Claw 15 < 20 succeeds (the else-if fallthrough).
    const fallthrough = session([lead], [tackleFoe()], queueRng([35, 15]))
    setRawSpeed(fallthrough, 0, 100)
    setRawSpeed(fallthrough, 1, 140)
    expect(firstToAct(play(fallthrough))).toBe(0)

    // Both fail (35 then 25): the second number really was the Quick Claw roll.
    const bothFail = session([lead], [tackleFoe()], queueRng([35, 25]))
    setRawSpeed(bothFail, 0, 100)
    setRawSpeed(bothFail, 1, 140)
    expect(firstToAct(play(bothFail))).toBe(1)
  })

  it('round.quickDraw / round.usedCustapBerry do not carry over', () => {
    // roundStructsClear (turn.ts:786, battle_main.c:4490-4508) rebuilds the round
    // struct at the end of every turn. Turn 1 succeeds, then turn 2 rolls a failing
    // 99: if the flag survived, the holder would still move first.
    const quickDrawRng = mutableRng(0)
    const quickDraw = session(
      [{ species: 'SPECIES_SLOWBRO_GALARIAN', level: 50, moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
      quickDrawRng,
    )
    setRawSpeed(quickDraw, 0, 100)
    setRawSpeed(quickDraw, 1, 140)
    expect(firstToAct(play(quickDraw))).toBe(0)
    expect(quickDraw.state.battlers[0]!.round.quickDraw).toBe(false)
    quickDrawRng.value = 99
    expect(firstToAct(play(quickDraw))).toBe(1)

    const quickClawRng = mutableRng(0)
    const quickClaw = session(
      [{ species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_QUICK_CLAW', moves: ['MOVE_TACKLE'] }],
      [tackleFoe()],
      quickClawRng,
    )
    setRawSpeed(quickClaw, 0, 100)
    setRawSpeed(quickClaw, 1, 140)
    expect(firstToAct(play(quickClaw))).toBe(0)
    expect(quickClaw.state.battlers[0]!.round.usedCustapBerry).toBe(false)
    quickClawRng.value = 99
    expect(firstToAct(play(quickClaw))).toBe(1)
  })
})

describe('s20l - role policy and AI deps', () => {
  it('outspeeds agrees with the executed order for a scarfed Sopranice vs Mega Alakazam', () => {
    // docs/battle-sim/role-policy-test-fights.json fight 0 is TRAINER_SIDNEY (level cap
    // 80). The player's Sopranice (team index 5) carries ITEM_CHOICE_SCARF; the foe is
    // Sidney's elite Alakazam, taken to its data Mega form (SPECIES_ALAKAZAM_MEGA_REDUX,
    // the permanent-mega species alite notes in solver.ts:246-250). Level 80, 252 Spe,
    // Timid: raw Speed 224 for Sopranice and 352 for the Mega, so Scarf 336 < 352.
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json'), 'utf8'),
    ) as { fights: Array<Record<string, unknown>> }
    const setup = buildFightSetup(data, fixture.fights[0] as never)
    const sidney = setup.trainer
    const eliteAlakazam = sidney.parties.elite.find((m) => m.species === 'SPECIES_ALAKAZAM_REDUX')!
    const foeTrainer: TrainerData = {
      ...sidney,
      noSwitching: true,
      parties: { ace: [], elite: [{ ...eliteAlakazam, species: 'SPECIES_ALAKAZAM_MEGA_REDUX' }], hell: [] },
    }
    const make = () =>
      createSession({
        data,
        playerParty: setup.party,
        opponentTrainer: foeTrainer,
        tier: 'elite',
        rng: constantRng(0),
        leadIndex: 5,
      })

    const plain = make()
    expect(plain.state.battlers[0]!.mon.speciesId).toBe('SPECIES_SOPRANICE')
    expect(plain.state.battlers[1]!.mon.speciesId).toBe('SPECIES_ALAKAZAM_MEGA_REDUX')
    expect(totalSpeed(plain, 0)).toBe(336)
    expect(totalSpeed(plain, 1)).toBe(352)
    const ourAction = moveAction(plain, 0, 'MOVE_BOOMBURST')
    const theirAction = moveAction(plain, 1, 'MOVE_DARK_PULSE')
    expect(outspeeds(plain, ourAction, theirAction)).toBe(false)
    expect(firstToAct(stepTurn(plain, ourAction, theirAction))).toBe(1)

    // +1 Speed stage (gStatStageRatios[7] = 3/2): 336 * 3 / 2 = 504 > 352.
    const boosted = make()
    boosted.state.battlers[0]!.mon.statStages[STAT_SPEED] = 7
    expect(totalSpeed(boosted, 0)).toBe(504)
    const boostedAction = moveAction(boosted, 0, 'MOVE_BOOMBURST')
    const boostedTheirAction = moveAction(boosted, 1, 'MOVE_DARK_PULSE')
    expect(outspeeds(boosted, boostedAction, boostedTheirAction)).toBe(true)
    expect(firstToAct(stepTurn(boosted, boostedAction, boostedTheirAction))).toBe(0)
  })

  it('the AI and battle-start deps carry the live hold effect, not the neutral null', () => {
    const s = session(
      [
        { species: 'SPECIES_MUDKIP', level: 50, item: 'ITEM_CHOICE_SCARF', moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MUDKIP', ['MOVE_TACKLE'], { item: 'ITEM_QUICK_CLAW' })],
    )
    // Battle-start built chooseAiDeps already (session.ts:263) and turnDeps (session.ts:279).
    expect(s.chooseAiDeps.turnOrder.holdEffectOf(0)).toBe('HOLD_EFFECT_CHOICE_SCARF')
    expect(s.chooseAiDeps.turnOrder.holdEffectOf(1)).toBe('HOLD_EFFECT_QUICK_CLAW')
    expect(s.turnDeps.turnOrder.holdEffectOf(0)).toBe('HOLD_EFFECT_CHOICE_SCARF')
    // The negation path is the same one turn order uses.
    s.state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(s.chooseAiDeps.turnOrder.holdEffectOf(0)).toBeNull()
  })
})
