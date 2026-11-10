/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 156c: IsAbilityOnOpposingSide goes through IsSuppressed, so Neutralizing
// Gas / Gastro Acid turn off Permanence, Hemolysis and Cosmic Daze.
//
//   IsAbilityOnSide, battle_util.c:4792-4799:
//     BATTLER_HAS_ABILITY_AND_ALIVE(battlerId, ability, TRUE)  (include/battle_util.h:74)
//   -> BattlerHasAbility -> IsSuppressed, battle_util.c:9255-9260:
//     ((gFieldTimers.neutralizingGas || gStatuses3[battler] & STATUS3_GASTRO_ACID)
//      && !IsUnsuppressableAbility(ability)) -> !DoesBattlerHaveAbilityShield(battler)
//
//   CanBattlerHeal, battle_util.c:8979-8986:
//     STATUS3_HEAL_BLOCK, STATUS1_BLEED, IsBloodStainAffected,
//     IsAbilityOnOpposingSide(battler, ABILITY_PERMANENCE), and
//     status1 & STATUS1_POISON_ANY && IsAbilityOnOpposingSide(battler, ABILITY_HEMOLYSIS).
//   IsHealBlockPreventingMove, battle_util.c:1400-1404 (CANCELLER_HEAL_BLOCKED,
//   :3326-3336): Heal Block OR opposing Permanence, plus an IsHealingMoveEffect
//   STATUS move.
//   Confusion self-hit power, battle_util.c:3376-3378: 80 with an opposing
//   Cosmic Daze, else 40.
//   Enraged recoil, battle_script_commands.c:4496-4512: savedDmg / 3, doubled
//   when IsAbilityOnOpposingSide(gBattlerAttacker, ABILITY_COSMIC_DAZE); the
//   confusion recoil doubling just below (:4510-4511) is the same check.
//
// Permanence has no `.breakable` (abilities.cc:6745-6747) and Hemolysis has no
// Impl at all, so the C's mold-breaker clause (gated on gAbilities[ability].
// breakable, :9255) can never fire; isSimAbilitySuppressed's MOLD_BREAKABLE_SET
// gate ignores them. None of the three is in UNSUPPRESSABLE_ABILITIES
// (ai/aiAbilityHelpers.ts), which is asserted below.
//
// Every number is hand-derived from the C and the pinned data (data/v2.65beta);
// the arithmetic is in the comments. The fixed RNG stubs are described per
// describe block.
import { describe, expect, it } from 'vitest'

