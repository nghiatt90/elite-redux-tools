import json

from erdata.ability_hooks import ability_hooks_to_dict
from erdata.emit import ability_to_dict, item_to_dict, move_to_dict, species_to_dict, type_chart_to_dict
from erdata.parse import parse_abilities, parse_items, parse_moves, parse_species
from erdata.resolve import build_species_map, playable_species, universal_tutor_sets

# Scraping abilities.cc's 1026 blocks is the slowest fixture in this file by a wide
# margin; computed once and reused, same as the module already does for parse_*().
_ABILITY_HOOKS = ability_hooks_to_dict()


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
    assert d["speciesNum"] == 25
    assert d["baseStats"] == {"hp": 35, "atk": 55, "def": 40, "spatk": 50, "spdef": 50, "spe": 95}
    assert d["abilities"] == ["ABILITY_ELECTROCYTES", "ABILITY_GENERATOR", "ABILITY_ELECTRIC_BURST"]
    assert d["innates"] == ["ABILITY_SHORT_CIRCUIT", "ABILITY_STATIC", "ABILITY_GROUND_SHOCK"]
    assert d["isForm"] is False
    tutor = d["learnset"]["tutor"]
    assert len(tutor) == len(set(tutor))  # deduped -- one overlap exists in the raw data
    assert len(tutor) == len(pikachu.learnset.tutor) + 7 + 4 + 1 - 1


def test_species_dict_mega_item_resolves_to_enum_name():
    species, _, _, species_map, tutors = _fixtures()
    from erdata.generated import SpeciesEnum_pb2

    charizard_mega_x = next(
        s for s in species if SpeciesEnum_pb2.SpeciesEnum.Name(s.id) == "SPECIES_CHARIZARD_MEGA_X"
    )
    d = species_to_dict(charizard_mega_x, species_map, tutors)
    assert d["megas"] == [{"from": "SPECIES_CHARIZARD", "megaType": "MEGA_X", "item": "ITEM_CHARIZARDITE_X"}]


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


def test_move_dict_has_no_effect_or_custom_behavior_when_plain_hit():
    _, moves, _, _, _ = _fixtures()
    pound = next(m for m in moves if m.name == "Pound")
    d = move_to_dict(pound)
    assert d["effect"] is None
    assert d["customBehavior"] is None


def test_move_dict_effect_is_the_move_behavior_enum():
    _, moves, _, _, _ = _fixtures()
    tri_attack = next(m for m in moves if m.name == "Tri Attack")
    d = move_to_dict(tri_attack)
    assert d["effect"] == "EFFECT_TRI_ATTACK"
    assert d["splitFlag"] == "USE_HIGHEST_OFFENSE"


def test_move_dict_inline_custom_behavior():
    _, moves, _, _, _ = _fixtures()
    razor_wind = next(m for m in moves if m.name == "Razor Wind")
    d = move_to_dict(razor_wind)
    assert d["effect"] is None
    assert d["customBehavior"]["attack"]["superEffectiveVs"] == "TYPE_ROCK"
    assert d["crit"] == "HIGH"


def test_move_dict_argument_shape():
    _, moves, _, _, _ = _fixtures()
    double_slap = next(m for m in moves if m.name == "Double Slap")
    d = move_to_dict(double_slap)
    assert d["argument"] == {"kind": "effect", "effect": "MOVE_EFFECT_DOUBLESLAP", "affectsUser": False, "certain": False}


def test_move_dict_has_no_type2_split_flag_crit_hits_air_hit_count_when_default():
    _, moves, _, _, _ = _fixtures()
    pound = next(m for m in moves if m.name == "Pound")
    d = move_to_dict(pound)
    assert d["type2"] is None
    assert "splitFlag" not in d
    assert "crit" not in d
    assert "hitsAir" not in d
    assert "hitCount" not in d
    assert "argument" not in d


