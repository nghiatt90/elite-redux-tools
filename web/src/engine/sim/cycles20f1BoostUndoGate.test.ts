/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 20f1: the role policy's "opponent can undo our boosts" gate treated
// every EFFECT_HIT_SWITCH_TARGET move as phazing. Roar of Time is not: used by
// a holder of ABILITY_TEMPORAL_RUPTURE it is a plain hit
// (BattleScript_EffectHitSwitchTarget, data/battle_scripts_1.s:1669-1671:
// `jumpifnotmove MOVE_ROAR_OF_TIME, BattleScript_EffectHitSwitchTarget_Continue`
// then `jumpifability BS_ATTACKER, ABILITY_TEMPORAL_RUPTURE, BattleScript_EffectHit`),
// and the sim's own switch handler applies the same test (turn.ts:5073-5085).
// Before the fix the sweeper refused to set up against Drake's Dialga and the
// support Baton Passed without boosting; these cases pin the corrected gate.
//
// Fixtures are built through `createSession` and advanced with
// `beginTurn`/`stepTurn` exactly as `playPolicyBattle` does, so every gate is
// read off the real state. HP and damage numbers below are derived from the
// sim's own range call, the same way cycle 946's sweeper tests do.
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, PARTY_SIZE, STAT_ATK, STAT_SPATK } from './constants'
import { aiDamageRolls } from './ai/aiCalcDamage'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'

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

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

/** One turn exactly as `playPolicyBattle` runs it: beginTurn, the policy, the
 * switch-slot write, stepTurn. */
function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

const playerOne = (moves: string[]): PlayerMonSpec[] => [{ species: 'SPECIES_SNORLAX', level: 50, moves }]

// Dialga's Roar of Time (90 BP, SPECIAL, priority -6, moves.json) onto a level
// 50, 0-EV Hardy Snorlax: 85..101, max HP 235. 101 * 100 = 10100 <= 50 * 235 =
// 11750, so the sweeper's 50% safety line stays open, and 101 < 235 is no KO.
const DIALGA_ROAR_MAX = 101
const SNORLAX_MAX_HP = 235

describe('cycle 20f1 - Temporal Rupture Roar of Time is not a phaze', () => {
  it('setupSweeper boosts against the holder on the field, then still stands after the hit', () => {
    const s = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_DIALGA', ['MOVE_ROAR_OF_TIME'], { ability: 'ABILITY_TEMPORAL_RUPTURE' }),
    ])
    const incoming = aiDamageRolls(
      s.state,
      'MOVE_ROAR_OF_TIME',
      1,
      0,
      aiDamageDepsFor(data, s.state, s.inverseBattle),
    )!
    const high = (incoming.totalRolls ?? incoming.rolls)[15]!
    expect(s.state.battlers[0]!.mon.maxHp).toBe(SNORLAX_MAX_HP)
    expect(high).toBe(DIALGA_ROAR_MAX)
    expect(high * 100).toBeLessThanOrEqual(50 * SNORLAX_MAX_HP)
    expect(high).toBeLessThan(SNORLAX_MAX_HP)

    // Swords Dance is EFFECT_ATTACK_UP_2 (moves.json); BattleScript_EffectAttackUp2
    // (battle_scripts_1.s:4240-4242) is `setstatchanger STAT_ATK, 2, FALSE`.
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_SWORDS_DANCE')
    expect(s.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // BattleScript_EffectHit meant no switch: the sweeper is still the active mon.
    expect(s.state.battlers[0]!.partyIndex).toBe(0)
    expect(s.state.battlers[0]!.mon.hp).toBeGreaterThan(0)
  })

  it('setupSweeper boosts when the holder is a RESERVE behind a Celebrate-only active', () => {
    const s = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_DIALGA', ['MOVE_ROAR_OF_TIME'], { ability: 'ABILITY_TEMPORAL_RUPTURE' }),
    ])
    // The reserve is rebuilt through stateWithReserve, which carries the party
    // mon's live abilities; the active mon's Celebrate threatens nothing.
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_SWORDS_DANCE')
    expect(s.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('support with Baton Pass boosts instead of passing nothing', () => {
    // Mr. Mime-style support: Calm Mind (BattleScript_EffectCalmMind,
    // battle_scripts_1.s:6739-6763, `setstatchanger STAT_SPATK, 1`) and Baton
    // Pass, with a live bench slot to pass into. The foe's Roar of Time cannot
    // damage a Fairy target, and a second weak move keeps the AI's prediction
    // on a real move; neither threatens 50% of 115 HP.
    const s = session(
      [
        { species: 'SPECIES_MR_MIME', level: 50, moves: ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_MOONBLAST'] },
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] },
      ],
      [mon('SPECIES_SHUCKLE', ['MOVE_ROAR_OF_TIME', 'MOVE_BODY_SLAM'], { ability: 'ABILITY_TEMPORAL_RUPTURE' })],
    )
    const choice = playTurn(s, 'support', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CALM_MIND')
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    // The bench is still there for the hand-off the Baton Pass rule needs.
    expect(s.state.sides[0].party[1]!.hp).toBeGreaterThan(0)
  })

  it('negative: Roar of Time on a holder WITHOUT Temporal Rupture still blocks, and phazes through stepTurn', () => {
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM'] },
        { species: 'SPECIES_SHUCKLE', level: 50, moves: ['MOVE_CELEBRATE'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_ROAR_OF_TIME'])],
    )
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
    // Cmd_forcerandomswitch (battle_script_commands.c:10156-10182) picked the
    // only live reserve, so the sweeper was dragged out: the gate was right.
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[0]!.mon.speciesId).toBe('SPECIES_SHUCKLE')
  })

  it('negative: a Temporal Rupture holder suppressed by Neutralizing Gas still blocks', () => {
    // gFieldTimers.neutralizingGas is set while a Neutralizing Gas holder is on
    // the field (battle_util.c:4698-4699) and IsSuppressed reads it
    // (battle_util.c:9254-9261); the sim keeps the flag but does not yet set it
    // from the ability, so the fixture writes it as cycle 156c does. Temporal
    // Rupture is not unsuppressable (ABILITY_TEMPORAL_RUPTURE is absent from
    // UNSUPPRESSABLE_ABILITIES, aiAbilityHelpers.ts:81-88).
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, ability: 'ABILITY_NEUTRALIZING_GAS', moves: ['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM'] }],
      [mon('SPECIES_DIALGA', ['MOVE_ROAR_OF_TIME'], { ability: 'ABILITY_TEMPORAL_RUPTURE' })],
    )
    s.state.field.timers.neutralizingGas = true
    expect(moveId(chooseRoleAction(s, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('negative: a Temporal Rupture holder in a party that also has Haze still blocks', () => {
    const s = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_DIALGA', ['MOVE_ROAR_OF_TIME'], { ability: 'ABILITY_TEMPORAL_RUPTURE' }),
      mon('SPECIES_SNORLAX', ['MOVE_HAZE']),
    ])
    expect(moveId(chooseRoleAction(s, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})
