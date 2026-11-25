/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 945b: two rule fixes in the solver-v2 role policy (plan decision 14).
//
// 1. `choosePivot` used to take the first LEGAL pivot move whether or not it
//    could really switch. Every pivot script gates the switch on the C's
//    can-switch test (data/battle_scripts_1.s:2788 HIT_ESCAPE's
//    jumpifmovehadnoeffect, :5379 BattleScript_DoMoveSwitch's jumpifcantswitch,
//    :5271 Baton Pass/Teleport's ButItFailed, :5356-5358 Shed Tail's substitute
//    and HP gates), so a failing pivot was re-chosen every turn. The policy now
//    scans for the first pivot move that passes those gates, which also means a
//    failing first pivot no longer hides a working second one.
// 2. `chooseAttacker` played a non-KO priority move when slower and
//    threatened; priority is only a tie-break among KO moves
//    (docs/battle-sim/solver-v2-plan.md:329).
//
// Fixtures go through `createSession` / `beginTurn` / `stepTurn`, the shape
// cycle945's test uses. Every damage number below is the sim's own range call on
// the fixture named in the comment; the policy thresholds are MODEL CHOICES.
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE, STATUS2_SUBSTITUTE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { ourDamageRange } from './driver/policyInputs'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction, highestRoll, lowestRoll } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[]): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
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
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/speed overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
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

