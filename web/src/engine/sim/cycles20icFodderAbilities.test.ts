/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, PARTY_SIZE, STAT_DEF, WEATHER_FOG_PERMANENT } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { highestRoll, rangeOnOurReserve, readPredictions, stateWithReserve } from './driver/rolePolicy'
import type { PredictionView } from './driver/rolePolicy'
import { beginTurn, cloneSession, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import {
  createTeamLayer,
  FODDER_ABILITY_GAPS,
  FODDER_ABILITY_SEEDS,
  fodderAbilityTriggers,
  isStrictlyLessUseful,
  monUsefulness,
  ON_ABSORB_ABILITIES,
  ON_DISGUISE_ABILITIES,
  ON_REVIVE_ABILITIES,
} from './driver/teamLayer'
import { ON_DEFENDER_ABILITIES } from './moveEnd'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

const data = loadSimData()

// ---------------------------------------------------------------------------
// Scaffolding, copied from cycles20ibFodder.test.ts
// ---------------------------------------------------------------------------

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
  seed = 1,
  playerReplacement?: (state: BattleState, battlerId: number) => number,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(seed),
    ...(playerReplacement ? { playerReplacement } : {}),
  })
}

function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

const OUR_SNORLAX: PlayerMonSpec = { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] }
const OUR_DONPHAN: PlayerMonSpec = { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_TACKLE'] }
const MACHAMP_BODY_SLAM = ['MOVE_BODY_SLAM']

/** The ability object a patched bench mon carries. Innates are nulled so only
 * the slot under test differs between the compared bench mons. */
const abilitySlots = (ability: string | null, innates: (string | null)[] = [null, null, null]) => ({
  ability,
  innates,
})

interface FodderFixture {
  layer: ReturnType<typeof createTeamLayer>
  s: BattleSession
}

/** Snorlax (active, 20 HP, doomed) + Aggron (an unsafe good counter, excluded
 * from the fodder pool) + two Donphan bench fodder mons. Aggron's move decides
 * whether it threatens the foe: Iron Head for a non-Fire foe, Rock Slide for a
 * Fire one (Steel is 0.5x on Fire). */
function fodderFixture(foeMons: TrainerMonData[], aggronMoves: string[] = ['MOVE_IRON_HEAD']): FodderFixture {
  const layer = createTeamLayer({
    roles: ['attacker', 'setupSweeper', 'attacker', 'attacker'],
    genes: { switchInSafety: 3 },
  })
  const s = session(
    [OUR_SNORLAX, { species: 'SPECIES_AGGRON', level: 50, moves: aggronMoves }, OUR_DONPHAN, OUR_DONPHAN],
    foeMons,
    1,
    layer.replacement,
  )
  // Foe at 150 HP so Aggron's Iron Head is a good counter (2 * 78 >= 150).
  patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
  // Active Snorlax at 20 HP: Body Slam is a KO threat and Snorlax cannot KO them.
  patchMon(s.state, 0, 0, { hp: 20 })
  return { layer, s }
}

function fodderChoice(fixture: FodderFixture): { tags: string[]; choice: PlayerChoice } {
  const trace: PolicyTraceEntry[] = []
  const choice = fixture.layer.policy(fixture.s, 1, trace)
  return { tags: trace[0]!.tags, choice: choice! }
}

// ---------------------------------------------------------------------------
// The ability exception
// ---------------------------------------------------------------------------

describe('cycle s20ic - team layer fodder: the ability exception', () => {
  it('case 1: Flame Body is chosen over an equally useful mon in the higher slot and over a less useful one', () => {
    // Flame Body, src/abilities.cc:1126-1134:
    //   CHECK(ShouldApplyOnHitEffect(opponent))  -- the hit dealt damage, attacker alive
    //   CHECK(CanBeBurned(opponent))
    //   chance = IsMoveMakingContact(move, gBattlerAttacker) ? 30 : 20; CHECK(Random() % 100 < chance)
    // Body Slam is a contact physical move (moves.json flags.contact), so the
    // contact roll is 30% per seed; FODDER_ABILITY_SEEDS = 32 makes a firing seed
    // overwhelmingly likely, and the sim loop stops at the first one.
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(s)
    const view = readPredictions(s, 50)
    expect(view.predictedMoveId).toBe('MOVE_BODY_SLAM')
    expect(data.dataContext.move('MOVE_BODY_SLAM')!.flags.contact).toBe(true)

    // Machamp's Body Slam onto Donphan: the sim's own 16 rolls peak at 39 (the
    // same call s20ib uses: rangeOnOurReserve substitutes the reserve at battler
    // 0 and reads aiDamageRolls 1 -> 0). 39 >= 5, so the 5 HP fodder faints,
    // while Flame Body's CHECK(ShouldApplyOnHitEffect(attacker)) -- the ATTACKER
    // is the health gate, not the holder -- still holds.
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 3)!
    expect(highestRoll(incoming)).toBe(39)
    expect(highestRoll(incoming)).toBeGreaterThanOrEqual(5)

    // Equal usefulness: the two Donphan differ only in the ability, which no
    // damage path reads, so the usefulness keys tie and the LOWER slot (2) would
    // win the tie-break alone; the trigger puts slot 3 first.
    const u2 = monUsefulness(s, 2, view)
    const u3 = monUsefulness(s, 3, view)
    expect(u3.capable).toBe(u2.capable)
    expect(u3.damageFraction).toBeCloseTo(u2.damageFraction, 10)

    expect(fodderAbilityTriggers(s, 3, view).usable).toContain('ABILITY_FLAME_BODY')
    expect(fodderAbilityTriggers(s, 2, view).usable).toEqual([])

    const { tags, choice } = fodderChoice({ layer, s })
    expect(tags).toEqual(['team', 'sacrifice'])
    expect(choice.action.action).toBe('SWITCH')
    expect(choiceMoveId(choice)).toBeNull()
    expect(choice.switchTo).toBe(3)
  })

  it('case 1b: the trigger outranks a strictly less useful mon with no trigger', () => {
    // Slot 3's Flame Body Donphan is at 10 HP and slot 2's is at 5 HP: slot 3 is
    // strictly MORE useful, so `compareUsefulness` alone would put slot 2 first.
    // Both are still strictly less useful than the active Snorlax at 20 HP:
    //   active  (20 / 235) * min(1, 69 / 150)    = 0.039149
    //   slot 3  (10 / 165) * min(1, 25.4375/150) = 0.010278
    //   slot 2  ( 5 / 165) * min(1, 25.4375/150) = 0.005139
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 10, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(s)
    const view = readPredictions(s, 50)
    const active = monUsefulness(s, 0, view)
    const u2 = monUsefulness(s, 2, view)
    const u3 = monUsefulness(s, 3, view)
    expect(active.capable).toBe(false)
    expect(active.damageFraction).toBeCloseTo(0.039149, 5)
    expect(u3.damageFraction).toBeCloseTo(0.010278, 5)
    expect(u2.damageFraction).toBeCloseTo(0.005139, 5)
    expect(isStrictlyLessUseful(u2, u3)).toBe(true)
    expect(isStrictlyLessUseful(u3, active)).toBe(true)
    expect(isStrictlyLessUseful(u2, active)).toBe(true)

    const { tags, choice } = fodderChoice({ layer, s })
    expect(tags).toEqual(['team', 'sacrifice'])
    expect(choice.switchTo).toBe(3)
  })

  it('case 2: a Fire-type attacker cannot be burned, so Flame Body is not usable', () => {
    // Body Slam from a Fire-type: canBeBurned returns false for a FIRE holder
    // (src/battle_util.c:5061-5070), and Flame Body needs CanBeBurned. Brick
    // Break is contact (moves.json), so this is not a contact-only shortcut:
    // the burn is impossible for type reasons.
    const { layer, s } = fodderFixture([mon('SPECIES_MAGMAR', ['MOVE_BRICK_BREAK'])], ['MOVE_ROCK_SLIDE'])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(s)
    const view = readPredictions(s, 50)
    expect(view.predictedMoveId).toBe('MOVE_BRICK_BREAK')
    expect(data.dataContext.move('MOVE_BRICK_BREAK')!.flags.contact).toBe(true)
    expect(s.state.battlers[1]!.mon.types).toContain('FIRE')

    expect(fodderAbilityTriggers(s, 3, view).usable).toEqual([])

    const { tags, choice } = fodderChoice({ layer, s })
    expect(tags).toEqual(['team', 'sacrifice'])
    // No trigger, equal usefulness: the lower slot (2, no Flame Body) wins.
    expect(choice.switchTo).toBe(2)
  })

  it('case 3: a contact-only ability fires on a contact move and not on a non-contact one', () => {
    // Rough Skin, src/abilities.cc:784-793:
    //   CHECK(ShouldApplyOnHitEffect(attacker)); CHECK_NOT(IsMagicGuardProtected(attacker));
    //   CHECK(IsMoveMakingContact(move, attacker)); gBattleMoveDamage = maxHP / 8
    // It is onDefender-only and deterministic, so the twin does not rest on a roll.
    const contact = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(contact.s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(contact.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_ROUGH_SKIN') })
    beginTurn(contact.s)
    const contactView = readPredictions(contact.s, 50)
    expect(fodderAbilityTriggers(contact.s, 3, contactView).usable).toContain('ABILITY_ROUGH_SKIN')
    expect(fodderChoice(contact).choice.switchTo).toBe(3)

    // Water Gun is not contact (moves.json has no contact flag), so Rough Skin's
    // CHECK(IsMoveMakingContact) refuses and the run must show no gain.
    const special = fodderFixture([mon('SPECIES_MACHAMP', ['MOVE_WATER_GUN'])])
    patchMon(special.s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(special.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_ROUGH_SKIN') })
    beginTurn(special.s)
    const specialView = readPredictions(special.s, 50)
    expect(specialView.predictedMoveId).toBe('MOVE_WATER_GUN')
    expect(data.dataContext.move('MOVE_WATER_GUN')!.flags.contact).toBeUndefined()
    expect(fodderAbilityTriggers(special.s, 3, specialView).usable).toEqual([])
    expect(fodderChoice(special).choice.switchTo).toBe(2)

    // Flame Body is explicitly NOT contact-only: abilities.cc:1129 is
    // `chance = IsMoveMakingContact(...) ? 30 : 20`, so the same non-contact
    // Water Gun DOES burn at 20% on some seed and Flame Body IS usable here.
    const flameNonContact = fodderFixture([mon('SPECIES_MACHAMP', ['MOVE_WATER_GUN'])])
    patchMon(flameNonContact.s.state, 0, 3, { hp: 165, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(flameNonContact.s)
    const flameNonContactView = readPredictions(flameNonContact.s, 50)
    expect(fodderAbilityTriggers(flameNonContact.s, 3, flameNonContactView).usable).toContain('ABILITY_FLAME_BODY')
  })

  it('case 4: an on-faint ability fires only when the predicted move KOs', () => {
    // Aftermath, src/abilities.cc:1662-1669: CHECK_NOT(IsBattlerAlive(battler)),
    // then UseOutOfTurnAttack(Explosion/Outburst). The sim's own survival decides.
    const doomed = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(doomed.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_AFTERMATH') })
    beginTurn(doomed.s)
    const doomedView = readPredictions(doomed.s, 50)
    const koRange = rangeOnOurReserve(doomed.s, 'MOVE_BODY_SLAM', 3)!
    expect(highestRoll(koRange)).toBe(39)
    expect(highestRoll(koRange)).toBeGreaterThanOrEqual(5)
    expect(fodderAbilityTriggers(doomed.s, 3, doomedView).usable).toContain('ABILITY_AFTERMATH')

    // Full HP Donphan (165) survives Body Slam's highest roll (39 < 165), so
    // CHECK_NOT(IsBattlerAlive(battler)) is false and the explosion never queues.
    const surviving = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(surviving.s.state, 0, 3, { hp: 165, abilities: abilitySlots('ABILITY_AFTERMATH') })
    beginTurn(surviving.s)
    const survivingView = readPredictions(surviving.s, 50)
    const liveRange = rangeOnOurReserve(surviving.s, 'MOVE_BODY_SLAM', 3)!
    expect(highestRoll(liveRange)).toBe(39)
    expect(highestRoll(liveRange)).toBeLessThan(165)
    expect(fodderAbilityTriggers(surviving.s, 3, survivingView).usable).toEqual([])
  })

  it('case 5: an innate is counted, not just the ability slot', () => {
    // Ability slot holds GUTS (onStat only, no hit hook); the only trigger is the
    // Flame Body innate, so the candidate comes from `reserve.abilities.innates`.
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_GUTS', ['ABILITY_FLAME_BODY', null, null]) })
    beginTurn(s)
    const view = readPredictions(s, 50)
    expect(fodderAbilityTriggers(s, 3, view).usable).toContain('ABILITY_FLAME_BODY')
    expect(fodderChoice({ layer, s }).choice.switchTo).toBe(3)
  })

  it('case 6a: an onAbsorb ability is usable only against an absorbed type', () => {
    // Sap Sipper absorbs Grass and raises the highest attacking stat by 1
    // (src/abilities.cc:2232-2241). Leafage is Grass and non-contact.
    const grass = fodderFixture([mon('SPECIES_MACHAMP', ['MOVE_LEAFAGE'])])
    patchMon(grass.s.state, 0, 3, { hp: 165, abilities: abilitySlots('ABILITY_SAP_SIPPER') })
    beginTurn(grass.s)
    const grassView = readPredictions(grass.s, 50)
    expect(grassView.predictedMoveId).toBe('MOVE_LEAFAGE')
    expect(grass.s.data.dataContext.move('MOVE_LEAFAGE')!.type).toBe('GRASS')
    expect(fodderAbilityTriggers(grass.s, 3, grassView).usable).toContain('ABILITY_SAP_SIPPER')

    // A Normal move is not absorbed, so the run must show no gain.
    const normal = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(normal.s.state, 0, 3, { hp: 165, abilities: abilitySlots('ABILITY_SAP_SIPPER') })
    beginTurn(normal.s)
    const normalView = readPredictions(normal.s, 50)
    expect(normal.s.data.dataContext.move('MOVE_BODY_SLAM')!.type).toBe('NORMAL')
    expect(fodderAbilityTriggers(normal.s, 3, normalView).usable).toEqual([])
  })

  it('case 6b: an onRevive ability needs its weather and latches the counter', () => {
    // Recurring Nightmare, src/abilities.cc:7896-7902:
    //   CHECK(IsBattlerWeatherAffected(battler, WEATHER_FOG_ANY)); return B_MSG_FADE_OUT;
    // The faint scan (battle_script_commands.c:3184-3197) latches
    // singleUseAbility[partyIndex][slot][side] = 1.
    const fogged = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    fogged.s.state.field.weather = WEATHER_FOG_PERMANENT
    patchMon(fogged.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_RECURRING_NIGHTMARE') })
    beginTurn(fogged.s)
    const foggedView = readPredictions(fogged.s, 50)
    expect(fodderAbilityTriggers(fogged.s, 3, foggedView).usable).toContain('ABILITY_RECURRING_NIGHTMARE')

    // Drive the same probe the helper uses and read the latch it leaves behind.
    const reserve = fogged.s.state.sides[0].party[3]!
    const probe = cloneSession(
      { ...fogged.s, state: stateWithReserve(fogged.s.state, 0, reserve, 3), playerReplacement: () => PARTY_SIZE },
      0,
    )
    probe.turnDeps = { ...probe.turnDeps, replacement: undefined }
    stepTurn(probe, null, structuredClone(foggedView.predictedAction!))
    expect(probe.state.battlers[0]!.mon.hp).toBe(0)
    expect(probe.state.singleUseAbility[3]![0]![0]).toBe(1)

    // No fog: the same KO leaves the counter unlatched.
    const clear = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(clear.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_RECURRING_NIGHTMARE') })
    beginTurn(clear.s)
    const clearView = readPredictions(clear.s, 50)
    expect(fodderAbilityTriggers(clear.s, 3, clearView).usable).toEqual([])
  })

  it('case 6c: the known gaps are reported for a mon that has the ability', () => {
    const backup = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(backup.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_BACKUP_POWER') })
    beginTurn(backup.s)
    const backupResult = fodderAbilityTriggers(backup.s, 3, readPredictions(backup.s, 50))
    expect(backupResult.usable).toEqual([])
    expect(backupResult.gaps.map((g) => `${g.abilityId}/${g.hook}`)).toContain('ABILITY_BACKUP_POWER/onRevive')

    const disguise = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(disguise.s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_DISGUISE') })
    beginTurn(disguise.s)
    const disguiseResult = fodderAbilityTriggers(disguise.s, 3, readPredictions(disguise.s, 50))
    expect(disguiseResult.usable).toEqual([])
    expect(disguiseResult.gaps.map((g) => `${g.abilityId}/${g.hook}`)).toContain('ABILITY_DISGUISE/onDisguise')
  })

  it('case 7: the four candidate lists equal data/v2.65beta/abilityHooks.json and the gap list is exact', () => {
    const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
    const hooks = JSON.parse(readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8')) as Record<
      string,
      { hooks?: Record<string, unknown> }
    >
    const idsFor = (hook: string): string[] =>
      Object.entries(hooks)
        .filter(([, entry]) => entry.hooks !== undefined && hook in entry.hooks)
        .map(([id]) => id)
        .sort()

    expect([...ON_DEFENDER_ABILITIES].sort()).toEqual(idsFor('onDefender'))
    expect([...ON_ABSORB_ABILITIES].sort()).toEqual(idsFor('onAbsorb'))
    expect([...ON_DISGUISE_ABILITIES].sort()).toEqual(idsFor('onDisguise'))
    expect([...ON_REVIVE_ABILITIES].sort()).toEqual(idsFor('onRevive'))
    expect(FODDER_ABILITY_SEEDS).toBe(32)

    expect(FODDER_ABILITY_GAPS.map((gap) => `${gap.abilityId}/${gap.hook}`).sort()).toEqual([
      'ABILITY_BACKUP_POWER/onRevive',
      'ABILITY_DISGUISE/onDisguise',
      'ABILITY_ICE_FACE/onDisguise',
      'ABILITY_PATCHWORK/onDisguise',
    ])
  })

  it('case 8: the trigger evaluation and a policy call leave the live session unchanged', () => {
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(s)

    const realRng = s.state.rng
    let draws = 0
    s.state.rng = {
      random16: () => {
        draws++
        return realRng.random16()
      },
    }

    // Warm the one-time Illusion arm (see cycles20ibFodder.test.ts case 9) before
    // snapshotting.
    layer.policy(s, 1, [])
    const view = readPredictions(s, 50)
    draws = 0
    const stateBefore = JSON.stringify(s.state, (key, value) => (key === 'rng' ? undefined : value))

    fodderAbilityTriggers(s, 3, view)
    layer.policy(s, 1, [])
    expect(draws).toBe(0)

    const stateAfter = JSON.stringify(s.state, (key, value) => (key === 'rng' ? undefined : value))
    expect(stateAfter).toBe(stateBefore)
  })

  it('case 9: a predicted SWITCH or no prediction makes nothing usable', () => {
    const { s } = fodderFixture([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_FLAME_BODY') })
    beginTurn(s)

    const noPrediction: PredictionView = {
      threatened: false,
      koThreat: false,
      switchSlot: null,
      predictedAction: null,
      predictedMoveId: null,
    }
    expect(fodderAbilityTriggers(s, 3, noPrediction).usable).toEqual([])

    const switchView: PredictionView = {
      ...noPrediction,
      predictedAction: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null },
    }
    expect(fodderAbilityTriggers(s, 3, switchView).usable).toEqual([])
  })

  it('case 10: a predicted recoil move is not a benefit of an unrelated bench ability', () => {
    // Double-Edge (moves.json: EFFECT_RECOIL_33, accuracy 100) hurts the USER for
    // 1/3 of the HP it deals. The recoil, src/battle_script_commands.c:4474-4475:
    //   int recoilFraction = GetRecoilFraction(gBattleMoves[gCurrentMove].effect);
    //   gBattleMoveDamage = recoilFraction ? max(1, gTurnStructs[gBattlerAttacker].savedDmg / recoilFraction) : 0;
    // The foe's own recoil is a cost of the predicted turn, not a gain from the
    // bench mon's ability: Sap Sipper absorbs GRASS only (src/abilities.cc:2232-2241)
    // and does nothing to a Normal move.
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', ['MOVE_DOUBLE_EDGE'])])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_SAP_SIPPER') })
    beginTurn(s)
    const view = readPredictions(s, 50)
    expect(view.predictedMoveId).toBe('MOVE_DOUBLE_EDGE')

    // Premise: the foe is lower after the stepped probe than before it. The probe
    // takes 5 HP off the 5 HP reserve, so savedDmg = 5 and the recoil is
    // max(1, 5 / 3) = 1: 150 -> 149.
    const foeHpBefore = s.state.battlers[1]!.mon.hp
    expect(foeHpBefore).toBe(150)
    const reserve = s.state.sides[0].party[3]!
    const probe = cloneSession(
      { ...s, state: stateWithReserve(s.state, 0, reserve, 3), playerReplacement: () => PARTY_SIZE },
      0,
    )
    probe.turnDeps = { ...probe.turnDeps, replacement: undefined }
    stepTurn(probe, null, structuredClone(view.predictedAction!))
    expect(probe.state.battlers[0]!.mon.hp).toBe(0)
    expect(probe.state.battlers[1]!.mon.hp).toBe(foeHpBefore - 1)

    // No trigger, equal usefulness: the lower slot (2, no ability) wins, as in case 2.
    expect(fodderAbilityTriggers(s, 3, view).usable).toEqual([])
    const { tags, choice } = fodderChoice({ layer, s })
    expect(tags).toEqual(['team', 'sacrifice'])
    expect(choice.switchTo).toBe(2)
  })

  it('case 11: a predicted self-stat-drop move is not a benefit of an unrelated bench ability', () => {
    // Clanging Scales (moves.json: EFFECT_ATTACKER_DEFENSE_DOWN_HIT, accuracy 100,
    // Dragon special, not contact) lowers its USER's Def by 1, certain:
    //   data/battle_scripts_1.s:806-808 BattleScript_EffectAttackerDefenseDownHit
    //   setmoveeffect MOVE_EFFECT_DEF_MINUS_1 | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    // That drop is the foe's own cost of the predicted turn, not a gain for the
    // bench mon: Rough Skin is contact-only (src/abilities.cc:784-793
    // CHECK(IsMoveMakingContact(move, attacker))) and the move never touches it.
    const { layer, s } = fodderFixture([mon('SPECIES_MACHAMP', ['MOVE_CLANGING_SCALES'])])
    patchMon(s.state, 0, 2, { hp: 5, abilities: abilitySlots('ABILITY_GUTS') })
    patchMon(s.state, 0, 3, { hp: 5, abilities: abilitySlots('ABILITY_ROUGH_SKIN') })
    beginTurn(s)
    const view = readPredictions(s, 50)
    expect(view.predictedMoveId).toBe('MOVE_CLANGING_SCALES')
    expect(data.dataContext.move('MOVE_CLANGING_SCALES')!.flags.contact).toBeUndefined()

    // Premise: the move hits on the asserted seed (the 5 HP reserve faints) and
    // the foe's own Def stage is 1 lower after the stepped probe.
    const reserve = s.state.sides[0].party[3]!
    const probe = cloneSession(
      { ...s, state: stateWithReserve(s.state, 0, reserve, 3), playerReplacement: () => PARTY_SIZE },
      0,
    )
    probe.turnDeps = { ...probe.turnDeps, replacement: undefined }
    const stageBefore = probe.state.battlers[1]!.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
    stepTurn(probe, null, structuredClone(view.predictedAction!))
    const stageAfter = probe.state.battlers[1]!.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
    expect(probe.state.battlers[0]!.mon.hp).toBe(0)
    expect(stageBefore).toBe(DEFAULT_STAT_STAGE)
    expect(stageAfter).toBe(DEFAULT_STAT_STAGE - 1)

    expect(fodderAbilityTriggers(s, 3, view).usable).toEqual([])
    const { tags, choice } = fodderChoice({ layer, s })
    expect(tags).toEqual(['team', 'sacrifice'])
    expect(choice.switchTo).toBe(2)
  })
})
