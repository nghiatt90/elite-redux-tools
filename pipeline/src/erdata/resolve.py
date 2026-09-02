"""Resolve Elite Redux's reference fields on top of the raw parsed species list.

Ports the resolution rules from eliteredux-source's own Kotlin codegen
(tools/codegen/src/er/GeneratorUtils.kt), not the C-serialisation output of that
codegen — see the "do not replicate C-array padding" note below.
"""

from dataclasses import dataclass

from erdata.generated import MoveList_pb2, SpeciesList_pb2
from erdata.parse import parse_moves, parse_species

TutorType = MoveList_pb2.TutorType

_HIDDEN = SpeciesList_pb2.Species.RandomizeBanned.SPECIES_HIDDEN
_SPECIES_NONE = 0
_SPECIES_EGG_NAME = "SPECIES_EGG"


def playable_species(species: list) -> list:
    """The species a player can actually encounter: GeneratorUtils.SPECIES_LIST excludes
    randomizer_banned == SPECIES_HIDDEN (2 unused mega forms); we additionally drop the
    id-0 "??????????" placeholder template and SPECIES_EGG, neither of which carries a
    dex entry of its own or via form_of. This reproduces nextdex's published count of
    1907, verified below.
    """
    result = []
    for s in species:
        if s.randomizer_banned == _HIDDEN:
            continue
        if s.id == _SPECIES_NONE:
            continue
        has_own_dex = s.WhichOneof("base_species_info") == "dex" and s.dex.name != ""
        inherits_dex = s.WhichOneof("base_species_info") == "form_of"
        if not (has_own_dex or inherits_dex):
            continue  # SPECIES_EGG: no dex, not a form
        result.append(s)
    return result


@dataclass
class ResolvedTutors:
    universal_status: list[int]
    universal_attack: list[int]
    universal_gendered: list[int]


def build_species_map(species: list) -> dict[int, object]:
    return {s.id: s for s in species}


def resolve_dex_info(species, species_map):
    """form_of inherits ONLY the base species' SpeciesDexInfo (name, category,
    description, dex numbers, egg groups, body colour, scale/offset). Stats, types,
    abilities and innates are always explicit per species -- they are never inherited.
    """
    if species.WhichOneof("base_species_info") == "form_of":
        return species_map[species.form_of].dex
    return species.dex


def resolve_learnset(species, species_map, chain=None):
    """Port of GeneratorUtils.findLearnsetForSpecies: six branches in priority order,
    with cycle detection. NOTE this deliberately does not replicate any C-struct
    serialisation artifacts from the generator (there are none in the learnset path,
    unlike BaseStatsGenerator's ability-list padding -- see resolve_abilities below).
    """
    if chain is None:
        chain = []
    if species.id in chain:
        raise ValueError(f"self-referential learnset: {chain + [species.id]}")
    chain = [*chain, species.id]

    if species.id == _SPECIES_NONE:
        return species.learnset
    if species.mega:
        return resolve_learnset(species_map[getattr(species.mega[0], 'from')], species_map, chain)
    if species.primal:
        return resolve_learnset(species_map[getattr(species.primal[0], 'from')], species_map, chain)
    if species.HasField("battle_form"):
        return resolve_learnset(species_map[species.battle_form.of], species_map, chain)
    if species.WhichOneof("learnset_or_ref") == "learnset":
        return species.learnset
    if species.WhichOneof("learnset_or_ref") == "uses_learnset":
        return resolve_learnset(species_map[species.uses_learnset], species_map, chain)
    if species.HasField("form_shift_of"):
        return resolve_learnset(species_map[species.form_shift_of], species_map, chain)
    return resolve_learnset(species_map[species.form_of], species_map, chain)


def resolve_visuals(species, species_map):
    """reuse_visuals chains to another species' visuals; 70 species in the current data
    use it, and directory/species names don't reliably match, so this must be followed
    rather than guessed from the species name.
    """
    if species.WhichOneof("visuals_or") == "reuse_visuals":
        return resolve_visuals(species_map[species.reuse_visuals], species_map)
    return species.visuals


def universal_tutor_sets(moves: list) -> ResolvedTutors:
    """The three tutor buckets keyed by MoveList's per-move `tutor` field. These are not
    on the species at all -- see expand_learnset.
    """
    return ResolvedTutors(
        universal_status=[m.id for m in moves if m.tutor == TutorType.TUTOR_UNIVERSAL_STATUS],
        universal_attack=[m.id for m in moves if m.tutor == TutorType.TUTOR_UNIVERSAL_ATTACK],
        universal_gendered=[
            m.id for m in moves if m.tutor == TutorType.TUTOR_UNIVERSAL_STATUS_GENDERED
        ],
    )


def expand_learnset(learnset, species, tutors: ResolvedTutors) -> list[int]:
    """Port of GeneratorUtils.expandLearnset: a species' real tutor-taught move list is
    the three universal buckets (attack bucket skipped if universal_tutors ==
    NO_ATTACKS, gendered bucket skipped if the species is genderless) plus whatever is
    explicitly listed in its own learnset.tutor. NOT just learnset.tutor alone --
    nextdex does not do this expansion.

    A move can legitimately appear in both a universal bucket and a species' own
    explicit learnset.tutor (685 of 1907 species do this in the current data) --
    dedupe while keeping first-occurrence order rather than showing the same tutor
    move twice.
    """
    NoAttacks = type(learnset).UniversalTutors.NO_ATTACKS
    result = list(tutors.universal_status)
    if learnset.universal_tutors != NoAttacks:
        result += tutors.universal_attack
    if species.WhichOneof("gender") != "genderless":
        result += tutors.universal_gendered
    result += list(learnset.tutor)

    seen = set()
    deduped = []
    for move_id in result:
        if move_id not in seen:
            seen.add(move_id)
            deduped.append(move_id)
    return deduped


def resolve_abilities(species) -> list[int]:
    """Explicit non-goal: BaseStatsGenerator.kt pads a species' ability array to 3 slots
    by repeating the last ability, purely because it's filling a fixed-size C array.
    That is a serialisation artifact, not game data -- do not reproduce it. Return
    exactly what's declared, 0-3 entries.
    """
    return list(species.ability)


if __name__ == "__main__":
    species = parse_species()
    moves = parse_moves()
    species_map = build_species_map(species)
    playable = playable_species(species)
    print(f"total={len(species)} playable={len(playable)}")
    assert len(playable) == 1907, len(playable)

    pikachu = next(s for s in playable if s.dex.name == "Pikachu")
    tutors = universal_tutor_sets(moves)
    learnset = resolve_learnset(pikachu, species_map)
    expanded = expand_learnset(learnset, pikachu, tutors)
    print(f"Pikachu tutor moves (expanded): {len(expanded)}")
    assert len(expanded) == 7 + 4 + 1 + len(pikachu.learnset.tutor), len(expanded)
    print("ok")
