/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 156d: the remaining CanBattlerHeal / isHealingBlocked callers forward
// their dataContext, so the two opposing-side clauses of CanBattlerHeal
// (battle_util.c:8979-8986) respect IsSuppressed (battle_util.c:9255-9260):
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
//
// Permanence has no `.breakable` (abilities.cc:6745-6747) and Hemolysis has no
// Impl, so the C's mold-breaker clause (gated on gAbilities[ability].breakable)
// never fires; neither is unsuppressable. Every number below is hand-derived
// from the C and the pinned data (data/v2.65beta).
//
// Note on Neutralizing Gas and the healing SOURCE: the sim checks Poison Heal
// with NO_SUPPRESSION (endTurn.ts) and computes absorbing abilities without a
// Neutralizing Gas test (damageResolver.ts / calculate.ts only apply mold
// breaker), so the tasks below use Neutralizing Gas purely to suppress the
// OPPOSING Permanence/Hemolysis clause, exactly as the C's IsAbilityOnSide
// does. Where the heal source itself is an ability, the shield-neutralized
// case uses Gastro Acid on the foe instead, so the source is not suppressed.
//
// The fixed RNG stub returns 1: every accuracy check hits (1 % 100 = 1 < 100)
// and every crit roll misses (1 % 24 = 1). The foe's action is the literal
// `null` fixed action unless a scenario forces one, so it does nothing.
import { describe, expect, it } from 'vitest'

import {
  STATUS1_POISON,
  STATUS3_GASTRO_ACID,
  STATUS_FIELD_GRASSY_TERRAIN,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { RandomSource } from './state'
import { isSimAbilitySuppressed } from './statBuffs'
import { applySwitchInAbilities } from './switchInAbility'

const data = loadSimData()

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
 * cycle156cOpposingSuppression.test.ts). */
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

function setPlayerAbility(s: BattleSession, ability: string): void {
  s.state.battlers[0]!.mon.abilities.ability = ability
}

// Mudkip L50, IV 31, 0 EVs, neutral nature (data/v2.65beta/species.json hp 55):
//   maxHp = floor((2*55 + 31) * 50 / 100) + 50 + 10 = 70 + 60 = 130.
const MUDKIP_MAX_HP = 130