const playerTwo = (firstMoves: string[]): PlayerMonSpec[] => [
  { species: 'SPECIES_SNORLAX', level: 50, moves: firstMoves },
  { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
]

/** The role's decision plus its trace tags, on a fixture already begun. */
function decide(s: BattleSession, role: RoleName, params: RoleParams = {}): { choice: PlayerChoice; tags: string[] } {
  beginTurn(s)
  const trace: PolicyTraceEntry[] = []
  const choice = chooseRoleAction(s, role, params, memory(), trace)
  return { choice, tags: trace[0]!.tags }
}

describe('cycle 945b - pivot: a pivot that cannot switch is not a pivot', () => {
  it('refuses an immune HIT_ESCAPE move and attacks instead', () => {
    // Volt Switch is Electric and their Donphan is Ground: the range is immune
    // ([0, 0, isImmune]), so BattleScript_EffectHitEscape's
    // jumpifmovehadnoeffect (data/battle_scripts_1.s:2788) ends the move before
    // the switch. Their Earthquake ([68, 80]) beats the 50% line on our 80 HP,
    // so the pivot rule really is engaged and must fall through to Body Slam.
    const s = session(playerTwo(['MOVE_VOLT_SWITCH', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_DONPHAN', ['MOVE_EARTHQUAKE']),
    ])
    patchMon(s.state, 0, 0, { hp: 80 })
    const quake = ourDamageRange(s, 'MOVE_EARTHQUAKE', 1, 0)
    expect(highestRoll(quake!)).toBeGreaterThan(40)
    const volt = ourDamageRange(s, 'MOVE_VOLT_SWITCH', 0, 1)
    expect(volt!.isImmune).toBe(true)
    const { choice, tags } = decide(s, 'pivot')
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
    expect(choice.switchTo).toBeUndefined()
    expect(tags).toEqual(['pivot', 'damage'])
  })

  it('does not Baton Pass as the last mon, and does with a reserve', () => {
    // BattleScript_EffectBatonPass's
    // jumpifcantswitch ... BattleScript_ButItFailed (:5271) needs a reserve.
    const last = session(playerOne(['MOVE_BATON_PASS', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(last.state, 0, 0, { hp: 80 })
    const alone = decide(last, 'pivot')
    expect(moveId(alone.choice)).toBe('MOVE_BODY_SLAM')
    expect(alone.choice.switchTo).toBeUndefined()

    // Control: the identical position with a living slot 1 does pass.
    const withBench = session(playerTwo(['MOVE_BATON_PASS', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']),
    ])
    patchMon(withBench.state, 0, 0, { hp: 80 })
    const passes = decide(withBench, 'pivot')
    expect(moveId(passes.choice)).toBe('MOVE_BATON_PASS')
    expect(passes.choice.switchTo).toBe(1)
  })

  it('gates Shed Tail on its HP cost, and its switch really happens', () => {
    // Cmd_setsubstitute fails when hp <= max(1, maxHP / 2)
    // (src/battle_script_commands.c:10535-10555); Snorlax maxHP is 235 here, so
    // the line is 117. safetyPct 25 keeps the 46 max roll threatening
    // (46/118 and 46/117 are both over 25%).
    const s = session(playerTwo(['MOVE_SHED_TAIL', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']),
    ])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const half = Math.floor(maxHp / 2)
    patchMon(s.state, 0, 0, { hp: half })
    const incoming = ourDamageRange(s, 'MOVE_BODY_SLAM', 1, 0)
    expect(lowestRoll(incoming!)).toBe(39)
    expect(highestRoll(incoming!)).toBe(46)
    expect(highestRoll(incoming!) * 100).toBeGreaterThan(25 * half)
    const atLine = decide(s, 'pivot', { safetyPct: 25 })
    expect(moveId(atLine.choice)).toBe('MOVE_BODY_SLAM')
    expect(atLine.choice.switchTo).toBeUndefined()

    // One HP above the line Shed Tail works. Snorlax is sped up so it acts
    // before the Machamp: the script's HP check reads the live HP at execution
    // time, and a 39..46 Body Slam first would push us back under the line.
    const s2 = session(playerTwo(['MOVE_SHED_TAIL', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']),
    ])
    const maxHp2 = s2.state.battlers[0]!.mon.maxHp
    const half2 = Math.floor(maxHp2 / 2)
    patchMon(s2.state, 0, 0, { hp: half2 + 1 })
    patchMon(s2.state, 0, 0, { rawStats: { ...s2.state.battlers[0]!.mon.rawStats, spe: 200 } })
    patchMon(s2.state, 1, 0, { rawStats: { ...s2.state.battlers[1]!.mon.rawStats, spe: 1 } })
    const incoming2 = ourDamageRange(s2, 'MOVE_BODY_SLAM', 1, 0)
    expect(highestRoll(incoming2!) * 100).toBeGreaterThan(25 * (half2 + 1))
    const choice = playTurn(s2, 'pivot', { safetyPct: 25 }, memory())
    expect(moveId(choice)).toBe('MOVE_SHED_TAIL')
    expect(choice.switchTo).toBe(1)
    expect(s2.state.battlers[0]!.partyIndex).toBe(1)
  })

  it('refuses Shed Tail under an existing substitute', () => {
    // jumpifstatus2 BS_ATTACKER, STATUS2_SUBSTITUTE (data/battle_scripts_1.s:5356).
    const s = session(playerTwo(['MOVE_SHED_TAIL', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']),
    ])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { status2: STATUS2_SUBSTITUTE })
    s.state.battlers[0]!.volatiles.substituteHp = Math.floor(maxHp / 4)
    // safetyPct 10: the 46 max roll (19.6% of 235) still threatens, and the HP
    // cost gate is wide open at full HP, so the substitute is the only refusal.
    const subbed = decide(s, 'pivot', { safetyPct: 10 })
    expect(moveId(subbed.choice)).toBe('MOVE_BODY_SLAM')
    expect(subbed.choice.switchTo).toBeUndefined()

    // Control: same position without the substitute does shed the tail.
    const clean = session(playerTwo(['MOVE_SHED_TAIL', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']),
    ])
    const control = decide(clean, 'pivot', { safetyPct: 10 })
    expect(moveId(control.choice)).toBe('MOVE_SHED_TAIL')
    expect(control.choice.switchTo).toBe(1)
  })

  it('takes the working pivot when the first one fails', () => {
    // Shed Tail sorts before U-turn in pivotMoves and is in the moveset, but the
    // HP gate at exactly half closes it; U-turn (a HIT_ESCAPE move that lands on
    // the Machamp) is then the usable hand-off.
    const s = session(playerTwo(['MOVE_SHED_TAIL', 'MOVE_U_TURN']), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor(maxHp / 2) })
    const uTurn = ourDamageRange(s, 'MOVE_U_TURN', 0, 1)
    expect(uTurn!.isImmune).toBe(false)
    const { choice } = decide(s, 'pivot', { safetyPct: 25 })
    expect(moveId(choice)).toBe('MOVE_U_TURN')
    expect(choice.switchTo).toBe(1)
  })
})
