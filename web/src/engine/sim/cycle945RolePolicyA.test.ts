/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 945: the solver-v2 role policy core (Step 2.0a) -- attacker, pivot and
// lead/hazard setter, plus the shared inputs every role reads (a 3-sample AI
// prediction, our damage ranges, speed order, the predicted switch-in).
//
// Every expected damage number below was computed once with `ourDamageRange` /
// `aiDamageRolls` on the fixture named in its comment, at level 50, Hardy, 0
// EVs, 31 IVs (the game forces 31 -- CLAUDE.md). The fixtures themselves are
// built through `createSession` and advanced through `beginTurn`/`stepTurn`, so
// the gates under test (isFirstTurn, hazard layers, AI switch samples) are the
// real state, not hand-written values.
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE, SIDE_STATUS_STEALTH_ROCK, STATUS3_PERISH_SONG } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { predictAi } from './driver/policyInputs'
import type { RoleMemory, RoleParams, RoleName } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
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

describe('cycle 945 - attacker: Fake Out', () => {
  it('uses Fake Out on turn 1 and not on turn 2', () => {
    const s = session(playerOne(['MOVE_FAKE_OUT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    // createSession runs TryDoEventsBeforeFirstTurn's cleanup, which leaves the
    // lead at isFirstTurn == 1 (battle_main.c:3406; create.ts:486-489).
    expect(s.state.battlers[0]!.volatiles.isFirstTurn).toBe(1)
    beginTurn(s)
    const turn1 = chooseRoleAction(s, 'attacker', {}, mem)
    expect(moveId(turn1)).toBe('MOVE_FAKE_OUT')

    // Step the chosen turn; the end-of-turn TurnValuesCleanUp decrements
    // isFirstTurn 1 -> 0 (turn.ts:782-784, battle_main.c:4490-4510), and Fake
    // Out's jumpifnotfirstturn gate (battle_scripts_1.s:5932-5934) now fails.
    s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
    stepTurn(s, turn1.action)
    expect(s.state.battlers[0]!.volatiles.isFirstTurn).toBe(0)
    beginTurn(s)
    const turn2 = chooseRoleAction(s, 'attacker', {}, mem)
    expect(moveId(turn2)).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 945 - attacker: guaranteed KO beats a higher accuracy-weighted move', () => {
  it('takes the lower-scoring guaranteed KO, and the stronger move when neither KOs', () => {
    // Attacker Snorlax (Atk 110) vs defender Snorlax (Normal, Def 65), level 50:
    //   MOVE_DYNAMIC_PUNCH (120 Fighting, 2x vs Normal, 50% accuracy): min 139, mean 151.3
    //   MOVE_BODY_SLAM (85 Normal, 100% accuracy):                    min 75,  mean 81.9
    // Accuracy-weighted: Dynamic Punch 151.3*0.5 = 75.65 < Body Slam 81.9, so
    // only the guaranteed-KO rule can pick Dynamic Punch.
    const s = session(playerOne(['MOVE_DYNAMIC_PUNCH', 'MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { hp: 100 })
    // Dynamic Punch's worst roll (139) >= 100; Body Slam's worst (75) < 100.
    const choice = chooseRoleAction(s, 'attacker', {}, memory())
    expect(moveId(choice)).toBe('MOVE_DYNAMIC_PUNCH')

    // Negative: HP 150 puts both worst rolls below the target's HP, so no move
    // is a guaranteed KO and the accuracy-weighted fallback picks Body Slam.
    const s2 = session(playerOne(['MOVE_DYNAMIC_PUNCH', 'MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    patchMon(s2.state, 1, 0, { hp: 150 })
    expect(moveId(chooseRoleAction(s2, 'attacker', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('prefers a guaranteed KO that also outspeeds over the higher worst roll', () => {
    // Both moves KO a 50-HP Machamp: Extreme Speed (priority 2) min 60, Body
    // Slam min 63. Body Slam's worst roll is higher, but we are slower (spe 1
    // vs 200), so the faster KO -- Extreme Speed -- wins.
    const s = session(
      playerOne(['MOVE_BODY_SLAM', 'MOVE_EXTREME_SPEED']),
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    patchMon(s.state, 1, 0, { hp: 50 })
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 1 } })
    patchMon(s.state, 1, 0, { rawStats: { ...s.state.battlers[1]!.mon.rawStats, spe: 200 } })
    expect(moveId(chooseRoleAction(s, 'attacker', {}, memory()))).toBe('MOVE_EXTREME_SPEED')
  })
})

describe('cycle 945 - attacker: priority when slower and threatened', () => {
  const setup = (): BattleSession => {
    const s = session(playerOne(['MOVE_BODY_SLAM', 'MOVE_QUICK_ATTACK']), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    // Machamp's Body Slam onto our Snorlax: min 39, max 46. Speeds: ours 1, theirs 200.
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 1 } })
    patchMon(s.state, 1, 0, { rawStats: { ...s.state.battlers[1]!.mon.rawStats, spe: 200 } })
    return s
  }

  it('takes the priority move when threatened and slower', () => {
    const s = setup()
    // HP 80: the predicted 46 removes more than 50% (40) but does not KO.
    patchMon(s.state, 0, 0, { hp: 80 })
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'attacker', {}, memory()))).toBe('MOVE_QUICK_ATTACK')
  })

  it('does not prioritise when not threatened', () => {
    const s = setup()
    // HP 235 (full): 46 is well under 50% (117.5), so the accuracy-weighted
    // fallback picks Body Slam (mean 69) over Quick Attack (32.8).
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'attacker', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 945 - pivot', () => {
  const pivotMoves = ['MOVE_U_TURN', 'MOVE_BODY_SLAM']

  it('uses U-turn and names the bench slot when threatened', () => {
    const s = session(playerTwo(pivotMoves), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    // Machamp's Body Slam max 46 > 50% of 80, so the matchup is bad.
    patchMon(s.state, 0, 0, { hp: 80 })
    beginTurn(s)
    const choice = chooseRoleAction(s, 'pivot', {}, memory())
    expect(moveId(choice)).toBe('MOVE_U_TURN')
    // The only living reserve is party slot 1; U-turn's switch reads
    // monToSwitchIntoId (turn.ts:1864).
    expect(choice.switchTo).toBe(1)
  })

  it('attacks when not threatened', () => {
    const s = session(playerTwo(pivotMoves), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    beginTurn(s)
    const choice = chooseRoleAction(s, 'pivot', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
    expect(choice.switchTo).toBeUndefined()
  })

  it('attacks when it holds no pivot move', () => {
    const s = session(playerTwo(['MOVE_BODY_SLAM', 'MOVE_TACKLE']), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(s.state, 0, 0, { hp: 80 })
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'pivot', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('pivots on an "unable to damage" matchup even when safe', () => {
    // Every damaging move is Normal and the target is a Ghost (immune), so the
    // noDamage half of 'either' fires. Teleport is a status pivot move
    // (EFFECT_SWITCH_ARGUMENT) and is legal, so it switches into slot 1.
    const s = session(playerTwo(['MOVE_BODY_SLAM', 'MOVE_QUICK_ATTACK', 'MOVE_TELEPORT']), [
      mon('SPECIES_GENGAR', ['MOVE_TACKLE']),
    ])
    beginTurn(s)
    const choice = chooseRoleAction(s, 'pivot', {}, memory())
    expect(moveId(choice)).toBe('MOVE_TELEPORT')
    expect(choice.switchTo).toBe(1)
  })

  it('treats a predicted AI switch as safe and does not pivot', () => {
    // Same party and HP as the pivoting case, but Perish Song forces every
    // sampled AI action to be a switch (cycle 944's fixture, aiShouldSwitch.ts's
    // ShouldSwitchIfPerishSong), so nothing hits us and the pivot stays in.
    const s = session(
      playerTwo(pivotMoves),
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']), mon('SPECIES_SNORLAX', ['MOVE_TACKLE'])],
      { noSwitching: false },
    )
    patchMon(s.state, 0, 0, { hp: 80 })
    s.state.battlers[1]!.statuses3 |= STATUS3_PERISH_SONG
    s.state.battlers[1]!.volatiles.perishSongTimer = 0
    beginTurn(s)
    // The gate really is the prediction: every sample is a switch.
    expect(predictAi(s, 3, 0).map((p) => p.action?.action)).toEqual(['SWITCH', 'SWITCH', 'SWITCH'])
    const choice = chooseRoleAction(s, 'pivot', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
    expect(choice.switchTo).toBeUndefined()

    // Control: the identical party without the forced switch is threatened and
    // does pivot, so the safe verdict above came from the samples.
    const control = session(
      playerTwo(pivotMoves),
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']), mon('SPECIES_SNORLAX', ['MOVE_TACKLE'])],
      { noSwitching: false },
    )
    patchMon(control.state, 0, 0, { hp: 80 })
    beginTurn(control)
    expect(predictAi(control, 3, 0).map((p) => p.action?.action)).toEqual(['USE_MOVE', 'USE_MOVE', 'USE_MOVE'])
    expect(moveId(chooseRoleAction(control, 'pivot', {}, memory()))).toBe('MOVE_U_TURN')
  })
})

describe('cycle 945 - leadHazard', () => {
  it('lays Stealth Rock to its target layer then plays the attacker fallback', () => {
    const s = session(playerOne(['MOVE_STEALTH_ROCK', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    const turn1 = playTurn(s, 'leadHazard', { targetLayers: 1 }, mem)
    expect(moveId(turn1)).toBe('MOVE_STEALTH_ROCK')
    expect(s.state.sides[1].statuses & SIDE_STATUS_STEALTH_ROCK).toBe(SIDE_STATUS_STEALTH_ROCK)
    const turn2 = playTurn(s, 'leadHazard', { targetLayers: 1 }, mem)
    expect(moveId(turn2)).toBe('MOVE_BODY_SLAM')
  })

  it('stops Spikes at the target layer count', () => {
    const s = session(playerOne(['MOVE_SPIKES', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    expect(moveId(playTurn(s, 'leadHazard', { targetLayers: 2 }, mem))).toBe('MOVE_SPIKES')
    expect(s.state.sides[1].timers.spikesAmount).toBe(1)
    expect(moveId(playTurn(s, 'leadHazard', { targetLayers: 2 }, mem))).toBe('MOVE_SPIKES')
    expect(s.state.sides[1].timers.spikesAmount).toBe(2)
    // At the cap (min(targetLayers, 3) == 2) the fallback plays.
    expect(moveId(playTurn(s, 'leadHazard', { targetLayers: 2 }, mem))).toBe('MOVE_BODY_SLAM')
  })

  it('prefers Stealth Rock over Spikes when both are below target', () => {
    const s = session(
      playerOne(['MOVE_SPIKES', 'MOVE_STEALTH_ROCK', 'MOVE_BODY_SLAM']),
      [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])],
    )
    expect(moveId(playTurn(s, 'leadHazard', { targetLayers: 3 }, memory()))).toBe('MOVE_STEALTH_ROCK')
    expect(s.state.sides[1].statuses & SIDE_STATUS_STEALTH_ROCK).toBe(SIDE_STATUS_STEALTH_ROCK)
  })
})

describe('cycle 945 - predicted switch-in is the damage target', () => {
  it('picks the move that KOs the predicted switch-in instead of the active target', () => {
    // Body Slam (85 Normal) is our best move against the active Machamp; against
    // a Ghost switch-in it is immune. Bite (60 Dark, 2x vs Ghost) KOs a 30-HP
    // Gengar (min 74 from the fixture below).
    // No switch: a lone Machamp, Body Slam wins on mean (69.0 vs 16.2).
    const quiet = session(playerOne(['MOVE_BODY_SLAM', 'MOVE_BITE']), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    beginTurn(quiet)
    expect(moveId(chooseRoleAction(quiet, 'attacker', {}, memory()))).toBe('MOVE_BODY_SLAM')

    // Forced switch: Perish Song makes all 3 samples switch into slot 1.
    const s = session(
      playerOne(['MOVE_BODY_SLAM', 'MOVE_BITE']),
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM']), mon('SPECIES_GENGAR', ['MOVE_TACKLE'])],
      { noSwitching: false },
    )
    patchMon(s.state, 1, 1, { hp: 30 })
    s.state.battlers[1]!.statuses3 |= STATUS3_PERISH_SONG
    s.state.battlers[1]!.volatiles.perishSongTimer = 0
    beginTurn(s)
    // All three samples switch into slot 1, so the target is the 30-HP Gengar.
    expect(predictAi(s, 3, 0).map((p) => p.switchSlot)).toEqual([1, 1, 1])
    expect(moveId(chooseRoleAction(s, 'attacker', {}, memory()))).toBe('MOVE_BITE')
  })
})