import { UNSUPPRESSABLE_ABILITIES } from './ai/aiAbilityHelpers'
import { runAttackCanceller } from './attackCanceller'
import {
  STATUS1_POISON,
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS3_GASTRO_ACID,
  setCounter,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import { canBattlerHeal, isHealingBlocked } from './endTurn'
import type { RandomSource } from './state'
import { isSimAbilitySuppressed } from './statBuffs'

const data = loadSimData()

/** A constant RNG stream. 1 makes every accuracy check in these tests hit
 * (1 % 100 = 1 < 85/100), every crit roll miss (1 % 24 = 1) and every
 * `Random() % 2 !== 0` ability check true. 3 makes the confusion check
 * `Random() % 3 == 0` fire (attackCanceller.ts:676). */
function fixedRng(value: number): RandomSource {
  return { random16: () => value }
}

function foeMon(species: string, ability: string, moves: string[], item = 'ITEM_NONE'): TrainerMonData {
  return {
    species,
    item,
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves,
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

function trainer(mons: TrainerMonData[]): TrainerData {
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

/** SPECIES_MUDKIP's species abilities/innates are replaced with null so no
 * onEntry innate perturbs the HP arithmetic (same scaffolding as
 * cycle156WrapPressure.test.ts). */
function playerParty(moveIds: string[], count = 1) {
  const party = buildPlayerParty(
    Array.from({ length: count }, () => ({ species: 'SPECIES_MUDKIP', level: 50, moves: moveIds })),
    50,
    data,
  )
  for (const slot of party) slot.abilities = { ability: null, innates: [null, null, null] }
  return party
}

function session(
  foeMons: TrainerMonData[],
  playerMoves: string[] = ['MOVE_TACKLE'],
  rng: RandomSource = fixedRng(1),
): BattleSession {
  return createSession({
    data,
    playerParty: playerParty(playerMoves),
    opponentTrainer: trainer(foeMons),
    rng,
  })
}

/** Sets a battler's HP (and optionally max HP) on the active mon and its party
 * slot, the way endTurn.ts's applyEndTurnHp syncs the party slot. */
function setHp(s: BattleSession, battlerId: number, hp: number, maxHp = hp): void {
  const battler = s.state.battlers[battlerId]!
  battler.mon.hp = hp
  battler.mon.maxHp = maxHp
  const slot = s.state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) {
    slot.hp = hp
    slot.maxHp = maxHp
  }
}

/** The player's own ActionOutcome: the foe's fixed `null` action may or may not
 * produce one, so find battler 0 rather than trusting the array index. */
function playerAction(step: ReturnType<typeof stepTurn>) {
  return step.outcome.actions.find((a) => a.battlerId === 0)!
}

describe('cycle 156c - Permanence heal block and suppression', () => {
  // No suppression: CANCELLER_HEAL_BLOCKED (battle_util.c:3326-3336 via
  // IsHealBlockPreventingMove, :1400-1404) cancels Morning Sun before it runs
  // and sets usedHealBlockedMove.
  //
  // Neutralizing Gas: IsSuppressed(battler 1, ABILITY_PERMANENCE) is TRUE
  // (Permanence is not unsuppressable, no ability shield), so there is no
  // opposing Permanence and the canceller lets the move through.
  // handleWeatherRecovery (moveEffects.ts, BattleScript_EffectMorningSun,
  // battle_script_commands.c:11433-11460) heals trunc(maxHP / 2) in clear
  // weather -- it does not consult CanBattlerHeal.
  //
  // Gastro Acid + Ability Shield: IsSuppressed returns !DoesBattlerHaveAbilityShield
  // = FALSE, so Permanence is alive and the block stays.
  function healSession(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session(
      [foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE')],
      ['MOVE_MORNING_SUN'],
    )
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    return { s, maxHp }
  }

  function healTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const { s, maxHp } = healSession(opts)
    const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_MORNING_SUN'), null)
    return { s, step, maxHp }
  }

  /** One canceller pass on a fresh position: TurnValuesCleanUp zeroes
   * gRoundStructs at the end of each turn (turn.ts:737+), so the
   * usedHealBlockedMove flag can only be read before stepTurn finishes. */
  function cancellerResult(s: BattleSession) {
    return runAttackCanceller(
      s.state,
      0,
      1,
      'MOVE_MORNING_SUN',
      data.dataContext.move('MOVE_MORNING_SUN'),
      [],
      null,
      undefined,
      null,
      data.dataContext,
    )
  }

  it('the three abilities are not in UNSUPPRESSABLE_ABILITIES', () => {
    expect(UNSUPPRESSABLE_ABILITIES).not.toContain('ABILITY_PERMANENCE')
    expect(UNSUPPRESSABLE_ABILITIES).not.toContain('ABILITY_HEMOLYSIS')
    expect(UNSUPPRESSABLE_ABILITIES).not.toContain('ABILITY_COSMIC_DAZE')
  })

  it('an unsuppressed opposing Permanence cancels the heal and leaves HP alone', () => {
    const fresh = healSession().s
    expect(cancellerResult(fresh).cancelledBy).toBe('HEAL_BLOCK')
    expect(fresh.state.battlers[0]!.round.usedHealBlockedMove).toBe(true)

    const { s, step } = healTurn()
    expect(playerAction(step).cancelledBy).toBe('HEAL_BLOCK')
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Permanence, so the move heals maxHP/2', () => {
    const fresh = healSession({ neutralizingGas: true }).s
    expect(cancellerResult(fresh).cancelledBy).toBeNull()
    expect(fresh.state.battlers[0]!.round.usedHealBlockedMove).toBe(false)

    const { s, step, maxHp } = healTurn({ neutralizingGas: true })
    expect(playerAction(step).cancelledBy).toBeNull()
    // setHp started the player at 1 HP; clear weather heals trunc(maxHP / 2).
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.trunc(maxHp / 2))
  })

  it('Gastro Acid + Ability Shield leaves Permanence alive, so the block stays', () => {
    const { s, step } = healTurn({ gastroAcid: true, shield: true })
    expect(playerAction(step).cancelledBy).toBe('HEAL_BLOCK')
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})

describe('cycle 156c - CanBattlerHeal suppression', () => {
  // battle_util.c:8979-8986. battler 0 (player) tries to heal; battler 1 has the
  // blocking ability. Without a dataContext the helper keeps the raw lookup;
  // with one it evaluates IsSuppressed (:9255-9260), so Neutralizing Gas turns
  // the clause off. The deleted mold-breaker notes must no longer be pushed.
  it('Permanence: blocked without a dataContext, allowed under Neutralizing Gas', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'])])
    const player = s.state.battlers[0]!
    const notes: string[] = []

    expect(canBattlerHeal(s.state, 0, player, notes)).toBe(false)
    s.state.field.timers.neutralizingGas = true
    expect(canBattlerHeal(s.state, 0, player, notes, data.dataContext)).toBe(true)
    expect(notes).toEqual([])
  })

  it('Hemolysis + poison: blocked without a dataContext, allowed under Neutralizing Gas', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_HEMOLYSIS', ['MOVE_TACKLE'])])
    const player = s.state.battlers[0]!
    player.mon.status1 = STATUS1_POISON
    const notes: string[] = []

    expect(canBattlerHeal(s.state, 0, player, notes)).toBe(false)
    s.state.field.timers.neutralizingGas = true
    expect(canBattlerHeal(s.state, 0, player, notes, data.dataContext)).toBe(true)
    expect(notes).toEqual([])
  })

  it('isHealingBlocked forwards the dataContext', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'])])
    const player = s.state.battlers[0]!
    const notes: string[] = []

    expect(isHealingBlocked(s.state, 0, player, notes)).toBe(true)
    s.state.field.timers.neutralizingGas = true
    expect(isHealingBlocked(s.state, 0, player, notes, data.dataContext)).toBe(false)
    expect(notes).toEqual([])
  })

  it('the ability shield keeps Permanence alive under Gastro Acid', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'], 'ITEM_ABILITY_SHIELD')])
    const foe = s.state.battlers[1]!
    foe.statuses3 |= STATUS3_GASTRO_ACID

    // IsSuppressed: the Gastro Acid clause holds, but
    // DoesBattlerHaveAbilityShield is true, so IsSuppressed returns FALSE.
    expect(isSimAbilitySuppressed(s.state, foe, 'ABILITY_PERMANENCE', true, 0, false, data.dataContext)).toBe(false)
    expect(canBattlerHeal(s.state, 0, s.state.battlers[0]!, [], data.dataContext)).toBe(false)
  })
})

