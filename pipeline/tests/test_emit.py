import json

from erdata.ability_hooks import ability_hooks_to_dict
from erdata.emit import (
    _build_exact_groups,
    _build_near_groups,
    ability_to_dict,
    item_to_dict,
    move_to_dict,
    species_to_dict,
    trainer_to_dict,
    type_chart_to_dict,
)
from erdata.parse import parse_abilities, parse_items, parse_moves, parse_species
from erdata.randomizer import parse_randomizer_banned
from erdata.resolve import build_species_map, playable_species, universal_tutor_sets
from erdata.trainers import parse_trainers, real_trainers, resolve_party_tiers

# Scraping abilities.cc's 1026 blocks is the slowest fixture in this file by a wide
# margin; computed once and reused, same as the module already does for parse_*().
_ABILITY_HOOKS = ability_hooks_to_dict()


def _ability_dict(ability, abilities, name_index):
    banned_ids = parse_randomizer_banned()
    exact_groups = _build_exact_groups(abilities)
    near_groups = _build_near_groups(name_index)
    return ability_to_dict(ability, name_index, _ABILITY_HOOKS, banned_ids, exact_groups, near_groups)


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
    d = _ability_dict(volt_absorb, abilities, name_index)
    json.dumps(d)
    assert d["id"] == "ABILITY_VOLT_ABSORB"
    assert d["abilityNum"] == int(volt_absorb.id)


def test_ability_dict_grants_type():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    half_drake = next(a for a in abilities if a.name == "Half Drake")
    d = _ability_dict(half_drake, abilities, name_index)
    assert d["grantsType"] == "DRAGON"


def test_ability_dict_compound_resolves_components():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    big_leaves = next(a for a in abilities if a.name == "Big Leaves")
    d = _ability_dict(big_leaves, abilities, name_index)
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
    d = _ability_dict(volt_absorb, abilities, name_index)
    assert "components" not in d


def test_ability_dict_randomizer_banned_flag():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    wonder_guard = next(a for a in abilities if a.name == "Wonder Guard")
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    assert _ability_dict(wonder_guard, abilities, name_index)["randomizerBanned"] is True
    assert _ability_dict(volt_absorb, abilities, name_index)["randomizerBanned"] is False


def test_ability_dict_exact_equivalence_group():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    filter_ = next(a for a in abilities if a.name == "Filter")
    d = _ability_dict(filter_, abilities, name_index)
    # "Thick Skin" resolves to ABILITY_PERMAFROST_CLONE, not ABILITY_THICK_SKIN --
    # grouping is by AbilityEnum id (matching how components/abilities/innates are
    # already emitted elsewhere), not by display name, precisely so a naming quirk
    # like this one can't cause a silent mismatch.
    assert d["equivalenceGroup"] == sorted(
        [
            "ABILITY_FILTER",
            "ABILITY_SOLID_ROCK",
            "ABILITY_PRISM_ARMOR",
            "ABILITY_PERMAFROST",
            "ABILITY_PERMAFROST_CLONE",
            "ABILITY_FLAME_SHIELD",
        ]
    )


def test_ability_dict_curated_near_equivalent_group():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    mold_breaker = next(a for a in abilities if a.name == "Mold Breaker")
    d = _ability_dict(mold_breaker, abilities, name_index)
    assert d["nearEquivalentGroup"] == sorted(
        ["ABILITY_MOLD_BREAKER", "ABILITY_TERAVOLT", "ABILITY_TURBOBLAZE"]
    )


def test_ability_dict_no_group_fields_when_unique():
    _, _, abilities, _, _ = _fixtures()
    name_index = {a.name: a for a in abilities}
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    d = _ability_dict(volt_absorb, abilities, name_index)
    assert "equivalenceGroup" not in d
    assert "nearEquivalentGroup" not in d


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


def _trainers():
    return real_trainers(parse_trainers())


def test_trainer_dict_shape():
    trainers = _trainers()
    sawyer = next(t for t in trainers if t.id == 1)  # TRAINER_SAWYER_1
    d = trainer_to_dict(sawyer)
    json.dumps(d)
    assert d["id"] == "TRAINER_SAWYER_1"
    assert d["name"] == "Sawyer"
    assert d["class"] == "TRAINER_CLASS_HIKER"
    ace = d["parties"]["ace"]
    assert len(ace) == 5
    carbink = next(m for m in ace if m["species"] == "SPECIES_CARBINK")
    assert carbink["ability"] == "ABILITY_STURDY"
    assert carbink["item"] == "ITEM_LIGHT_CLAY"
    assert carbink["nature"] == "NATURE_IMPISH"
    assert carbink["moves"] == [
        "MOVE_EXPLOSION",
        "MOVE_MOONBLAST",
        "MOVE_REFLECT",
        "MOVE_LIGHT_SCREEN",
    ]


