from erdata.parse import parse_abilities, parse_moves, parse_species


def test_species_count():
    assert len(parse_species()) == 1911


def test_moves_count():
    assert len(parse_moves()) == 1032


def test_abilities_count():
    assert len(parse_abilities()) == 1044


def test_pikachu_stats():
    pikachu = next(s for s in parse_species() if s.dex.name == "Pikachu")
    stats = (pikachu.hp, pikachu.atk, getattr(pikachu, "def"), pikachu.spatk, pikachu.spdef, pikachu.spe)
    assert stats == (35, 55, 40, 50, 50, 95)
