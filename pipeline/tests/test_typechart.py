from erdata.typechart import parse_inverse_type_chart, parse_type_chart


def test_full_matrix_present():
    chart = parse_type_chart()
    assert len(chart) == 20
    for row in chart.values():
        assert len(row) == 20


def test_known_matchups():
    chart = parse_type_chart()
    assert chart["TYPE_FIRE"]["TYPE_GRASS"] == 2.0
    assert chart["TYPE_WATER"]["TYPE_FIRE"] == 2.0
    assert chart["TYPE_NORMAL"]["TYPE_GHOST"] == 0.0
    assert chart["TYPE_ELECTRIC"]["TYPE_GROUND"] == 0.0
    assert chart["TYPE_DARK"]["TYPE_FAIRY"] == 0.5


def test_stellar_row_present():
    # ER-added type not in vanilla; makes sure the parser isn't silently truncating
    # at the vanilla 18-type boundary.
    chart = parse_type_chart()
    assert "TYPE_STELLAR" in chart
    assert chart["TYPE_STELLAR"]["TYPE_STELLAR"] == 2.0


# sInverseTypeEffectivenessTable (battle_util.c:1015-1057), selected by GetTypeModifier
# (:8021-8038) for Inverse Room / Miracle Eye / B_FLAG_INVERSE_BATTLE. A separate
# hand-written array, not derived from the forward table -- see typechart.py's own
# module comment on _INVERSE_TABLE_NAME.
def test_inverse_full_matrix_present():
    chart = parse_inverse_type_chart()
    assert len(chart) == 20
    for row in chart.values():
        assert len(row) == 20


def test_inverse_known_matchups():
    chart = parse_inverse_type_chart()
    # Deliberately different matchups than test_known_matchups above: the whole point
    # of this table is that it doesn't mirror the forward one via any simple rule
    # (e.g. Normal->Ghost is a flat 0.0 immunity in the forward table -- no
    # reciprocal-style transform could produce this table's real 2.0 there).
    assert chart["TYPE_NORMAL"]["TYPE_GHOST"] == 2.0
    assert chart["TYPE_FIRE"]["TYPE_GRASS"] == 0.5
    assert chart["TYPE_DARK"]["TYPE_PSYCHIC"] == 0.5


def test_inverse_stellar_row_present():
    chart = parse_inverse_type_chart()
    assert "TYPE_STELLAR" in chart
    assert chart["TYPE_STELLAR"]["TYPE_STELLAR"] == 0.5


def test_inverse_table_is_not_the_forward_table():
    assert parse_inverse_type_chart() != parse_type_chart()