def test_species_dict_has_weight_and_height():
    species, _, _, species_map, tutors = _fixtures()
    pikachu = next(s for s in playable_species(species) if s.dex.name == "Pikachu")
    d = species_to_dict(pikachu, species_map, tutors)
    assert d["weight"] == pikachu.dex.weight
    assert d["height"] == pikachu.dex.height
    assert d["weight"] > 0  # Pikachu has real dex data upstream


def test_ability_dict_shape():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    d = ability_to_dict(volt_absorb, name_index, _ABILITY_HOOKS)
    json.dumps(d)
    assert d["id"] == "ABILITY_VOLT_ABSORB"


def test_ability_dict_grants_type():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    half_drake = next(a for a in abilities if a.name == "Half Drake")
    d = ability_to_dict(half_drake, name_index, _ABILITY_HOOKS)
    assert d["grantsType"] == "DRAGON"


def test_ability_dict_compound_resolves_components():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    big_leaves = next(a for a in abilities if a.name == "Big Leaves")
    d = ability_to_dict(big_leaves, name_index, _ABILITY_HOOKS)
    assert d["components"] == [
        "ABILITY_CHLOROPLAST",
        "ABILITY_CHLOROPHYLL",
        "ABILITY_LEAF_GUARD",
        "ABILITY_HARVEST",
        "ABILITY_SOLAR_POWER",
    ]


def test_ability_dict_non_compound_has_no_components():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    d = ability_to_dict(volt_absorb, name_index, _ABILITY_HOOKS)
    assert "components" not in d


def test_item_dict_shape():
    items = parse_items()
    charizardite_x = next(i for i in items if i.name == "Charizardite X")
    d = item_to_dict(charizardite_x)
    json.dumps(d)
    assert d["id"] == "ITEM_CHARIZARDITE_X"
    assert d["itemNum"] == 761
    assert d["grouping"] == "POCKET_MEGA_STONES"
    assert d["holdEffect"] == "HOLD_EFFECT_MEGA_STONE"
    assert d["resolvedHoldEffect"] == "HOLD_EFFECT_MEGA_STONE"


def test_item_dict_resolves_hold_effect_custom_by_alias_or_id():
    items = parse_items()
    by_name = {i.name: i for i in items}

    life_orb = item_to_dict(by_name["Life Orb"])
    assert life_orb["holdEffect"] == "HOLD_EFFECT_CUSTOM"
    assert life_orb["resolvedHoldEffect"] == "HOLD_EFFECT_LIFE_ORB"

    choice_band = item_to_dict(by_name["Choice Band"])
    assert choice_band["holdEffect"] == "HOLD_EFFECT_CUSTOM"
    assert choice_band["resolvedHoldEffect"] == "HOLD_EFFECT_CHOICE_BAND"

    # the whole point: these two were indistinguishable before resolvedHoldEffect
    assert life_orb["resolvedHoldEffect"] != choice_band["resolvedHoldEffect"]


def test_item_dict_mega_stone_hint_kinds():
    items = parse_items()
    by_name = {i.name: i for i in items}

    # er-config's own field for this item happens to be nurse-joy; a vanilla-GameFreak
    # Mega Stone -- picked because it's stable across balance patches, not because
    # this pipeline hardcodes an assumption about which stones are vanilla.
    assert item_to_dict(by_name["Charizardite X"])["megaStoneHint"] == {"kind": "nurseJoy"}
    assert item_to_dict(by_name["Tera Orb"])["megaStoneHint"] == {"kind": "legendarySage"}

    adoption_center_item = next(
        i for i in items if i.WhichOneof("mega_stone_hint") == "adoption_center"
    )
    assert item_to_dict(adoption_center_item)["megaStoneHint"] == {"kind": "adoptionCenter"}

    unique = item_to_dict(by_name["Slowkingite"])["megaStoneHint"]
    assert unique == {"kind": "uniqueLocation", "text": "Defeat Tate & Liza."}


def test_item_dict_has_no_mega_stone_hint_when_unset():
    items = parse_items()
    potion = next(i for i in items if i.name == "Potion")
    assert "megaStoneHint" not in item_to_dict(potion)


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
