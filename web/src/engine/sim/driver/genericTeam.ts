import type { PlayerMonSpec } from './buildParty'

/**
 * Fixed generic player team: six level-matched (Lv 50) Pokemon chosen from the data:
 * 1. Swampert (SPECIES_SWAMPERT): bulky physical water/ground attacker (Leftovers, Torrent).
 * 2. Garchomp (SPECIES_GARCHOMP): fast physical dragon/ground sweeper (Life Orb, Rough Skin).
 * 3. Scizor (SPECIES_SCIZOR): physical bug/steel priority pivot (Metal Coat, Technician).
 * 4. Gengar (SPECIES_GENGAR): fast special ghost/poison sweeper (Focus Sash, Levitate).
 * 5. Tyranitar (SPECIES_TYRANITAR): rock/dark tank with weather setter (Smooth Rock, Sand Stream).
 * 6. Blissey (SPECIES_BLISSEY): normal special wall and cleric (Heavy-Duty Boots, Natural Cure).
 */
export const GENERIC_PLAYER_SPECS: PlayerMonSpec[] = [
  {
    species: 'SPECIES_SWAMPERT',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spe: 4 },
    ability: 'ABILITY_TORRENT',
    item: 'ITEM_LEFTOVERS',
    moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH', 'MOVE_ROCK_SLIDE'],
  },
  {
    species: 'SPECIES_GARCHOMP',
    level: 50,
    nature: 'NATURE_JOLLY',
    evs: { atk: 252, spe: 252, hp: 4 },
    ability: 'ABILITY_ROUGH_SKIN',
    item: 'ITEM_LIFE_ORB',
    moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
  },
  {
    species: 'SPECIES_SCIZOR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, def: 4 },
    ability: 'ABILITY_TECHNICIAN',
    item: 'ITEM_METAL_COAT',
    moves: ['MOVE_BULLET_PUNCH', 'MOVE_BUG_BITE', 'MOVE_SWORDS_DANCE', 'MOVE_ROOST'],
  },
  {
    species: 'SPECIES_GENGAR',
    level: 50,
    nature: 'NATURE_TIMID',
    evs: { spatk: 252, spe: 252, hp: 4 },
    ability: 'ABILITY_LEVITATE',
    item: 'ITEM_FOCUS_SASH',
    moves: ['MOVE_SHADOW_BALL', 'MOVE_SLUDGE_BOMB', 'MOVE_THUNDERBOLT', 'MOVE_FOCUS_BLAST'],
  },
  {
    species: 'SPECIES_TYRANITAR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spdef: 4 },
    ability: 'ABILITY_SAND_STREAM',
    item: 'ITEM_SMOOTH_ROCK',
    moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'],
  },
  {
    species: 'SPECIES_BLISSEY',
    level: 50,
    nature: 'NATURE_BOLD',
    evs: { hp: 252, def: 252, spdef: 4 },
    ability: 'ABILITY_NATURAL_CURE',
    item: 'ITEM_HEAVY_DUTY_BOOTS',
    moves: ['MOVE_SEISMIC_TOSS', 'MOVE_SOFT_BOILED', 'MOVE_TOXIC', 'MOVE_THUNDER_WAVE'],
  },
]

