/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20g: the support role's own-boost step does NOT use the setupSweeper's
// shared threatened/safe gate any more. It boosts only when the boost can be
// expected to pass on: check 1 asks whether any predicted move -- or any real
// priority move in the opponent's slots -- can KO us this turn with at least
// BATON_BOOST_KO_RISK (15%), and check 2 clones the turn to prove turn 2 is
// safe (we outspeed with no damaging priority move against us, or the two-hit
// cumulative KO chance is below 15%). Both thresholds are a fixed driver policy
// choice (docs/battle-sim/solver-v2-plan.md decision 14, Yoshi 2026-11-26), not
// genes. Every fixture below is driven through stepTurn via `playTurn`, the
// same scaffolding cycle 20f1 uses; `patchMon` is cycle 947's.
//
// Damage is read from the sim's own `aiDamageRolls` (the engine's 16 rolls plus
// its forced-crit row) and the multiset below mirrors damageResolver.ts
// `resolve` (:299-316): the crit is drawn with probability
// 1/critChanceDenominator (null = never, 1 = always), then one of the 16 rolls;
// Bad Luck/Bad Omen force the minimum; a multi-hit move uses the summed
// totalRolls/totalCritRolls. C: crit before damage,
// data/battle_script_commands.c:1568-1594.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { calcKoChances } from '../kochance'
import type { AiDamageRolls } from './ai/aiCalcDamage'
import { aiDamageRolls } from './ai/aiCalcDamage'
import { DEFAULT_STAT_STAGE, PARTY_SIZE, STAT_SPEED, STATUS1_POISON } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildFightSetup, gameSeed, playComparisonGame, type PolicyComparisonFixture } from './driver/policyComparison'
import { predictAi } from './driver/policyInputs'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction, readPredictions } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, cloneSession, createSession, stepTurn } from './driver/session'
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
 * the party mon), the shape a fixture needs for HP/stat/status overrides
 * (cycle 947's helper). */
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

/** The support under test: a boost move, Baton Pass, a damaging fallback and a
 * live bench slot to pass into. */
const supportTeam = (moves: string[], species = 'SPECIES_SNORLAX'): PlayerMonSpec[] => [
  { species, level: 50, moves },
  { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
]
// Calm Mind = EFFECT_CALM_MIND -> Sp. Atk/Sp. Def +1 (battle_scripts_1.s:6739-6763);
// Baton Pass = EFFECT_BATON_PASS; Body Slam = EFFECT_PARALYZE_HIT, 85 BP.
const CALM_MIND_TEAM = ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM']
// Agility = EFFECT_SPEED_UP_2 -> Speed +2 (moveEffects.ts:11321); Swords Dance =
// EFFECT_ATTACK_UP_2 -> Attack +2.
const AGILITY_TEAM = ['MOVE_AGILITY', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM']
const SWORDS_DANCE_TEAM = ['MOVE_SWORDS_DANCE', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM']

/** The sim's equiprobable damage multiset for one move, the shape calcKoChances
 * takes. Mirrors damageResolver.ts `resolve` (:299-316) -- see the file header. */
function koMultiset(range: AiDamageRolls): number[] {
  if (range.isImmune) return [0]
  const nonRolls = range.totalRolls ?? range.rolls
  const critRolls = range.totalRolls ? range.totalCritRolls : range.critRolls
  const non = range.isForcedMinRoll ? [nonRolls[0]!] : nonRolls
  const crit = critRolls === null ? null : range.isForcedMinRoll ? [critRolls[0]!] : critRolls
  const denominator = range.critChanceDenominator
  if (denominator === null || crit === null) return [...non]
  if (denominator === 1) return [...crit]
  const multiset: number[] = []
  for (let i = 0; i < denominator - 1; i++) multiset.push(...non)
  multiset.push(...crit)
  return multiset
}

function koChance(range: AiDamageRolls, hp: number): number {
  if (hp <= 0) return 1
  return calcKoChances(koMultiset(range), hp, 1)[0]?.probability ?? 0
}

function attackRange(s: BattleSession, moveId: string): AiDamageRolls {
  return aiDamageRolls(s.state, moveId, 1, 0, aiDamageDepsFor(data, s.state, s.inverseBattle))!
}

// Machamp's Body Slam onto our level-50, 0-EV Hardy Snorlax: the engine's 16
// non-crit rolls are 39..46 and the forced-crit row is 86..102, with a 1/24
// crit denominator (moves.json: 85 BP, EFFECT_PARALYZE_HIT).
const BODY_SLAM_ROLLS = [39, 39, 40, 40, 40, 41, 41, 42, 42, 43, 43, 44, 44, 45, 45, 46]
const BODY_SLAM_CRITS = [86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 102]

describe('cycle s20g - support Baton Pass own-boost gate: check 1 (this turn)', () => {
  it('1. boosts when the opponent\'s best move cannot KO and we are faster', () => {
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    // Fast enough that check 2's speed clause holds (50 -> 200 raw Speed).
    patchMon(s.state, 0, 0, { hp: 90 })
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const incoming = attackRange(s, 'MOVE_BODY_SLAM')
    expect(incoming.rolls).toEqual(BODY_SLAM_ROLLS)
    expect(incoming.critRolls).toEqual(BODY_SLAM_CRITS)
    expect(incoming.critChanceDenominator).toBe(24)
    // 23 non-crit copies of each roll + one crit row = 384 equiprobable values.
    // At 90 HP only the crit row reaches it: 12 of the 16 crit values (90..102,
    // with 101 absent) = 12/384 = 3.125% < 15%.
    expect(koMultiset(incoming)).toHaveLength(384)
    expect(koChance(incoming, 90)).toBeCloseTo(12 / 384, 12)
    // The OLD gate: Body Slam's 46 max roll is more than 50% of 90 HP
    // (46 * 100 = 4600 > 50 * 90 = 4500), so `view.threatened` was true.
    expect(readPredictions(s, 50).threatened).toBe(true)
    const choice = playTurn(s, 'support', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CALM_MIND')
  })

  it('2. refused at the 15% boundary and allowed at the nearest HP below it', () => {
    // Rolls that reach 45 HP: the two 45s (2 copies per 16 rolls x 23 = 46) +
    // the 46 (23) + the whole crit row (16) = 85/384 = 22.14% >= 15%. At 46 HP
    // only the 46 (23) and the crit row (16) reach it: 39/384 = 10.16% < 15%.
    // So 45 refuses and 46 (the next point up) allows.
    const refused = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(refused.state, 0, 0, { hp: 45 })
    patchMon(refused.state, 0, 0, { rawStats: { ...refused.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const at45 = attackRange(refused, 'MOVE_BODY_SLAM')
    expect(koChance(at45, 45)).toBeCloseTo(85 / 384, 12)
    expect(koChance(at45, 45)).toBeGreaterThanOrEqual(0.15)
    expect(moveId(playTurn(refused, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')

    const allowed = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(allowed.state, 0, 0, { hp: 46 })
    patchMon(allowed.state, 0, 0, { rawStats: { ...allowed.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const at46 = attackRange(allowed, 'MOVE_BODY_SLAM')
    expect(koChance(at46, 46)).toBeCloseTo(39 / 384, 12)
    expect(koChance(at46, 46)).toBeLessThan(0.15)
    expect(readPredictions(allowed, 50).threatened).toBe(true)
    expect(moveId(playTurn(allowed, 'support', {}, memory()))).toBe('MOVE_CALM_MIND')
  })

  it('3. refused when a priority move KOes with at least 15%, even when the AI predicts another move', () => {
    // (a) The predicted move is itself the priority move. Extreme Speed (80 BP,
    // priority 2, moves.json) onto Snorlax: 36..43 non-crit, 81..96 crit, 1/24.
    // At 42 HP, 85 of 384 rolls reach it = 22.14% >= 15%.
    const direct = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_EXTREME_SPEED'])])
    patchMon(direct.state, 0, 0, { hp: 42 })
    const es = attackRange(direct, 'MOVE_EXTREME_SPEED')
    expect(es.rolls).toEqual([36, 36, 37, 37, 38, 38, 39, 39, 39, 40, 40, 41, 41, 42, 42, 43])
    expect(es.critRolls).toEqual([81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96])
    expect(koChance(es, 42)).toBeCloseTo(85 / 384, 12)
    expect(predictAi(direct, 3, 0).every((sample) => sample.action?.chosenMove?.id === 'MOVE_EXTREME_SPEED')).toBe(true)
    expect(moveId(playTurn(direct, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')

    // (b) The AI predicts Extreme Speed, but the priority move that crosses 15%
    // is Bullet Punch (40 BP, priority 1), which no sample uses. On Clefable
    // (Fairy) Bullet Punch is 2x: 40..48 non-crit, 61..72 crit, 1/8. At 48 HP
    // Bullet Punch reaches it with its single 48 (7 copies at the 1/8 crit
    // denominator) plus the whole crit row (16) = 23/128 = 17.97%, while
    // Extreme Speed at 48 is its crit row alone (16/384 = 4.17%), so the
    // sample is safe and only the priority scan refuses.
    const indirect = session(supportTeam(['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_MOONBLAST'], 'SPECIES_CLEFABLE'), [
      mon('SPECIES_MACHAMP', ['MOVE_EXTREME_SPEED', 'MOVE_BULLET_PUNCH']),
    ])
    patchMon(indirect.state, 0, 0, { hp: 48 })
    const es2 = attackRange(indirect, 'MOVE_EXTREME_SPEED')
    const bp = attackRange(indirect, 'MOVE_BULLET_PUNCH')
    expect(bp.rolls).toEqual([40, 41, 41, 42, 42, 43, 43, 44, 44, 45, 45, 46, 46, 47, 47, 48])
    expect(bp.critChanceDenominator).toBe(8)
    expect(koChance(es2, 48)).toBeCloseTo(16 / 384, 12)
    expect(koChance(es2, 48)).toBeLessThan(0.15)
    expect(koChance(bp, 48)).toBeCloseTo(23 / 128, 12)
    expect(koChance(bp, 48)).toBeGreaterThanOrEqual(0.15)
    const predictions = predictAi(indirect, 3, 0)
    expect(predictions.every((sample) => sample.action?.chosenMove?.id === 'MOVE_EXTREME_SPEED')).toBe(true)
    expect(moveId(playTurn(indirect, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')
  })
})

describe('cycle s20g - support Baton Pass own-boost gate: check 2 (the turn-2 clone)', () => {
  it('4. a slower mon that survives one hit but not two is refused; higher HP allows', () => {
    // Snorlax (Speed 50) is slower than Machamp (75), so check 2 (a) fails and
    // the two-hit clause decides. The probe's hpAfter is live HP - v + the 14 HP
    // Self-Sufficient heal, so the two hits must reach live HP + 14. At 46 HP
    // that is 60, which two Body Slams (minimum 39 each) always reach; at 91 HP
    // it is 105, above two non-crit maxima (46 + 46 = 92), so only a crit on
    // either hit gets there: 1 - (23/24)^2 = 8.16% < 15%.
    const refused = session(supportTeam(SWORDS_DANCE_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(refused.state, 0, 0, { hp: 46 })
    const one = attackRange(refused, 'MOVE_BODY_SLAM')
    expect(one.rolls).toEqual(BODY_SLAM_ROLLS)
    expect(one.critRolls).toEqual(BODY_SLAM_CRITS)
    expect(koChance(one, 46)).toBeCloseTo(39 / 384, 12)
    expect(koChance(one, 46)).toBeLessThan(0.15)
    // The probe's hpAfter is live HP - 45 + 14: Snorlax's Self-Sufficient
    // innate heals maxHp / 16 = 14 at end of turn 1 (endTurn.ts:1183-1195,
    // abilities.cc:4041-4054), so the two hits must reach 46 + 14 = 60.
    expect(twoHitChance(one, one, 46 + 14)).toBeCloseTo(1, 12)
    expect(moveId(playTurn(refused, 'support', {}, memory()))).not.toBe('MOVE_SWORDS_DANCE')

    const allowed = session(supportTeam(SWORDS_DANCE_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(allowed.state, 0, 0, { hp: 91 })
    const oneAt91 = attackRange(allowed, 'MOVE_BODY_SLAM')
    expect(koChance(oneAt91, 91)).toBeCloseTo(11 / 384, 12)
    // Probe hpAfter = 91 - 45 + 14 = 60, so turn 2 must remove 60 + 45 - a =
    // 105 - a. Two non-crit Body Slams top out at 92, so the two-hit KO happens
    // exactly when either hit crits: 1 - (23/24)^2 = 47/576 = 8.16% < 15%.
    expect(twoHitChance(oneAt91, oneAt91, 91 + 14)).toBeCloseTo(1 - (23 / 24) ** 2, 12)
    expect(twoHitChance(oneAt91, oneAt91, 91 + 14)).toBeLessThan(0.15)
    expect(readPredictions(allowed, 50).threatened).toBe(true)
    expect(moveId(playTurn(allowed, 'support', {}, memory()))).toBe('MOVE_SWORDS_DANCE')
  })

  it('5. the same mon at the same HP boosts when turn 1 flips the speed order', () => {
    // Agility is a guaranteed Speed +2 on turn 1 (EFFECT_SPEED_UP_2,
    // moveEffects.ts:11321), so at the same 46 HP where the Swords Dance fixture
    // above is refused, Snorlax's 50 becomes 100 and outspeeds Machamp's 75 on
    // turn 2: check 2 (a) holds. The control keeps Agility but patches the
    // opponent to 200 Speed so the +2 cannot flip the order and check 2 falls
    // back to the certain two-hit KO.
    const allowed = session(supportTeam(AGILITY_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(allowed.state, 0, 0, { hp: 46 })
    expect(readPredictions(allowed, 50).threatened).toBe(true)
    expect(moveId(playTurn(allowed, 'support', {}, memory()))).toBe('MOVE_AGILITY')

    const control = session(supportTeam(AGILITY_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(control.state, 0, 0, { hp: 46 })
    patchMon(control.state, 1, 0, { rawStats: { ...control.state.battlers[1]!.mon.rawStats, spe: 200 } })
    expect(moveId(playTurn(control, 'support', {}, memory()))).not.toBe('MOVE_AGILITY')
  })

  it('6. chip damage flips an allowed boost to refused', () => {
    // At 91 HP the two-hit chance is 8.16% (only a crit; see test 4), so Swords
    // Dance is allowed. Poison
    // ticks maxHp / 8 = 29 at end of turn (endTurn.ts:2510-2511,
    // battle_util.c:2510-2511) and Snorlax's Self-Sufficient innate heals
    // maxHp / 16 = 14 (endTurn.ts:1183-1195, abilities.cc:4041-4054), a net 15
    // chip. The probe's forced 45 leaves hpAfter = 91 - 45 - 15 = 31, so the
    // turn-2 hit only has to remove 31 + 45 - a = 76 - a: every turn-1 roll a in
    // 39..46 leaves that at <= 37, below Body Slam's minimum 39, so the two-hit
    // chance becomes 1.0 and the boost is refused.
    const control = session(supportTeam(SWORDS_DANCE_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(control.state, 0, 0, { hp: 91 })
    expect(moveId(playTurn(control, 'support', {}, memory()))).toBe('MOVE_SWORDS_DANCE')

    const chipped = session(supportTeam(SWORDS_DANCE_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(chipped.state, 0, 0, { hp: 91, status1: STATUS1_POISON })
    expect(moveId(playTurn(chipped, 'support', {}, memory()))).not.toBe('MOVE_SWORDS_DANCE')
  })

  it('7. an opponent Speed Boost at end of turn 1 flips the decision; another ability does not', () => {
    // Our Snorlax is patched to 75 Speed, Machamp to 60, so we act first on
    // turn 1 and would outspeed on turn 2 (check 2 (a)). ABILITY_SPEED_BOOST
    // raises the opponent's Speed by 1 at end of turn 1 (endTurn.ts:1065-1085,
    // abilities.cc:515-524, skipped only on the switch-in turn): 60 becomes 90
    // and (a) fails, while the two-hit KO at 46 HP is certain. Guts is the
    // control.
    const boost = session(supportTeam(SWORDS_DANCE_TEAM), [
      mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'], { ability: 'ABILITY_SPEED_BOOST' }),
    ])
    patchMon(boost.state, 0, 0, { hp: 46 })
    patchMon(boost.state, 0, 0, { rawStats: { ...boost.state.battlers[0]!.mon.rawStats, spe: 75 } })
    patchMon(boost.state, 1, 0, { rawStats: { ...boost.state.battlers[1]!.mon.rawStats, spe: 60 } })
    const refused = playTurn(boost, 'support', {}, memory())
    expect(moveId(refused)).not.toBe('MOVE_SWORDS_DANCE')
    expect(boost.state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)

    const control = session(supportTeam(SWORDS_DANCE_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(control.state, 0, 0, { hp: 46 })
    patchMon(control.state, 0, 0, { rawStats: { ...control.state.battlers[0]!.mon.rawStats, spe: 75 } })
    patchMon(control.state, 1, 0, { rawStats: { ...control.state.battlers[1]!.mon.rawStats, spe: 60 } })
    expect(moveId(playTurn(control, 'support', {}, memory()))).toBe('MOVE_SWORDS_DANCE')
  })

  it('8. a SWITCH sample is safe and does not block the boost', () => {
    // Gengar is immune to Body Slam (Normal) and Mach Punch (Fighting), so the
    // ported AI's own "all bad moves" switch check sends Machamp to its bench
    // (noSwitching: false is irrelevant to ShouldSwitch -- see aiShouldSwitch.ts
    // :602-624, the flag reads battleTypeFlags, not aiFlags -- but the record
    // asks for it, and the fixture really does switch). Check 1 skips SWITCH
    // samples; check 2 runs once for the switch action, writes the switch slot
    // and then sees the bench Snorlax slower than Gengar on turn 2.
    const s = session(
      supportTeam(['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_SHADOW_BALL'], 'SPECIES_GENGAR'),
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM', 'MOVE_MACH_PUNCH']), mon('SPECIES_SNORLAX', ['MOVE_SHADOW_BALL'])],
      { noSwitching: false },
    )
    const predictions = predictAi(s, 3, 0)
    expect(predictions.map((sample) => sample.action?.action)).toEqual(['SWITCH', 'SWITCH', 'SWITCH'])
    expect(predictions.map((sample) => sample.switchSlot)).toEqual([1, 1, 1])
    expect(moveId(playTurn(s, 'support', {}, memory()))).toBe('MOVE_CALM_MIND')
  })
})

describe('cycle s20g - the check does not touch the live session', () => {
  it('9. HP, stat stages, the rest of the state and the RNG stream are unchanged', () => {
    const build = (): BattleSession => {
      const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
      patchMon(s.state, 0, 0, { hp: 46 })
      patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
      beginTurn(s)
      return s
    }
    const snapshot = (state: BattleState): string => {
      const { rng, ...rest } = state
      void rng
      return JSON.stringify(structuredClone(rest))
    }
    const checked = build()
    // Read the state once first: GetIllusionMonPtr lazily arms illusion.set on
    // the FIRST read (battle_util.c:8281-8292, bridge.ts:547) and the policy's
    // own readPredictions does the same, so warm that one-time flag before the
    // snapshot. Nothing below it may move.
    chooseRoleAction(checked, 'support', {}, memory())
    const before = snapshot(checked.state)
    const decision = chooseRoleAction(checked, 'support', {}, memory())
    expect(moveId(decision)).toBe('MOVE_CALM_MIND')
    expect(snapshot(checked.state)).toBe(before)

    // The RNG stream is untouched: an identically built session that never ran
    // the policy yields the same next draws.
    const untouched = build()
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < 8; i++) {
      a.push(checked.state.rng.random16())
      b.push(untouched.state.rng.random16())
    }
    expect(a).toEqual(b)
  })

  it('10. hit 1 is forced to v, not to the maximum roll', () => {
    // At 46 HP with 200 Speed the rule boosts: v = sorted[n - k] with n = 384
    // and k = floor(0.15 * 384) + 1 = 58, so v = sorted[326] = 45 (the highest
    // value with more than 15% chance of being met or exceeded). The probe
    // survives at 1 HP and outspeeds on turn 2. Forcing the MAXIMUM roll (102)
    // instead would faint battler 0 and make the probe unsafe, which is a
    // different decision -- so v is not interchangeable with the max roll.
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(s.state, 0, 0, { hp: 46 })
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const range = attackRange(s, 'MOVE_BODY_SLAM')
    const sorted = [...koMultiset(range)].sort((x, y) => x - y)
    const v = sorted[sorted.length - (Math.floor(0.15 * sorted.length) + 1)]!
    expect(sorted).toHaveLength(384)
    expect(v).toBe(45)
    expect(sorted[sorted.length - 1]).toBe(102)
    expect(v).toBeLessThan(sorted[sorted.length - 1]!)

    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).toBe('MOVE_CALM_MIND')

    const probe = cloneSession(s, 0)
    const original = probe.turnDeps.damage
    let forced = false
    probe.turnDeps = {
      ...probe.turnDeps,
      damage: {
        ...original,
        resolve(state, attackerId, targetId, action, context) {
          const resolution = original.resolve(state, attackerId, targetId, action, context)
          if (attackerId === 1 && targetId === 0 && resolution.targetDamage !== null && resolution.targetDamage > 0) {
            const targetDamage = forced ? 0 : 102
            forced = true
            return { ...resolution, targetDamage }
          }
          return resolution
        },
      },
    }
    probe.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
    stepTurn(probe, choice.action, predictAi(s, 3, 0)[0]!.action)
    // The forced maximum faints our mon; the turn's replacement brings the
    // bench mon in, so the live party index no longer matches (check 2's step 5).
    expect(probe.state.sides[0].party[0]!.hp).toBe(0)
    expect(probe.state.battlers[0]!.partyIndex).not.toBe(0)
  })
})

/** P(two independent hits, each drawn from `first`/`second`, total `hp`). The
 * rule's own two-hit clause uses hpAfter + v - a; when hpAfter is the probe's
 * HP after the forced v and any end-of-turn heal or chip, that reduces to
 * `liveHp + heal - chip - a`, so callers pass the effective total the two hits
 * must reach (e.g. 91 + 14 for Snorlax's uncancelled Self-Sufficient heal). */
function twoHitChance(first: AiDamageRolls, second: AiDamageRolls, hp: number): number {
  const a = koMultiset(first)
  const b = koMultiset(second)
  let total = 0
  for (const hit1 of a) total += hit1 >= hp ? 1 : koChanceMultiset(b, hp - hit1)
  return total / a.length
}

function koChanceMultiset(multiset: number[], hp: number): number {
  if (hp <= 0) return 1
  return calcKoChances(multiset, hp, 1)[0]?.probability ?? 0
}

// --- smoke: 3 role games on the Sidney and Drake fixtures --------------------
// Run with SIM_SMOKE=1. Writes no files; it prints the support 'setup' trace
// lines and the per-game boosting `used` counter so a reviewer can eyeball that
// the new gate still fires in real fights. Never run the 80-game measurement.
const FIXTURE_PATH = resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json')
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PolicyComparisonFixture

describe.skipIf(process.env.SIM_SMOKE !== '1')('cycle s20g smoke - Sidney and Drake, 3 role games each', () => {
  for (const trainer of ['TRAINER_SIDNEY', 'TRAINER_DRAKE']) {
    it(`${trainer}: prints support setup traces and used counts`, () => {
      const fight = fixture.fights.find((entry) => entry.trainer === trainer)
      expect(fight, `${trainer} fixture`).toBeDefined()
      const setup = buildFightSetup(data, fight!)
      for (let game = 1; game <= 3; game++) {
        const record = playComparisonGame(setup, 'role', gameSeed(0, game), { collectLog: true })
        const setupLines = (record.log ?? '')
          .split('\n')
          .filter((line) => line.includes('support:setup'))
        console.log(
          `${trainer} game ${game}: outcome=${record.outcome} turns=${record.turns} used=${record.used} boosted=${record.boosted} setupLines=${setupLines.length}`,
        )
        for (const line of setupLines) console.log(`  ${line.trim()}`)
      }
    })
  }
})
