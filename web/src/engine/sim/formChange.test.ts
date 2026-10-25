// Unit tests for Mega Evolution and Primal Reversion in the simulator turn loop.
//
// Hand-derived from eliteredux-source C sources at pinned SHA:
// - VARIOUS_HANDLE_MEGA_EVO (src/battle_script_commands.c:7374-7426)
// - VARIOUS_HANDLE_PRIMAL_REVERSION (src/battle_script_commands.c:7428-7489)
// - RecalcBattlerStats (src/battle_script_commands.c:6618-6638)
// - RepopulateAbilities (src/battle_util.c:9281-9297)
// - UpdateAbilityStateIndices (src/battle_util.c:8833-8862)
// - UndoMegaEvolution (src/battle_util.c:8187-8215)
// - CanMegaEvolve (src/battle_util.c:8124-8185)
// - GetMegaEvolutionSpecies (src/battle_util.c:8092-8100)
// - GetPrimalReversionSpecies (src/battle_util.c:8102-8110)
// - OpponentHandleChooseMove (src/battle_controller_opponent.c:1608-1611)
// - CheckMegaEvolutionBeforeTurn (src/battle_main.c:4513-4541)
// - TryChangeTurnOrder (src/battle_main.c:4545-4549)
// - TryPrimalReversion (src/battle_util.c:3908-3920)
// - SetPermanentWeather (src/battle_util.c:3745-3757)

import { describe, expect, it } from 'vitest'

import { calcHp } from '../stats'

import { createBattleState, createBattlerState } from './create'
import type { RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import {
  canMegaEvolve,
  changeBattlerForm,
  getMegaEvolutionSpecies,
  updateAbilityStateIndices,
} from './formChange'
import {
  ENUM_WEATHER_RAIN,
  MAGIC_ROOM_DURATION,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_PRIMAL,
  WEATHER_SUN_PRIMAL,
} from './constants'
import { applyBattleStartPass, tryChangeBattleWeather } from './switchInAbility'
import { switchIn } from './switchIn'
import { loadSimData, type SimDataBundle } from './driver/loadSimData'
import { runBattle } from './driver/runBattle'

const simData = loadSimData()

function dummyDamage(): DamageResolver {
  return {
    resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [] }),
  }
}

