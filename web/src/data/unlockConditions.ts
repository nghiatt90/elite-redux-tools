/** Manually curated Mega/Primal/Origin unlock text, keyed by the FORM species id
 * (e.g. `SPECIES_TYPHLOSION_MEGA`), not the base. This is narrative game-progression
 * info -- which trainer to beat, which badge gates it, which NPC hands it over -- that
 * doesn't exist anywhere in the structured PBS/proto source the pipeline parses.
 *
 * Every entry below was confirmed by reading the actual, live trigger in Elite
 * Redux's own map scripts (`data/maps/<Map>/scripts.pory` in
 * Elite-Redux/eliteredux-source, `upcoming` branch, checked 2026-09) -- the
 * `flag(FLAG_BADGEnn_GET)` gate (or its absence) and the `giveitem`/
 * `setwildbattle...` call that hands over the item, in a script block that's
 * genuinely reachable from that map's own dialogue/event tree. That bar exists
 * because two earlier, less careful passes each shipped wrong claims:
 *
 * 1. A first version transcribed only the community wiki's own informal draft doc
 *    (docs/er-wiki-google-docs.md) at face value. Checking it against the scripts
 *    surfaced several real errors: it omitted the specific badge gate on multiple
 *    Totem/trainer fights (Dewgong, Gyarados Y, Hitmon trio, Dragonite, Krookodile);
 *    it called Toucannonite and Slowkingite badge rewards ("for Winona's/Tate &
 *    Liza's badge") when both are actually POSTGAME gifts from a Champion-rematch
 *    dialogue tree (`FortreeCity_Gym_EventScript_GiveRoost`,
 *    `MossdeepCity_Gym_EventScript_GiveCalmMind`); it described Primal Cascoon as
 *    just a location when it's gated on `FLAG_SYS_GAME_CLEAR`.
 * 2. A second version, trying to fix the above, still claimed Charizardite X/Y are
 *    hidden items in Fiery Path / Ember Path based on finding script LABELS named
 *    for them in `data/scripts/item_ball_scripts.inc` -- without checking whether
 *    either map actually places that script anywhere. It doesn't: both maps'
 *    `bg_events` (where hidden items live) are empty, and `FieryPath`/`EmberPath`'s
 *    own `scripts.pory` never reference the label at all. Dead scaffolding, not a
 *    real in-game location. Likewise the Primal Forms (Tera Orb etc.) and Origin
 *    Formes (Nurse Joy's orbs) entries were sourced only from the wiki draft's
 *    prose and dropped here after no map script could be found that actually grants
 *    them -- they may be real, but not confirmed the same way as everything else
 *    below, so they're not asserted as fact.
 *
 * Deliberately incomplete: there are ~275 Mega/Primal/Origin forms in total and only
 * the ones below have been individually confirmed this way. Everything else falls
 * back to `DEFAULT_MEGA_UNLOCK` / a generic Primal fallback rather than a specific
 * claim that hasn't been checked against a live script.
 */
export const UNLOCK_CONDITIONS: Record<string, string> = {
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

  // Gated on the Mind Badge (defeat Tate & Liza) -- badge07
  SPECIES_DEWGONG_MEGA: 'Seaspray Cave (B1F), Totem Dewgong -- requires the Mind Badge (Tate & Liza)',
  SPECIES_GYARADOS_MEGA_Y: 'Route 132, Totem Gyarados -- requires the Mind Badge (Tate & Liza)',
  SPECIES_CROBAT_MEGA: 'Dewford Manor, defeat the old lady -- requires the Mind Badge (Tate & Liza)',
  SPECIES_GRANBULL_MEGA: 'Route 123, defeat the lady by the lake -- requires the Mind Badge (Tate & Liza)',

  // Postgame gifts, from a Champion-rematch dialogue with the gym leader
  SPECIES_TOUCANNON_MEGA: 'Postgame gift from Winona, in a rematch with her as reigning Champion (Fortree Gym)',
  SPECIES_SLOWKING_MEGA: 'Postgame gift from Liza, in a rematch with Tate & Liza as reigning Champions (Mossdeep Gym)',

  // Sidequest-gated, no badge involved
  SPECIES_LANTURN_MEGA: 'From Wattson in Mauville City, after completing his New Mauville quest',

  // Postgame (game clear)
  SPECIES_CASCOON_PRIMAL: 'Deep in Petalburg Woods, across a surf spot -- only after beating the Champion',
}

/** Every Mega Evolution -- whichever specific stone it needs -- also needs the Mega
 * Bracelet itself, a one-time prerequisite Norman hands you along with a starter set
 * of Mega Stones right before your 5th gym battle (Petalburg Gym, `scripts.pory`
 * case 6: `giveitem(ITEM_MEGA_BRACELET)`, gated on all 4 prior badges). That's the
 * honest default for any Mega whose specific stone location hasn't been individually
 * confirmed (see UNLOCK_CONDITIONS above) -- unlike a made-up location, it's actually
 * true of every single one of them.
 */
export const DEFAULT_MEGA_UNLOCK = 'Requires the Mega Bracelet, from Norman (after 4 Badges)'

export function unlockConditionFor(formId: string): string | undefined {
  return UNLOCK_CONDITIONS[formId]
}
