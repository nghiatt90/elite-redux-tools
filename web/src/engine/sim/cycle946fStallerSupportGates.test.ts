/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946f: the staller's status gate (`statusMoveWorks`) and its Leech Seed
// pick must agree with the handlers on the two target-side gates the sim already
// models -- Substitute and Magic Bounce -- and the support's pivot scan must
// skip a failing pivot instead of hiding a working one behind it.
//
// Every gate is read from the C at the pinned SHA:
//  - Substitute: `jumpifsubstituteblocks` in Will-O-Wisp (:6094) and Leech Seed
//    (:4584); SetMoveEffect's early return on DoesSubstituteBlockMove
//    (battle_script_commands.c:2388) for Toxic / Poison / Paralyze / Sleep.
//  - Magic Bounce: Cmd_attackcanceler (battle_script_commands.c:1153-1173) on
//    FLAG_MAGIC_COAT_AFFECTED.
//  - Ghost Curse: BattleScript_DoGhostCurse (battle_scripts_1.s:4972-4980) has
//    no substitute jump and sets HITMARKER_IGNORE_SUBSTITUTE; Cmd_cursetarget
//    only checks the cursed status. No change was needed, so this pins it.
//
// The scaffolding (fixtures, playTurn, forceMove, moveId) is cycle 946b's; the
// Shed Tail / pivot fixtures are cycle 945b's and 947's. Every substitute is
// created by actually using MOVE_SUBSTITUTE through a real turn, never by
// setting the status bit.
import { describe, expect, it } from 'vitest'

import {
  PARTY_SIZE,
  STATUS1_PARALYSIS,
  STATUS1_POISON_ANY,
  STATUS1_SLEEP,
  STATUS2_CURSED,
  STATUS2_SUBSTITUTE,
  STATUS3_LEECHSEED,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, buildMoveAction, createSession, stepTurn } from './driver/session'
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
 * the party mon), the shape a fixture needs for HP/stat overrides. */
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
 * force it through `stepTurn`: a status that stays unchanged there is the
 * handler's own refusal, not a policy skip. */
function forceMove(s: BattleSession, id: string): void {
  beginTurn(s)
  const choice = legalChoices(s).find((c) => moveId(c) === id)
  expect(choice, `${id} must be a legal choice`).toBeDefined()
  s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
  stepTurn(s, choice!.action)
}

/** Make battler 1 actually use MOVE_SUBSTITUTE in a turn. The foe's moveset
 * must carry it so the PP deduction has a slot. */
function targetSubstitutes(s: BattleSession): void {
  beginTurn(s)
  stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_SUBSTITUTE'))
  expect(s.state.battlers[1]!.mon.status2 & STATUS2_SUBSTITUTE).toBe(STATUS2_SUBSTITUTE)
}

/** Snorlax is Normal (poisonable, not Fire, not Ground) and carries the moves
 * under test plus Body Slam, the damaging fallback. */
const playerOne = (moves: string[], ability?: string): PlayerMonSpec[] => [
  { species: 'SPECIES_SNORLAX', level: 50, moves, ...(ability ? { ability } : {}) },
]

/** The foe never damages us, so the staller's rule 1 is never skipped for a KO
 * threat; `moves` may also carry MOVE_SUBSTITUTE for the substitute fixtures. */
const idle = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData =>
  mon(species, moves, overrides)

const SUB_FOE_MOVES = ['MOVE_SUBSTITUTE', 'MOVE_CELEBRATE']

describe('cycle 946f - Substitute gates the status pick', () => {
  it('does not pick Thunder Wave or Will-O-Wisp behind a Substitute, and the handlers agree', () => {
    // Will-O-Wisp's script runs `jumpifsubstituteblocks` before anything else
    // (battle_scripts_1.s:6094); Thunder Wave's paralysis reaches
    // SetMoveEffect, whose DoesSubstituteBlockMove return (battle_script_commands.c:2388)
    // stops it. Machamp is neither Ground nor Electric nor Fire, so type immunity
    // is not what keeps status1 at 0.
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', SUB_FOE_MOVES),
    ])
    targetSubstitutes(s)

    const choice = chooseRoleAction(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_THUNDER_WAVE')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)

    // The substitute survived the blocked move, so Will-O-Wisp is still gated.
    expect(s.state.battlers[1]!.mon.status2 & STATUS2_SUBSTITUTE).toBe(STATUS2_SUBSTITUTE)
    forceMove(s, 'MOVE_WILL_O_WISP')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
  })

  it('does not pick Toxic or Spore behind a Substitute, and the handlers agree', () => {
    const toxicSession = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', SUB_FOE_MOVES),
    ])
    targetSubstitutes(toxicSession)
    expect(moveId(chooseRoleAction(toxicSession, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
    forceMove(toxicSession, 'MOVE_TOXIC')
    expect(toxicSession.state.battlers[1]!.mon.status1).toBe(0)

    const sleepSession = session(playerOne(['MOVE_SPORE', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', SUB_FOE_MOVES),
    ])
    targetSubstitutes(sleepSession)
    expect(moveId(chooseRoleAction(sleepSession, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
    forceMove(sleepSession, 'MOVE_SPORE')
    expect(sleepSession.state.battlers[1]!.mon.status1 & STATUS1_SLEEP).toBe(0)
  })

  it('an Infiltrator user still statusses a target behind a Substitute', () => {
    // Infiltrates(battlerAtk, move, moveType, INFILTRATE_SUBSTITUTE)
    // (battle_script_commands.c:12246-12250) makes DoesSubstituteBlockMove
    // return false, which both the policy and handleParalyze read.
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_INFILTRATOR'), [
      idle('SPECIES_MACHAMP', SUB_FOE_MOVES),
    ])
    targetSubstitutes(s)

    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_THUNDER_WAVE')
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
  })
})

describe('cycle 946f - Magic Bounce gates the status pick', () => {
  it('does not pick Toxic into Magic Bounce, and the bounce poisons the user', () => {
    // Cmd_attackcanceler bounces a FLAG_MAGIC_COAT_AFFECTED move back onto the
    // attacker (battle_script_commands.c:1153-1173); turn.ts:2849-2869 runs it.
    const s = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', ['MOVE_CELEBRATE'], { ability: 'ABILITY_MAGIC_BOUNCE' }),
    ])

    const choice = chooseRoleAction(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')

    forceMove(s, 'MOVE_TOXIC')
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect(s.state.battlers[0]!.mon.status1 & STATUS1_POISON_ANY).not.toBe(0)
  })

  it('a Mold Breaker user picks Toxic into Magic Bounce and it lands', () => {
    // battlerHasSimAbility suppresses the target's ability when the attacker has
    // Mold Breaker (turn.ts:2861 attaches attackerHasMoldBreakerActive), so both
    // the policy's gate and the bounce skip it.
    const s = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_MACHAMP', ['MOVE_CELEBRATE'], { ability: 'ABILITY_MAGIC_BOUNCE' }),
    ])
    // Toxic still has to pass its accuracy roll; Machamp's innate No Guard
    // makes Toxic's 90% ALWAYS_HITS anyway, but pin the roll so the assertion
    // cannot read as a miss.
    s.state.rng = { random16: () => 0 }

    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_TOXIC')
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_POISON_ANY).not.toBe(0)
  })
})

