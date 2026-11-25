/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import {
  PARTY_SIZE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  WEATHER_FOG_TEMPORARY,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { RoleMemory, RoleParams, RoleName } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState } from './state'
import { getHighestAttackingStatId } from './statBuffs'

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
 * switch-slot write, stepTurn (same helper as cycle 945). */
function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

const playerOne = (moves: string[], ability = 'ABILITY_OBLIVIOUS'): PlayerMonSpec[] => [
  { species: 'SPECIES_SNORLAX', level: 50, moves, ability },
]

describe('cycle 946d - set-up sweeper and Baton Pass boost tables', () => {
  it('case 1: Belly Drum at full HP picks Belly Drum, reaches Attack stage 12, and cuts half HP', () => {
    // BattleScript_EffectBellyDrum (battle_scripts_1.s:5592-5604; Cmd_maxattackhalvehp,
    // battle_script_commands.c:11338-11354). Snorlax's innate ABILITY_SELF_SUFFICIENT
    // (endTurn.ts:1183; src/abilities.cc:4041-4054) heals max(1, trunc(maxHp / 16)) at end of turn.
    const s = session(playerOne(['MOVE_BELLY_DRUM', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BELLY_DRUM')
    expect(s.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(12)
    const halfHp = Math.max(1, Math.floor(maxHp / 2))
    const selfSufficientHeal = Math.max(1, Math.trunc(maxHp / 16))
    expect(s.state.battlers[0]!.mon.hp).toBe(maxHp - halfHp + selfSufficientHeal)
  })

  it('case 2: Belly Drum boundary: skips Belly Drum at floor(maxHp / 2), picks at floor(maxHp / 2) + 1', () => {
    // Cmd_maxattackhalvehp (battle_script_commands.c:11340-11348): Belly Drum fails
    // when hp <= halfHp.
    const s1 = session(playerOne(['MOVE_BELLY_DRUM', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const halfHp = Math.floor(s1.state.battlers[0]!.mon.maxHp / 2)
    patchMon(s1.state, 0, 0, { hp: halfHp })
    beginTurn(s1)
    const choice1 = chooseRoleAction(s1, 'setupSweeper', {}, memory())
    expect(moveId(choice1)).toBe('MOVE_BODY_SLAM')

    const s2 = session(playerOne(['MOVE_BELLY_DRUM', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s2.state, 0, 0, { hp: halfHp + 1 })
    beginTurn(s2)
    const choice2 = chooseRoleAction(s2, 'setupSweeper', {}, memory())
    expect(moveId(choice2)).toBe('MOVE_BELLY_DRUM')
  })

  it('case 3: Belly Drum in Baton Pass path: skips Belly Drum at floor(maxHp / 2) and picks Baton Pass', () => {
    // Support role with Baton Pass and live bench: when Belly Drum is gated by HP,
    // Baton Pass setup returns null and support pivots out with Baton Pass.
    const party: PlayerMonSpec[] = [
      { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BELLY_DRUM', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM'] },
      { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
    ]
    const s = session(party, [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const halfHp = Math.floor(s.state.battlers[0]!.mon.maxHp / 2)
    patchMon(s.state, 0, 0, { hp: halfHp })
    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).not.toBe('MOVE_BELLY_DRUM')
    expect(moveId(choice)).toBe('MOVE_BATON_PASS')
  })

  it('case 4: Sharpen raises the higher attacking stat by 1 when safe', () => {
    // BattleScript_EffectSharpen (battle_scripts_1.s:12008-12046; GetHighestAttackingStatId,
    // battle_script_commands.c:8159-8170).
    const s = session(playerOne(['MOVE_SHARPEN', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const deps = aiDamageDepsFor(s.data, s.state, s.inverseBattle)
    const highestStat = getHighestAttackingStatId(s.state, 0, deps.statStageRatios)
    const otherStat = highestStat === STAT_ATK ? STAT_SPATK : STAT_ATK
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_SHARPEN')
    expect(s.state.battlers[0]!.mon.statStages[highestStat]).toBe(7)
    expect(s.state.battlers[0]!.mon.statStages[otherStat]).toBe(6)
  })

  it('case 5: Karma raises Sp. Atk and Sp. Def by 1 and lowers Speed by 1', () => {
    // BattleScript_EffectKarma (battle_scripts_1.s:4989 onwards): Speed -1, Sp. Atk +1, Sp. Def +1.
    const s = session(playerOne(['MOVE_KARMA', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_KARMA')
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
  })

  it('case 6: non-Ghost Curse raises Attack and Defense by 1 and lowers Speed by 1', () => {
    // BattleScript_EffectCurse (battle_scripts_1.s:4928-4960): non-Ghost branch
    // Speed -1, Attack +1, Defense +1. Snorlax is Normal type.
    const s = session(playerOne(['MOVE_CURSE', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    expect(s.state.battlers[0]!.mon.types.includes('GHOST')).toBe(false)
    const choice = playTurn(s, 'setupSweeper', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CURSE')
    expect(s.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(s.state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
  })

  it('case 7: Curse negatives: Ghost user or fog skips Curse as setup and attacks', () => {
    // Ghost user: BattleScript_EffectCurse jumps to GhostCurse (:4929)
    const ghostPlayer: PlayerMonSpec[] = [
      { species: 'SPECIES_GENGAR', level: 50, moves: ['MOVE_CURSE', 'MOVE_SHADOW_BALL'] },
    ]
    const sGhost = session(ghostPlayer, [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    expect(sGhost.state.battlers[0]!.mon.types.includes('GHOST')).toBe(true)
    beginTurn(sGhost)
    const ghostChoice = chooseRoleAction(sGhost, 'setupSweeper', {}, memory())
    expect(moveId(ghostChoice)).not.toBe('MOVE_CURSE')
    expect(moveId(ghostChoice)).toBe('MOVE_SHADOW_BALL')

    // Non-Ghost in fog: jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY (:4930)
    const sFog = session(playerOne(['MOVE_CURSE', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    expect(sFog.state.battlers[0]!.mon.types.includes('GHOST')).toBe(false)
    sFog.state.field.weather = WEATHER_FOG_TEMPORARY
    beginTurn(sFog)
    const fogChoice = chooseRoleAction(sFog, 'setupSweeper', {}, memory())
    expect(moveId(fogChoice)).not.toBe('MOVE_CURSE')
    expect(moveId(fogChoice)).toBe('MOVE_BODY_SLAM')
  })

  it('case 8: Ruination on bench foe makes the sweeper attack instead of Swords Dance', () => {
    // MOVE_RUINATION = EFFECT_SUPER_FANG_HAZE (battle_scripts_1.s:4105-4118 -> Cmd_normalisebuffs).
    const withRuination = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_RUINATION']),
    ])
    beginTurn(withRuination)
    const choiceWithRuination = chooseRoleAction(withRuination, 'setupSweeper', {}, memory())
    expect(moveId(choiceWithRuination)).toBe('MOVE_BODY_SLAM')

    // Positive control: same bench mon with Tackle allows Swords Dance
    const withTackle = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_TACKLE']),
    ])
    beginTurn(withTackle)
    const choiceWithTackle = chooseRoleAction(withTackle, 'setupSweeper', {}, memory())
    expect(moveId(choiceWithTackle)).toBe('MOVE_SWORDS_DANCE')
  })

  it('case 9: Clear Smog on bench foe makes the sweeper attack instead of Swords Dance', () => {
    // MOVE_CLEAR_SMOG = EFFECT_CLEAR_SMOG (battle_scripts_1.s:1700-1702 -> MOVE_EFFECT_CLEAR_SMOG).
    const withClearSmog = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_CLEAR_SMOG']),
    ])
    beginTurn(withClearSmog)
    const choiceWithClearSmog = chooseRoleAction(withClearSmog, 'setupSweeper', {}, memory())
    expect(moveId(choiceWithClearSmog)).toBe('MOVE_BODY_SLAM')

    // Positive control: same bench mon with Tackle allows Swords Dance
    const withTackle = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_TACKLE']),
    ])
    beginTurn(withTackle)
    const choiceWithTackle = chooseRoleAction(withTackle, 'setupSweeper', {}, memory())
    expect(moveId(choiceWithTackle)).toBe('MOVE_SWORDS_DANCE')
  })
})