def test_trainer_dict_ability_resolves_as_a_real_id_not_a_slot_index():
    # TrainerList.proto:248 declares TrainerMon.ability as AbilityEnum, not an int32
    # slot index -- see trainers.py's module docstring. A slot index would show up
    # here as "0"/"1"/"2"; a real id looks like every other AbilityEnum field.
    trainers = _trainers()
    sawyer = next(t for t in trainers if t.id == 1)
    d = trainer_to_dict(sawyer)
    abilities = {m["ability"] for mons in d["parties"].values() for m in mons}
    assert all(a.startswith("ABILITY_") for a in abilities)
    assert "ABILITY_STURDY" in abilities


def test_trainer_dict_evs_block_shape():
    trainers = _trainers()
    sawyer = next(t for t in trainers if t.id == 1)
    d = trainer_to_dict(sawyer)
    carbink = next(m for m in d["parties"]["ace"] if m["species"] == "SPECIES_CARBINK")
    assert carbink["evs"] == {"hp": 252, "atk": 0, "def": 252, "spatk": 0, "spdef": 4, "spe": 0}


def test_trainer_dict_has_no_level_or_ivs():
    # Level is derived at battle time (GetHighestLevelInPlayerParty()-relative, see
    # CLAUDE.md) and IVs are forced to 31 on recalculation -- neither is parsed game
    # data, so trainer_to_dict must never fabricate either field.
    trainers = _trainers()
    sawyer = next(t for t in trainers if t.id == 1)
    d = trainer_to_dict(sawyer)
    assert "level" not in d
    for mons in d["parties"].values():
        for m in mons:
            assert "level" not in m
            assert "ivs" not in m


def test_resolve_party_tiers_elite_falls_back_to_ace_when_empty():
    # TrainerPartyGenerator.kt:177: `elite.monList.ifEmpty { ace.monList }`.
    trainers = _trainers()
    sawyer2 = next(
        t for t in trainers if t.name == "Sawyer" and len(t.elite.mon) == 0 and len(t.ace.mon) > 0
    )
    tiers = resolve_party_tiers(sawyer2)
    assert tiers["elite"] == tiers["ace"]
    assert len(tiers["ace"]) == 4


def test_resolve_party_tiers_hell_falls_back_to_elite_when_only_hell_empty():
    # TrainerPartyGenerator.kt:178: `hell.monList.ifEmpty { actualElite }` -- hell
    # must fall back to elite, not skip straight past it to ace, whenever elite
    # itself has real data. TRAINER_NOLEN: ace=3, elite=6, hell=0 in the textproto.
    trainers = _trainers()
    nolen = next(
        t
        for t in trainers
        if t.name == "Nolen" and len(t.hell.mon) == 0 and len(t.elite.mon) > 0
    )
    tiers = resolve_party_tiers(nolen)
    assert tiers["hell"] == tiers["elite"]
    assert tiers["hell"] != tiers["ace"]
    assert len(tiers["elite"]) == 6
    assert len(tiers["ace"]) == 3


def test_resolve_party_tiers_hell_chains_through_elite_to_ace_when_both_empty():
    # TrainerPartyGenerator.kt:177-178: hell falls back to *actualElite* (the
    # already-resolved elite tier), not directly to ace -- when both elite and hell
    # are empty in the textproto this must still bottom out at ace via that chain.
    # TRAINER_SAWYER_2: ace=4, elite=0, hell=0 in the textproto.
    trainers = _trainers()
    sawyer2 = next(
        t for t in trainers if t.name == "Sawyer" and len(t.elite.mon) == 0 and len(t.hell.mon) == 0
    )
    tiers = resolve_party_tiers(sawyer2)
    assert tiers["elite"] == tiers["ace"]
    assert tiers["hell"] == tiers["ace"]


def test_trainer_dict_nonstandard_override_reason_is_carried_through():
    trainers = _trainers()
    alberto = next(t for t in trainers if t.name == "Alberto")
    d = trainer_to_dict(alberto)
    pelipper = next(
        m
        for mons in d["parties"].values()
        for m in mons
        if m["species"] == "SPECIES_PELIPPER" and "nonstandard" in m
    )
    assert pelipper["nonstandard"] == "Invalid moves: [MOVE_U_TURN]"


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
