from erdata.ability_groups import NEAR_EQUIVALENT_GROUPS
from erdata.emit import _abilities_count, _build_exact_groups, _build_near_groups
from erdata.parse import parse_abilities
from erdata.randomizer import parse_randomizer_banned


def test_banned_count_and_none_included():
    banned = parse_randomizer_banned()
    assert len(banned) == 38
    assert "ABILITY_NONE" in banned


def test_abilities_count_matches_gapfree_enum():
    # The randomizer's LCG modulus is this minus one. Cross-checked against the
    # released build in test_oracle.test_abilities_count_matches_the_released_game --
    # if that one fails too, the lockfile has run ahead of the ROM, not the enum.
    abilities = parse_abilities()
    assert _abilities_count(abilities) == 1034


def test_exact_groups_count_and_membership():
    abilities = parse_abilities()
    groups = _build_exact_groups(abilities)

    distinct = {tuple(v) for v in groups.values()}
    assert len(distinct) == 22
    assert sum(len(g) for g in distinct) == 54

    assert groups["ABILITY_FILTER"] == groups["ABILITY_SOLID_ROCK"]
    assert len(groups["ABILITY_FILTER"]) == 6


def test_exact_groups_exclude_singletons():
    abilities = parse_abilities()
    groups = _build_exact_groups(abilities)
    volt_absorb = next(a for a in abilities if a.name == "Volt Absorb")
    from erdata.generated import AbilityEnum_pb2

    assert AbilityEnum_pb2.AbilityEnum.Name(volt_absorb.id) not in groups


def test_curated_groups_resolve_to_real_abilities():
    abilities = parse_abilities()
    name_index = {a.name: a for a in abilities}
    for group in NEAR_EQUIVALENT_GROUPS:
        for member in group["members"]:
            assert member in name_index, f"curated group member {member!r} is not a real ability"


def test_near_groups_dont_collide_with_exact_groups_by_name_alone():
    # Mold Breaker / Teravolt / Turboblaze share a description prefix but not the
    # full description (Teravolt/Turboblaze also grant a type), so exact-group
    # derivation must NOT merge them -- only the curated tier does.
    abilities = parse_abilities()
    exact = _build_exact_groups(abilities)
    assert "ABILITY_MOLD_BREAKER" not in exact
    assert "ABILITY_TERAVOLT" not in exact
    assert "ABILITY_TURBOBLAZE" not in exact

    name_index = {a.name: a for a in abilities}
    near = _build_near_groups(name_index)
    assert near["ABILITY_MOLD_BREAKER"] == sorted(
        ["ABILITY_MOLD_BREAKER", "ABILITY_TERAVOLT", "ABILITY_TURBOBLAZE"]
    )


def test_compound_count():
    from erdata.emit import _components

    abilities = parse_abilities()
    name_index = {a.name: a for a in abilities}
    compounds = [a for a in abilities if _components(a.description, name_index)]
    assert len(compounds) == 150
