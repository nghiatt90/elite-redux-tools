from erdata.natures import (
    battle_constants_to_dict,
    parse_critical_hit_chance,
    parse_nature_stat_table,
    parse_stat_stage_ratios,
)


def test_nature_stat_table_has_25_entries_summing_to_zero_or_neutral():
    table = parse_nature_stat_table()
    assert len(table) == 25
    for name, stats in table.items():
        total = sum(stats.values())
        # every nature is either neutral (all zero) or exactly one +1 and one -1
        assert total == 0, f"{name}: stats don't net to zero: {stats}"


def test_nature_stat_table_known_values():
    table = parse_nature_stat_table()
    assert table["NATURE_ADAMANT"] == {"ATK": 1, "DEF": 0, "SPEED": 0, "SPATK": -1, "SPDEF": 0}
    assert table["NATURE_JOLLY"] == {"ATK": 0, "DEF": 0, "SPEED": 1, "SPATK": -1, "SPDEF": 0}
    assert table["NATURE_TIMID"] == {"ATK": -1, "DEF": 0, "SPEED": 1, "SPATK": 0, "SPDEF": 0}
    # the 5 neutral natures
    for neutral in ["HARDY", "DOCILE", "SERIOUS", "BASHFUL", "QUIRKY"]:
        assert table[f"NATURE_{neutral}"] == {"ATK": 0, "DEF": 0, "SPEED": 0, "SPATK": 0, "SPDEF": 0}


def test_stat_stage_ratios():
    ratios = parse_stat_stage_ratios()
    assert len(ratios) == 13
    assert ratios[0] == [10, 40]  # -6
    assert ratios[6] == [10, 10]  # 0, no-op
    assert ratios[12] == [40, 10]  # +6


def test_critical_hit_chance_is_the_gen7_table():
    # ER pins B_CRIT_CHANCE to GEN_7 -- {24, 8, 2, 1, 1}, i.e. 1/24, 1/8, 1/2, guaranteed
    assert parse_critical_hit_chance() == [24, 8, 2, 1, 1]


def test_battle_constants_dict_shape():
    d = battle_constants_to_dict()
    assert d["maxIvs"] == 31
    assert d["maxEvPerStat"] == 252
    assert d["maxEvTotal"] == 510
    assert d["uq412Precision"] == 10
    assert len(d["natureStatTable"]) == 25
    assert len(d["statStageRatios"]) == 13
    assert d["criticalHitChance"] == [24, 8, 2, 1, 1]
