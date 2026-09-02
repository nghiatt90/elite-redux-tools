/** Some species aren't caught in the wild the normal way -- "special formes" handed
 * over by a specific NPC/event, and a good number of legendaries/mythicals that are
 * fixed, one-time static encounters at a specific map (Elite Redux keeps the vanilla
 * Emerald static-encounter locations for the Gen 1-3 legendary birds/beasts/Regis/
 * Eon duo/weather trio, plus its own additions for later gens). Not proto data (no
 * field for "how a species itself is obtained" exists in SpeciesList.proto), so --
 * same discipline as the Mega Stone hints in items.json -- every entry here has been
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
 * - One `scripts.pory` per static legendary, each its own map (kept from vanilla
 *   Emerald almost unchanged: Shoal Cave/New Mauville/Ember Path/Altering Cave/
 *   Faraway Island/Navel Rock for the birds+beasts+Mewtwo+Mew, Desert Ruins/Island
 *   Cave/Ancient Tomb/Sealed Chamber for the Regis, Southern Island for the Eon duo,
 *   Marine Cave/Terra Cave/Sky Pillar for the weather trio, plus Elite Redux's own
 *   additions: Meteor Falls for Jirachi, Birth Island for Deoxys, Scorched Slab for
 *   Heatran, Cave of Origin for Diancie). Verified via the actual catch command
 *   (`setwildbattle`, or `special CreateEventLegalEnemyMon` immediately followed by
 *   `BattleSetup_StartLegendaryBattle`/`_StartLatiBattle`), not just a species-name
 *   match in the file -- an earlier draft of this file got Kyogre/Groudon/Rayquaza
 *   wrong exactly that way: all 3 appear in `SootopolisCity`'s `scripts.pory`, but
 *   only via `playmoncry` against a `script: '0x0'` (non-interactive) map.json
 *   object -- purely the story cutscene where they clash, not a catchable encounter.
 *   The real ones are `MarineCave_End`/`TerraCave_End`/`SkyPillar_Top`, each with a
 *   real `setwildbattle`. Regigigas (Sealed Chamber) additionally requires
 *   Regirock+Regice+Registeel already in the party (`CheckSpeciesInParty`); Latias/
 *   Latios (Southern Island) is the vanilla mechanic where one is static and the
 *   other roams the region (`VAR_ROAMER_POKEMON`).
 * - `data/maps/LittlerootTown_ProfessorBirchsLab/scripts.pory`: Cosmog, from
 *   Professor Birch. Gated on `VAR_DEX_UPGRADE_JOHTO_STARTER_STATE == 1`, which the
 *   file's own comment defines as "Beat Elite Four, Dex upgrade ready" -- i.e. the
 *   National Dex upgrade itself (and Cosmog with it) is a POSTGAME event here, not
 *   the early-game one vanilla Emerald has. (An earlier draft of this file had this
 *   backwards, assuming the vanilla-standard early timing without checking.)
 * - `data/maps/MossdeepCity_StevensHouse/scripts.pory` + its `map.json`: Meltan, a
 *   Poké Ball object on the floor of Steven's house, holding Melmetalite (matches
 *   Melmetalite's own `unique_mega_location` text in items.json). Checked for a
 *   champion/game-clear gate on this specifically (the object's own `map.json` flag,
 *   the giving script, the warp into the house, and where Dive -- needed to reach
 *   Mossdeep -- is first given, at the Space Center mid-story) and found none; an
 *   earlier draft of this file wrongly attributed a `FLAG_SYS_GAME_CLEAR` check on
 *   an unrelated object in the same room to this one. Kept unqualified since nothing
 *   found supports a gate, but this is a narrower search than a full playthrough
 *   would be -- flag if it turns out to be wrong in practice. Melmetal itself isn't
 *   listed separately -- it's Meltan's normal level-up evolution (level 55), already
 *   shown by the Evolution section.
 *
 * NOT listed despite looking like candidates -- confirmed as ordinary, unconditioned
 * wild encounters instead (`src/data/wild_encounters.json`, `MAP_VICTORY_ROAD_REWORK`
 * -- the literal path from Ever Grande City to the Elite Four, walked in the normal
 * course of the main story, nothing postgame about it despite the "Rework" name,
 * which just means "redesigned map"): Ogerpon, Raikou, Entei, Suicune, Uxie,
 * Mesprit, Azelf, Cobalion, Terrakion, Virizion, and the 3 Galarian legendary birds.
 * None of Elite Redux's ~1800 other wild-encounter species get an entry in this file
 * either -- these don't need one any more than they do.
 *
 * - `data/maps/Route<N>/scripts.pory` (Routes 109, 111, 113-121, 123, 127-134, plus
 *   VictoryRoad_1F/B1F/B2F), each with its own `EventScript_LegendaryNPC` -- a
 *   "Sage" who explicitly names a legendary/mythical/Ultra-Beast (trio, in most
 *   cases) tied to that specific route, and, once you're champion, gates a DexNav
 *   reveal of them on a route-specific "defeat every trainer here" condition. The
 *   species aren't in any encounter table this pipeline's own checks could find
 *   (no `setwildbattle`/`CreateEventLegalEnemyMon`/`wild_encounters.json` row) --
 *   per the player, the Sage's reveal genuinely opens a new encounter table on
 *   that route once both conditions are met, presumably wired up somewhere this
 *   session's searches didn't reach (a DexNav-specific spawn mechanism, most
 *   likely). Listed on that basis. Route113's "legendary birds trio" (Articuno/
 *   Zapdos/Moltres by name) and Route114's "Legendary beastly trio" (Raikou/
 *   Entei/Suicune by name) are NOT re-listed under their Sage, despite being
 *   named there too -- both already have a separately-confirmed, code-verified
 *   path (the Gen 1-3 static encounters below; the unconditioned Victory Road
 *   wild encounter, respectively), and a postgame-quest framing would be
 *   incomplete for a species that's also available before that.
 *
 * Checked but NOT found anywhere in data/maps, src/*.c, or wild_encounters.json,
 * including no Sage NPC referencing them -- so left with no entry here, same "not
 * confirmed" honesty as items.json's own "Unknown unlock method." default:
 * - The remaining Pikachu cosmetic forms: _BELLE, _LIBRE, _POP_STAR, _ROCK_STAR, _COSPLAY.
 * - Plain SPECIES_DARKRAI and SPECIES_SPECTRIER (only their Monotype Champion gift
 *   formes, _NIGHTMARE and _CLOUD, are confirmed).
 * - The 4 Tapus' remaining 2 (Tapu Lele, Tapu Fini -- Koko and Bulu are Route128's
 *   Sage), Cosmoem, Solgaleo, Lunala, base Melmetal, Kubfu, Urshifu, Zarude,
 *   Koraidon, Miraidon, Okidogi, Munkidori, Fezandipiti, Pecharunt. Route132/133's
 *   Sages each promise unnamed additional Ultra Beasts too vague to assign a
 *   species to ("some more Ultra Beasts", "some of the Ultra Beasts").
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
  // Also promised by VictoryRoad_B2F's Sage (postgame, defeat every trainer there,
  // DexNav reveal) -- Mystery Gift already covers it unconditionally once eligible.
  SPECIES_CALYREX: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  // Also promised by Route117's Sage (postgame, defeat every trainer there, DexNav
  // reveal) -- Mystery Gift already covers it unconditionally once eligible.
  SPECIES_KELDEO: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_ZYGARDE_10: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  SPECIES_TERAPAGOS: 'Mystery Gift NPC (Pokémon Center), after beating the Champion.',
  // Also promised by Route127's Sage (postgame, defeat every trainer there, DexNav
  // reveal) -- Mystery Gift already covers it unconditionally once eligible.
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

  // Ogerpon is NOT listed here -- its Mystery Gift row is malformed (see doc comment
  // above) AND it's simply a normal wild encounter in Victory Road
  // (src/data/wild_encounters.json, MAP_VICTORY_ROAD_REWORK), same as any other
  // route Pokémon, so it needs no special explanation at all -- the malformed
  // Mystery Gift row is very likely just dead/leftover code.

  // Sage NPC quest-lines: postgame, defeat every trainer on the named route, then
  // the Sage reveals the species on your DexNav.
  SPECIES_HOOPA: 'Postgame; Sage NPC on Route 109 (defeat every trainer there).',
  SPECIES_XURKITREE: 'Postgame; Sage NPC on Route 134 (defeat every trainer there).',
  SPECIES_STAKATAKA: 'Postgame; Sage NPC on Route 134 (defeat every trainer there).',
  SPECIES_BLACEPHALON: 'Postgame; Sage NPC on Route 134 (defeat every trainer there).',
  SPECIES_VIRIZION: 'Postgame; Sage NPC on Route 121 (defeat every trainer there).',
  SPECIES_COBALION: 'Postgame; Sage NPC on Route 121 (defeat every trainer there).',
  SPECIES_TERRAKION: 'Postgame; Sage NPC on Route 121 (defeat every trainer there).',
  SPECIES_MANAPHY: 'Postgame; Sage NPC on Route 118 (defeat every trainer there).',
  SPECIES_PHIONE: 'Postgame; Sage NPC on Route 118 (defeat every trainer there).',
  SPECIES_CELEBI: 'Postgame; Sage NPC on Route 118 (defeat every trainer there).',
  SPECIES_DARKRAI: 'Postgame; Sage NPC on Route 117 (defeat every trainer there).',
  SPECIES_CRESSELIA: 'Postgame; Sage NPC on Route 117 (defeat every trainer there).',
  SPECIES_TYPE_NULL: 'Postgame; Sage NPC on Victory Road (B1F) (defeat every trainer there).',
  SPECIES_MARSHADOW: 'Postgame; Sage NPC on Victory Road (B1F) (defeat every trainer there).',
  SPECIES_NECROZMA: 'Postgame; Sage NPC on Route 131 (defeat every trainer there).',
  SPECIES_RESHIRAM: 'Postgame; Sage NPC on Route 123 (defeat every trainer there).',
  SPECIES_ZEKROM: 'Postgame; Sage NPC on Route 123 (defeat every trainer there).',
  SPECIES_KYUREM: 'Postgame; Sage NPC on Route 123 (defeat every trainer there).',
  SPECIES_DIALGA: 'Postgame; Sage NPC on Route 116 (defeat every trainer there).',
  SPECIES_PALKIA: 'Postgame; Sage NPC on Route 116 (defeat every trainer there).',
  SPECIES_GIRATINA: 'Postgame; Sage NPC on Route 116 (defeat every trainer there).',
  SPECIES_TAPU_KOKO: 'Postgame; Sage NPC on Route 128 (defeat every trainer there).',
  SPECIES_TAPU_BULU: 'Postgame; Sage NPC on Route 128 (defeat every trainer there).',
  SPECIES_GLASTRIER: 'Postgame; Sage NPC on Route 128 (defeat every trainer there).',
  SPECIES_XERNEAS: 'Postgame; Sage NPC on Route 111 (defeat every trainer there).',
  SPECIES_YVELTAL: 'Postgame; Sage NPC on Route 111 (defeat every trainer there).',
  SPECIES_ZYGARDE: 'Postgame; Sage NPC on Route 111 (defeat every trainer there).',
  SPECIES_TORNADUS: 'Postgame; Sage NPC on Route 120 (defeat every trainer there).',
  SPECIES_THUNDURUS: 'Postgame; Sage NPC on Route 120 (defeat every trainer there).',
  SPECIES_LANDORUS: 'Postgame; Sage NPC on Route 120 (defeat every trainer there).',
  SPECIES_ARCEUS: 'Postgame; Sage NPC on Route 119 (defeat every trainer there).',
  SPECIES_SHAYMIN: 'Postgame; Sage NPC on Route 119 (defeat every trainer there).',
  SPECIES_VICTINI: 'Postgame; Sage NPC on Route 119 (defeat every trainer there).',
  SPECIES_POIPOLE: 'Postgame; Sage NPC on Victory Road (1F) (defeat every trainer there).',
  SPECIES_NAGANADEL: 'Postgame; Sage NPC on Victory Road (1F) (defeat every trainer there).',
  SPECIES_ZERAORA: 'Postgame; Sage NPC on Victory Road (1F) (defeat every trainer there).',
  SPECIES_GENESECT: 'Postgame; Sage NPC on Route 127 (defeat every trainer there).',
  SPECIES_MAGEARNA: 'Postgame; Sage NPC on Route 127 (defeat every trainer there).',

  // Static encounters -- Gen 1-3 legendaries, vanilla Emerald locations
  SPECIES_ARTICUNO: 'Shoal Cave (Low Tide, Ice Room), static encounter.',
  SPECIES_ZAPDOS: 'New Mauville (Inside), static encounter.',
  SPECIES_MOLTRES: 'Ember Path, static encounter.',
  SPECIES_MEWTWO: 'Altering Cave (B1F), static encounter.',
  SPECIES_MEW: 'Faraway Island, static encounter.',
  SPECIES_LUGIA: 'Navel Rock (Bottom), static encounter.',
  SPECIES_HO_OH: 'Navel Rock (Top), static encounter.',
  SPECIES_REGIROCK: 'Desert Ruins, solve the Braille puzzle.',
  SPECIES_REGICE: 'Island Cave, solve the Braille puzzle.',
  SPECIES_REGISTEEL: 'Ancient Tomb, solve the Braille puzzle.',
  SPECIES_REGIGIGAS: 'Sealed Chamber, once Regirock, Regice, and Registeel are all in your party.',
  SPECIES_LATIAS: 'Southern Island (the other Eon Pokémon roams the region instead).',
  SPECIES_LATIOS: 'Southern Island (the other Eon Pokémon roams the region instead).',
  SPECIES_KYOGRE: 'Marine Cave (End), static encounter.',
  SPECIES_GROUDON: 'Terra Cave (End), static encounter.',
  SPECIES_RAYQUAZA: 'Sky Pillar (Top), static encounter.',

  // Static encounters -- Elite Redux's own additions
  SPECIES_JIRACHI: "Meteor Falls (Jirachi's Room), static encounter.",
  SPECIES_DEOXYS: 'Birth Island, solve the triangle puzzle.',
  SPECIES_HEATRAN: 'Scorched Slab, static encounter.',
  SPECIES_DIANCIE: "Cave of Origin (Diancie's Room), static encounter.",

  // Other
  SPECIES_COSMOG: 'From Professor Birch (Littleroot Town Lab), after beating the Elite Four (National Dex upgrade event).',
  SPECIES_MELTAN: "From Steven's house in Mossdeep City -- a Poké Ball on the floor. Comes holding Melmetalite.",
}
