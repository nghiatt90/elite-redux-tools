"""Scrape nature and a handful of other small, universal battle constants out of
eliteredux-source's C -- none of this is proto data (er-config has no notion of
natures at all). Follows typechart.py's precedent of regex-scraping a named C array
rather than hand-transcribing it, so a value changing upstream is caught by re-running
this against the pinned checkout rather than silently going stale.
"""

import re

from erdata.paths import ER_SOURCE

_STATS = ["ATK", "DEF", "SPEED", "SPATK", "SPDEF"]

# src/pokemon.c's gNatureStatTable is built from a macro, not literal numbers:
#   #define NATURE_STAT(up, down) {(up==STAT_ATK)-(down==STAT_ATK), ...}
#   [NATURE_ADAMANT] = NATURE_STAT(STAT_ATK, STAT_SPATK),
# so this expands the macro itself in Python (per stat, (up==stat) - (down==stat))
# rather than reading five already-computed literals, matching resolve.py's stated
# policy of porting resolution *rules*, not C-serialisation output.
_ENTRY_RE = re.compile(
    r"\[NATURE_(?P<name>[A-Z0-9_]+)\]\s*=\s*NATURE_STAT\(STAT_(?P<up>[A-Z]+),\s*STAT_(?P<down>[A-Z]+)\)"
)


def parse_nature_stat_table() -> dict[str, dict[str, int]]:
    text = (ER_SOURCE / "src" / "pokemon.c").read_text(encoding="utf-8")
    matches = list(_ENTRY_RE.finditer(text))
    if len(matches) != 25:
        raise AssertionError(
            f"expected 25 NATURE_STAT(...) entries in gNatureStatTable, found {len(matches)} -- "
            "src/pokemon.c's nature table format may have changed upstream"
        )
    table = {}
    for m in matches:
        name = f"NATURE_{m['name']}"
        up, down = m["up"], m["down"]
        if up not in _STATS or down not in _STATS:
            raise AssertionError(f"nature {name}: unrecognized stat in NATURE_STAT({up}, {down})")
        table[name] = {stat: (1 if up == stat else 0) - (1 if down == stat else 0) for stat in _STATS}
    return table


# gStatStageRatios[MAX_STAT_STAGE + 1][2], src/pokemon.c -- index 0..12, stage -6..+6,
# DEFAULT_STAT_STAGE (index 6, stage 0) is always {10, 10} (no-op).
_RATIO_TABLE_RE = re.compile(r"gStatStageRatios\[MAX_STAT_STAGE \+ 1\]\[2\]\s*=\s*\{(?P<body>.*?)\};", re.DOTALL)
_RATIO_ENTRY_RE = re.compile(r"\{\s*(\d+)\s*,\s*(\d+)\s*\}")


def parse_stat_stage_ratios() -> list[list[int]]:
    text = (ER_SOURCE / "src" / "pokemon.c").read_text(encoding="utf-8")
    body = _RATIO_TABLE_RE.search(text)
    if not body:
        raise AssertionError("could not find gStatStageRatios[MAX_STAT_STAGE + 1][2] in src/pokemon.c")
    ratios = [[int(a), int(b)] for a, b in _RATIO_ENTRY_RE.findall(body["body"])]
    if len(ratios) != 13:
        raise AssertionError(f"expected 13 stat stage ratios (-6..+6), found {len(ratios)}")
    if ratios[6] != [10, 10]:
        raise AssertionError(f"expected the default stage (index 6) to be a no-op [10, 10], got {ratios[6]}")
    return ratios


# sCriticalHitChance -- src/battle_script_commands.c, gated by #if B_CRIT_CHANCE >= ...
# ER pins B_CRIT_CHANCE to GEN_7 (include/constants/battle_config.h:20), so only that
# branch is live; fail loudly if that ever stops being true rather than silently
# picking the wrong table.
_CRIT_CHANCE_RE = re.compile(
    r"#if B_CRIT_CHANCE >= GEN_7\s*\nstatic const u8 sCriticalHitChance\[\]\s*=\s*\{(?P<body>[\d,\s]+)\};"
)


def parse_critical_hit_chance() -> list[int]:
    config_text = (ER_SOURCE / "include" / "constants" / "battle_config.h").read_text(encoding="utf-8")
    if not re.search(r"#define\s+B_CRIT_CHANCE\s+GEN_7\b", config_text):
        raise AssertionError(
            "include/constants/battle_config.h no longer pins B_CRIT_CHANCE to GEN_7 -- "
            "the critical-hit chance table this pipeline emits may be the wrong branch"
        )
    text = (ER_SOURCE / "src" / "battle_script_commands.c").read_text(encoding="utf-8")
    m = _CRIT_CHANCE_RE.search(text)
    if not m:
        raise AssertionError("could not find the #if B_CRIT_CHANCE >= GEN_7 sCriticalHitChance table")
    chances = [int(x) for x in m["body"].split(",") if x.strip()]
    if len(chances) != 5:
        raise AssertionError(f"expected 5 critical hit chance stages, found {len(chances)}")
    return chances


# Small scalar constants, hand-verified against the exact lines cited -- not worth a
# regex each given they're single #defines that never repeat with this name elsewhere.
BATTLE_CONSTANTS = {
    "maxIvs": 31,  # include/pokemon.h:18 -- MAX_IVS. ER forces every IV to this value
    # on every stat recalculation (CalculateMonStatsMaster, src/pokemon.c:970-1044),
    # except a hell-mode 0-IV flag and a MON_DATA_SPEED_DOWN -> speedIV 0 case.
    "maxEvPerStat": 252,  # include/constants/pokemon.h:326 -- MAX_PER_STAT_EVS
    "maxEvTotal": 510,  # include/constants/pokemon.h:327 -- MAX_TOTAL_EVS
    "maxLevel": 100,  # include/constants/pokemon.h:283 -- MAX_LEVEL
    "defaultStatStage": 6,  # include/constants/pokemon.h:123 -- DEFAULT_STAT_STAGE
    "uq412Precision": 10,  # include/global.h:113 -- UQ_4_12_PRECISION. NOT 12, despite
    # the macro's name; UQ_4_12(1.0) == 1 << 10 == 1024 in this codebase.
}


def battle_constants_to_dict() -> dict:
    return {
        "natureStatTable": parse_nature_stat_table(),
        "statStageRatios": parse_stat_stage_ratios(),
        "criticalHitChance": parse_critical_hit_chance(),
        **BATTLE_CONSTANTS,
    }


if __name__ == "__main__":
    natures = parse_nature_stat_table()
    print(f"natures={len(natures)}")
    assert len(natures) == 25
    assert natures["NATURE_ADAMANT"] == {"ATK": 1, "DEF": 0, "SPEED": 0, "SPATK": -1, "SPDEF": 0}
    assert natures["NATURE_HARDY"] == {"ATK": 0, "DEF": 0, "SPEED": 0, "SPATK": 0, "SPDEF": 0}
    ratios = parse_stat_stage_ratios()
    assert ratios[0] == [10, 40] and ratios[12] == [40, 10]
    chances = parse_critical_hit_chance()
    assert chances == [24, 8, 2, 1, 1], chances
    print("ok")
