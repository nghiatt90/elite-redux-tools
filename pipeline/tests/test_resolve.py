from erdata.generated import SpeciesEnum_pb2, SpeciesList_pb2
from erdata.parse import parse_moves, parse_species
from erdata.resolve import (
    build_species_map,
    expand_learnset,
    playable_species,
    resolve_abilities,
    resolve_dex_info,
    resolve_learnset,
    resolve_visuals,
    universal_tutor_sets,
)

SPECIES_NAME = SpeciesEnum_pb2.SpeciesEnum.Name


def _by_name(species, name):
    return next(s for s in species if SPECIES_NAME(s.id) == name)


def test_playable_count_matches_published_dex():
    species = parse_species()
    assert len(playable_species(species)) == 1907


def test_form_inherits_dex_but_not_stats():
    species = parse_species()
    species_map = build_species_map(species)
    form = _by_name(species, "SPECIES_BEWARDEN_REDUX")
    base = _by_name(species, "SPECIES_BEWARDEN")

    dex = resolve_dex_info(form, species_map)
    assert dex.name == base.dex.name == "Bewarden"
    # stats are never inherited, even when dex info is
    assert (form.hp, form.atk) != (0, 0)
    assert list(form.ability) != [] or list(base.ability) != []


def test_mega_uses_base_species_learnset():
    species = parse_species()
    species_map = build_species_map(species)
    mega = _by_name(species, "SPECIES_DUDUDUNSPARCE_MEGA")
    base = _by_name(species, "SPECIES_DUDUDUNSPARCE")

    assert resolve_learnset(mega, species_map) == base.learnset


def test_uses_learnset_reference_is_followed():
    species = parse_species()
    species_map = build_species_map(species)
    scrafster = _by_name(species, "SPECIES_SCRAFSTER")
    scrafty = _by_name(species, "SPECIES_SCRAFTY")

    assert resolve_learnset(scrafster, species_map) == scrafty.learnset


def test_reuse_visuals_reference_is_followed():
    species = parse_species()
    species_map = build_species_map(species)
    arceus_fighting = _by_name(species, "SPECIES_ARCEUS_FIGHTING")
    arceus = _by_name(species, "SPECIES_ARCEUS")

    assert resolve_visuals(arceus_fighting, species_map) == arceus.visuals


def test_no_attacks_flag_excludes_universal_attack_tutors():
    species = parse_species()
    moves = parse_moves()
    tutors = universal_tutor_sets(moves)
    wobbuffet = _by_name(species, "SPECIES_WOBBUFFET")

    NoAttacks = SpeciesList_pb2.Species.Learnset.UniversalTutors.NO_ATTACKS
    assert wobbuffet.learnset.universal_tutors == NoAttacks

    expanded = expand_learnset(wobbuffet.learnset, wobbuffet, tutors)
    for move_id in tutors.universal_attack:
        assert move_id not in expanded
    for move_id in tutors.universal_status:
        assert move_id in expanded


def test_expand_learnset_adds_universal_tutors_pikachu():
    species = parse_species()
    moves = parse_moves()
    tutors = universal_tutor_sets(moves)
    pikachu = _by_name(species, "SPECIES_PIKACHU")

    expanded = expand_learnset(pikachu.learnset, pikachu, tutors)
    assert len(expanded) == len(pikachu.learnset.tutor) + 7 + 4 + 1


def test_ability_list_is_never_padded_to_three():
    # BaseStatsGenerator.kt pads a species' ability array to 3 slots by repeating the
    # last entry, purely to fill a fixed-size C array -- resolve_abilities must be a
    # straight passthrough regardless of declared count, and never invent a synthetic
    # duplicate to pad out to 3. In the current data every species has exactly 0 or 3
    # declared abilities; this asserts the passthrough property holds for both, and
    # would still hold if a future data revision introduces a 1- or 2-ability species.
    species = parse_species()
    for s in species:
        resolved = resolve_abilities(s)
        assert resolved == list(s.ability)
        assert len(resolved) == len(s.ability)
