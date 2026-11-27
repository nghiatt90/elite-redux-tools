/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s21a: every move starts at its PP-Up maximum.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   pokemon.c:1487-1488   GetBoxMonData returns 255 for MON_DATA_PP_BONUSES.
//   pokemon.c:1853        SetBoxMonData ignores writes to MON_DATA_PP_BONUSES.
//   pokemon.c:2260-2263   CalculatePPWithBonus: basePP + ((basePP*20*bonus)/100).
//   pokemon.c:2239-2258   CalculatePPWithBonusPlayer: Hell mode gives sleep moves
//                         (and Rest/Sleep Talk) 2 PP and every other move base PP.
//   pokemon.c:6432        isHellMode: difficulty == DIFFICULTY_HELL.
//   battle_main.c:1894-1895  Foe starting PP uses CalculatePPWithBonus in every tier.
//   battle_tower.c:2450-2453 Custom partner writes plain base PP.
//   battle_script_commands.c:7116-7129  VARIOUS_RESTORE_PP (Lunar Dance).

import { describe, expect, it } from 'vitest'

import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'
import { fightSpecFor } from './driver/fightSpec'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import { createRandomSource } from './rng'

const data = loadSimData()

const trainerMon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
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
const trainerParties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })
const opponentTrainer = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: trainerParties(mons),
  ...overrides,
})

function buildSession(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  tier: 'ace' | 'elite' | 'hell' = 'elite',
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponentTrainer(foeMons),
    tier,
    rng: createRandomSource(1),
  })
}