describe('cycle 156c - confusion self-hit power (Cosmic Daze)', () => {
  // CANCELLER_CONFUSED, battle_util.c:3368-3399: `Random() % 3 == 0` self-hits
  // for CalculateMoveDamage(MOVE_NONE, ..., power, ..., TRUE) with power 80 when
  // IsAbilityOnSide(BATTLE_OPPOSITE(attacker), ABILITY_COSMIC_DAZE) else 40
  // (:3376-3378). The RNG stub returns 3, so the first draw in the canceller
  // (the confusion roll) fires; the foe's action is null, so nothing else draws.
  //
  // Damage is the maximum roll (the resolver passes randomFactor 0 and reads
  // rolls[15] from damageResolver.ts). MOVE_NONE's type is overridden to
  // TYPE_MYSTERY (battle_util.c:3375-3377). A mono-type Pokemon carries
  // TYPE_MYSTERY in its third type slot (pokemon.c:2302, battle_main.c:3002) and
  // IS_BATTLER_OF_TYPE checks type1/type2/type3 (include/battle.h:753-754), so
  // StabMultiplierInHalves answers 3 (battle_util.c:7450-7461), i.e.
  // UQ_4_12(1.5) (:7616-7618) -- the self-hit DOES get STAB in the ROM too.
  // Mudkip at level 50 with IV 31 and 0 EVs, neutral nature
  // (data/v2.65beta/species.json: atk 75, def 50):
  //   atk = floor((2*75 + 31) * 50 / 100) + 5 = 90 + 5 = 95
  //   def = floor((2*50 + 31) * 50 / 100) + 5 = 65 + 5 = 70
  //   dmg = floor(floor((2*50/5 + 2) * power * 95 / 70) / 50) + 2   (calculate.ts:1282-1286)
  //   power 40: 22*40*95 = 83600 -> /70 = 1194 -> /50 = 23 -> +2 = 25
  //   power 80: 22*80*95 = 167200 -> /70 = 2388 -> /50 = 47 -> +2 = 49
  // applyModifier (fixed.ts, UQ_4_12 with round-half-up:
  // floor((1536 * dmg + 512) / 1024)):
  //   25 -> floor((1536*25 + 512) / 1024) = 38
  //   49 -> floor((1536*49 + 512) / 1024) = 74
  function confusedTurn(opts: { neutralizingGas?: boolean } = {}) {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_COSMIC_DAZE', ['MOVE_TACKLE'])], ['MOVE_TACKLE'], fixedRng(3))
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    s.state.battlers[0]!.mon.status2 = setCounter(0, STATUS2_CONFUSION, 2) // counter 2 -> 1, still confused
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)
    return { s, step, maxHp }
  }

  it('an unsuppressed opposing Cosmic Daze doubles the power to 80: 74 damage', () => {
    const { s, step } = confusedTurn()
    const action = playerAction(step)
    expect(action.cancelledBy).toBe('CONFUSION')
    expect(action.confusionSelfHitDamage).toBe(74)
    expect(s.state.battlers[0]!.mon.hp).toBe(s.state.battlers[0]!.mon.maxHp - 74)
  })

  it('Neutralizing Gas suppresses Cosmic Daze, so the power falls back to 40: 38 damage', () => {
    const { s, step } = confusedTurn({ neutralizingGas: true })
    const action = playerAction(step)
    expect(action.cancelledBy).toBe('CONFUSION')
    expect(action.confusionSelfHitDamage).toBe(38)
    expect(s.state.battlers[0]!.mon.hp).toBe(s.state.battlers[0]!.mon.maxHp - 38)
  })
})

