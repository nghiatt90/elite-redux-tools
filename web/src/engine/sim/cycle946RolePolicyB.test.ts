/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946: the solver-v2 role policies' second slice (s20b2) -- the set-up
// sweeper and the staller, replacing cycle 945's `chooseStallerStub`, plus the
// lead/hazard setter's fallback to the real staller (plan decision 14).
//
// The fixtures are built through `createSession` and (where a turn actually
// runs) advanced with `beginTurn`/`stepTurn`, so the gates under test are the
// real state. HP and stat stages are patched on the created session the same
// way cycle 945's test does -- nothing is poked after `executeTurn`. Every
// status/stat expectation below cites the C handler or the data row that fixes
// it; the policy thresholds are MODEL CHOICES (decision 14's defaults).
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ATK,
  STATUS1_BURN,
  STATUS3_LEECHSEED,
} from './constants'
import { aiDamageRolls } from './ai/aiCalcDamage'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { PROTECT_SUCCESS_RATES } from './moveEffects'
import type { RoleMemory, RoleParams, RoleName } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
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

/** One stat stage on the active battler (the C's internal 0..12, 6 neutral). */
function setStage(state: BattleState, side: 0 | 1, stat: number, stage: number): void {
  state.battlers[side]!.mon.statStages[stat] = stage
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

const playerOne = (moves: string[]): PlayerMonSpec[] => [{ species: 'SPECIES_SNORLAX', level: 50, moves }]

// Machamp's Body Slam onto our level-50 Hardy Snorlax: min 39, max 46
// (cycle 945's fixture and the same sim range call). Every threatened/safe
// arithmetic below uses that 46.
const MACHAMP_BODY_SLAM_MAX = 46

describe('cycle 946 - setupSweeper', () => {
  const sweeper = (foeMons: TrainerMonData[], hp?: number, overrides: Partial<TrainerData> = {}): BattleSession => {
    const s = session(playerOne(['MOVE_SWORDS_DANCE', 'MOVE_BODY_SLAM']), foeMons, overrides)
    if (hp !== undefined) patchMon(s.state, 0, 0, { hp })
    return s
  }

  it('uses Swords Dance when safe and below the target stage', () => {
    // BattleScript_EffectAttackUp2 (battle_scripts_1.s:4240-4242) raises Attack
    // by 2. The opponent only Celebrates, so no sample threatens and no party
    // mon can undo the boost.
    const s = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    const trace: PolicyTraceEntry[] = []
    const choice = chooseRoleAction(s, 'setupSweeper', {}, mem, trace)
    expect(moveId(choice)).toBe('MOVE_SWORDS_DANCE')
    expect(trace[0]!.tags).toEqual(['setupSweeper', 'setup'])
  })

  it('attacks when a sample threatens (highest roll > safetyPct of our HP)', () => {
    // HP 80: Machamp's Body Slam max 46 -- 46*100 = 4600 > 50*80 = 4000 -- so
    // the default 50% safety line is crossed and the sweeper attacks.
    const s = sweeper([mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])], 80)
    expect(moveId(chooseRoleAction(s, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('attacks once the Attack stage has reached targetStage', () => {
    // +2 (statStages[STAT_ATK] = 6 + 2) meets the default targetStage 2, so the
    // gate is closed and the sweeper plays as attacker.
    const s = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    setStage(s.state, 0, STAT_ATK, DEFAULT_STAT_STAGE + 2)
    expect(moveId(chooseRoleAction(s, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('attacks when the opposing party holds Haze', () => {
    // MOVE_HAZE = EFFECT_HAZE (data/v2.65beta/moves.json); BattleScript_EffectHaze
    // resets both sides' stages. The reserve's moveset is visible unmasked.
    const withHaze = sweeper([
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_HAZE']),
    ])
    expect(moveId(chooseRoleAction(withHaze, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')

    // Negative control: the same position without the Haze mon boosts.
    const withoutHaze = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    expect(moveId(chooseRoleAction(withoutHaze, 'setupSweeper', {}, memory()))).toBe('MOVE_SWORDS_DANCE')
  })

  it('attacks when the opposing party holds a phazing move', () => {
    // MOVE_ROAR = EFFECT_ROAR and MOVE_DRAGON_TAIL = EFFECT_HIT_SWITCH_TARGET
    // (moves.json), both of which drag the boosted mon out.
    const withRoar = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']), mon('SPECIES_SNORLAX', ['MOVE_ROAR'])])
    expect(moveId(chooseRoleAction(withRoar, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
    const withDragonTail = sweeper([
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
      mon('SPECIES_SNORLAX', ['MOVE_DRAGON_TAIL']),
    ])
    expect(moveId(chooseRoleAction(withDragonTail, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('attacks when an opposing mon has Unaware', () => {
    // ABILITY_UNAWARE has abilityHooks.json bitfields.unaware (IsUnaware,
    // battle_util.c:9006-9009), so the boost would not apply to its damage.
    const s = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'], { ability: 'ABILITY_UNAWARE' })])
    expect(moveId(chooseRoleAction(s, 'setupSweeper', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('targetStage 1 vs 2 decides at +1 Attack', () => {
    // At +1 (statStages[STAT_ATK] = 7) the current stage equals 1: targetStage 1
    // is already met (attack), targetStage 2 is not (boost).
    const atTarget = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    setStage(atTarget.state, 0, STAT_ATK, DEFAULT_STAT_STAGE + 1)
    expect(moveId(chooseRoleAction(atTarget, 'setupSweeper', { targetStage: 1 }, memory()))).toBe('MOVE_BODY_SLAM')

    const belowTarget = sweeper([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    setStage(belowTarget.state, 0, STAT_ATK, DEFAULT_STAT_STAGE + 1)
    expect(moveId(chooseRoleAction(belowTarget, 'setupSweeper', { targetStage: 2 }, memory()))).toBe('MOVE_SWORDS_DANCE')
  })

  it('safetyPct 25 vs 75 crosses at the hand-derived line', () => {
    // Our HP is 80 and Machamp's Body Slam highest roll is derived from the
    // sim's own range (46, MACHAMP_BODY_SLAM_MAX):
    //   safetyPct 25: 46*100 = 4600 > 25*80 = 2000  -> threatened -> attack.
    //   safetyPct 75: 46*100 = 4600 <= 75*80 = 6000 -> safe      -> boost.
    // Neither line KOs us (46 < 80), so this is the safety gate, not koThreat.
    const probe = sweeper([mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])], 80)
    const incoming = aiDamageRolls(probe.state, 'MOVE_BODY_SLAM', 1, 0, aiDamageDepsFor(data, probe.state, probe.inverseBattle))!
    const high = (incoming.totalRolls ?? incoming.rolls)[15]!
    expect(high).toBe(MACHAMP_BODY_SLAM_MAX)
    expect(high * 100).toBeGreaterThan(25 * 80)
    expect(high * 100).toBeLessThanOrEqual(75 * 80)

    const tight = sweeper([mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])], 80)
    expect(moveId(chooseRoleAction(tight, 'setupSweeper', { safetyPct: 25 }, memory()))).toBe('MOVE_BODY_SLAM')
    const loose = sweeper([mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])], 80)
    expect(moveId(chooseRoleAction(loose, 'setupSweeper', { safetyPct: 75 }, memory()))).toBe('MOVE_SWORDS_DANCE')
  })
})

describe('cycle 946 - staller: status', () => {
  it('uses Toxic on a clean target', () => {
    // BattleScript_EffectToxic (battle_scripts_1.s:3957-3970) -> CanBePoisoned
    // (battle_util.c:5042-5050). Machamp is Fighting, so no type immunity.
    const s = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory(), trace))).toBe('MOVE_TOXIC')
    expect(trace[0]!.tags).toEqual(['staller', 'status'])
  })

  it('uses Will-O-Wisp on a non-Fire target and skips a Fire target', () => {
    // BattleScript_EffectWillOWisp (:6090-6103) -> CanBeBurned :5061-5070,
    // which returns false for a Fire-type.
    const vsMachamp = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    expect(moveId(chooseRoleAction(vsMachamp, 'staller', {}, memory()))).toBe('MOVE_WILL_O_WISP')

    const vsCharizard = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_CHARIZARD', ['MOVE_CELEBRATE']),
    ])
    expect(moveId(chooseRoleAction(vsCharizard, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('skips Toxic on a Poison target and does not re-status a statused target', () => {
    // CanBePoisoned's canPoisonType (statusEffects.ts, battle_util.c) refuses
    // Poison and Steel targets; Bite (Dark) hits Ghost Gengar through its Ghost
    // half, so the damaging fallback is Bite rather than the immune Body Slam.
    const vsGengar = session(playerOne(['MOVE_TOXIC', 'MOVE_BITE']), [mon('SPECIES_GENGAR', ['MOVE_CELEBRATE'])])
    expect(moveId(chooseRoleAction(vsGengar, 'staller', {}, memory()))).toBe('MOVE_BITE')

    // CanBePoisoned also fails when status1 is already set (STATUS1_ANY).
    const alreadyBurned = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    patchMon(alreadyBurned.state, 1, 0, { status1: STATUS1_BURN })
    expect(moveId(chooseRoleAction(alreadyBurned, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 946 - staller: heal', () => {
  it('uses Recover below the heal threshold', () => {
    // BattleScript_EffectRestoreHp (battle_scripts_1.s:3940-3955). HP set to 40%
    // of maxHp: 40 < the default 50 -> heal.
    const s = session(playerOne(['MOVE_RECOVER', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory(), trace))).toBe('MOVE_RECOVER')
    expect(trace[0]!.tags).toEqual(['staller', 'heal'])
  })

  it('healThreshold 33 vs 66 at HP 40% of max', () => {
    // hp = floor(maxHp*40/100), so hp*100 is ~40*maxHp:
    //   33: 40 < 33 is false -> no heal -> the damaging fallback.
    //   66: 40 < 66 is true  -> Recover.
    const low = session(playerOne(['MOVE_RECOVER', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const maxHp = low.state.battlers[0]!.mon.maxHp
    patchMon(low.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    expect(moveId(chooseRoleAction(low, 'staller', { healThreshold: 33 }, memory()))).toBe('MOVE_BODY_SLAM')

    const high = session(playerOne(['MOVE_RECOVER', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(high.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    expect(moveId(chooseRoleAction(high, 'staller', { healThreshold: 66 }, memory()))).toBe('MOVE_RECOVER')
  })

  it('uses Wish, then Protect so the Wish lands at the end of the next turn', () => {
    const s = session(playerOne(['MOVE_WISH', 'MOVE_PROTECT']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    const hurt = Math.floor((maxHp * 40) / 100)
    patchMon(s.state, 0, 0, { hp: hurt })
    const mem = memory()

    // Turn 1: wishCounter is 0, so Cmd_trywish case 0 (battle_script_commands.c:
    // 11784-11793) succeeds and sets it to 2; the end-of-turn countdown leaves 1.
    const turn1 = playTurn(s, 'staller', {}, mem)
    expect(moveId(turn1)).toBe('MOVE_WISH')
    expect(mem.lastMove).toBe('MOVE_WISH')
    expect(s.state.field.wishCounter[0]).toBe(1)

    // Turn 2: counter 1 means the Wish lands at the END of this turn
    // (battle_util.c:1946's `--wishCounter == 0`), so Protect now. Script the
    // single Protect success draw low (threshold 65535 >= Random(), :6649-6655;
    // PROTECT_SUCCESS_RATES[0]).
    expect(PROTECT_SUCCESS_RATES[0]).toBe(65535)
    s.state.rng = { random16: () => 0 }
    const turn2 = playTurn(s, 'staller', {}, mem)
    expect(moveId(turn2)).toBe('MOVE_PROTECT')
    expect(s.state.field.wishCounter[0]).toBe(0)
    // The Wish healed half maxHp at end of turn 2, proof it landed.
    expect(s.state.battlers[0]!.mon.hp).toBeGreaterThan(hurt)
  })

  it('does not use Wish while a Wish is already pending', () => {
    // Counter 2: Cmd_trywish fails (11784-11793). No direct recovery and no
    // Protect move, so the staller falls back to the damaging move.
    const s = session(playerOne(['MOVE_WISH', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const maxHp = s.state.battlers[0]!.mon.maxHp
    patchMon(s.state, 0, 0, { hp: Math.floor((maxHp * 40) / 100) })
    s.state.field.wishCounter[0] = 2
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 946 - staller: Protect', () => {
  it('Protects while residual damage ticks on a burned target', () => {
    const s = session(playerOne(['MOVE_PROTECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory(), trace))).toBe('MOVE_PROTECT')
    expect(trace[0]!.tags).toEqual(['staller', 'protect'])
  })

  it('does not Protect twice: memory.lastMove and battlers[0].lastMove block it', () => {
    // ProtectSucceeds (battle_script_commands.c:6649-6655) checks whether the
    // last move was a protection move; usedProtectionLastTurn reads
    // battlers[0].lastMove (falling back to memory.lastMove when null).
    const viaMemory = session(playerOne(['MOVE_PROTECT', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    patchMon(viaMemory.state, 1, 0, { status1: STATUS1_BURN })
    expect(moveId(chooseRoleAction(viaMemory, 'staller', {}, { turn: 1, lastMove: 'MOVE_PROTECT' }))).toBe(
      'MOVE_BODY_SLAM',
    )

    const viaUses = session(playerOne(['MOVE_PROTECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(viaUses.state, 1, 0, { status1: STATUS1_BURN })
    viaUses.state.battlers[0]!.volatiles.protectUses = 1
    viaUses.state.battlers[0]!.lastMove = 'MOVE_BODY_SLAM'
    expect(moveId(chooseRoleAction(viaUses, 'staller', {}, { turn: 1, lastMove: 'MOVE_PROTECT' }))).toBe('MOVE_PROTECT')

    const viaBattlerLastMove = session(playerOne(['MOVE_PROTECT', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    patchMon(viaBattlerLastMove.state, 1, 0, { status1: STATUS1_BURN })
    viaBattlerLastMove.state.battlers[0]!.lastMove = 'MOVE_PROTECT'
    expect(moveId(chooseRoleAction(viaBattlerLastMove, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('does not treat an EFFECT_PROTECT move without the isProtection flag as Protect', () => {
    // MOVE_CRAFTY_SHIELD is EFFECT_PROTECT, target USER, but priority 3 and no
    // `isProtection` flag in data/v2.65beta/moves.json, so isProtectionMove
    // rejects it and the burned-target residual rule cannot fire Protect.
    const s = session(playerOne(['MOVE_CRAFTY_SHIELD', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('uses Leech Seed once on an unseeded, non-Grass target', () => {
    // BattleScript_EffectLeechSeed (battle_scripts_1.s:4579-4590) fails on a
    // Grass target or one already carrying STATUS3_LEECHSEED.
    const s = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'staller', {}, memory(), trace))).toBe('MOVE_LEECH_SEED')
    expect(trace[0]!.tags).toEqual(['staller', 'residual'])

    const seeded = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    seeded.state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED
    expect(moveId(chooseRoleAction(seeded, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const grass = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM']), [mon('SPECIES_VENUSAUR', ['MOVE_CELEBRATE'])])
    expect(moveId(chooseRoleAction(grass, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 946 - leadHazard falls back to the real staller', () => {
  it('lays Stealth Rock then statuses, tagging staller and its own tag', () => {
    const s = session(playerOne(['MOVE_STEALTH_ROCK', 'MOVE_TOXIC', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    const mem = memory()
    const params: RoleParams = { targetLayers: 1, fallbackRole: 'staller' }
    expect(moveId(playTurn(s, 'leadHazard', params, mem))).toBe('MOVE_STEALTH_ROCK')
    expect(s.state.sides[1].statuses & SIDE_STATUS_STEALTH_ROCK).toBe(SIDE_STATUS_STEALTH_ROCK)

    // Turn 2: the layer cap is met, so the fallback staller runs and statuses a
    // clean target. The trace shows role, delegated role and the staller's tag.
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'leadHazard', params, mem, trace))).toBe('MOVE_TOXIC')
    expect(trace[0]!.tags).toEqual(['leadHazard', 'staller', 'status'])
  })
})
