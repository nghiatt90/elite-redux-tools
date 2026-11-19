/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 7 (dbl-6b2, step 6.2 of docs/battle-sim/doubles-plan.md):
// partner controller for battler 2 under BATTLE_TYPE_INGAME_PARTNER.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_controller_player_partner.c:1517-1521  PlayerPartnerHandleChooseAction -> AI_TrySwitchOrUseItem()
//   battle_controller_player_partner.c:1528-1550  PlayerPartnerHandleChooseMove:
//     - chosenMoveId = gBattleStruct->aiMoveOrAction[gActiveBattler]
//     - gBattlerTarget = gBattleStruct->aiChosenTarget[gActiveBattler]
//     - if target & (MOVE_TARGET_USER | MOVE_TARGET_USER_OR_SELECTED) -> gBattlerTarget = gActiveBattler
//     - if target & MOVE_TARGET_BOTH -> OPPONENT_LEFT (1) or OPPONENT_RIGHT (3) if OPPONENT_LEFT absent
//     - if CanMegaEvolve(gActiveBattler) -> RET_MEGA_EVOLUTION (no HOLD_EFFECT_PRIMAL_ORB test)
//   battle_controller_player_partner.c:1557-1590  PlayerPartnerHandleChoosePokemon:
//     - chosenMonId = GetMostSuitableMonToSwitchInto()
//     - if chosenMonId == 6: first i in 3..5 with hp != 0, i != battler0, i != battler2
//   battle_ai_switch_items.c:1089-1090  ShouldUseItem returns FALSE for INGAME_PARTNER at PLAYER_RIGHT
//   battle_ai_main.c:147  BattleAI_SetupFlags reads gTrainerBattleOpponent_A for every AI battler
//   battle_main.c:3629  HandleTurnActionSelectionState picks actions in battler-id order

import { describe, expect, it } from 'vitest'

