"""Hand-curated near-equivalent ability groups.

Exact groups (same `description` text, derived in emit.py) can't catch abilities that
behave the same for randomizer-search purposes but are worded differently -- e.g.
Mold Breaker's family. This is the explicit, hand-maintained list for those, following
this repo's existing precedent for curated data (web/src/data/giftMonUnlocks.ts).
Each entry needs a one-line rationale; `emit.py` asserts every member name resolves to
a real ability.
"""

NEAR_EQUIVALENT_GROUPS: list[dict] = [
    {
        "members": ["Mold Breaker", "Teravolt", "Turboblaze"],
        "rationale": (
            "All three let moves hit through the target's abilities and innates. "
            "Teravolt and Turboblaze additionally grant Electric/Fire type on entry "
            "(already flagged via grantsType), which is why their descriptions differ "
            "enough that exact-group derivation can't merge them."
        ),
    },
]
