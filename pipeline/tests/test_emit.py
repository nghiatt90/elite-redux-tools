import json

from erdata.emit import ability_to_dict, move_to_dict, species_to_dict, type_chart_to_dict
from erdata.parse import parse_abilities, parse_moves, parse_species
from erdata.resolve import build_species_map, playable_species, universal_tutor_sets


def _fixtures():
    species = parse_species()
    moves = parse_moves()
    abilities = parse_abilities()
    species_map = build_species_map(species)
    tutors = universal_tutor_sets(moves)
    return species, moves, abilities, species_map, tutors


def test_species_dict_is_json_serializable_and_has_expected_shape():
    species, _, _, species_map, tutors = _fixtures()
    pikachu = next(s for s in playable_species(species) if s.dex.name == "Pikachu")
    d = species_to_dict(pikachu, species_map, tutors)

    json.dumps(d)  # round-trips without error
    assert d["id"] == "SPECIES_PIKACHU"
    assert d["baseStats"] == {"hp": 35, "atk": 55, "def": 40, "spatk": 50, "spdef": 50, "spe": 95}
    assert d["abilities"] == ["ABILITY_ELECTROCYTES", "ABILITY_GENERATOR", "ABILITY_ELECTRIC_BURST"]
    assert d["innates"] == ["ABILITY_SHORT_CIRCUIT", "ABILITY_STATIC", "ABILITY_GROUND_SHOCK"]
    assert d["isForm"] is False
    assert len(d["learnset"]["tutor"]) == len(pikachu.learnset.tutor) + 7 + 4 + 1


def test_form_species_dict_carries_inherited_dex_info():
    species, _, _, species_map, tutors = _fixtures()
    from erdata.generated import SpeciesEnum_pb2

    form = next(
        s for s in species if SpeciesEnum_pb2.SpeciesEnum.Name(s.id) == "SPECIES_BEWARDEN_REDUX"
    )
    d = species_to_dict(form, species_map, tutors)
    assert d["isForm"] is True
    assert d["formOf"] == "SPECIES_BEWARDEN"
    assert d["name"] == "Bewarden"


def test_move_dict_shape():
    _, moves, _, _, _ = _fixtures()
    pound = next(m for m in moves if m.name == "Pound")
    d = move_to_dict(pound)
    json.dumps(d)
    assert d["id"] == "MOVE_POUND"
    assert d["type"] == "TYPE_NORMAL"
    assert d["split"] == "PHYSICAL"
    assert d["power"] == 40
    assert d["flags"]["contact"] is True


def test_ability_dict_shape():
    _, _, abilities, _, _ = _fixtures()
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    d = ability_to_dict(volt_absorb)
    json.dumps(d)
    assert d["id"] == "ABILITY_VOLT_ABSORB"


def test_type_chart_dict_uses_bare_names():
    chart = type_chart_to_dict()
    assert chart["FIRE"]["GRASS"] == 2.0
    assert "TYPE_FIRE" not in chart


def test_emit_is_deterministic(tmp_path, monkeypatch):
    import erdata.paths as paths_mod

    monkeypatch.setattr(paths_mod, "DATA_ROOT", tmp_path)
    import erdata.emit as emit_mod

    monkeypatch.setattr(emit_mod, "output_dir", lambda: tmp_path / paths_mod.game_version())

    emit_mod.build()
    first = (tmp_path / paths_mod.game_version() / "species.json").read_bytes()
    emit_mod.build()
    second = (tmp_path / paths_mod.game_version() / "species.json").read_bytes()
    assert first == second
