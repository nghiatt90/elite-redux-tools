/** Some "special formes" -- alternate species with their own stats/abilities, not
 * reached via level-up evolution or a Mega/Primal item -- are gift Pokémon rewarded
 * for beating one of Evergrande City's 18 Monotype Champions (one per type; the
 * Mono Champion Room, unlocked after clearing the main game and every other badge).
 * 6 of these 18 hand over a bare item instead (already covered by items.json's own
 * `megaStoneHint.uniqueLocation` text, e.g. "Defeat the Ghost Monotype Champion." on
 * Phantom Meteor) -- these 12 hand over a whole Pokémon instead (sometimes ALSO
 * holding that type's mega stone, e.g. Mimikyu Apex comes holding Phantom Meteor).
 *
 * Verified by reading the entirety of `data/maps/EvergrandeCity_MonoChampRoom_1/
 * scripts.pory` in Elite-Redux/eliteredux-source (`upcoming` branch, checked
 * 2026-09) -- all 18 `EverGrandeCity_MonoChampRoom_1_EventScript_MonoChamp_<Type>`
 * blocks, each one's `givemon`/`giveitem` call. Not proto data (no field for
 * "how a species itself is obtained" exists in SpeciesList.proto), so -- same as
 * the Mega Stone hints -- kept to only what's been read directly in the live
 * script, not inferred or paraphrased.
 */
export const GIFT_MON_UNLOCK: Record<string, string> = {
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
}
