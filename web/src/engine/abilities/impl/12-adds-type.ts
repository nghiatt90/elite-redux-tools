// Batch J: pure `addsType` abilities -- src/abilities.cc's `.addsType = TYPE_X`
// bitfield, no lambda hook at all. The extra type itself is ALREADY reflected in
// species.json's `grantsType`-derived dex types (pipeline/src/erdata/emit.py uses
// this exact bitfield to resolve it, replacing an earlier regex scrape -- see
// CLAUDE.md's pipeline notes), so `attacker.types`/`defender.types` already include
// it by the time this engine runs. Registering these here isn't dead weight: it's
// what lets the coverage gate confirm each one was deliberately checked against the
// C rather than silently missed, and it carries `breakable`/`levitate`/
// `adaptability` for the handful that also set those bitfields.

import { aliasMoldBreaker, aliasParentalBond } from './alias'
import type { AbilityImpl } from '../types'

export const ADDS_TYPE_ABILITIES: AbilityImpl[] = [
  { id: 'ABILITY_AQUATIC', src: 'src/abilities.cc:4047', addsType: 'WATER' },
  { id: 'ABILITY_BRUISER', src: 'src/abilities.cc:11136', addsType: 'FIGHTING' },
  { id: 'ABILITY_DRAGONFLY', src: 'src/abilities.cc:4063', addsType: 'DRAGON', flags: { breakable: true, levitate: true } },
  { id: 'ABILITY_DRAGONFRUIT', src: 'src/abilities.cc:11194', addsType: 'DRAGON' },
  { id: 'ABILITY_FAIRY_TALE', src: 'src/abilities.cc:5804', addsType: 'FAIRY' },
  { id: 'ABILITY_FEY_FLIGHT', src: 'src/abilities.cc:10182', addsType: 'FAIRY', flags: { breakable: true, levitate: true } },
  { id: 'ABILITY_GROUNDED', src: 'src/abilities.cc:3905', addsType: 'GROUND' },
  { id: 'ABILITY_HALF_DRAKE', src: 'src/abilities.cc:4041', addsType: 'DRAGON' },
  { id: 'ABILITY_HOVER', src: 'src/abilities.cc:8857', addsType: 'PSYCHIC', flags: { breakable: true, levitate: true } },
  { id: 'ABILITY_ICE_AGE', src: 'src/abilities.cc:4035', addsType: 'ICE' },
  { id: 'ABILITY_KOMODO', src: 'src/abilities.cc:10234', addsType: 'DRAGON' },
  { id: 'ABILITY_LIGHTNING_BORN', src: 'src/abilities.cc:10222', addsType: 'ELECTRIC' },
  { id: 'ABILITY_LIGHT_SABER', src: 'src/abilities.cc:10991', addsType: 'FIRE' },
  { id: 'ABILITY_METALLIC', src: 'src/abilities.cc:4109', addsType: 'STEEL' },
  { id: 'ABILITY_METALLIC_JAWS', src: 'src/abilities.cc:9676', addsType: 'STEEL', onParentalBond: aliasParentalBond('ABILITY_PRIMAL_MAW') },
  { id: 'ABILITY_PHANTOM', src: 'src/abilities.cc:4168', addsType: 'GHOST' },
  { id: 'ABILITY_ROCKY_EXTERIOR', src: 'src/abilities.cc:11181', addsType: 'ROCK' },
  // .onMoldBreaker = Impl<ABILITY_MOLD_BREAKER>.onMoldBreaker (alias, added
  // once onMoldBreaker joined the damage-hook census -- see batch W).
  { id: 'ABILITY_TERAVOLT', src: 'src/abilities.cc:2264', addsType: 'ELECTRIC', onMoldBreaker: aliasMoldBreaker('ABILITY_MOLD_BREAKER') },
  { id: 'ABILITY_TURBOBLAZE', src: 'src/abilities.cc:2257', addsType: 'FIRE', onMoldBreaker: aliasMoldBreaker('ABILITY_MOLD_BREAKER') },
  // .addsType = Impl<ABILITY_AQUATIC>.addsType == TYPE_WATER
  { id: 'ABILITY_WATERBORNE', src: 'src/abilities.cc:11728', addsType: 'WATER', flags: { adaptability: true } },
  {
    id: 'ABILITY_WITCH_BROOM',
    src: 'src/abilities.cc:11438',
    addsType: 'PSYCHIC',
    flags: { breakable: true, levitate: true },
    onParentalBond: aliasParentalBond('ABILITY_HYPER_AGGRESSIVE'),
  },
]