describe('cycle 946f - Leech Seed picks respect the same gates', () => {
  it('seeds a clean target', () => {
    const s = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_LEECH_SEED')
    expect(s.state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(STATUS3_LEECHSEED)
  })

  it('does not pick Leech Seed behind a Substitute, and the handler agrees', () => {
    // battle_scripts_1.s:4584 jumpifsubstituteblocks; handleLeechSeed runs the
    // same predicate (moveEffects.ts:2889).
    const s = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', SUB_FOE_MOVES),
    ])
    targetSubstitutes(s)
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
    forceMove(s, 'MOVE_LEECH_SEED')
    expect(s.state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(0)
  })

  it('does not pick Leech Seed into Magic Bounce; forced, the target stays unseeded', () => {
    // MOVE_LEECH_SEED carries magicCoatAffected in moves.json, so the bounce
    // sends the seed back to the user instead.
    const s = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_MACHAMP', ['MOVE_CELEBRATE'], { ability: 'ABILITY_MAGIC_BOUNCE' }),
    ])
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
    forceMove(s, 'MOVE_LEECH_SEED')
    expect(s.state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(0)
  })
})

describe('cycle 946f - Ghost Curse ignores a Substitute', () => {
  it('a Ghost user still picks Curse and the target ends up cursed', () => {
    // BattleScript_DoGhostCurse (battle_scripts_1.s:4972-4980) has no
    // jumpifsubstituteblocks and sets HITMARKER_IGNORE_SUBSTITUTE; Cmd_cursetarget
    // (battle_script_commands.c:11103-11113) only checks STATUS2_CURSED.
    const s = session(
      [{ species: 'SPECIES_GENGAR', level: 50, moves: ['MOVE_CURSE', 'MOVE_SHADOW_BALL'] }],
      [idle('SPECIES_MACHAMP', SUB_FOE_MOVES)],
    )
    targetSubstitutes(s)

    const choice = playTurn(s, 'staller', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CURSE')
    expect(s.state.battlers[1]!.mon.status2 & STATUS2_CURSED).toBe(STATUS2_CURSED)
  })
})

describe('cycle 946f - support pivot scan', () => {
  it('takes a working second pivot when the first cannot switch, and the turn switches', () => {
    // pivotMoves is sorted by id, so MOVE_SHED_TAIL precedes MOVE_VOLT_SWITCH.
    // At exactly half HP Shed Tail's Cmd_setsubstitute check fails
    // (battle_script_commands.c:10535-10541); Volt Switch lands on Machamp and
    // its switch really happens. Speeds are patched so we act first.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_SHED_TAIL', 'MOVE_VOLT_SWITCH', 'MOVE_BODY_SLAM'] },
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor(maxHp / 2) })
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    patchMon(s.state, 1, 0, { rawStats: { ...s.state.battlers[1]!.mon.rawStats, spe: 1 } })

    const choice = playTurn(s, 'support', {}, memory())
    expect(moveId(choice)).toBe('MOVE_VOLT_SWITCH')
    expect(choice.switchTo).toBe(1)
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
  })

  it('with only the failing pivot it does not choose a pivot', () => {
    // A live bench slot exists, so the scan runs, but Shed Tail fails its HP
    // gate and there is no second pivot; the support falls through to its
    // attacker fallback rather than re-picking Shed Tail every turn.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_SHED_TAIL', 'MOVE_BODY_SLAM'] },
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])],
    )
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor(maxHp / 2) })

    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
    expect(choice.switchTo).toBeUndefined()
  })
})