import {
  PARTY_SIZE,
  STATUS3_PERISH_SONG,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { fightSpecFor } from './driver/fightSpec'
import { loadSimData } from './driver/loadSimData'
import { createRandomSource } from './rng'
import { buildMoveAction, createSession, stepTurn } from './driver/session'
import { runBattle } from './driver/runBattle'
import { chooseAiAction } from './ai/chooseAiAction'
import { createAiPartnerReplacement } from './ai/aiSwitching'
import { getPartnerSelectedMoveTarget } from './moveTargetFlags'
import { canMegaEvolve } from './formChange'

const data = loadSimData()

const PLAYER_3_MONS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

describe('cycle 7: partner controller for battler 2 under BATTLE_TYPE_INGAME_PARTNER', () => {
  it('1. chooseAiAction accepts battler 2 under INGAME_PARTNER; throws for battler 0 and non-partner doubles', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    // Battler 2 (partner) succeeds and returns an action
    const result = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(result.action).toBeDefined()
    expect(result.action.action).toBe('USE_MOVE')

    // Battler 0 (player) still throws
    expect(() => chooseAiAction(session.state, 0, session.chooseAiDeps)).toThrow(
      'battler 0 is not on the opponent side',
    )

    // Non-partner double (Tate & Liza) still throws for battler 2
    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const tateSession = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: tateSpec.opponentTrainer,
      format: tateSpec.format,
      rng: createRandomSource(1),
    })
    expect(() => chooseAiAction(tateSession.state, 2, tateSession.chooseAiDeps)).toThrow(
      'battler 2 requires BATTLE_TYPE_INGAME_PARTNER',
    )
  })

  it('2. Target rules: spread (MOVE_TARGET_BOTH), self-target (MOVE_TARGET_USER), and single-target', () => {
    // Direct unit test of getPartnerSelectedMoveTarget (battle_controller_player_partner.c:1536-1543)
    expect(getPartnerSelectedMoveTarget(2, 'BOTH', 1, 0)).toBe(1)
    expect(getPartnerSelectedMoveTarget(2, 'BOTH', 1, 1 << 1)).toBe(3) // battler 1 absent -> battler 3
    expect(getPartnerSelectedMoveTarget(2, 'USER', 1, 0)).toBe(2)
    expect(getPartnerSelectedMoveTarget(2, 'USER_OR_SELECTED', 1, 0)).toBe(2)
    expect(getPartnerSelectedMoveTarget(2, 'USER_OR_ALLY', 1, 0)).toBe(2)
    expect(getPartnerSelectedMoveTarget(2, 'ALL_BATTLERS', 1, 0)).toBe(2)
    expect(getPartnerSelectedMoveTarget(2, 'SELECTED', 1, 0)).toBe(1) // keeps AI's target

    // End-to-end via chooseAiAction
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    const partnerMon = session.state.battlers[2]!.mon

    // Spread move: MOVE_ACID (target: BOTH in moves.json)
    partnerMon.moves = ['MOVE_ACID', null, null, null]
    partnerMon.pp = [30, 0, 0, 0]
    session.state.absentBattlerFlags = 0
    const bothRes1 = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(bothRes1.action.target).toBe(1) // OPPONENT_LEFT

    // Spread move with battler 1 absent -> OPPONENT_RIGHT (3)
    session.state.absentBattlerFlags = 1 << 1
    const bothRes2 = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(bothRes2.action.target).toBe(3)
    session.state.absentBattlerFlags = 0

    // Self-target move: MOVE_SWORDS_DANCE (target: USER in moves.json)
    partnerMon.moves = ['MOVE_SWORDS_DANCE', null, null, null]
    partnerMon.pp = [20, 0, 0, 0]
    const userRes = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(userRes.action.target).toBe(2) // battler 2 itself

    // Single-target move: MOVE_TACKLE (target: SELECTED)
    partnerMon.moves = ['MOVE_TACKLE', null, null, null]
    partnerMon.pp = [35, 0, 0, 0]
    const selectedRes = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(selectedRes.action.target === 1 || selectedRes.action.target === 3).toBe(true)
  })

  it('3. Mega: partner emits mega: true with mega stone or primal orb; opponent excludes primal orb; no stone is negative', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    // Setup partner battler 2 as Blaziken with Blazikenite
    const battler2 = session.state.battlers[2]!
    battler2.mon.speciesId = 'SPECIES_BLAZIKEN'
    battler2.mon.itemId = 'ITEM_BLAZIKENITE'
    session.state.sides[0].party[3]!.speciesId = 'SPECIES_BLAZIKEN'
    session.state.sides[0].party[3]!.itemId = 'ITEM_BLAZIKENITE'

    expect(canMegaEvolve(session.state, 2, session.chooseAiDeps.dataContext)).toBe(true)

    // Case 1: Partner holding mega stone -> returns mega: true
    const megaResult = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(megaResult.action.action).toBe('USE_MOVE')
    expect((megaResult.action as { mega?: boolean }).mega).toBe(true)

    // Case 2: Primal Orb equivalent (holdEffect: HOLD_EFFECT_PRIMAL_ORB)
    // battle_controller_player_partner.c:1545-1548 does NOT exclude HOLD_EFFECT_PRIMAL_ORB;
    // battle_controller_opponent.c:1608 DOES exclude it.
    const primalDeps = {
      ...session.chooseAiDeps,
      dataContext: {
        ...session.chooseAiDeps.dataContext,
        item: (id: string) =>
          id === 'ITEM_BLAZIKENITE'
            ? { ...session.chooseAiDeps.dataContext.item(id)!, resolvedHoldEffect: 'HOLD_EFFECT_PRIMAL_ORB' }
            : session.chooseAiDeps.dataContext.item(id),
      },
    }

    // Partner still returns mega: true
    const partnerPrimal = chooseAiAction(session.state, 2, primalDeps)
    expect((partnerPrimal.action as { mega?: boolean }).mega).toBe(true)

    // Opponent battler 1 with same mon/item does NOT return mega: true
    const battler1 = session.state.battlers[1]!
    battler1.mon.speciesId = 'SPECIES_BLAZIKEN'
    battler1.mon.itemId = 'ITEM_BLAZIKENITE'
    session.state.sides[1].party[0]!.speciesId = 'SPECIES_BLAZIKEN'
    session.state.sides[1].party[0]!.itemId = 'ITEM_BLAZIKENITE'
    const oppPrimal = chooseAiAction(session.state, 1, primalDeps)
    expect((oppPrimal.action as { mega?: boolean }).mega).toBeUndefined()

    // Case 3: Negative case of no stone
    battler2.mon.itemId = null
    session.state.sides[0].party[3]!.itemId = null
    const noStoneResult = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect((noStoneResult.action as { mega?: boolean }).mega).toBeUndefined()
  })

  it('4. Partner AI switch returns action: SWITCH via AI_TrySwitchOrUseItem', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    // Trigger switch via Perish Song timer 0 (battle_ai_switch_items.c:64-77 ShouldSwitchIfPerishSong)
    const battler2 = session.state.battlers[2]!
    battler2.statuses3 |= STATUS3_PERISH_SONG
    battler2.volatiles.perishSongTimer = 0

    const result = chooseAiAction(session.state, 2, session.chooseAiDeps)
    expect(result.action).toEqual({
      action: 'SWITCH',
      moveToBeUsed: null,
      chosenMove: null,
      target: null,
    })
  })

  it('5. Replacement: slots 3..5 fallback, never slot 3 fainted mon, never battler 0, loop end 6', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    const { state } = session
    const party = state.sides[0].party

    // Partner mon in slot 3 is fainted; partner slots 4 and 5 are alive
    party[3]!.hp = 0
    state.battlers[2]!.mon.hp = 0
    party[4]!.hp = 100
    party[5]!.hp = 100

    const unmodelled: string[] = []
    const slot = session.turnDeps.replacement!.chooseReplacement(state, 2, unmodelled)

    // Returned slot must be in 3..5, not 3 (fainted), not 0 (battler 0)
    expect(slot).toBeGreaterThanOrEqual(3)
    expect(slot).toBeLessThan(PARTY_SIZE)
    expect(slot).not.toBe(3)
    expect(slot).not.toBe(state.battlers[0]!.partyIndex)

    // When getMostSuitableMonToSwitchInto returns PARTY_SIZE (6), first-live fallback is slot 4
    // Give both reserves identical status-only moves so offensive & dmg steps return PARTY_SIZE
    party[4]!.types = ['NORMAL', 'NORMAL', 'MYSTERY']
    party[5]!.types = ['NORMAL', 'NORMAL', 'MYSTERY']
    party[4]!.moves = ['MOVE_GROWL', null, null, null]
    party[5]!.moves = ['MOVE_GROWL', null, null, null]
    party[4]!.rawStats = { atk: 50, def: 50, spatk: 50, spdef: 50, spe: 50 }
    party[5]!.rawStats = { atk: 50, def: 50, spatk: 50, spdef: 50, spe: 50 }

    const partnerReplacement = createAiPartnerReplacement(session.chooseAiDeps)
    const fallbackSlot = partnerReplacement.chooseReplacement(state, 2, [])
    expect(fallbackSlot).toBe(4)

    // When all three partner mons (3, 4, 5) are dead, fallback loop finishes at PARTY_SIZE (6)
    party[4]!.hp = 0
    party[5]!.hp = 0
    const deadSlot = partnerReplacement.chooseReplacement(state, 2, [])
    expect(deadSlot).toBe(6)

    // Verify slots 0..2 are never returned
    expect([0, 1, 2].includes(deadSlot)).toBe(false)
  })

  it('6. Driving: runBattle on Meteor Falls reaches outcome without playerPolicy for battler 2, slotActions[2] wins', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')

    let battler2PolicyCalls = 0
    const battleResult = runBattle({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(42),
      maxTurns: 30,
      playerPolicy(state, _u, battlerId) {
        if (battlerId === 2) {
          battler2PolicyCalls++
          throw new Error('playerPolicy should never be called for battler 2 in partner format!')
        }
        return buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 1)
      },
    })

    expect(battleResult.outcome).toBeDefined()
    expect(battler2PolicyCalls).toBe(0)

    // Negative: with slotActions[2] supplied in stepTurn, the supplied action is used and AI is NOT called
    const session = createSession({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(42),
    })

    const playerAction = buildMoveAction(session.state, data, 0, 'MOVE_TACKLE', session.turnDeps.damage, 1)
    const suppliedPartnerAction = buildMoveAction(session.state, data, 2, 'MOVE_TACKLE', session.turnDeps.damage, 3)

    const step = stepTurn(session, playerAction, undefined, { 2: suppliedPartnerAction })
    // The action executed for battler 2 in this turn is the supplied action targeting battler 3
    const battler2Executed = step.outcome.actions.find((a) => a.battlerId === 2)
    expect(battler2Executed).toBeDefined()
    expect(battler2Executed?.targetId).toBe(3)
  })

  it('7. Space Center smoke: fixed-seed runBattle reaches an outcome', () => {
    const spec = fightSpecFor(data, 'TRAINER_MAXIE_MOSSDEEP')
    expect(spec.format.partner?.id).toBe('TRAINER_STEVEN_MOSSDEEP')

    const battleResult = runBattle({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(42),
      maxTurns: 30,
    })

    expect(battleResult.outcome).toBeDefined()
    expect(battleResult.turns).toBeGreaterThan(0)
  })

  it('8. Regression: Tate & Liza double still calls playerPolicy for battler 2', () => {
    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    expect((tateSpec.format as { type?: string }).type).not.toBe('partner')

    let battler2PolicyCalled = false
    runBattle({
      data,
      playerParty: buildPlayerParty(PLAYER_3_MONS, 50, data),
      opponentTrainer: tateSpec.opponentTrainer,
      format: tateSpec.format,
      rng: createRandomSource(42),
      maxTurns: 3,
      playerPolicy(_s, _u, battlerId) {
        if (battlerId === 2) {
          battler2PolicyCalled = true
        }
        return null
      },
    })

    expect(battler2PolicyCalled).toBe(true)
  })
})