describe('cycle 156c - Enraged recoil doubling (Cosmic Daze)', () => {
  // battle_script_commands.c:4496-4512. Recoil first: EFFECT_RECOIL_33's
  // fraction is 3 (moveEnd.ts:594-600), so fractionDmg = max(1, floor(hpDealt/3)).
  // Enraged then adds floor(hpDealt/3), doubled when
  // IsAbilityOnOpposingSide(attacker, ABILITY_COSMIC_DAZE), and the sum is
  // floored at 1 (:4500). With no suppression:
  //   recoil = floor(hpDealt/3) + 2 * floor(hpDealt/3) = 3 * floor(hpDealt/3)
  // With Neutralizing Gas the Cosmic Daze check is FALSE:
  //   recoil = floor(hpDealt/3) + floor(hpDealt/3)     = 2 * floor(hpDealt/3)
  // hpDealt is the observed targetDamage (MOVE_DOUBLE_EDGE's own damage, with a
  // 400 HP foe so nothing is capped). The stub returns 1: accuracy 1 < 100,
  // crit 1 % 24 = 1, and no secondary effect draws.
  function recoilTurn(opts: { neutralizingGas?: boolean } = {}) {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_COSMIC_DAZE', ['MOVE_TACKLE'])], ['MOVE_DOUBLE_EDGE'])
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    setHp(s, 1, 400, 400) // the foe survives the hit, so hpDealt is uncapped
    s.state.battlers[0]!.mon.status2 |= STATUS2_ENRAGED
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_DOUBLE_EDGE'), null)
    return { s, step, maxHp }
  }

  it('an unsuppressed opposing Cosmic Daze doubles the enraged term', () => {
    const { s, step, maxHp } = recoilTurn()
    const hpDealt = playerAction(step).targetDamage!
    expect(hpDealt).toBeGreaterThan(0)
    const fraction = Math.max(1, Math.floor(hpDealt / 3))
    const expected = fraction + 2 * Math.floor(hpDealt / 3)
    expect(playerAction(step).attackerDamage).toBe(expected)
    expect(s.state.battlers[0]!.mon.hp).toBe(maxHp - expected)
  })

  it('Neutralizing Gas suppresses Cosmic Daze, so the enraged term is x1', () => {
    const { s, step, maxHp } = recoilTurn({ neutralizingGas: true })
    const hpDealt = playerAction(step).targetDamage!
    expect(hpDealt).toBeGreaterThan(0)
    const fraction = Math.max(1, Math.floor(hpDealt / 3))
    const expected = fraction + Math.floor(hpDealt / 3)
    expect(playerAction(step).attackerDamage).toBe(expected)
    expect(s.state.battlers[0]!.mon.hp).toBe(maxHp - expected)
  })
})
