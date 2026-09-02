/** Some "special formes" -- alternate species with their own stats/abilities, not
 * reached via level-up evolution or a Mega/Primal item -- are gift Pokémon handed
 * over by a specific NPC or event, rather than caught. Not proto data (no field for
 * "how a species itself is obtained" exists in SpeciesList.proto), so -- same
 * discipline as the Mega Stone hints in items.json -- every entry here has been
 * read directly out of the live map/C script that grants it, not inferred or
 * paraphrased from a wiki/guide.
 *
 * Checked in evolutionChain.ts/PokedexDetail.tsx BEFORE the Mega/Primal item-hint
 * lookup, not after: 3 of the Mystery Gift species below (Pikachu/Eevee/Meowth
 * Partner) have their own Mega form, and the mega stone they need (Pikanite/Eevite/
 * Meowthite) has no `megaStoneHint` of its own in items.json -- it's handed over
 * already held by the Partner gift mon itself, a fact that lives only in the
 * mysteryGiftData table below, not on the item. Giving GIFT_MON_UNLOCK priority
 * means those 3 Mega forms show the real answer instead of "Unknown unlock method."
 *
 * Sources, all in Elite-Redux/eliteredux-source (`upcoming` branch, checked 2026-09):
 *
 * - `data/maps/EvergrandeCity_MonoChampRoom_1/scripts.pory`: 18 Monotype Champions
 *   (Evergrande City, postgame), one per type. 6 of the 18 hand over a bare item
 *   instead (already covered by items.json's own `megaStoneHint.uniqueLocation`,
 *   e.g. "Defeat the Ghost Monotype Champion." on Phantom Meteor) -- the 12 below
 *   hand over a whole Pokémon (sometimes ALSO holding that type's own mega stone,
 *   e.g. Mimikyu Apex comes holding Phantom Meteor).
 * - `data/maps/Route110_TrickHouseEnd/scripts.pory`: vanilla Emerald's 8-level Trick
 *   House puzzle (Route 110), repurposed here to reward a Cap Pikachu per level
 *   instead of the usual TM/item -- `switch VAR_TRICK_HOUSE_LEVEL` / `case 0..7`,
 *   one `givecustommon` each, in level order.
 * - `data/maps/FallarborTown_CozmosHouse/scripts.pory`: hand Professor Cozmo the
 *   Meteorite (an existing sidequest item) for Pikachu Ph.D.
 * - `src/field_specials.c`'s `GetMysteryGiftSpecies()`: a genuine Mystery Gift
 *   table, `mysteryGiftData[][4]` (species, held item, received-flag, requirement-
 *   flag), served by a Pokémon Center NPC (`PKMN_Center_EventScript_Mystery_Gift`
 *   in `data/scripts/pokemon_center_move_tutor.inc`). The NPC hands out whichever
 *   table row is earliest in array order among ones the player is both eligible for
 *   and hasn't already received -- sequential, not independently triggerable per
 *   species, so "Mystery Gift NPC" here means "eventually, once eligible," not "on
 *   demand." One row (Ogerpon's) is short an element in the source itself --
 *   `{SPECIES_OGERPON, FLAG_RECEIVED_OGERPON, FLAG_BADGE08_GET}` against a `[4]`
 *   row type -- which silently shifts every field after the missing item one slot
 *   over at runtime; flagged rather than asserting a badge that may not be the one
 *   actually checked.
 *
 * Checked but NOT found anywhere in data/maps or src/*.c at all (so left with no
 * entry here, same "not confirmed" honesty as items.json's own "Unknown unlock
 * method." default): SPECIES_PIKACHU_BELLE, _LIBRE, _POP_STAR, _ROCK_STAR, _COSPLAY.
 */
