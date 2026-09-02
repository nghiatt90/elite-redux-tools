/** Manually curated Mega/Primal/Origin unlock text, keyed by the FORM species id
 * (e.g. `SPECIES_TYPHLOSION_MEGA`), not the base. This is narrative game-progression
 * info -- which trainer to beat, which badge gates it, which NPC hands it over -- that
 * doesn't exist anywhere in the structured PBS/proto source the pipeline parses.
 *
 * Every entry here has been verified against Elite Redux's own map event scripts
 * (`data/maps/<Map>/scripts.pory` in Elite-Redux/eliteredux-source, `upcoming`
 * branch, checked 2026-09) -- specifically the `flag(FLAG_BADGEnn_GET)` gate (or its
 * absence) and the `giveitem`/`setwildbattle...` call that actually hands over the
 * item. This replaces an earlier version transcribed only from the community wiki's
 * own informal draft doc (docs/er-wiki-google-docs.md), which turned out wrong in
 * several places once checked against the scripts themselves -- notably: it claims
 * Norman personally hands out "vanilla" Mega Stones including Charizardite, but
 * Charizardite X/Y are actually unconditioned hidden items (Fiery Path / Ember Path)
 * with no story gate at all; it lists several Totem/trainer fights (Dewgong,
 * Gyarados Y, Hitmon trio, Dragonite, Krookodile) without mentioning they also each
 * require a specific badge; it calls Toucannonite a reward "for Winona's badge" when
 * it's actually a postgame gift from a rematch with her as reigning Champion; and it
 * describes Primal Cascoon as just a location when it's actually gated on having
 * cleared the game. Lesson applied: don't ship narrative text sourced only from an
 * informal paraphrase without checking the scripts that actually implement it.
 *
 * Deliberately incomplete: there are ~275 Mega/Primal/Origin forms in total and only
 * the ones below have been individually checked. Everything else falls back to the
 * plain, always-true "via held item" (see `unlockConditionFor`) rather than guessing
 * at specifics that haven't been verified the same way.
 */
export const UNLOCK_CONDITIONS: Record<string, string> = {
  // Hidden items, no story gate at all
  SPECIES_CHARIZARD_MEGA_X: 'Hidden item in Fiery Path',
  SPECIES_CHARIZARD_MEGA_Y: 'Hidden item in Ember Path',

  // Gated on the Balance Badge (defeat Norman) -- badge05
  SPECIES_TYPHLOSION_MEGA: 'Ashen Woods (top right), defeat Kindler -- requires the Balance Badge (Norman)',
  SPECIES_MEGANIUM_MEGA: 'Verdanturf Meadow, defeat the Aroma Lady -- requires the Balance Badge (Norman)',
  SPECIES_FERALIGATR_MEGA_X: 'Route 105 beach, defeat the Sailor -- requires the Balance Badge (Norman)',
  SPECIES_FERALIGATR_MEGA_Y: 'Route 114, Totem Feraligatr -- requires the Balance Badge (Norman)',
  SPECIES_BRELOOM_MEGA: 'North Petalburg Forest (New Area), Totem Breloom -- requires the Balance Badge (Norman)',
  SPECIES_SANDSLASH_MEGA: 'South of Route 111 (desert), Totem Sandslash -- requires the Balance Badge (Norman)',
  SPECIES_KROOKODILE_MEGA:
    'Route 111, defeat the treasure hunter outside the ruins -- requires the Balance Badge (Norman)',
  SPECIES_NIDOKING_MEGA: 'Route 116, outside Rusturf Tunnel -- requires the Balance Badge (Norman)',
  SPECIES_NIDOQUEEN_MEGA: 'Route 116, outside Rusturf Tunnel -- requires the Balance Badge (Norman)',
  SPECIES_SLAKING_MEGA: 'From Norman himself, back at Petalburg Gym -- requires the Feather Badge (Winona)',

  // Gated on the Feather Badge (defeat Winona) -- badge06
  SPECIES_HITMONLEE_MEGA: 'Granite Cave (B2F), defeat the Black Belt -- requires the Feather Badge (Winona)',
  SPECIES_HITMONCHAN_MEGA: 'Granite Cave (B2F), defeat the Black Belt -- requires the Feather Badge (Winona)',
  SPECIES_HITMONTOP_MEGA: 'Granite Cave (B2F), defeat the Black Belt -- requires the Feather Badge (Winona)',
  SPECIES_DRAGONITE_MEGA: 'Sky Pillar, defeat the trio of Sages guarding it -- requires the Feather Badge (Winona)',
  SPECIES_DRAGONITE_MEGA_Y:
    'Sky Pillar, defeat the trio of Sages guarding it -- requires the Feather Badge (Winona)',
  SPECIES_TOUCANNON_MEGA: "Gift from Winona at Fortree Gym, in a postgame rematch as the reigning Champion",

  // Gated on the Mind Badge (defeat Tate & Liza) -- badge07
  SPECIES_DEWGONG_MEGA: 'Seaspray Cave (B1F), Totem Dewgong -- requires the Mind Badge (Tate & Liza)',
  SPECIES_GYARADOS_MEGA_Y: 'Route 132, Totem Gyarados -- requires the Mind Badge (Tate & Liza)',
  SPECIES_CROBAT_MEGA: 'Dewford Manor, defeat the old lady -- requires the Mind Badge (Tate & Liza)',
  SPECIES_GRANBULL_MEGA: 'Route 123, defeat the lady by the lake -- requires the Mind Badge (Tate & Liza)',
  SPECIES_SLOWKING_MEGA: 'From Tate & Liza, for the Mind Badge',
  SPECIES_SLOWKING_MEGA_GALARIAN: 'From Tate & Liza, for the Mind Badge',

  // Sidequest-gated, no badge involved
  SPECIES_LANTURN_MEGA: "From Wattson in Mauville City, after completing his New Mauville quest",

  // Postgame (game clear)
  SPECIES_CASCOON_PRIMAL: 'Deep in Petalburg Woods, across a surf spot -- only after beating the Champion',

  // Primal Forms: Ace Trainer by your house
  SPECIES_TERAPAGOS_STELLAR: 'From the Ace Trainer by your house (Tera Orb)',
  SPECIES_ETERNATUS_ETERNAMAX: 'From the Ace Trainer by your house (Eternamax Orb)',
  SPECIES_NECROZMA_ULTRA: 'From the Ace Trainer by your house (Ultra Necrozmite)',
  SPECIES_ZACIAN_CROWNED_SWORD: 'From the Ace Trainer by your house (Crowned Sword)',
  SPECIES_ZAMAZENTA_CROWNED_SHIELD: 'From the Ace Trainer by your house (Crowned Shield)',

  // Origin Formes (Sinnoh trio): Nurse Joy, first talk
  SPECIES_DIALGA_ORIGIN: 'From Nurse Joy, first time you talk to her (Adamant Orb)',
  SPECIES_PALKIA_ORIGIN: 'From Nurse Joy, first time you talk to her (Lustrous Orb)',
  SPECIES_GIRATINA_ORIGIN: 'From Nurse Joy, first time you talk to her (Griseous Orb)',
}

export function unlockConditionFor(formId: string): string | undefined {
  return UNLOCK_CONDITIONS[formId]
}
