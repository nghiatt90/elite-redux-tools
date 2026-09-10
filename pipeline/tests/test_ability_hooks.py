import json

import pytest

from erdata.ability_hooks import (
    ability_hooks_to_dict,
    extract_ability_blocks,
    parse_ability_struct_fields,
    split_block_fields,
)


def test_ability_struct_fields_derived_from_header():
    fields = parse_ability_struct_fields()
    assert "onOffensiveMultiplier" in fields["hooks"]
    assert "onStab" in fields["hooks"]
    assert "onOffensiveMultiplierFor" in fields["applyOn"]
    assert "adaptability" in fields["bitfields"]
    assert "addsType" in fields["bitfields"]
    # the three string fields are dropped, never misclassified as bitfields
    assert "name" not in fields["bitfields"]
    assert "description" not in fields["bitfields"]


def test_extract_ability_blocks_count_matches_raw_occurrences():
    from erdata.ability_hooks import _ABILITIES_CC

    text = _ABILITIES_CC.read_text(encoding="utf-8")
    blocks = extract_ability_blocks(text)
    assert len(blocks) == 1016
    assert len(blocks) == text.count("constexpr Ability Impl<")


def test_extract_ability_blocks_rejects_unbalanced_braces():
    from erdata.ability_hooks import _find_matching_brace

    with pytest.raises(AssertionError):
        _find_matching_brace("{ this brace never closes", 0)


def test_split_block_fields_rejects_unknown_field():
    allowed = parse_ability_struct_fields()
    with pytest.raises(AssertionError, match="unrecognized field"):
        split_block_fields(".thisFieldDoesNotExist = TRUE,", "ABILITY_FAKE", allowed)


def test_ability_hooks_dict_shape_and_count():
    d = ability_hooks_to_dict()
    json.dumps(d)  # round-trips without error
    assert len(d) == 1016


def test_ability_hooks_tinted_lens_lambda():
    d = ability_hooks_to_dict()
    tinted_lens = d["ABILITY_TINTED_LENS"]
    assert tinted_lens["damageRelevant"] is True
    assert tinted_lens["damageRelevantReasons"] == ["onOffensiveMultiplier"]
    hook = tinted_lens["hooks"]["onOffensiveMultiplier"]
    assert hook["form"] == "lambda"
    assert "RESISTANCE(2)" in hook["source"]


def test_ability_hooks_adaptability_is_a_bare_bitfield():
    d = ability_hooks_to_dict()
    adaptability = d["ABILITY_ADAPTABILITY"]
    assert adaptability["hooks"] == {}
    assert adaptability["bitfields"] == {"adaptability": "TRUE"}
    assert adaptability["damageRelevant"] is True


def test_ability_hooks_alias_form_resolves_target_and_hook():
    d = ability_hooks_to_dict()
    full_metal_body = d["ABILITY_FULL_METAL_BODY"]
    hook = full_metal_body["hooks"]["onBlockStatDrops"]
    assert hook["form"] == "alias"
    assert hook["aliasTarget"] == "ABILITY_CLEAR_BODY"
    assert hook["aliasHook"] == "onBlockStatDrops"


def test_ability_hooks_ate_ability_bare_macro_expands_to_two_fields():
    d = ability_hooks_to_dict()
    pixilate = d["ABILITY_PIXILATE"]
    assert pixilate["hooks"]["onMoveType"]["form"] == "macro"
    assert pixilate["hooks"]["onMoveType"]["macroName"] == "ATE_ABILITY"
    assert pixilate["hooks"]["onMoveType"]["macroArgs"] == "TYPE_FAIRY"
    assert pixilate["hooks"]["onStab"]["macroArgs"] == "TYPE_FAIRY"
    # onStab is a damage hook, onMoveType (as a bare hook) is not in _DAMAGE_HOOKS'
    # source-relevance list on its own -- but Pixilate is still flagged relevant via onStab
    assert "onStab" in pixilate["damageRelevantReasons"]


def test_ability_hooks_cute_charm_either_ability_is_not_damage_relevant():
    d = ability_hooks_to_dict()
    cute_charm = d["ABILITY_CUTE_CHARM"]
    assert set(cute_charm["hooks"]) == {"onAttacker", "onDefender"}
    assert cute_charm["damageRelevant"] is False


def test_ability_hooks_source_lines_are_plausible_and_ordered_by_scan():
    d = ability_hooks_to_dict()
    truant = d["ABILITY_TRUANT"]
    assert truant["sourceLine"] < truant["endLine"]
    assert truant["sourceLine"] > 400  # well past the file's macro-definition preamble


def test_ability_hooks_census_matches_investigation():
    d = ability_hooks_to_dict()
    no_damage = [v for v in d.values() if not v["damageRelevant"]]
    damage = [v for v in d.values() if v["damageRelevant"]]
    # sanity bounds from the manual census during planning (485 no-damage, 123
    # declarative-only, 418 with lambda hooks) -- this scraper counts a few more as
    # damage-relevant since it also tracks onRecoil/onMoveType and 3 extra bitfields
    # (negatesBurnAtkDrop, negatesFrzSpatkDrop, noBurnDamage) that weren't in the
    # original hand count, so assert a bound rather than the exact historical number.
    assert 400 < len(no_damage) < 550
    assert 450 < len(damage) < 620
