/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946b: the staller's status gate (`statusMoveWorks`) and its Curse rule
// (chooseStaller rule 4) must agree with the move handlers, otherwise the
// staller skips a move that works or re-picks a failing one every turn up to
// the 200-turn cap.
//
// Three gates under test, each read from the C at the pinned SHA:
//  - Thunder Wave's typecalc Ground block (battle_scripts_1.s:4366 before
//    requirecandoeffect :4367; battle_script_commands.c:1213/2506).
//  - The powder canceller (battle_util.c:3455-3466 -> IsPowderImmune :3190-3197).
//  - Curse's fog branch (battle_scripts_1.s:4928-4930).
//
// The scaffolding (fixtures, playTurn, moveId) is cycle 946's, copied from
// cycle946RolePolicyB.test.ts. Every case either runs a real turn through
// beginTurn/stepTurn or forces the move through stepTurn, so the status read
// afterwards is the real state, not a policy prediction.
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE, STATUS1_PARALYSIS, STATUS1_SLEEP, STATUS2_CURSED, WEATHER_FOG_TEMPORARY } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
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

/** One turn exactly as `playPolicyBattle` runs it: beginTurn, the policy, the
 * switch-slot write, stepTurn (cycle 946's helper). */
function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

/** The staller's gate and the handler must agree, so where the policy is
 * expected to skip a status move we also pick that move from `legalChoices` and
 * force it through `stepTurn`: a status that stays 0 there is the handler's own
 * refusal, not a policy skip. */
function forceMove(s: BattleSession, id: string): void {
  beginTurn(s)
  const choice = legalChoices(s).find((c) => moveId(c) === id)
  expect(choice, `${id} must be a legal choice`).toBeDefined()
  s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
  stepTurn(s, choice!.action)
}

/** Snorlax is Normal (handleCurse's non-Ghost branch) and carries the status
 * move under test plus Body Slam, the damaging fallback. */
const playerOne = (moves: string[]): PlayerMonSpec[] => [{ species: 'SPECIES_SNORLAX', level: 50, moves }]

/** The foe always Celebrates: no damage, so the staller's rule 1 is never
 * skipped for a KO threat and nothing but the move under test can change the
 * target's status. */
const celebrate = (species: string, overrides: Partial<TrainerMonData> = {}): TrainerMonData =>
  mon(species, ['MOVE_CELEBRATE'], overrides)

describe('cycle 946b - Thunder Wave typecalc (EFFECT_PARALYZE)', () => {
  it('paralyzes a Fighting target', () => {
    // BattleScript_EffectParalyze runs typecalc (:4366) -- Electric vs Fighting
    // is neutral -- then requirecandoeffect (:4367), accuracycheck (:4369) and
    // setmoveeffect MOVE_EFFECT_PARALYSIS (:4372), where applyPrimaryStatusEffect
    // calls CanBeParalyzed (battle_util.c:5072-5080). Machamp's innate No Guard
    // (species.json) makes the 90% accuracy roll an ALWAYS_HITS one
    // (accuracy.ts:529), so this case cannot miss.
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    const mem = memory()
    expect(moveId(playTurn(s, 'staller', {}, mem))).toBe('MOVE_THUNDER_WAVE')
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
  })

  it('skips Thunder Wave on a Ground target and the handler agrees', () => {
    // typecalc (:4366) on an Electric move vs a Ground type sets
    // MOVE_RESULT_DOESNT_AFFECT_FOE, so accuracycheck (:4369) jumps to
    // BattleScript_ButItFailed (JumpIfMoveFailed,
    // battle_script_commands.c:1213) -- no accuracy roll, no status. This is the
    // gate that was missing from statusMoveWorks (handleParalyze already has
    // it, moveEffects.ts:2025-2028).
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_SANDSLASH', { ability: 'ABILITY_BATTLE_ARMOR' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_THUNDER_WAVE')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
  })

  it('skips Thunder Wave on an Electric target and the handler agrees', () => {
    // requirecandoeffect (:4367) passes an Electric target because it carries
    // MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES, but the later `setmoveeffect
    // MOVE_EFFECT_PARALYSIS` (:4372) has no such flag, so the paralysis case
    // reaches `if (!CanBeParalyzed(...)) break;` (battle_script_commands.c:2506)
    // and CanParalyzeType (battle_script_commands.c:6472-6479) refuses an
    // Electric target. Keeping canBeParalyzed (not the ignore-type variant) in
    // statusMoveWorks is what makes the policy agree. Electabuzz's chosen
    // ability is Power Fists, not Motor Drive, and its innates (Vital Spirit,
    // Static) do not block paralysis.
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_ELECTABUZZ', { ability: 'ABILITY_POWER_FISTS' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    // The move does roll accuracy here (no typecalc block), so pin the roll to
    // 0 -- `Random() % 100 >= accuracy` is false, a hit (moveEffects.ts:427) --
    // and the status that stays 0 is the type gate, not a miss.
    s.state.rng = { random16: () => 0 }
    forceMove(s, 'MOVE_THUNDER_WAVE')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
  })
})