function testDeps(bundle: SimDataBundle = simData, damage: DamageResolver = dummyDamage()): TurnLoopDeps {
  return {
    turnOrder: bundle.turnOrder,
    grounding: bundle.grounding,
    damage,
    statStageRatios: bundle.statStageRatios,
    dataContext: bundle.dataContext,
    hazardTypes: {
      typeChart: bundle.typeChart,
      inverseTypeChart: bundle.inverseTypeChart,
      inverseBattle: false,
    },
  }
}

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_VENUSAUR',
    rawStats: { atk: 102, def: 103, spatk: 120, spdef: 120, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 150,
    maxHp: 150,
    itemId: null,
    statStages: [],
    types: ['GRASS', 'POISON', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: 'ABILITY_CHLOROPLAST',
      innates: ['ABILITY_OVERGROW', 'ABILITY_THICK_FAT', 'ABILITY_POISON_ABSORB'],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_VENUSAUR',
    hp: 150,
    maxHp: 150,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: {
      ability: 'ABILITY_CHLOROPLAST',
      innates: ['ABILITY_OVERGROW', 'ABILITY_THICK_FAT', 'ABILITY_POISON_ABSORB'],
    },
    rawStats: { atk: 102, def: 103, spatk: 120, spdef: 120, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['GRASS', 'POISON', 'MYSTERY'],
    ...overrides,
  }
}

function moveAction(
  target: number,
  moveId: string,
  bundle: SimDataBundle = simData,
  options?: { mega?: boolean },
): ChosenAction {
  const m = bundle.dataContext.move(moveId)
  if (!m) throw new Error(`Missing move ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return {
    action: 'USE_MOVE',
    moveToBeUsed: view,
    chosenMove: view,
    target,
    mega: options?.mega,
  }
}

describe('Form change primitive: changeBattlerForm and updateAbilityStateIndices', () => {
  it('updates species, recalculates rawStats and max HP, updates types and abilities', () => {
    const rng = countingRng()
    const pMon0 = partyMon({
      speciesId: 'SPECIES_VENUSAUR',
      itemId: 'ITEM_VENUSAURITE',
      hp: 120,
      maxHp: 150,
    })
    const bMon0 = mon({
      speciesId: 'SPECIES_VENUSAUR',
      itemId: 'ITEM_VENUSAURITE',
      hp: 120,
      maxHp: 150,
    })
    const pMon1 = partyMon({ speciesId: 'SPECIES_CHARIZARD' })
    const bMon1 = mon({ speciesId: 'SPECIES_CHARIZARD' })

    const state = createBattleState({
      battlers: [createBattlerState(0, bMon0, 0), createBattlerState(1, bMon1, 0)],
      playerParty: [pMon0],
      opponentParty: [pMon1],
      rng,
    })

    const initialAtk = state.battlers[0]!.mon.rawStats.atk
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_VENUSAUR')

    // Perform form change to SPECIES_VENUSAUR_MEGA
    changeBattlerForm(state, 0, 'SPECIES_VENUSAUR_MEGA', simData.dataContext)

    const updatedMon = state.battlers[0]!.mon
    expect(updatedMon.speciesId).toBe('SPECIES_VENUSAUR_MEGA')
    // RecalcBattlerStats -> CalculateMonStatsMaster (src/pokemon.c:1000-1046): max HP is recomputed from the new
    // form's base HP (IV 31, no EVs here) and current HP moves by the same delta.
    const megaBaseHp = simData.dataContext.species('SPECIES_VENUSAUR_MEGA')!.baseStats.hp
    const expectedMaxHp = calcHp(megaBaseHp, 31, 0, updatedMon.level, false)
    expect(updatedMon.maxHp).toBe(expectedMaxHp)
    expect(updatedMon.hp).toBe(Math.max(1, 120 + expectedMaxHp - 150))
    // Mega Venusaur has higher base Atk than standard Venusaur
    expect(updatedMon.rawStats.atk).toBeGreaterThan(initialAtk)
    // Types from SPECIES_VENUSAUR_MEGA
    expect(updatedMon.types[0]).toBe('GRASS')
    expect(updatedMon.types[1]).toBe('POISON')
    // Abilities updated to Mega Venusaur
    const megaSpeciesData = simData.dataContext.species('SPECIES_VENUSAUR_MEGA')!
    expect(updatedMon.abilities.innates).toEqual(megaSpeciesData.innates)
    // Party record is updated in sync
    expect(state.sides[0].party[0].speciesId).toBe('SPECIES_VENUSAUR_MEGA')
    expect(state.sides[0].party[0].rawStats).toEqual(updatedMon.rawStats)
  })

  it('updateAbilityStateIndices preserves state for retained abilities and resets for newly gained abilities', () => {
    const battler = createBattlerState(0, mon({
      abilities: {
        ability: 'ABILITY_CHLOROPLAST',
        innates: ['ABILITY_OVERGROW', 'ABILITY_THICK_FAT', 'ABILITY_POISON_ABSORB'],
      },
    }), 0)

    // Simulate that THICK_FAT (slot 2) had its switch-in effect executed and turn trigger set
    battler.volatiles.switchInAbilityDone[2] = true
    battler.turn.turnAbilityTriggers[2] = true
    battler.volatiles.abilityState[2] = 42

    // Mega Venusaur innates: [ABILITY_FOREST_RAGE, ABILITY_THICK_FAT, ABILITY_POISON_ABSORB]
    // THICK_FAT is now in slot 2 (innate 1). ABILITY_FOREST_RAGE is a new innate in slot 1 (innate 0).
    const newAbilities = {
      ability: 'ABILITY_CHLOROPLAST',
      innates: ['ABILITY_FOREST_RAGE', 'ABILITY_THICK_FAT', 'ABILITY_POISON_ABSORB'] as [string | null, string | null, string | null],
    }

    updateAbilityStateIndices(battler, newAbilities)

    // Slot 1 (new ability FOREST_RAGE) must start fresh
    expect(battler.volatiles.switchInAbilityDone[1]).toBe(false)
    expect(battler.turn.turnAbilityTriggers[1]).toBe(false)
    expect(battler.volatiles.abilityState[1]).toBe(0)

    // Slot 2 (retained ability THICK_FAT) preserves state
    expect(battler.volatiles.switchInAbilityDone[2]).toBe(true)
    expect(battler.turn.turnAbilityTriggers[2]).toBe(true)
    expect(battler.volatiles.abilityState[2]).toBe(42)
  })
})

describe('Trigger rules: canMegaEvolve and getMegaEvolutionSpecies', () => {
  it('returns target mega species and true when holding matching Mega Stone', () => {
    const megaSpecies = getMegaEvolutionSpecies('SPECIES_VENUSAUR', 'ITEM_VENUSAURITE', simData.dataContext)
    expect(megaSpecies).toBe('SPECIES_VENUSAUR_MEGA')

    const rng = countingRng()
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' })],
      rng,
    })

    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(true)
  })

  it('returns null and false when holding non-matching item or no item', () => {
    expect(getMegaEvolutionSpecies('SPECIES_VENUSAUR', 'ITEM_LEFTOVERS', simData.dataContext)).toBeNull()
    expect(getMegaEvolutionSpecies('SPECIES_VENUSAUR', 'ITEM_CHARIZARDITE_X', simData.dataContext)).toBeNull()
    expect(getMegaEvolutionSpecies('SPECIES_VENUSAUR', null, simData.dataContext)).toBeNull()

    const rng = countingRng()
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_LEFTOVERS' }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      rng,
    })

    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(false)
  })

  it('is blocked when Magic Room is active (battle_util.c:8162)', () => {
    const rng = countingRng()
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' })],
      rng,
    })

    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(true)

    // Activate Magic Room
    state.field.timers.magicRoomTimer = MAGIC_ROOM_DURATION
    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(false)
  })

  it('enforces once-per-battle for player side (battle_util.c:8148-8158)', () => {
    const rng = countingRng()
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD', itemId: 'ITEM_CHARIZARDITE_X' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD', itemId: 'ITEM_CHARIZARDITE_X' })],
      rng,
    })

    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(true)

    // Mark player position 0 as already evolved
    state.mega.alreadyEvolved[0] = true
    expect(canMegaEvolve(state, 0, simData.dataContext)).toBe(false)

    // C QUIRK KEPT: battle_util.c does NOT check alreadyEvolved for B_SIDE_OPPONENT (battler 1)
    state.mega.alreadyEvolved[1] = true
    expect(canMegaEvolve(state, 1, simData.dataContext)).toBe(true)
  })
})

describe('Execution timing: checkMegaEvolutionBeforeTurn and TryChangeTurnOrder', () => {
  it('evolves before actions execute, changing species, and logs MEGA_EVOLUTION outcome', () => {
    const rng = countingRng()
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE', hp: 100, maxHp: 100 }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD', hp: 100, maxHp: 100 }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD' })],
      rng,
    })

    const action0 = moveAction(1, 'MOVE_TACKLE', simData, { mega: true })
    const action1 = moveAction(0, 'MOVE_TACKLE', simData)

    const outcome = executeTurn(state, [action0, action1], testDeps())

    expect(outcome.megaEvolutions).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_VENUSAUR_MEGA')
    // Max HP is recomputed from the Mega form's base HP (src/pokemon.c:1000-1008)
    const megaBaseHp = simData.dataContext.species('SPECIES_VENUSAUR_MEGA')!.baseStats.hp
    expect(state.battlers[0]!.mon.maxHp).toBe(calcHp(megaBaseHp, 31, 0, state.battlers[0]!.mon.level, false))

    // The evolution is reported on the turn outcome (CheckMegaEvolutionBeforeTurn, battle_main.c:4513-4541)
    expect(outcome.megaEvolved).toEqual([
      expect.objectContaining({ battlerId: 0, speciesId: 'SPECIES_VENUSAUR_MEGA' }),
    ])
  })

  it('recalculates turn order so a mega evolving mon with higher speed strikes first (TryChangeTurnOrder)', () => {
    const rng = countingRng()

    // Beedrill base speed 75 (level 50 raw speed ~95); Beedrill-Mega base speed 145 (raw speed >160)
    // Opponent has speed 110: slower than Mega Beedrill, but faster than base Beedrill.
    const beedrill = mon({
      speciesId: 'SPECIES_BEEDRILL',
      itemId: 'ITEM_BEEDRILLITE',
      rawStats: { atk: 100, def: 80, spatk: 80, spdef: 80, spe: 95 },
    })
    const opponent = mon({
      speciesId: 'SPECIES_RAICHU',
      rawStats: { atk: 100, def: 80, spatk: 80, spdef: 80, spe: 110 },
    })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, beedrill, 0),
        createBattlerState(1, opponent, 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_BEEDRILL', itemId: 'ITEM_BEEDRILLITE' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_RAICHU' })],
      rng,
    })

    // Turn 1 WITHOUT mega: Opponent (110) moves first
    const actionNoMega = moveAction(1, 'MOVE_TACKLE', simData, { mega: false })
    const actionOpponent = moveAction(0, 'MOVE_TACKLE', simData)
    const outcomeNoMega = executeTurn(state, [actionNoMega, actionOpponent], testDeps())

    // Move actions only (excluding mega actions)
    const moveActionsNoMega = outcomeNoMega.actions.filter((a) => a.action === 'USE_MOVE')
    expect(moveActionsNoMega[0].battlerId).toBe(1) // Opponent moved first!

    // Reset battler 0 back to base Beedrill for turn 2 test WITH mega
    state.battlers[0]!.mon.speciesId = 'SPECIES_BEEDRILL'
    state.battlers[0]!.mon.rawStats.spe = 95
    state.mega.alreadyEvolved[0] = false

    const actionWithMega = moveAction(1, 'MOVE_TACKLE', simData, { mega: true })
    const outcomeWithMega = executeTurn(state, [actionWithMega, actionOpponent], testDeps())

    expect(outcomeWithMega.megaEvolutions).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_BEEDRILL_MEGA')
    // Speed recalculated: Mega Beedrill speed is >160
    expect(state.battlers[0]!.mon.rawStats.spe).toBeGreaterThan(110)

    // With TryChangeTurnOrder (battle_main.c:4545-4549), battler 0 overtakes opponent and moves first!
    const moveActionsWithMega = outcomeWithMega.actions.filter((a) => a.action === 'USE_MOVE')
    expect(moveActionsWithMega[0].battlerId).toBe(0) // Mega Beedrill struck first!
  })
})

describe('Switch-in effects after form change (BattleScript_MegaEvolution:8412)', () => {
  it('triggers on-entry ability of the new form (e.g. Snow Warning on Mega Abomasnow)', () => {
    const rng = countingRng()

    // Base Abomasnow has [ABILITY_ICE_BODY, ABILITY_CRYOMANCY, ABILITY_PERMAFROST] - NO weather setter
    // Mega Abomasnow has [ABILITY_SNOW_WARNING, ABILITY_WHITEOUT, ABILITY_PERMAFROST] - sets Hail
    const abomasnow = mon({
      speciesId: 'SPECIES_ABOMASNOW',
      itemId: 'ITEM_ABOMASITE',
      abilities: {
        ability: 'ABILITY_ICE_BODY',
        innates: ['ABILITY_ICE_BODY', 'ABILITY_CRYOMANCY', 'ABILITY_PERMAFROST'],
      },
    })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, abomasnow, 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_ABOMASNOW', itemId: 'ITEM_ABOMASITE' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD' })],
      rng,
    })

    expect(state.field.weather).toBe(0) // No weather initially

    const action0 = moveAction(1, 'MOVE_TACKLE', simData, { mega: true })
    const action1 = moveAction(0, 'MOVE_TACKLE', simData)

    executeTurn(state, [action0, action1], testDeps())

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ABOMASNOW_MEGA')
    // Snow Warning activated immediately upon mega evolution
    expect(state.field.weather & WEATHER_HAIL_TEMPORARY).toBeTruthy()
  })
})

describe('Primal Reversion: tryPrimalReversion and permanent weather', () => {
  it('Groudon holding Red Orb primal reverts at battle start and sets permanent Desolate Land sun', () => {
    const rng = countingRng()

    const groudon = mon({
      speciesId: 'SPECIES_GROUDON',
      itemId: 'ITEM_RED_ORB',
      hp: 200,
      maxHp: 200,
    })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, groudon, 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_KYOGRE' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_GROUDON', itemId: 'ITEM_RED_ORB' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_KYOGRE' })],
      rng,
    })

    // At battle start pass (battle_main.c:3370-3372)
    const unmodelled: string[] = []
    applyBattleStartPass(state, testDeps(), unmodelled)

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_GROUDON_PRIMAL')
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    // Permanent weather has duration 255 (battle_util.c:3754)
    expect(state.field.weatherDuration).toBe(255)

    // Permanent weather cannot be overwritten by normal temporary rain (battle_util.c:3725)
    const changed = tryChangeBattleWeather(state, 1, ENUM_WEATHER_RAIN, false, testDeps()) // battler 1 has no primal ability (battle_util.c:3724-3727)
    expect(changed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('Kyogre holding Blue Orb primal reverts on switch-in and sets permanent Primordial Sea rain', () => {
    const rng = countingRng()

    const kyogreParty = partyMon({
      speciesId: 'SPECIES_KYOGRE',
      itemId: 'ITEM_BLUE_ORB',
      hp: 200,
      maxHp: 200,
    })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_PIKACHU' }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_PIKACHU' }), kyogreParty],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD' })],
      rng,
    })

    // Switch Kyogre in to replace Pikachu
    const unmodelled: string[] = []
    switchIn(state, 0, 1, testDeps(), unmodelled)

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_KYOGRE_PRIMAL')
    expect(state.field.weather).toBe(WEATHER_RAIN_PRIMAL)
    expect(state.field.weatherDuration).toBe(255)
  })

  it('Primal Reversion does not consume the once-per-battle Mega Evolution slot', () => {
    const rng = countingRng()

    const groudon = mon({
      speciesId: 'SPECIES_GROUDON',
      itemId: 'ITEM_RED_ORB',
    })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, groudon, 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [partyMon({ speciesId: 'SPECIES_GROUDON', itemId: 'ITEM_RED_ORB' })],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD' })],
      rng,
    })

    const unmodelled: string[] = []
    applyBattleStartPass(state, testDeps(), unmodelled)

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_GROUDON_PRIMAL')
    // Primal reversion does not set alreadyEvolved (VARIOUS_HANDLE_MEGA_EVO:7417)
    expect(state.mega.alreadyEvolved[0]).toBe(false)
  })
})

describe('UndoMegaEvolution and party record (battle_util.c:8187-8215)', () => {
  it('reverts player mon to base species on switch-out', () => {
    const rng = countingRng()

    const venusaurParty = partyMon({
      speciesId: 'SPECIES_VENUSAUR',
      itemId: 'ITEM_VENUSAURITE',
      hp: 150,
      maxHp: 150,
    })
    const backupParty = partyMon({ speciesId: 'SPECIES_BLASTOISE' })

    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE', hp: 150, maxHp: 150 }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD' }), 0),
      ],
      playerParty: [venusaurParty, backupParty],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD' })],
      rng,
    })

    // Mega evolve on turn 1
    const action0 = moveAction(1, 'MOVE_TACKLE', simData, { mega: true })
    const action1 = moveAction(0, 'MOVE_TACKLE', simData)
    executeTurn(state, [action0, action1], testDeps())

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_VENUSAUR_MEGA')
    expect(state.sides[0].party[0].speciesId).toBe('SPECIES_VENUSAUR_MEGA')
    expect(state.mega.playerBaseSpecies[0]).toBe('SPECIES_VENUSAUR')

    // Player switches out slot 0 for slot 1 (battle_main.c:3007 calls undoMegaEvolution)
    const unmodelled: string[] = []
    switchIn(state, 0, 1, testDeps(), unmodelled)

    // Party mon slot 0 has reverted back to SPECIES_VENUSAUR!
    expect(state.sides[0].party[0].speciesId).toBe('SPECIES_VENUSAUR')
    // Active battler is now Blastoise
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_BLASTOISE')
  })

  it('reverts player mon to base species at battle end (battle_main.c:4830)', () => {
    const rng = countingRng()

    const venusaurParty = partyMon({
      speciesId: 'SPECIES_VENUSAUR',
      itemId: 'ITEM_VENUSAURITE',
      hp: 150,
      maxHp: 150,
    })

    // Opponent with 1 HP so a single hit ends the battle
    const state = createBattleState({
      battlers: [
        createBattlerState(0, mon({ speciesId: 'SPECIES_VENUSAUR', itemId: 'ITEM_VENUSAURITE', hp: 150, maxHp: 150 }), 0),
        createBattlerState(1, mon({ speciesId: 'SPECIES_CHARIZARD', hp: 1, maxHp: 100 }), 0),
      ],
      playerParty: [venusaurParty],
      opponentParty: [partyMon({ speciesId: 'SPECIES_CHARIZARD', hp: 1, maxHp: 100 })],
      rng,
    })

    const action0 = moveAction(1, 'MOVE_TACKLE', simData, { mega: true })
    const action1 = moveAction(0, 'MOVE_TACKLE', simData)

    const outcome = executeTurn(state, [action0, action1], testDeps())

    // Foe fainted, battle is won
    expect(outcome.outcome).not.toBeNull()
    expect(state.battleOutcome).toBe('WON')

    // At battle end, UndoMegaEvolution has reverted party slot back to SPECIES_VENUSAUR
    expect(state.sides[0].party[0].speciesId).toBe('SPECIES_VENUSAUR')
  })
})

describe('Driver hook: runBattle tracks megaEvolutions count', () => {
  it('runs a battle with Mega Stone participant and records megaEvolutions in result', () => {
    const playerParty = [
      partyMon({
        speciesId: 'SPECIES_VENUSAUR',
        itemId: 'ITEM_VENUSAURITE',
        hp: 150,
        maxHp: 150,
        moves: ['MOVE_TACKLE', null, null, null],
        pp: [35, 0, 0, 0],
      }),
    ]

    const opponent = simData.trainersById.get('TRAINER_SAWYER_1')!
    expect(opponent).toBeDefined()

    const result = runBattle({
      data: simData,
      playerParty,
      opponentTrainer: opponent,
      tier: 'ace',
      maxTurns: 5,
    })

    // Smoke check: battle ran and tracked mega evolution count
    expect(result.megaEvolutions).toBeGreaterThanOrEqual(1)
  })
})
