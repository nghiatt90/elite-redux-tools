/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 45 (dbl-3c-statbuffs, dbl-3c-bloodstain-fidelity):
// BenefitsFromStatBuffs & IsBloodStainAffected, src/battle_util.c:8988-8993, 9000-9004.
// - Blood Stain is self-held (not foe-held), with Ghost and Rock exemptions.
// - Hemolysis covers both opposing battlers in doubles via ((battlerId & 1) ^ 1).

import './driver/session'
import { describe, expect, it } from 'vitest'

import { STATUS1_BLEED, STATUS1_POISON } from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import type { BattleState, SimBattleMon } from './state'
import { benefitsFromStatBuffs } from './statBuffs'

const simData = loadSimData()

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function ability(id: string): SimBattleMon['abilities'] {
  return { ability: id, innates: [null, null, null] }
}

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: s.abilities[0] ?? null,
      innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function make4BattlerState(
  b0: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  b1: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  b2: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  b3: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
): BattleState {
  return createBattleState({
    battlers: [
      createBattlerState(0, b0, 0),
      createBattlerState(1, b1, 0),
      createBattlerState(2, b2, 1),
      createBattlerState(3, b3, 1),
    ],
    rng: { random16: () => 0 },
  })
}

describe('benefitsFromStatBuffs (battle_util.c:8988-8993)', () => {
  describe('Blood Stain fidelity (battle_util.c:9000-9004)', () => {
    it('own Blood Stain on a non-Ghost/Rock holder returns false; battler without it returns true', () => {
      const stateWithBloodStain = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(stateWithBloodStain.battlersCount).toBe(4)
      expect(benefitsFromStatBuffs(stateWithBloodStain, 0)).toBe(false)

      const stateWithoutBloodStain = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(stateWithoutBloodStain, 0)).toBe(true)
    })

    it('own Blood Stain on a Ghost holder returns true', () => {
      const ghostHolder = make4BattlerState(
        monFor('SPECIES_GENGAR', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(ghostHolder, 0)).toBe(true)

      const nonGhostHolder = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(nonGhostHolder, 0)).toBe(false)
    })

    it('own Blood Stain on a Rock holder returns true', () => {
      const rockHolder = make4BattlerState(
        monFor('SPECIES_GEODUDE', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(rockHolder, 0)).toBe(true)

      const nonRockHolder = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(nonRockHolder, 0)).toBe(false)
    })

    it('Blood Stain only on a foe returns true for battler without it', () => {
      // Foe battler 1 has Blood Stain; battler 0 has no Blood Stain
      const stateFoeBloodStain = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(stateFoeBloodStain, 0)).toBe(true)

      // Paired negative: if battler 0 itself has Blood Stain (non-Ghost/Rock), returns false
      const stateBothBloodStain = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_BLOOD_STAIN') }),
      )
      expect(benefitsFromStatBuffs(stateBothBloodStain, 0)).toBe(false)
    })
  })

  describe('Hemolysis opposing side in doubles (battle_util.c:8991)', () => {
    it('Hemolysis on foe battler 1 prevents buffs for poisoned battler 2', () => {
      // Battler 2 (side 0 partner) is poisoned; foe battler 1 (side 1 lead) has Hemolysis
      const state = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(state, 2)).toBe(false)

      // Paired negative: unpoisoned battler 2 benefits despite foe Hemolysis
      const stateUnpoisoned = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(stateUnpoisoned, 2)).toBe(true)
    })

    it('Hemolysis on foe battler 3 prevents buffs for poisoned battler 0', () => {
      // Battler 0 (side 0 lead) is poisoned; foe battler 3 (side 1 partner) has Hemolysis
      const state = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
      )
      expect(benefitsFromStatBuffs(state, 0)).toBe(false)

      // Paired negative: unpoisoned battler 0 benefits despite foe Hemolysis
      const stateUnpoisoned = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
      )
      expect(benefitsFromStatBuffs(stateUnpoisoned, 0)).toBe(true)
    })

    it('foe Hemolysis fainted (hp 0) allows poisoned battler to benefit', () => {
      // Foe battler 1 has Hemolysis but is fainted (hp 0); battler 2 is poisoned
      const stateFainted = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS'), hp: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(stateFainted, 2)).toBe(true)

      // Paired negative: alive foe Hemolysis prevents buffs
      const stateAlive = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS'), hp: 100 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(stateAlive, 2)).toBe(false)
    })

    it('poisoned battler with no Hemolysis anywhere benefits from stat buffs', () => {
      const state = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(state, 0)).toBe(true)
      expect(benefitsFromStatBuffs(state, 2)).toBe(true)

      // Paired negative: with Hemolysis on foe side, poisoned battler cannot benefit
      const stateWithHemo = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(stateWithHemo, 0)).toBe(false)
      expect(benefitsFromStatBuffs(stateWithHemo, 2)).toBe(false)
    })

    it('Hemolysis on foe side but battler is not poisoned benefits from stat buffs', () => {
      const state = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(state, 0)).toBe(true)
      expect(benefitsFromStatBuffs(state, 2)).toBe(true)

      // Paired negative: same state with poisoned battler returns false
      const statePoisoned = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_POISON }),
        monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HEMOLYSIS') }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: 0 }),
        monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      )
      expect(benefitsFromStatBuffs(statePoisoned, 0)).toBe(false)
    })
  })

  describe('Bleed status (battle_util.c:8989)', () => {
    it('bleed status returns false regardless of abilities', () => {
      // Baseline bleed
      const stateBleed = make4BattlerState(
        monFor('SPECIES_MUDKIP', { abilities: noAbility, status1: STATUS1_BLEED }),
      )
      expect(benefitsFromStatBuffs(stateBleed, 0)).toBe(false)

      // Bleed on Ghost holder with Blood Stain still returns false
      const stateGhostBleed = make4BattlerState(
        monFor('SPECIES_GENGAR', { abilities: ability('ABILITY_BLOOD_STAIN'), status1: STATUS1_BLEED }),
      )
      expect(benefitsFromStatBuffs(stateGhostBleed, 0)).toBe(false)

      // Bleed on Rock holder with Blood Stain still returns false
      const stateRockBleed = make4BattlerState(
        monFor('SPECIES_GEODUDE', { abilities: ability('ABILITY_BLOOD_STAIN'), status1: STATUS1_BLEED }),
      )
      expect(benefitsFromStatBuffs(stateRockBleed, 0)).toBe(false)

      // Paired negative: same mon without bleed returns true
      const stateGhostNoBleed = make4BattlerState(
        monFor('SPECIES_GENGAR', { abilities: ability('ABILITY_BLOOD_STAIN'), status1: 0 }),
      )
      expect(benefitsFromStatBuffs(stateGhostNoBleed, 0)).toBe(true)
    })
  })
})