describe('cycle 946b - powder moves (CANCELLER_POWDER_MOVE)', () => {
  it('Spore skips a Grass target and the handler agrees', () => {
    // CANCELLER_POWDER_MOVE (battle_util.c:3455-3466) cancels a FLAG_POWDER
    // move when IsPowderImmune (:3190-3197) is true; the first clause there is
    // the Grass type.
    const s = session(playerOne(['MOVE_SPORE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_TANGELA', { ability: 'ABILITY_CHLOROPHYLL' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_SPORE')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
  })

  it('Spore sleeps a target with no powder immunity', () => {
    // Spore is 100 accuracy, and Machamp's innate No Guard makes it
    // ALWAYS_HITS anyway. handleSleep sets STATUS1_SLEEP; the low 3 bits are the
    // sleep counter, which is non-zero on the turn it lands.
    const s = session(playerOne(['MOVE_SPORE', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])
    expect(moveId(playTurn(s, 'staller', {}, memory()))).toBe('MOVE_SPORE')
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_SLEEP).not.toBe(0)
  })

  it('Spore skips a Safety Goggles holder', () => {
    // IsPowderImmune's second clause: GetBattlerHoldEffect ==
    // HOLD_EFFECT_SAFETY_GOGGLES (battle_util.c:3193).
    const s = session(playerOne(['MOVE_SPORE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_MACHAMP', { item: 'ITEM_SAFETY_GOGGLES' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('Stun Spore skips a Grass target too', () => {
    // Stun Spore is EFFECT_PARALYZE_IGNORE_TYPE, which the powder canceller runs
    // before (attackcanceler is the first script command), so the ignore-type
    // flag does not save it.
    const s = session(playerOne(['MOVE_STUN_SPORE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_TANGELA', { ability: 'ABILITY_CHLOROPHYLL' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('Glare is not a powder move, so a Grass target is still paralyzable', () => {
    // MOVE_GLARE has no powderAffected flag (moves.json), so
    // CANCELLER_POWDER_MOVE never fires; Tangela has no paralysis-blocking
    // ability.
    const s = session(playerOne(['MOVE_GLARE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_TANGELA', { ability: 'ABILITY_CHLOROPHYLL' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_GLARE')
  })
})

describe('cycle 946b - Glare still ignores type immunity', () => {
  it('paralyzes an Electric target', () => {
    // BattleScript_EffectParalyzeIgnoreType (:4346-4360) has no typecalc and
    // keeps MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES on setmoveeffect, so
    // applyPrimaryStatusEffect's `ignoreTypeImmunities` shortcut
    // (battle_script_commands.c:2495-2498) sets the status past CanParalyzeType.
    const s = session(playerOne(['MOVE_GLARE', 'MOVE_BODY_SLAM']), [
      celebrate('SPECIES_ELECTABUZZ', { ability: 'ABILITY_POWER_FISTS' }),
    ])
    expect(moveId(playTurn(s, 'staller', {}, memory()))).toBe('MOVE_GLARE')
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
  })
})

describe('cycle 946b - Curse under fog (staller rule 4)', () => {
  const curseSession = (): BattleSession =>
    session(playerOne(['MOVE_CURSE', 'MOVE_BODY_SLAM']), [celebrate('SPECIES_MACHAMP')])

  it('picks Curse through fog for a non-Ghost attacker', () => {
    // BattleScript_EffectCurse (:4928-4930) jumps to BattleScript_GhostCurse
    // when the attacker is Ghost OR fog is effective on it
    // (`jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY`); that branch runs
    // Cmd_cursetarget (battle_script_commands.c:11103-11113), which sets
    // STATUS2_CURSED, and charges the attacker max(1, maxHp / 2)
    // (moveEffects.ts:3843).
    const s = curseSession()
    s.state.field.weather = WEATHER_FOG_TEMPORARY
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CURSE')
    expect(s.state.battlers[1]!.mon.status2 & STATUS2_CURSED).toBe(STATUS2_CURSED)
    // max(1, floor(maxHp / 2)) off our own HP, then Snorlax's innate Self
    // Sufficient heals max(1, maxHP / 16) at end of turn because it is below max
    // HP (endTurn.ts:1183-1195, the port of abilityHooks.json's onEndTurn
    // lambda). The foe only Celebrates, so nothing else moves our HP.
    const hpCost = Math.max(1, Math.floor(maxHp / 2))
    const selfHeal = Math.max(1, Math.trunc(maxHp / 16))
    expect(s.state.battlers[0]!.mon.hp).toBe(maxHp - hpCost + selfHeal)
  })

  it('does not pick Curse without fog on a non-Ghost attacker', () => {
    // Without Ghost typing or fog the script takes the non-Ghost branch
    // (`jumpifstat ... STAT_SPEED`, :4931+), which is a self boost, not a
    // residual: the staller attacks instead.
    const s = curseSession()
    expect(moveId(playTurn(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
    expect(s.state.battlers[1]!.mon.status2 & STATUS2_CURSED).toBe(0)
  })

  it('does not re-Curse a target that already has STATUS2_CURSED', () => {
    // Cmd_cursetarget fails when STATUS2_CURSED is already set
    // (battle_script_commands.c:11103-11113); the policy's `target lacks it`
    // clause mirrors that.
    const s = curseSession()
    s.state.field.weather = WEATHER_FOG_TEMPORARY
    patchMon(s.state, 1, 0, { status2: STATUS2_CURSED })
    expect(moveId(playTurn(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})