describe('cycle 156d - moveEffects.ts heal handlers thread dataContext', () => {
  // Recover -> BattleScript_EffectRestoreHp (data/battle_scripts_1.s:3940-3955)
  // -> Cmd_tryhealhalfhealth (battle_script_commands.c:9255-9274), handleHealHalf.
  // The STATUS move is first stopped by CANCELLER_HEAL_BLOCKED (battle_util.c:
  // 3326-3336, IsHealBlockPreventingMove :1400-1404) while the foe's Permanence
  // is alive; under Neutralizing Gas IsSuppressed (:9255-9260) turns it off, the
  // move runs, and handleHealHalf's own isHealingBlocked / CanBattlerHeal (both
  // now carrying dataContext) pass: heal trunc(maxHp/2) = trunc(130/2) = 65.
  function recoverTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE'),
    ], ['MOVE_RECOVER'])
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_RECOVER'), null)
    return { s, maxHp }
  }

  it('Recover under an unsuppressed Permanence does not heal', () => {
    const { s } = recoverTurn()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Permanence, so Recover heals trunc(maxHp/2)', () => {
    const { s, maxHp } = recoverTurn({ neutralizingGas: true })
    expect(maxHp).toBe(MUDKIP_MAX_HP)
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.trunc(maxHp / 2)) // 1 + 65 = 66
  })

  // Jungle Healing -> BattleScript_EffectJungleHealing (data/battle_scripts_1.s:
  // 773-804) -> VARIOUS_TRY_HEAL_PERCENT_HP (:7896-7907), handleJungleHealing.
  // Heal trunc(maxHp * 25 / 100) = trunc(130*25/100) = 32. No status is set, and
  // HP is below max, so the jumpifteamhealthy failure at :791 does not fire.
  function jungleTurn(opts: { neutralizingGas?: boolean } = {}) {
    const s = session(
      [foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'])],
      ['MOVE_JUNGLE_HEALING'],
    )
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_JUNGLE_HEALING'), null)
    return { s, maxHp }
  }

  it('Jungle Healing under an unsuppressed Permanence does not heal', () => {
    const { s } = jungleTurn()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Permanence, so Jungle Healing heals 25%', () => {
    const { s, maxHp } = jungleTurn({ neutralizingGas: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.trunc((maxHp * 25) / 100)) // 1 + 32 = 33
  })

  it('Gastro Acid + Ability Shield leaves Permanence alive, so Recover stays blocked', () => {
    const { s } = recoverTurn({ gastroAcid: true, shield: true })
    const foe = s.state.battlers[1]!
    // IsSuppressed returns !DoesBattlerHaveAbilityShield = FALSE.
    expect(isSimAbilitySuppressed(s.state, foe, 'ABILITY_PERMANENCE', true, 0, false, data.dataContext)).toBe(false)
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})

describe('cycle 156d - absorb.ts heal honours dataContext', () => {
  // Water Absorb (src/abilities.cc:633-640) absorbs the foe's Water move
  // (TestAbsorbingAbilities, battle_util.c:8961-8969). applyAbsorbEffect
  // (battle_util.c:4437-4444) then heals maxHp/4 only when CanBattlerHeal
  // passes. The player is poisoned and the foe carries Hemolysis, so the
  // poison clause (:8984-8985) blocks the heal until the dataContext lets
  // Neutralizing Gas suppress Hemolysis. The player does nothing; the foe is
  // forced to use MOVE_WATER_GUN. Starting at 20 HP: with no heal the only
  // change is the end-of-turn poison tick, max(1, floor(130/8)) = 16 -> 4.
  // With the heal, 20 + max(1, floor(130/4)) = 52, then -16 = 36.
  function absorbTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_HEMOLYSIS', ['MOVE_WATER_GUN'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE'),
    ])
    setPlayerAbility(s, 'ABILITY_WATER_ABSORB')
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    s.state.battlers[0]!.mon.status1 = STATUS1_POISON
    setHp(s, 0, 20, maxHp)
    stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_WATER_GUN'))
    return { s, maxHp }
  }

  it('a poisoned Water Absorb holder does not heal under an unsuppressed Hemolysis', () => {
    const { s, maxHp } = absorbTurn()
    // No absorb heal; only the end-of-turn poison damage lands: 20 - 16 = 4.
    expect(s.state.battlers[0]!.mon.hp).toBe(20 - Math.max(1, Math.floor(maxHp / 8)))
  })

  it('Neutralizing Gas suppresses Hemolysis, so Water Absorb heals maxHp/4', () => {
    const { s, maxHp } = absorbTurn({ neutralizingGas: true })
    const heal = Math.max(1, Math.floor(maxHp / 4)) // 32
    const poison = Math.max(1, Math.floor(maxHp / 8)) // 16
    expect(s.state.battlers[0]!.mon.hp).toBe(20 + heal - poison) // 20 + 32 - 16 = 36
  })

  it('Gastro Acid + Ability Shield leaves Hemolysis alive, so Water Absorb stays blocked', () => {
    const { s, maxHp } = absorbTurn({ gastroAcid: true, shield: true })
    const foe = s.state.battlers[1]!
    expect(isSimAbilitySuppressed(s.state, foe, 'ABILITY_HEMOLYSIS', true, 0, false, data.dataContext)).toBe(false)
    expect(s.state.battlers[0]!.mon.hp).toBe(20 - Math.max(1, Math.floor(maxHp / 8)))
  })
})

