"""Full-corpus cross-check against ER-nextdex's published data. See oracle.py for why
this is a legitimate thing to compare against, and what we expect to differ.

Both sources track a moving upstream branch (`upcoming`) pinned at slightly different
commits, and the game is under active development -- so a small fraction of species
disagreeing (a move added/removed between snapshots, e.g.) is expected drift, not a
pipeline bug. These tests assert near-total agreement (a systemic bug would show up as
the large majority mismatching, not a few percent) rather than byte-exact equality
against what is, on either side, a moving target.
"""

import urllib.error

import pytest

from erdata.emit import species_to_dict
from erdata.generated import AbilityEnum_pb2, MoveEnum_pb2
from erdata.oracle import fetch_oracle, oracle_species_by_id
from erdata.parse import parse_abilities, parse_moves, parse_species
from erdata.resolve import build_species_map, playable_species, universal_tutor_sets

_MAX_SET_DRIFT = 5  # small upstream-commit drift is fine; a larger delta is a real bug

# nextdex's cached snapshot is ~2 weeks older than our pinned SHA, and Elite Redux is
# under active balance-patch development on this branch -- per-field tolerances below
# are set from what a root-caused sample of real mismatches looks like (verified by
# hand: e.g. ABILITY_MENACING_SITUATION's in-game display name is "Phobia" as of our
# pin but nextdex's snapshot still shows "Menacing Situation"; Caterpie gained a new
# level-1 move "Silk Trap" after nextdex's snapshot was taken). These are content
# drift, not pipeline bugs. Level-up learnsets are the most actively tuned field and
# get the widest tolerance; base stats/types are the most stable and get the tightest.
_MAX_STAT_TYPE_MISMATCH_RATE = 0.05
_MAX_ABILITY_MISMATCH_RATE = 0.15
_MAX_LEARNSET_MISMATCH_RATE = 0.30
_MAX_TUTOR_SHORTFALL_RATE = 0.05


@pytest.fixture(scope="module")
def oracle():
    try:
        return oracle_species_by_id(fetch_oracle())
    except (urllib.error.URLError, TimeoutError) as e:
        pytest.skip(f"oracle unreachable: {e}")


@pytest.fixture(scope="module")
def ours():
    species = parse_species()
    moves = parse_moves()
    abilities = parse_abilities()
    species_map = build_species_map(species)
    tutors = universal_tutor_sets(moves)

    ability_display_name = {AbilityEnum_pb2.AbilityEnum.Name(a.id): a.name for a in abilities}
    move_display_name = {MoveEnum_pb2.MoveEnum.Name(m.id): m.name for m in moves}

    result = {}
    for s in playable_species(species):
        d = species_to_dict(s, species_map, tutors)
        result[d["id"]] = {
            "baseStats": d["baseStats"],
            "types": {t.removeprefix("TYPE_") for t in d["types"]},
            "abilities": {ability_display_name[a] for a in d["abilities"]},
            "innates": {ability_display_name[a] for a in d["innates"]},
            "levelUpMoves": {
                move_display_name[m] for lvl in d["learnset"]["levelUp"] for m in lvl["moves"]
            },
            "tutor": {move_display_name[m] for m in d["learnset"]["tutor"]},
        }
    return result


def _assert_mismatch_rate_low(shared, mismatches, label, max_rate):
    rate = len(mismatches) / len(shared)
    assert rate <= max_rate, (
        f"{label}: {len(mismatches)}/{len(shared)} ({rate:.1%}) mismatched, "
        f"exceeds {max_rate:.0%} tolerance -- sample: {mismatches[:10]}"
    )


def test_species_id_sets_nearly_match(ours, oracle):
    missing = set(oracle) - set(ours)
    extra = set(ours) - set(oracle)
    assert len(missing) <= _MAX_SET_DRIFT, f"in nextdex but not ours: {sorted(missing)}"
    assert len(extra) <= _MAX_SET_DRIFT, f"in ours but not nextdex: {sorted(extra)}"


def test_base_stats_and_types_nearly_match(ours, oracle):
    shared = set(ours) & set(oracle)
    assert len(shared) > 1800  # sanity: the overlap fixture actually has data in it
    mismatches = [
        id_
        for id_ in shared
        if ours[id_]["baseStats"] != oracle[id_]["baseStats"] or ours[id_]["types"] != oracle[id_]["types"]
    ]
    _assert_mismatch_rate_low(shared, mismatches, "stats/types", _MAX_STAT_TYPE_MISMATCH_RATE)


def test_abilities_and_innates_nearly_match(ours, oracle):
    shared = set(ours) & set(oracle)
    mismatches = [
        id_
        for id_ in shared
        if ours[id_]["abilities"] != oracle[id_]["abilities"] or ours[id_]["innates"] != oracle[id_]["innates"]
    ]
    _assert_mismatch_rate_low(shared, mismatches, "abilities/innates", _MAX_ABILITY_MISMATCH_RATE)


def test_level_up_learnset_nearly_matches(ours, oracle):
    shared = set(ours) & set(oracle)
    mismatches = [
        id_ for id_ in shared if ours[id_]["levelUpMoves"] != oracle[id_]["levelUpMoves"]
    ]
    _assert_mismatch_rate_low(shared, mismatches, "level-up learnsets", _MAX_LEARNSET_MISMATCH_RATE)


def test_our_tutor_list_is_nearly_always_a_superset_of_nextdex(ours, oracle):
    # Documented, intentional divergence: nextdex's `tutor` field is the species' raw
    # explicit tutor list; ours additionally expands the universal tutor buckets (see
    # resolve.expand_learnset), so ours should contain everything nextdex has plus
    # more. A handful of exceptions are just data drift between snapshots (e.g. a
    # tutor move added upstream after nextdex's snapshot was generated).
    shared = set(ours) & set(oracle)
    shortfalls = [id_ for id_ in shared if not oracle[id_]["tutor"] <= ours[id_]["tutor"]]
    _assert_mismatch_rate_low(shared, shortfalls, "tutor supersets", _MAX_TUTOR_SHORTFALL_RATE)

    strictly_more = sum(1 for id_ in shared if len(ours[id_]["tutor"]) > len(oracle[id_]["tutor"]))
    assert strictly_more > len(shared) * 0.5, (
        "expected universal-tutor expansion to add moves for most species"
    )
