"""Parse and resolve Elite Redux's trainer party data.

er-config's TrainerList.textproto (2.8MB) is the only source -- unlike species/moves/
abilities/items, there is no separate compiled-C-struct oracle to cross-check against
here, so every resolution rule below is cited against
tools/codegen/src/er/trainer/TrainerPartyGenerator.kt (the Kotlin generator that turns
this same textproto into gTrainers[]) and against src/battle_main.c where the runtime
reads that struct.

Two corrections against an earlier, wrong assumption about this schema, found by
reading the generator rather than trusting a secondhand description of it:

- `TrainerMon.ability` in the textproto is already a real AbilityEnum value (e.g.
  ABILITY_STURDY), not a slot index -- but it is not always what the mon fights with.
  TrainerPartyGenerator.kt:147-156 resolves it to an index into the species' own
  declared ability list (`SPECIES_MAP[species]!!.abilityList.indexOf(ability)`) when
  it writes the compiled C struct, and *omits* `.ability` entirely (silently
  zero-initialising it to slot 0) whenever the named ability isn't one of that
  species' declared abilities. 252 party entries across 130 trainers hit this. This
  module still parses and this file still exposes the raw textproto value; emit.py's
  trainer_to_dict is what resolves it against species_map and publishes the in-game
  ability as "ability" (with the textproto value kept under "textprotoAbility" and
  "abilityDivergence": true when the two differ) -- see that function's comment for
  the full citation chain.
- There is no per-mon "items absent" gap: `TrainerMon.item = 3` (a held item) is a
  real, always-present field in TrainerList.proto and is emitted normally. What is
  genuinely absent is a *trainer-level* bag/items list and an isAlpha flag -- neither
  field exists anywhere in the Trainer message (TrainerList.proto:263-279), matching
  CLAUDE.md's note that the codegen emits no `.items` and `gTrainers[].items[]` is
  empty; there was never a field here to omit in the first place.

Level is also absent and, per CLAUDE.md, is *derived* at battle time, not parsed:
`battle_main.c:1819-1827` computes
    level = GetHighestLevelInPlayerParty() + partyData[i].lvl (always 0, no .lvl
            field exists) + extraLevels (0 unless HELL_MODE_EXTRA_LEVELS_FLAG /
            FLAG_BADGE03_GET is set, in which case +HELL_MODE_EXTRA_LEVELS = 5,
            include/constants/pokemon_config.h:33-34)
clamped to MAX_LEVEL. This module deliberately emits no level field -- fabricating
one would misrepresent derived battle state as parsed game data.

IVs are likewise never emitted: every IV is forced to 31 on stat recalculation for
both sides (see CLAUDE.md), and TrainerList.proto carries no IV fields at all.
"""

from google.protobuf import text_format

from erdata.generated import TrainerList_pb2
from erdata.paths import ER_CONFIG

# TrainerEnum's own TRAINER_NONE -- er-config carries one placeholder Trainer entry
# with no id (defaults to 0) at index 0, the same pattern resolve.playable_species
# already handles for SPECIES_NONE.
_TRAINER_NONE = 0


def parse_trainers() -> list:
    """Raw parse of TrainerList.textproto. Kept in its own module rather than
    parse.py: trainers are self-contained (parse.py's other parse_* functions are all
    single-message-type reads with no cross-references), and this module also holds
    the party-tier resolution below, which parse.py's raw parsers deliberately don't do
    for any other type either (that's resolve.py's job elsewhere in this pipeline).
    """
    msg = TrainerList_pb2.TrainerList()
    text = (ER_CONFIG / "TrainerList.textproto").read_bytes()
    text_format.Parse(text, msg)
    return list(msg.trainer)


def real_trainers(trainers: list) -> list:
    """Drop the id-0 placeholder entry -- mirrors resolve.playable_species dropping
    the SPECIES_NONE placeholder species.
    """
    return [t for t in trainers if t.id != _TRAINER_NONE]


# TrainerPartyGenerator.kt:177-178:
#   val actualElite = elite.monList.ifEmpty { ace.monList }
#   val actualHell = hell.monList.ifEmpty { actualElite }
# i.e. gTrainers[].partyInsane/partyHell fall back to a lower difficulty's party
# whenever the textproto leaves that tier empty, and Hell falls back through the
# *resolved* Elite party, not directly to Ace. This is not an edge case: of the 932
# real trainers (the id-0 TRAINER_NONE placeholder already dropped by real_trainers,
# counted *after* that drop -- counting before it is the exact off-by-one that
# previously made this comment say 504/534), 503 leave the raw textproto `elite.mon`
# empty and 533 leave the raw textproto `hell.mon` empty, so skipping this fallback
# would silently emit an empty party for most trainers on Elite/Hell difficulty
# instead of what the game actually fields. Re-measured directly against
# TrainerList.textproto via parse_trainers()/real_trainers(), not carried over from
# an earlier count.
def resolve_party_tiers(trainer) -> dict[str, list]:
    ace = list(trainer.ace.mon)
    elite = list(trainer.elite.mon) or ace
    hell = list(trainer.hell.mon) or elite
    return {"ace": ace, "elite": elite, "hell": hell}


if __name__ == "__main__":
    trainers = real_trainers(parse_trainers())
    print(f"trainers={len(trainers)}")
    assert len(trainers) == 932, len(trainers)

    sawyer = next(t for t in trainers if t.name == "Sawyer")
    tiers = resolve_party_tiers(sawyer)
    print(f"Sawyer ace={len(tiers['ace'])} elite={len(tiers['elite'])} hell={len(tiers['hell'])}")
    assert len(tiers["ace"]) == 5 and len(tiers["elite"]) == 5 and len(tiers["hell"]) == 6

    # A trainer with no `elite` tier in the textproto must resolve to its Ace party.
    no_elite = next(t for t in trainers if len(t.elite.mon) == 0 and len(t.ace.mon) > 0)
    tiers = resolve_party_tiers(no_elite)
    assert tiers["elite"] == tiers["ace"], f"{no_elite.name}: elite fallback failed"
    print("ok")
