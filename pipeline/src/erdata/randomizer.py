"""Extract Elite Redux's randomizer-ban flag for abilities.

`gAbilities[id].randomizerBanned` (src/pokemon.c:4992, 5008 -- RandomizeInnate /
RandomizeAbility) gates whether an ability can appear as a randomizer *source* (a
banned source is left untouched) or *result* (the reroll loop skips it). It is not in
er-config -- `gAbilities` is hand-written C++, one `constexpr Ability
Impl<ABILITY_X> = { ... }` template specialization per ability (src/abilities.cc), not
generated from the proto. Abilities without an explicit specialization fall back to
`template <AbilityEnum Id> constexpr Ability Impl = {0};` (~line 449 at the pinned SHA)
-- i.e. not banned.

Specialization bodies contain nested braces (lambda bodies for onAttacker/onEntry/etc),
so naive brace-matching (as typechart.py does for a flat array) doesn't apply here.
Instead: specializations are sequential top-level declarations, so everything between
the start of one and the start of the next is guaranteed to be exactly that
specialization's body, however deeply its own braces nest.
"""

import re

from erdata.paths import ER_SOURCE

_SOURCE_FILE = "src/abilities.cc"
_EXPECTED_BANNED_COUNT = 38

_SPECIALIZATION = re.compile(r"constexpr Ability Impl<ABILITY_(\w+)>\s*=\s*\{")


def parse_randomizer_banned() -> set[str]:
    """AbilityEnum names (e.g. "ABILITY_NONE") banned from the ability/innate
    randomizer -- as a source (left untouched) and as a result (skipped on reroll)."""
    text = (ER_SOURCE / _SOURCE_FILE).read_text()
    matches = list(_SPECIALIZATION.finditer(text))
    assert matches, f"no Impl<ABILITY_*> specializations found in {_SOURCE_FILE}"

    banned = set()
    for i, m in enumerate(matches):
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end]
        if ".randomizerBanned = TRUE" in body:
            banned.add(f"ABILITY_{m.group(1)}")

    assert len(banned) == _EXPECTED_BANNED_COUNT, (
        f"expected {_EXPECTED_BANNED_COUNT} randomizer-banned abilities, got {len(banned)}"
    )
    assert "ABILITY_NONE" in banned, "ABILITY_NONE must be banned -- empty slots stay empty"
    return banned


if __name__ == "__main__":
    banned = parse_randomizer_banned()
    print(f"{len(banned)} randomizer-banned abilities")
    for name in sorted(banned):
        print(f"  {name}")
