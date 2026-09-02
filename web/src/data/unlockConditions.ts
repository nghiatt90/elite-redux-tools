/** Manually curated Mega/Primal/Origin unlock text, keyed by the FORM species id
 * (e.g. `SPECIES_TYPHLOSION_MEGA`), not the base. This is narrative game-progression
 * info -- which trainer to beat, which NPC sells it, which location to search -- that
 * doesn't exist anywhere in the structured PBS/proto source the pipeline parses, so
 * unlike the rest of `data/v2.65beta/*.json` it can't be generated; it's transcribed
 * by hand from Elite Redux's own wiki draft doc:
 * https://raw.githubusercontent.com/Elite-Redux/eliteredux-source/upcoming/docs/er-wiki-google-docs.md
 * ("Special Mega Stones Locations" / "Primal Forms" sections, current as of 2026-09).
 *
 * Only species the wiki calls out by name are listed here. Every other Mega/Primal
 * falls back to the wiki's own stated default ("Most new M.Stones: Adoption Center
 * post-Norman") -- see `unlockConditionFor` below -- rather than guessing at specifics
 * this doc doesn't give.
 */
export const UNLOCK_CONDITIONS: Record<string, string> = {
  // Johto starter Mega Stones
  SPECIES_TYPHLOSION_MEGA: 'Ashen Woods (top right), defeat Kindler',
  SPECIES_MEGANIUM_MEGA: 'Verdanturf Meadow, defeat Aroma Lady',
  SPECIES_FERALIGATR_MEGA_X: 'Route 105 beach, defeat Sailor',
  SPECIES_FERALIGATR_MEGA_Y: 'Route 114, defeat Totem Pokémon',

  // Sinnoh starter Mega Stones
  SPECIES_TORTERRA_MEGA: 'Game Corner',
  SPECIES_TORTERRA_REDUX_MEGA: 'Game Corner',
  SPECIES_INFERNAPE_MEGA: 'Game Corner',
  SPECIES_INFERNAPE_REDUX_MEGA: 'Game Corner',
  SPECIES_EMPOLEON_MEGA: 'Game Corner',
  SPECIES_EMPOLEON_REDUX_MEGA: 'Game Corner',

  // New Totem fights
  SPECIES_BRELOOM_MEGA: 'North Petalburg Forest (New Area), Totem fight',
  SPECIES_SANDSLASH_MEGA: 'South of Route 111 (desert), Totem fight',
  SPECIES_HAXORUS_MEGA: 'Meteor Falls, defeat the trainer guarding the new zone opening',
  SPECIES_DEWGONG_MEGA: 'Seaspray Cave (2F), Totem fight',
  SPECIES_GYARADOS_MEGA_Y: 'Route 132, Totem fight',

  // Special Event Mega Stones
  SPECIES_LANTURN_MEGA: "From Wattson, after completing his quest",
  SPECIES_SLAKING_MEGA: 'From Norman, post-Winona',
  SPECIES_TOUCANNON_MEGA: "From Winona, for her badge",
  SPECIES_SLOWKING_MEGA: 'From Tate & Liza, for their badge',

  // Tough Opponent Mega Stones
  SPECIES_KROOKODILE_MEGA: 'Defeat the Ruin Maniac outside the Mirage Tower extra zone',
  SPECIES_NIDOKING_MEGA: 'Outside Rusturf Tunnel (Route 116), defeat the Ace Trainer',
  SPECIES_NIDOQUEEN_MEGA: 'Outside Rusturf Tunnel (Route 116), defeat the Ace Trainer',
  SPECIES_HITMONLEE_MEGA: 'Granite Cave (B2F), defeat the Black Belt (Fighting-type gauntlet)',
  SPECIES_HITMONCHAN_MEGA: 'Granite Cave (B2F), defeat the Black Belt (Fighting-type gauntlet)',
  SPECIES_HITMONTOP_MEGA: 'Granite Cave (B2F), defeat the Black Belt (Fighting-type gauntlet)',
  SPECIES_DRAGONITE_MEGA: 'Sky Pillar, beat the gauntlet',
  SPECIES_DRAGONITE_MEGA_Y: 'Sky Pillar, beat the gauntlet',
  SPECIES_SHEDINJA_MEGA: 'Abandoned Ship (hidden room), defeat the Bug Catcher',
  SPECIES_CROBAT_MEGA: 'Dewford Mansion, from the old lady',
  SPECIES_GRANBULL_MEGA: 'Route 123, from the lady at the lake',

  // Spread on the overworld map
  SPECIES_LAPRAS_MEGA_X: 'Slateport Museum (top floor)',
  SPECIES_SHUCKLE_MEGA: 'Start of Cycling Road, north of Slateport',

  // Primal Forms
  SPECIES_TERAPAGOS_STELLAR: 'From the Ace Trainer by your house (Tera Orb)',
  SPECIES_ETERNATUS_ETERNAMAX: 'From the Ace Trainer by your house (Eternamax Orb)',
  SPECIES_NECROZMA_ULTRA: 'From the Ace Trainer by your house (Ultra Necrozmite)',
  SPECIES_ZACIAN_CROWNED_SWORD: 'From the Ace Trainer by your house (Crowned Sword)',
  SPECIES_ZAMAZENTA_CROWNED_SHIELD: 'From the Ace Trainer by your house (Crowned Shield)',
  SPECIES_CASCOON_PRIMAL: 'Deep in Petalburg Woods, across a surf spot',

  // Origin Formes (Sinnoh trio)
  SPECIES_DIALGA_ORIGIN: 'From Nurse Joy, first time you talk to her (Adamant Orb)',
  SPECIES_PALKIA_ORIGIN: 'From Nurse Joy, first time you talk to her (Lustrous Orb)',
  SPECIES_GIRATINA_ORIGIN: 'From Nurse Joy, first time you talk to her (Griseous Orb)',
}

/** Everything else defaults to the wiki's own stated default for ordinary Mega Stones. */
const DEFAULT_MEGA_UNLOCK = 'Adoption Center, after defeating Norman'

export function unlockConditionFor(formId: string): string {
  return UNLOCK_CONDITIONS[formId] ?? DEFAULT_MEGA_UNLOCK
}
