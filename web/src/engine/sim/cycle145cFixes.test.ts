/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { STATUS4_COMMANDED, setFlag } from './constants'
import type { RandomSource, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ReplacementDeps } from './switchIn'
import { buildMoveAction, createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'

// Scaffolding copied from cycle145bAbilities.test.ts / cycle146Abilities.test.ts
// (loadSimData bundle, scripted RNG, fixed damage resolver, trainer fixture).
const data = loadSimData()

function scriptedRng(value = 1): RandomSource & { calls: number } {
  const rng: RandomSource & { calls: number } = {
    calls: 0,
    random16: () => {
      rng.calls++
      return value
    },
  }
  return rng
}

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function foeMon(overrides: Partial<TrainerMonData> = {}): TrainerMonData {
  return {
    species: 'SPECIES_MUDKIP',
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability: 'ABILITY_SWIFT_SWIM',
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves: ['MOVE_TACKLE'],
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
    ...overrides,
  }
}

function trainerWith(lead: TrainerMonData, bench: TrainerMonData[] = []): TrainerData {
  const party = [lead, ...bench]
  return {
    id: 'TRAINER_CYCLE145C',
    trainerNum: 9999,
    name: 'CYCLE',
    gender: 'MALE',
    forcedDouble: false,
    risky: false,
    preferStatus: false,
    preferStall: false,
    noSwitching: false,
    class: 'TRAINER_CLASS_HIKER',
    parties: { ace: party, elite: party, hell: party },
  }
}

/**
 * Player party: slot 0 is the Emergency Exit holder with `blocker` in innate slot 0
 * (GetInnateInSlot, battle_util.c:8799-8802, keeps it at level 50 Elite); slot 1 is a
 * distinct-species reserve so the switch is observable by species, not just a flag.
 */
function holderParty(
  blocker: string | null,
  withReserve: boolean,
  holderAbility: string | null = 'ABILITY_EMERGENCY_EXIT',
): SimPartyMon[] {
  const specs: PlayerMonSpec[] = [
    {
      species: 'SPECIES_MUDKIP',
      level: 50,
      nature: 'NATURE_HARDY',
      ability: holderAbility,
      item: null,
      moves: ['MOVE_TACKLE', null, null, null],
    },
  ]
  if (withReserve) {
    specs.push({
      species: 'SPECIES_PIKACHU',
      level: 50,
      nature: 'NATURE_HARDY',
      ability: null,
      item: null,
      moves: ['MOVE_TACKLE', null, null, null],
    })
  }
  const party = buildPlayerParty(specs, 50, data)
  party[0]!.abilities = { ability: holderAbility, innates: [blocker, null, null] }
  if (withReserve) party[1]!.abilities = { ability: null, innates: [null, null, null] }
  return party
}

/**
 * One turn through the real turn loop: the opponent (battler 1) hits the holder
 * (battler 0) for `maxHp - 1`, so the holder ends at 1 HP: above half before the hit,
 * below half after, and still alive (CheckHalfHpAbility, moveEnd.ts:1194-1199).
 */
function runEmergencyExit(
  blocker: string | null,
  opts: { withReserve?: boolean; commanded?: boolean; holderAbility?: string | null } = {},
) {
  const withReserve = opts.withReserve ?? true
  const session = createSession({
    data,
    playerParty: holderParty(
      blocker,
      withReserve,
      opts.holderAbility === undefined ? 'ABILITY_EMERGENCY_EXIT' : opts.holderAbility,
    ),
    opponentTrainer: trainerWith(foeMon({ moves: ['MOVE_TACKLE'] })),
    rng: scriptedRng(1),
  })
  if (opts.commanded) {
    session.state.battlers[0]!.statuses4 = setFlag(session.state.battlers[0]!.statuses4, STATUS4_COMMANDED)
  }
  const maxHp = session.state.battlers[0]!.mon.maxHp
  const replacement: ReplacementDeps = { chooseReplacement: () => 1 }
  const deps: TurnLoopDeps = { ...session.turnDeps, damage: fixedDamage(maxHp - 1), replacement }
  const action = buildMoveAction(session.state, data, 1, 'MOVE_TACKLE')
  const outcome = executeTurn(session.state, [null, action, null, null], deps)
  return { session, outcome }
}

// ---------------------------------------------------------------------------
// Item 5: Emergency Exit is not blocked by the Roar-path suction-cups abilities
// ---------------------------------------------------------------------------

// BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500) runs
// openpartyscreen / switchoutabilities / switchhandleorder with no
// jumpifabilityflag at all. The Guard Dog / Strong Foundation / Superheavy /
// Suction Cups block lives in BattleScript_EffectRoar (jumpifabilityflag
// BS_TARGET, ABILITY_SUCTION_CUPS, :3761), which the sim mirrors in
// forceRandomSwitch (moveEffects.ts:10900-10920). CanBattlerSwitch
// (src/battle_script_commands.c:5061-5172; sim moveEffects.ts:10277) rejects only
// STATUS4_COMMANDED and the absence of a live reserve.
describe('Cycle 145c - Emergency Exit is not blocked by Roar-only suction-cups abilities', () => {
  for (const blocker of ['ABILITY_GUARD_DOG', 'ABILITY_STRONG_FOUNDATION', 'ABILITY_SUPERHEAVY']) {
    it(`${blocker} as an innate does not stop an Emergency Exit holder switching out`, () => {
      const { session } = runEmergencyExit(blocker)
      // Switch happened: the party-index-1 reserve is now the active battler.
      expect(session.state.battlers[0]!.partyIndex).toBe(1)
      expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_PIKACHU')
      expect(session.state.queuedSwitches).toEqual([])
    })
  }

  it('control: the same hit without Emergency Exit leaves the holder in', () => {
    // Isolates the switch to the ability: same blocker, same reserve, same 1-HP hit.
    const { session } = runEmergencyExit('ABILITY_GUARD_DOG', { holderAbility: null })
    expect(session.state.battlers[0]!.partyIndex).toBe(0)
    expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })

  it('negative: no live reserve means CanBattlerSwitch fails and the holder stays in', () => {
    const { session } = runEmergencyExit('ABILITY_GUARD_DOG', { withReserve: false })
    expect(session.state.battlers[0]!.partyIndex).toBe(0)
    expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(session.state.battlers[0]!.mon.hp).toBe(1)
  })

  it('negative: STATUS4_COMMANDED means CanBattlerSwitch fails and the holder stays in', () => {
    const { session } = runEmergencyExit('ABILITY_STRONG_FOUNDATION', { commanded: true })
    expect(session.state.battlers[0]!.partyIndex).toBe(0)
    expect(session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(session.state.battlers[0]!.mon.hp).toBe(1)
  })
})
