/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946c: staller Protect and heal rules (chooseStaller rules 2 and 3).
//
// 1. Protect: usedProtectionLastTurn reads session.state.battlers[0].lastMove,
//    falling back to memory.lastMove when null. protectUses is not consulted
//    because the engine resets it lazily on the next Protect attempt.
// 2. Recovery: rule 2 checks whether moves.json effect is in RECOVERY_EFFECTS
//    and whether the move would not fail or do nothing in its script. Rest is
//    deprioritized to only be chosen when no other usable recovery move exists.
//
// The fixtures are built through createSession and advanced with playTurn
// (beginTurn + chooseRoleAction + stepTurn).
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  PARTY_SIZE,
  STAT_ATK,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS2_SUBSTITUTE,
  STATUS_FIELD_ELECTRIC_TERRAIN,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

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

function session(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  overrides: Partial<TrainerData> = {},
  seed = 1,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(seed),
  })
}

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/status overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

/** One turn exactly as playPolicyBattle runs it: beginTurn, the policy, the
 * switch-slot write, stepTurn (cycle 946's helper). */
function playTurn(
  s: BattleSession,
  role: RoleName,
  params: RoleParams,
  mem: RoleMemory,
  trace?: PolicyTraceEntry[],
): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem, trace)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

/** The staller's gate and the handler must agree, so where the policy is
 * expected to skip a status move we also pick that move from legalChoices and
 * force it through stepTurn. */
function forceMove(s: BattleSession, id: string): void {
  beginTurn(s)
  const choice = legalChoices(s).find((c) => moveId(c) === id)
  expect(choice, `${id} must be a legal choice`).toBeDefined()
  s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
  stepTurn(s, choice!.action)
}

/** Machamp has abilities [GUTS, POWER_FISTS, SHEER_FORCE] and innates
 * [NO_GUARD, IRON_FIST, PRECISE_FIST] in species.json; none grant passive
 * healing (unlike Snorlax's ABILITY_SELF_SUFFICIENT innate) or sleep immunities.
 * Max HP at level 50 (neutral nature, 31 IV, 0 EV) is 165:
 *   floor((2 * 90 + 31) * 50 / 100) + 50 + 10 = 105 + 60 = 165.
 * Half max HP: trunc(165 / 2) = 82.
 * 25% max HP: trunc(165 * 25 / 100) = 41. */
const playerOne = (moves: string[], overrides: Partial<PlayerMonSpec> = {}): PlayerMonSpec[] => [
  { species: 'SPECIES_MACHAMP', level: 50, moves, ...overrides },
]

/** The foe always Celebrates: no damage, so the staller's rule 1 is never
 * skipped for a KO threat and nothing but the move under test can change the
 * target's status or our HP.
 * Foe Machamp raw Attack at level 50 (neutral nature, 31 IV, 0 EV) is 150:
 *   floor((2 * 130 + 31) * 50 / 100) + 5 = 145 + 5 = 150. */
const celebrate = (species: string, overrides: Partial<TrainerMonData> = {}): TrainerMonData =>
  mon(species, ['MOVE_CELEBRATE'], overrides)