describe('Cycle s21a: every move has max PP (three PP Ups)', () => {
  it('1. createSession vs TRAINER_SIDNEY (elite): Yveltal gets the bonus-3 PP for all four moves', () => {
    const session = createSession({
      data,
      playerParty: buildPlayerParty([{ species: 'SPECIES_MUDKIP', moves: ['MOVE_TACKLE'] }], 50, data),
      opponentTrainer: data.trainersById.get('TRAINER_SIDNEY')!,
      tier: 'elite',
      rng: createRandomSource(1),
    })
    const yveltal = session.state.sides[1].party[4]!
    expect(yveltal.moves).toEqual(['MOVE_HEAT_WAVE', 'MOVE_OBLIVION_WING', 'MOVE_BADDY_BAD', 'MOVE_AURA_SPHERE'])
    // 10 -> 16, 10 -> 16, 15 -> 24, 20 -> 32 (pokemon.c:2260-2263)
    expect(yveltal.pp).toEqual([16, 16, 24, 32])
  })

  it('2. player, elite: Fire Blast 8, Sketch stays 1, empty slot 0; one turn takes Fire Blast to 7', () => {
    const session = buildSession(
      [{ species: 'SPECIES_MUDKIP', moves: ['MOVE_FIRE_BLAST', 'MOVE_SKETCH', null, null] }],
      [trainerMon('SPECIES_TREECKO', ['MOVE_TACKLE'])],
    )
    const lead = session.state.sides[0].party[0]!
    // Fire Blast base 5 -> 8; Sketch base 1 -> 1 + 0 (integer division).
    expect(lead.pp).toEqual([8, 1, 0, 0])

    // Fire Blast misses or hits, but ppreduce always spends one PP
    // (BattleScript_PrintMoveMissed also runs ppreduce, battle_scripts_1.s:3092-3094).
    stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_FIRE_BLAST'), null)
    expect(session.state.battlers[0]!.mon.pp[0]).toBe(7)
  })

  it('3. Hell tier: player sleep moves and Rest get 2, everything else base; foe keeps bonus-3', () => {
    const playerMons: PlayerMonSpec[] = [
      { species: 'SPECIES_MUDKIP', moves: ['MOVE_FIRE_BLAST', 'MOVE_REST', 'MOVE_SPORE', 'MOVE_HYPNOSIS'] },
      { species: 'SPECIES_FEEBAS', moves: ['MOVE_SNORE', 'MOVE_SLEEP_TALK', null, null] },
    ]
    const foeMons = [trainerMon('SPECIES_TREECKO', ['MOVE_SPORE', 'MOVE_HYPNOSIS', 'MOVE_TACKLE'])]

    const hell = buildSession(playerMons, foeMons, 'hell')
    // CalculatePPWithBonusPlayer (pokemon.c:2243-2256): Fire Blast base 5,
    // Rest/Spore/Hypnosis -> 2. Snore/Sleep Talk -> 2 on the reserve slot.
    expect(hell.state.sides[0].party[0]!.pp).toEqual([5, 2, 2, 2])
    expect(hell.state.sides[0].party[1]!.pp).toEqual([2, 2, 0, 0])
    // The foe still uses CalculatePPWithBonus in Hell (battle_main.c:1894-1895):
    // Spore 15 -> 24, Hypnosis 20 -> 32, Tackle 20 -> 32.
    expect(hell.state.sides[1].party[0]!.pp).toEqual([24, 32, 32, 0])

    // A deliberately lowered PP survives the Hell clamp.
    const lowered = buildPlayerParty(playerMons, 50, data)
    lowered[0]!.pp[0] = 1
    const loweredSession = createSession({
      data,
      playerParty: lowered,
      opponentTrainer: opponentTrainer(foeMons),
      tier: 'hell',
      rng: createRandomSource(1),
    })
    expect(loweredSession.state.sides[0].party[0]!.pp[0]).toBe(1)

    // Control: the same party in elite keeps the bonus-3 maximum (Rest 10 -> 16).
    const elite = buildSession(playerMons, foeMons, 'elite')
    expect(elite.state.sides[0].party[0]!.pp[1]).toBe(16)
  })

  it('4. partner format: partner keeps base PP, the foe gets bonus-3, and Hell does not clamp the partner', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerMons: PlayerMonSpec[] = [
      { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
      { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
      { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
    ]
    const build = (tier: 'elite' | 'hell') =>
      createSession({
        data,
        playerParty: buildPlayerParty(playerMons, 50, data),
        opponentTrainer: spec.opponentTrainer,
        format: spec.format,
        tier,
        rng: createRandomSource(1),
      })

    const elite = build('elite')
    // Partner slot 3 is Pikachu Pop Star: Fake Out 10, Slam 10, Thunder Punch 15, Spotlight 15.
    expect(elite.state.sides[0].party[3]!.pp).toEqual([10, 10, 15, 15])
    // The foe still gets the bonus-3 maximum: the elite Ninetales' Solar Beam
    // 10 -> 16, Heat Wave 10 -> 16, Shadow Ball 15 -> 24, Nasty Plot 20 -> 32.
    expect(elite.state.sides[1].party[0]!.pp).toEqual([16, 16, 24, 32])
    // The player's own Tackle has the max in elite (20 -> 32).
    expect(elite.state.sides[0].party[0]!.pp[0]).toBe(32)

    const hell = build('hell')
    // The partner is untouched by the Hell clamp (battle_tower.c:2450-2453).
    expect(hell.state.sides[0].party[3]!.pp).toEqual([10, 10, 15, 15])
    // The player's own Tackle drops to base PP in Hell (pokemon.c:2256).
    expect(hell.state.sides[0].party[0]!.pp[0]).toBe(20)
  })

  it('5. Lunar Dance: player restores the bonus-3 maximum, Hell restores base / 2, foe restores bonus-3', () => {
    const playerMons: PlayerMonSpec[] = [
      { species: 'SPECIES_MUDKIP', moves: ['MOVE_LUNAR_DANCE', null, null, null] },
      { species: 'SPECIES_FEEBAS', moves: ['MOVE_FIRE_BLAST', 'MOVE_REST', null, null] },
    ]
    const foeMons = [trainerMon('SPECIES_TREECKO', ['MOVE_TACKLE'])]

    // Player side, elite: the incoming mon's depleted PP is refilled to bonus-3.
    const elite = buildSession(playerMons, foeMons, 'elite')
    const incoming = elite.state.sides[0].party[1]!
    incoming.pp[0] = 5
    incoming.pp[1] = 1
    stepTurn(elite, buildMoveAction(elite.state, data, 0, 'MOVE_LUNAR_DANCE'), null)
    expect(elite.state.battlers[0]!.partyIndex).toBe(1)
    // Fire Blast 5 -> 8 (base 5 + 3); Rest 10 -> 16.
    expect(incoming.pp[0]).toBe(8)
    expect(incoming.pp[1]).toBe(16)

    // Player side, Hell: the incoming mon is restored to base PP, Rest to 2.
    const hell = buildSession(playerMons, foeMons, 'hell')
    const hellIncoming = hell.state.sides[0].party[1]!
    hellIncoming.pp[0] = 1
    hellIncoming.pp[1] = 1
    stepTurn(hell, buildMoveAction(hell.state, data, 0, 'MOVE_LUNAR_DANCE'), null)
    expect(hell.state.battlers[0]!.partyIndex).toBe(1)
    expect(hellIncoming.pp[0]).toBe(5)
    expect(hellIncoming.pp[1]).toBe(2)

    // Foe side, Hell: CalculatePPWithBonus still applies (battle_main.c:1894-1895);
    // the foe's depleted Fire Blast is restored to 8.
    const foeSession = buildSession(
      [{ species: 'SPECIES_MUDKIP', moves: ['MOVE_TACKLE'] }],
      [
        trainerMon('SPECIES_TREECKO', ['MOVE_LUNAR_DANCE']),
        trainerMon('SPECIES_TORCHIC', ['MOVE_FIRE_BLAST']),
      ],
      'hell',
    )
    const foeIncoming = foeSession.state.sides[1].party[1]!
    foeIncoming.pp[0] = 5
    stepTurn(foeSession, null, buildMoveAction(foeSession.state, data, 1, 'MOVE_LUNAR_DANCE'))
    expect(foeSession.state.battlers[1]!.partyIndex).toBe(1)
    expect(foeIncoming.pp[0]).toBe(8)
  })
})