describe('cycle 156d - fieldEndTurn.ts Wish honours dataContext', () => {
  // ENDTURN_WISH, battle_util.c:1943-1958 -> BattleScript_WishComesTrue
  // (data/battle_scripts_1.s:8187-8207): Cmd_trywish heals sourceMaxHp/2
  // (battle_script_commands.c:11794-11816) only when jumpifhealingblocked
  // passes. With an unsuppressed opposing Permanence the heal is skipped;
  // Neutralizing Gas suppresses it. The Wish counter is set to 1, so it reaches
  // zero this turn; heal = trunc(130/2) = 65.
  function wishTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE'),
    ])
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    s.state.field.wishCounter[0] = 1
    stepTurn(s, null, null)
    return { s, maxHp }
  }

  it('Wish does not heal under an unsuppressed Permanence', () => {
    const { s } = wishTurn()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Permanence, so Wish heals trunc(sourceMaxHp/2)', () => {
    const { s, maxHp } = wishTurn({ neutralizingGas: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.trunc(maxHp / 2)) // 1 + 65 = 66
  })

  it('Gastro Acid + Ability Shield leaves Permanence alive, so Wish stays blocked', () => {
    const { s } = wishTurn({ gastroAcid: true, shield: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})

describe('cycle 156d - endTurn.ts Poison Heal honours dataContext', () => {
  // ENDTURN_POISON, battle_util.c:2497-2505: a Poison Heal holder below max HP
  // runs REQUIRE(CanBattlerHeal) before maxHP/8. The holder is poisoned and the
  // foe has Hemolysis, so the poison clause (:8984-8985) blocks the heal until
  // Neutralizing Gas suppresses Hemolysis. Heal = max(1, trunc(130/8)) = 16.
  function poisonHealTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_HEMOLYSIS', ['MOVE_TACKLE'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE'),
    ])
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    setPlayerAbility(s, 'ABILITY_POISON_HEAL')
    s.state.battlers[0]!.mon.status1 = STATUS1_POISON
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    stepTurn(s, null, null)
    return { s, maxHp }
  }

  it('Poison Heal does not heal under an unsuppressed Hemolysis', () => {
    const { s } = poisonHealTurn()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Hemolysis, so Poison Heal heals maxHp/8', () => {
    const { s, maxHp } = poisonHealTurn({ neutralizingGas: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.max(1, Math.trunc(maxHp / 8))) // 1 + 16 = 17
  })

  it('Gastro Acid + Ability Shield leaves Hemolysis alive, so Poison Heal stays blocked', () => {
    const { s } = poisonHealTurn({ gastroAcid: true, shield: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})

describe('cycle 156d - hitScripts.ts Party Favors honours dataContext', () => {
  // EFFECT_PARTY_FAVORS, data/battle_scripts_1.s:2975-2989:
  // tryhealpercenthealth BS_ATTACKER, 25 (the partner half at :2984 is skipped
  // in singles), VARIOUS_TRY_HEAL_PERCENT_HP (battle_script_commands.c:7894-7901)
  // fails at full HP or when !CanBattlerHeal. Party Favors is PHYSICAL, so a
  // CANCELLER_HEAL_BLOCKED (battle_util.c:3326-3336, STATUS-only) does not stop
  // it; the bug was the post-hit CanBattlerHeal ignoring dataContext. Heal =
  // max(1, floor(130 * 25 / 100)) = 32.
  function partyFavorsTurn(opts: { neutralizingGas?: boolean; gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session(
      [
        foeMon(
          'SPECIES_SNORLAX',
          'ABILITY_PERMANENCE',
          ['MOVE_TACKLE'],
          opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE',
        ),
      ],
      ['MOVE_PARTY_FAVORS'],
    )
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_PARTY_FAVORS'), null)
    return { s, maxHp }
  }

  it('Party Favors does not heal under an unsuppressed Permanence', () => {
    const { s } = partyFavorsTurn()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Neutralizing Gas suppresses Permanence, so Party Favors heals 25%', () => {
    const { s, maxHp } = partyFavorsTurn({ neutralizingGas: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.max(1, Math.floor((maxHp * 25) / 100))) // 1 + 32 = 33
  })

  it('Gastro Acid + Ability Shield leaves Permanence alive, so Party Favors stays blocked', () => {
    const { s } = partyFavorsTurn({ gastroAcid: true, shield: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})

describe('cycle 156d - switchInAbility.ts Curse of Famine honours dataContext', () => {
  // ABILITY_CURSE_OF_FAMINE, src/abilities.cc:10786-10793 (BattleScript_
  // CurseOfFamine): on entry with any terrain, clear it, raise a stat, and heal
  // maxHP/4 when CanBattlerHeal passes (switchInAbility.ts:1833-1867).
  //
  // No session driver exposes a player switch, and Neutralizing Gas would
  // suppress the holder's OWN ability (the IsSimAbilitySuppressed guard at
  // switchInAbility.ts:1383), so this reaches the branch with a direct
  // applySwitchInAbilities call and suppresses only the foe's Permanence with
  // Gastro Acid on the foe. Heal = max(1, floor(130/4)) = 32.
  function curseOfFamine(opts: { gastroAcid?: boolean; shield?: boolean } = {}) {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_PERMANENCE', ['MOVE_TACKLE'], opts.shield ? 'ITEM_ABILITY_SHIELD' : 'ITEM_NONE'),
    ])
    setPlayerAbility(s, 'ABILITY_CURSE_OF_FAMINE')
    s.state.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, 1, maxHp)
    applySwitchInAbilities(
      s.state,
      0,
      { dataContext: data.dataContext, grounding: s.turnDeps.grounding, statStageRatios: s.turnDeps.statStageRatios },
      [],
    )
    return { s, maxHp }
  }

  it('Curse of Famine does not heal under an unsuppressed Permanence', () => {
    const { s } = curseOfFamine()
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('Gastro Acid on the foe suppresses Permanence, so Curse of Famine heals maxHp/4', () => {
    const { s, maxHp } = curseOfFamine({ gastroAcid: true })
    // 1 + max(1, floor(130/4)) = 1 + 32 = 33
    expect(s.state.battlers[0]!.mon.hp).toBe(1 + Math.max(1, Math.floor(maxHp / 4)))
  })

  it('Gastro Acid + Ability Shield leaves Permanence alive, so the heal stays blocked', () => {
    const { s } = curseOfFamine({ gastroAcid: true, shield: true })
    expect(s.state.battlers[0]!.mon.hp).toBe(1)
  })
})
