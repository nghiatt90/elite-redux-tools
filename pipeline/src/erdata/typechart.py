"""Extract Elite Redux's type effectiveness chart.

This table is not in er-config -- Types.proto is just the 20-value type enum. The real
matchup table lives in the game's C source, as a NUMBER_OF_MON_TYPES x
NUMBER_OF_MON_TYPES fixed-point matrix (src/battle_util.c, sTypeEffectivenessTable).
"""

import re

from erdata.generated import Types_pb2
from erdata.paths import ER_SOURCE

_SOURCE_FILE = "src/battle_util.c"
_TABLE_NAME = "sTypeEffectivenessTable"

# The Inverse Room / B_FLAG_INVERSE_BATTLE table (battle_util.c:1015, selected by
# GetTypeModifier at :8021-8038). This is a SEPARATE hand-written array, not derived
# from the forward table above by any simple transform (e.g. Normal->Ghost is a flat
# 0.0 immunity in the forward table -- no reciprocal-style rule could turn that into
# the inverse table's real 2.0 there), so it must be scraped independently rather
# than computed from sTypeEffectivenessTable.
_INVERSE_TABLE_NAME = "sInverseTypeEffectivenessTable"

# C's TYPE_* constants are 0-indexed with no TYPE_NONE slot (include/constants/pokemon.h);
# Types.proto's Type enum is the same list shifted +1 to make room for TYPE_NONE = 0. Row/
# column order in the table matches this list exactly (verified against the table's own
# inline comments).
_C_TYPE_ORDER = [
    "NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL",
    "MYSTERY", "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK",
    "FAIRY", "STELLAR",
]


def _proto_type_name(c_type_name: str) -> str:
    return Types_pb2.Type.Name(_C_TYPE_ORDER.index(c_type_name) + 1)


def _parse_table(table_name: str) -> dict[str, dict[str, float]]:
    text = (ER_SOURCE / _SOURCE_FILE).read_text(encoding="utf-8")
    start = text.index(f"{table_name}[NUMBER_OF_MON_TYPES][NUMBER_OF_MON_TYPES] = {{")
    end = text.index("\n};", start)
    body = text[start:end]

    rows = re.findall(r"\{([^{}]*)\}", body)
    assert len(rows) == len(_C_TYPE_ORDER), f"expected {len(_C_TYPE_ORDER)} rows, got {len(rows)}"

    chart: dict[str, dict[str, float]] = {}
    for c_atk_type, row in zip(_C_TYPE_ORDER, rows):
        values = [float(v) for v in re.findall(r"X\(([\d.]+)\)", row)]
        assert len(values) == len(_C_TYPE_ORDER), (
            f"{c_atk_type}: expected {len(_C_TYPE_ORDER)} values, got {len(values)}"
        )
        atk_name = _proto_type_name(c_atk_type)
        chart[atk_name] = {
            _proto_type_name(c_def_type): mult for c_def_type, mult in zip(_C_TYPE_ORDER, values)
        }
    return chart


def parse_type_chart() -> dict[str, dict[str, float]]:
    return _parse_table(_TABLE_NAME)


def parse_inverse_type_chart() -> dict[str, dict[str, float]]:
    """sInverseTypeEffectivenessTable -- see the module-level comment on
    _INVERSE_TABLE_NAME for why this can't be derived from parse_type_chart()."""
    return _parse_table(_INVERSE_TABLE_NAME)


if __name__ == "__main__":
    chart = parse_type_chart()
    print(f"{len(chart)} attacking types")
    # Spot checks against known ER/vanilla matchups.
    assert chart["TYPE_FIRE"]["TYPE_GRASS"] == 2.0
    assert chart["TYPE_WATER"]["TYPE_FIRE"] == 2.0
    assert chart["TYPE_NORMAL"]["TYPE_GHOST"] == 0.0
    assert chart["TYPE_ELECTRIC"]["TYPE_GROUND"] == 0.0
    assert chart["TYPE_STELLAR"]["TYPE_STELLAR"] == 2.0
    assert chart["TYPE_DARK"]["TYPE_FAIRY"] == 0.5
    print("ok")

    inverse_chart = parse_inverse_type_chart()
    print(f"{len(inverse_chart)} attacking types (inverse)")
    # Spot checks against the inverse table's own values (see battle_util.c:1015-1057) --
    # deliberately NOT the same matchups as above, since the whole point of this table
    # is that it doesn't mirror the forward one via any simple rule.
    assert inverse_chart["TYPE_NORMAL"]["TYPE_GHOST"] == 2.0
    assert inverse_chart["TYPE_FIRE"]["TYPE_GRASS"] == 0.5
    assert inverse_chart["TYPE_DARK"]["TYPE_PSYCHIC"] == 0.5
    assert inverse_chart["TYPE_STELLAR"]["TYPE_STELLAR"] == 0.5
    print("ok")
