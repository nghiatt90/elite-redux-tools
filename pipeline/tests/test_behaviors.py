import json

from erdata.behaviors import move_behaviors_to_dict
from erdata.parse import parse_move_behaviors


def test_parse_move_behaviors_count():
    configs = parse_move_behaviors()
    assert len(configs) == 460


def test_move_behaviors_dict_shape_and_counts():
    d = move_behaviors_to_dict()
    json.dumps(d)  # round-trips without error

    behaviors = d["behaviors"]
    assert len(behaviors) == 460

    with_attack = [v for v in behaviors.values() if "attack" in v]
    assert len(with_attack) == 69

    with_damage = [v for v in with_attack if "damage" in v["attack"]]
    assert len(with_damage) == 27

    with_legacy = [v for v in behaviors.values() if "legacyConfig" in v]
    assert len(with_legacy) == 391


def test_move_behaviors_captivate_damage_modifier():
    d = move_behaviors_to_dict()
    captivate = d["behaviors"]["EFFECT_CAPTIVATE"]
    assert captivate["attack"]["damage"] == {
        "conditions": [{"kind": "status", "status": "STATUS2_INFATUATION", "battler": "BATTLER_TARGET"}],
        "modifier": {"kind": "multiply", "value": 2.0},
    }


def test_move_behaviors_legacy_config_is_opaque_script_name():
    d = move_behaviors_to_dict()
    multi_hit = d["behaviors"]["EFFECT_MULTI_HIT"]
    assert multi_hit["legacyConfig"] == "BattleScript_EffectArgumentHit"
    assert "attack" not in multi_hit


def test_move_behaviors_enum_value_options():
    d = move_behaviors_to_dict()
    # EFFECT_EXPLOSION = 7 [(no_parental_bond) = true]; -- MoveBehavior.proto
    assert d["behaviors"]["EFFECT_EXPLOSION"]["options"] == {"noParentalBond": True}
    # a config without any enum-value option set carries no "options" key at all
    assert "options" not in d["behaviors"]["EFFECT_HIT"]


def test_move_effect_options_shared_extension_numbers():
    d = move_behaviors_to_dict()
    options = d["moveEffectOptions"]
    assert options["MOVE_EFFECT_FLINCH"] == {"flinchEffect": True}
    assert options["MOVE_EFFECT_GLAIVE_RUSH"] == {"noSheerForce": True}
    assert "MOVE_EFFECT_NONE" not in options