export const GIFT_MON_UNLOCK: Record<string, string> = {
  // Monotype Champions (Evergrande City, postgame)
  SPECIES_BEWEAR_ANGRY: 'Defeat the Fighting Monotype Champion.',
  SPECIES_SPECTRIER_CLOUD: 'Defeat the Flying Monotype Champion.',
  SPECIES_MAWILE_REDUX_B: 'Defeat the Poison Monotype Champion.',
  SPECIES_WEAVILE_REDUX: 'Defeat the Ground Monotype Champion.',
  SPECIES_SOLROCK_SYSTEM: 'Defeat the Rock Monotype Champion.',
  SPECIES_RIBOMBEE_REDUX: 'Defeat the Bug Monotype Champion.',
  SPECIES_MIMIKYU_APEX: 'Defeat the Ghost Monotype Champion.',
  SPECIES_LEDIAN_PARADOX: 'Defeat the Steel Monotype Champion.',
  SPECIES_FLYGON_REDUX_B: 'Defeat the Electric Monotype Champion.',
  SPECIES_DRAGONITE_DELIVERY: 'Defeat the Dragon Monotype Champion.',
  SPECIES_DARKRAI_NIGHTMARE: 'Defeat the Dark Monotype Champion.',
  SPECIES_WIGGLYTUFF_APEX: 'Defeat the Fairy Monotype Champion.',

  // Trick House puzzle rewards (Route 110), one per level 1-8
  SPECIES_PIKACHU_ORIGINAL_CAP: 'Complete Trick House Puzzle 1 (Route 110).',
  SPECIES_PIKACHU_HOENN_CAP: 'Complete Trick House Puzzle 2 (Route 110).',
  SPECIES_PIKACHU_SINNOH_CAP: 'Complete Trick House Puzzle 3 (Route 110).',
  SPECIES_PIKACHU_UNOVA_CAP: 'Complete Trick House Puzzle 4 (Route 110).',
  SPECIES_PIKACHU_KALOS_CAP: 'Complete Trick House Puzzle 5 (Route 110).',
  SPECIES_PIKACHU_ALOLA_CAP: 'Complete Trick House Puzzle 6 (Route 110).',
  SPECIES_PIKACHU_PARTNER_CAP: 'Complete Trick House Puzzle 7 (Route 110).',
  SPECIES_PIKACHU_WORLD_CAP: 'Complete Trick House Puzzle 8 (Route 110).',

  // Sidequest reward
  SPECIES_PIKACHU_PH_D: 'Give Professor Cozmo the Meteorite (Fallarbor Town).',

  // Mystery Gift NPC (Pokémon Center) -- requires the Heat Badge (Flannery)
  SPECIES_GRENINJA_BATTLE_BOND: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery).',
  SPECIES_CHESNAUGHT_BATTLE_BOND: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery).',
  SPECIES_DELPHOX_BATTLE_BOND: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery).',
  SPECIES_PIKACHU_PARTNER: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery). Comes holding Pikanite.',
  SPECIES_EEVEE_PARTNER: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery). Comes holding Eevite.',
  SPECIES_MEOWTH_PARTNER: 'Mystery Gift NPC (Pokémon Center), once you have the Heat Badge (Flannery). Comes holding Meowthite.',
  SPECIES_PIKACHU_PARTNER_MEGA: 'Comes bundled with Pikachu Partner (Mystery Gift NPC, Pokémon Center) -- holding Pikanite.',
  SPECIES_EEVEE_PARTNER_MEGA: 'Comes bundled with Eevee Partner (Mystery Gift NPC, Pokémon Center) -- holding Eevite.',
  SPECIES_MEOWTH_PARTNER_MEGA: 'Comes bundled with Meowth Partner (Mystery Gift NPC, Pokémon Center) -- holding Meowthite.',

  // Mystery Gift NPC (Pokémon Center) -- requires the Mind Badge (Tate & Liza)
  SPECIES_REGIDRAGO: 'Mystery Gift NPC (Pokémon Center), once you have the Mind Badge (Tate & Liza).',
  SPECIES_REGIELEKI: 'Mystery Gift NPC (Pokémon Center), once you have the Mind Badge (Tate & Liza).',

  // Mystery Gift NPC (Pokémon Center) -- requires the Feather Badge (Winona)
  SPECIES_FLOETTE_ETERNAL_FLOWER: 'Mystery Gift NPC (Pokémon Center), once you have the Feather Badge (Winona).',

  // Mystery Gift NPC (Pokémon Center) -- requires beating the Champion
  SPECIES_MELOETTA: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_SILVALLY: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_CALYREX: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_KELDEO: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ZYGARDE_10: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_TERAPAGOS: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_VOLCANION: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ENAMORUS: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ETERNATUS: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_CHI_YU: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_WO_CHIEN: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_CHIEN_PAO: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_TING_LU: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ZACIAN: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ZAMAZENTA: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ZYGARDE_10_POWER_CONSTRUCT: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',

  // Mystery Gift NPC (Pokémon Center) -- this row is missing its item field in
  // Elite Redux's own source, which shifts every field after it one slot over, so
  // the actual runtime requirement can't be stated with confidence.
  SPECIES_OGERPON: 'Mystery Gift NPC (Pokémon Center) -- exact requirement unconfirmed.',
}
