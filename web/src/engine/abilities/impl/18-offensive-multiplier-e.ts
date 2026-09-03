// Batch P: onOffensiveMultiplier composites/aliases whose delegate targets have all
// landed in earlier batches by now (Liquid Voice, Iron Fist, Strong Jaw, Analytic,
// Neuroforce, Mega Launcher, Foul Energy, Tough Claws, Levitate, Flock, Sniper),
// plus the 4 "sound Normal move -> X type" hand-written onMoveType lambdas that
// turned out to be a straightforward variant of the ATE_ABILITY pattern (NOT the
// reversed "convert every move to Normal" mechanism Normalize itself needs) once
// actually read against the C.

import { aliasOffensiveMultiplier } from './alias'
import type { AbilityImpl, OnMoveTypeContext } from '../types'

function soundAteAbility(id: string, src: string, type: string): AbilityImpl {
  return {
    id,
    src,
    // Unlike ATE_ABILITY(type), these don't set ateBoost=TRUE -- faithful to the
    // C, which has no such assignment in this hand-written form.
    onMoveType: (ctx: OnMoveTypeContext) => {
      if (ctx.moveType === 'NORMAL' && ctx.moveFlags?.sound) ctx.moveType = type
    },
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_LIQUID_VOICE'),
  }
}

export const OFFENSIVE_MULTIPLIER_BATCH_E: AbilityImpl[] = [
  soundAteAbility('ABILITY_BANSHEE', 'src/abilities.cc:6810', 'GHOST'),
  soundAteAbility('ABILITY_POWER_METAL', 'src/abilities.cc:8172', 'STEEL'),
  soundAteAbility('ABILITY_SAND_SONG', 'src/abilities.cc:3672', 'GROUND'),
  soundAteAbility('ABILITY_SNOW_SONG', 'src/abilities.cc:7823', 'ICE'),

  { id: 'ABILITY_MAGICAL_FISTS', src: 'src/abilities.cc:9131', onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_IRON_FIST') },
  { id: 'ABILITY_POWER_FISTS', src: 'src/abilities.cc:3663', onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_IRON_FIST') },
  {
    // Referenced by ABILITY_GNASHING_CANNON's composite below.
    id: 'ABILITY_MIND_CRUSH',
    src: 'src/abilities.cc:7230',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_STRONG_JAW'),
  },

  {
    id: 'ABILITY_CALCULATIVE',
    src: 'src/abilities.cc:9683',
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_ANALYTIC')(ctx)
      aliasOffensiveMultiplier('ABILITY_NEUROFORCE')(ctx)
    },
  },
  {
    id: 'ABILITY_GNASHING_CANNON',
    src: 'src/abilities.cc:10261',
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_MEGA_LAUNCHER')(ctx)
      aliasOffensiveMultiplier('ABILITY_MIND_CRUSH')(ctx)
    },
  },
  {
    id: 'ABILITY_REAPERS_EMBARCE',
    src: 'src/abilities.cc:12542',
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_FOUL_ENERGY')(ctx)
      aliasOffensiveMultiplier('ABILITY_TOUGH_CLAWS')(ctx)
    },
  },
  {
    id: 'ABILITY_AERIALIST',
    src: 'src/abilities.cc:7651',
    flags: { breakable: true, levitate: true },
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_LEVITATE')(ctx)
      aliasOffensiveMultiplier('ABILITY_FLOCK')(ctx)
    },
  },
  {
    // The extra "0.5x during a processed extra attack" half needs a multi-hit/
    // extra-attack simulation state this engine doesn't have -- Sniper's own
    // crit-boost half is ported, the extra-attack condition is a documented gap.
    id: 'ABILITY_SUPER_SNIPER',
    src: 'src/abilities.cc:9798',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_SNIPER'),
  },
]
