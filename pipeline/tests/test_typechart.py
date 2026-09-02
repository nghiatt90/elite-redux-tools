from erdata.typechart import parse_type_chart


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