describe('cycle 946c - staller: Protect alternating turns through stepTurn', () => {
  it('alternates Protect and damaging move against a burned target across turns', () => {
    // Foe is burned so residual damage ticks, satisfying staller rule 3.
    // s.state.rng scripted low (random16 returns 0 < 65535) so Protect succeeds.
    const s = session(playerOne(['MOVE_PROTECT', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    s.state.rng = { random16: () => 0 }
    const mem = memory()

    // Turn 1: picks Protect. Protect succeeds, setting protectUses = 1 and lastMove = 'MOVE_PROTECT'.
    const turn1 = playTurn(s, 'staller', {}, mem)
    expect(moveId(turn1)).toBe('MOVE_PROTECT')
    expect(s.state.battlers[0]!.volatiles.protectUses).toBe(1)
    expect(s.state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')

    // Turn 2: battlers[0].lastMove is 'MOVE_PROTECT', so usedProtectionLastTurn returns true.
    // Rule 3 is blocked. Staller falls back to Body Slam.
    // Body Slam does not reset protectUses (only ProtectSucceeds does that lazily).
    const turn2 = playTurn(s, 'staller', {}, mem)
    expect(moveId(turn2)).toBe('MOVE_BODY_SLAM')
    expect(s.state.battlers[0]!.lastMove).toBe('MOVE_BODY_SLAM')
    expect(s.state.battlers[0]!.volatiles.protectUses).toBe(1)

    // Turn 3: battlers[0].lastMove is 'MOVE_BODY_SLAM' (not protection), so usedProtectionLastTurn
    // returns false. Rule 3 picks Protect again!
    // ProtectSucceeds resets protectUses and succeeds, ending with protectUses = 1.
    // On the old code, this failed because protectUses = 1 blocked the choice.
    const turn3 = playTurn(s, 'staller', {}, mem)
    expect(moveId(turn3)).toBe('MOVE_PROTECT')
    expect(s.state.battlers[0]!.volatiles.protectUses).toBe(1)
  })
})

describe('cycle 946c - staller: Roost and Soft-Boiled below threshold', () => {
  it('picks Roost with tag heal and restores half max HP', () => {
    // Roost: BattleScript_EffectRoost (battle_scripts_1.s:2736-2742).
    // Cmd_tryhealhalfhealth (battle_script_commands.c:9255-9274): maxHp / 2 = trunc(165 / 2) = 82.
    // Initial HP 66 (40% < 50% threshold): 66 + 82 = 148.
    const s = session(playerOne(['MOVE_ROOST', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    expect(maxHp).toBe(165)
    const hurtHp = Math.floor((maxHp * 40) / 100) // 66
    patchMon(s.state, 0, 0, { hp: hurtHp })
    const trace: PolicyTraceEntry[] = []
    const choice = playTurn(s, 'staller', {}, memory(), trace)
    expect(moveId(choice)).toBe('MOVE_ROOST')
    expect(trace[0]!.tags).toEqual(['staller', 'heal'])
    const expectedHp = Math.min(maxHp, hurtHp + Math.trunc(maxHp / 2))
    expect(s.state.battlers[0]!.mon.hp).toBe(expectedHp)
    expect(expectedHp).toBe(148)
  })

  it('picks Soft-Boiled with tag heal and restores half max HP', () => {
    // Soft-Boiled: BattleScript_EffectSoftboiled (battle_scripts_1.s:5909-5924).
    // Cmd_tryhealhalfhealth (:9255-9274): trunc(165 / 2) = 82.
    // Initial HP 66: 66 + 82 = 148.
    const s = session(playerOne(['MOVE_SOFT_BOILED', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100) // 66
    patchMon(s.state, 0, 0, { hp: hurtHp })
    const trace: PolicyTraceEntry[] = []
    const choice = playTurn(s, 'staller', {}, memory(), trace)
    expect(moveId(choice)).toBe('MOVE_SOFT_BOILED')
    expect(trace[0]!.tags).toEqual(['staller', 'heal'])
    const expectedHp = Math.min(maxHp, hurtHp + Math.trunc(maxHp / 2))
    expect(s.state.battlers[0]!.mon.hp).toBe(expectedHp)
    expect(expectedHp).toBe(148)
  })
})

describe('cycle 946c - staller: recovery moves table and stepTurn', () => {
  const recoveryMoves: { moveId: string; effect: string }[] = [
    { moveId: 'MOVE_MILK_DRINK', effect: 'EFFECT_SOFTBOILED' },
    { moveId: 'MOVE_MORNING_SUN', effect: 'EFFECT_MORNING_SUN' },
    { moveId: 'MOVE_SYNTHESIS', effect: 'EFFECT_SYNTHESIS' },
    { moveId: 'MOVE_MOONLIGHT', effect: 'EFFECT_MOONLIGHT' },
    { moveId: 'MOVE_SHORE_UP', effect: 'EFFECT_SHORE_UP' },
    { moveId: 'MOVE_REST', effect: 'EFFECT_REST' },
    { moveId: 'MOVE_STRENGTH_SAP', effect: 'EFFECT_STRENGTH_SAP' },
    { moveId: 'MOVE_JUNGLE_HEALING', effect: 'EFFECT_JUNGLE_HEALING' },
    { moveId: 'MOVE_LIFE_DEW', effect: 'EFFECT_JUNGLE_HEALING' },
    { moveId: 'MOVE_LUNAR_BLESSING', effect: 'EFFECT_JUNGLE_HEALING' },
  ]

  for (const { moveId: id, effect } of recoveryMoves) {
    it(`picks ${id} (${effect}) below threshold with tag heal`, () => {
      const s = session(playerOne([id, 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
      const maxHp = s.state.battlers[0]!.mon.maxHp
      patchMon(s.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
      const trace: PolicyTraceEntry[] = []
      const choice = chooseRoleAction(s, 'staller', {}, memory(), trace)
      expect(moveId(choice)).toBe(id)
      expect(trace[0]!.tags).toEqual(['staller', 'heal'])
    })
  }

  it('runs Moonlight through stepTurn asserting restored HP', () => {
    // BattleScript_EffectMoonlight (battle_scripts_1.s:5495-5503) -> Cmd_recoverbasedonsunlight
    // (battle_script_commands.c:11433-11462, handleWeatherRecovery in moveEffects.ts:2692).
    // In neutral weather, heal = trunc(maxHp / 2) = trunc(165 / 2) = 82.
    // Initial HP 66: 66 + 82 = 148.
    const s = session(playerOne(['MOVE_MOONLIGHT', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp })
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_MOONLIGHT')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp + Math.trunc(maxHp / 2))
    expect(s.state.battlers[0]!.mon.hp).toBe(148)
  })

  it('runs Rest through stepTurn asserting full HP and sleep status', () => {
    // BattleScript_EffectRest (battle_scripts_1.s:4023-4036) -> Cmd_trysetrest
    // (battle_script_commands.c:9415-9437, handleRest in moveEffects.ts:5068-5077).
    // Restores user to full HP (165) and sets status1 = STATUS1_SLEEP_TURN(3) = 3.
    // End of turn does not decrement sleep counter (sleep is decremented on attack
    // attempt in attackCanceller), so status1 remains 3 at turn end.
    const s = session(playerOne(['MOVE_REST', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_REST')
    expect(s.state.battlers[0]!.mon.hp).toBe(maxHp)
    expect(s.state.battlers[0]!.mon.status1).toBe(3)
  })

  it('runs Strength Sap through stepTurn asserting restored HP and foe Attack drop', () => {
    // BattleScript_EffectStrengthSap (battle_scripts_1.s:896-945, handleStrengthSap :2790-2850).
    // Foe Machamp raw Attack is 150 at level 50 neutral nature, statStage 6 (neutral).
    // Strength Sap lowers foe Attack stage by 1 (to stage 5 = DEFAULT_STAT_STAGE - 1)
    // and heals user by statValue (150).
    // Initial user HP 10: 10 + 150 = 160 <= 165 maxHp.
    const s = session(playerOne(['MOVE_STRENGTH_SAP', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    patchMon(s.state, 0, 0, { hp: 10 })
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_STRENGTH_SAP')
    expect(s.state.battlers[0]!.mon.hp).toBe(160)
    expect(s.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('runs Jungle Healing through stepTurn asserting restored HP and cured status', () => {
    // BattleScript_EffectJungleHealing (battle_scripts_1.s:773-804, handleJungleHealing :2706-2728).
    // Heals trunc(maxHp * 25 / 100) = trunc(165 * 25 / 100) = 41.
    // Cures status1 (burn cleared to 0).
    // Initial HP 66: 66 + 41 = 107.
    const s = session(playerOne(['MOVE_JUNGLE_HEALING', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp, status1: STATUS1_BURN })
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_JUNGLE_HEALING')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp + Math.trunc((maxHp * 25) / 100))
    expect(s.state.battlers[0]!.mon.hp).toBe(107)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })
})

describe('cycle 946c - staller: recovery negatives and preference', () => {
  it('falls back to Body Slam when Rest is blocked by Electric Terrain', () => {
    // Cmd_trysetrest (battle_script_commands.c:9415-9437): Electric Terrain prevents sleep.
    const s = session(playerOne(['MOVE_REST', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp })
    s.state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    s.state.field.timers.terrainTimer = 5
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_REST')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('falls back to Body Slam when Rest is blocked by ABILITY_INSOMNIA', () => {
    // IsAbilityStatusProtected (battle_script_commands.c:6579-6591): Insomnia protects against CHECK_SLEEP.
    const s = session(playerOne(['MOVE_REST', 'MOVE_BODY_SLAM'], { ability: 'ABILITY_INSOMNIA' }), [
      celebrate('SPECIES_MACHAMP'),
    ])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp })
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_REST')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp)
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
  })

  it('falls back to Body Slam when Strength Sap target is at MIN_STAT_STAGE Attack', () => {
    // BattleScript_EffectStrengthSap (battle_scripts_1.s:903-908): if target Attack is
    // MIN_STAT_STAGE, the script jumps to MoveEnd without healing.
    const s = session(playerOne(['MOVE_STRENGTH_SAP', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp })
    s.state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_STRENGTH_SAP')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp)
  })

  it('falls back to Body Slam when Strength Sap is blocked by substitute', () => {
    // BattleScript_EffectStrengthSap (battle_scripts_1.s:898): jumpifsubstituteblocks.
    const s = session(playerOne(['MOVE_STRENGTH_SAP', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp })
    patchMon(s.state, 1, 0, { status2: STATUS2_SUBSTITUTE })
    s.state.battlers[1]!.volatiles.substituteHp = 40
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_STRENGTH_SAP')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp)
  })

  it('falls back to Body Slam when Life Dew user is bleeding', () => {
    // BattleScript_EffectJungleHealing (battle_scripts_1.s:773-804): tryhealpercenthealth
    // fails under bleed, and Life Dew skips status cure (:791), doing nothing.
    const s = session(playerOne(['MOVE_LIFE_DEW', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp, status1: STATUS1_BLEED })
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    // Forcing Life Dew does not heal; because bleed was not cured, end-of-turn bleed
    // (runBleed in endTurn.ts:682, battle_util.c:2585) deals trunc(maxHp / 16) = trunc(165 / 16) = 10 dmg:
    // 66 - 10 = 56. Bleed status remains.
    const bleedDmg = Math.max(1, Math.trunc(maxHp / 16))
    forceMove(s, 'MOVE_LIFE_DEW')
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp - bleedDmg)
    expect(s.state.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
  })

  it('picks Recover while bleeding and stepTurn clears the bleed', () => {
    // BattleScript_EffectRestoreHp (battle_scripts_1.s:3940-3955): jumpifhealingblocked
    // ignores bleed, and :3948 jumpifstatus BS_TARGET, STATUS1_BLEED jumps to
    // BattleScript_MoveUsedBleedHeal (:156) which cures the bleed instead of healing HP.
    const s = session(playerOne(['MOVE_RECOVER', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurtHp = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurtHp, status1: STATUS1_BLEED })
    const trace: PolicyTraceEntry[] = []
    const choice = playTurn(s, 'staller', {}, memory(), trace)
    expect(moveId(choice)).toBe('MOVE_RECOVER')
    expect(trace[0]!.tags).toEqual(['staller', 'heal'])
    // Bleed is cured: STATUS1_BLEED bit is cleared.
    expect(s.state.battlers[0]!.mon.status1 & STATUS1_BLEED).toBe(0)
    // Curing bleed skips the HP heal (:156), so HP remains hurtHp (and no end-of-turn bleed ticks).
    expect(s.state.battlers[0]!.mon.hp).toBe(hurtHp)
  })

  it('prefers non-Rest recovery move over Rest even when Rest is first in moveset', () => {
    // MODEL CHOICE: Rest puts user to sleep for 3 turns, so choose it only
    // when no other usable recovery move exists.
    const s = session(playerOne(['MOVE_REST', 'MOVE_RECOVER', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    const trace: PolicyTraceEntry[] = []
    const choice = chooseRoleAction(s, 'staller', {}, memory(), trace)
    expect(moveId(choice)).toBe('MOVE_RECOVER')
    expect(trace[0]!.tags).toEqual(['staller', 'heal'])
  })
})
