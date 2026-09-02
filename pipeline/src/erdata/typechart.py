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


def parse_type_chart() -> dict[str, dict[str, float]]:
    text = (ER_SOURCE / _SOURCE_FILE).read_text()
    start = text.index(f"{_TABLE_NAME}[NUMBER_OF_MON_TYPES][NUMBER_OF_MON_TYPES] = {{")
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
