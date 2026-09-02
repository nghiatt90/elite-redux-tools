"""Cross-check our resolved output against ER-nextdex's published gameData.json.

nextdex (https://github.com/ForwardFeed/ER-nextdex, GPL-3.0) hand-parses Elite Redux's
generated C headers in TypeScript -- an independent implementation of roughly the same
job this pipeline does from er-config's protobuf source. Its output describes Elite
Redux's game data (facts, not ForwardFeed's creative work), so using it as a test oracle
doesn't touch its copyleft; we're not reusing any of its code.

Where the two intentionally diverge (the tutor-move expansion; see resolve.py), the
oracle test documents that rather than asserting false equality.
"""

import json
import urllib.request

from erdata.paths import UPSTREAM

_URL = (
    "https://raw.githubusercontent.com/ForwardFeed/ER-nextdex/main/"
    "static/js/data/gameDataV2.65beta.json"
)
_CACHE = UPSTREAM / "nextdex_gameData.json"


def fetch_oracle() -> dict:
    if not _CACHE.exists():
        UPSTREAM.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(_URL, timeout=30) as resp:
            _CACHE.write_bytes(resp.read())
    return json.loads(_CACHE.read_text())


def oracle_species_by_id(oracle: dict) -> dict[str, dict]:
    """Keyed by nextdex's own `NAME` field (its copy of the SPECIES_* symbolic id),
    NOT by display name -- many forms inherit their base species' display name (e.g.
    every Venusaur form is just named "Venusaur" in the actual game data; nextdex adds
    display-only suffixes like " Mega" in some but not all cases), so display name is
    not a unique key and silently collides.
    """
    type_names = oracle["typeT"]
    ability_names = {a["id"]: a["name"] for a in oracle["abilities"]}
    move_names = {m["id"]: m["name"] for m in oracle["moves"]}

    def convert(sp: dict) -> dict:
        stats = sp["stats"]
        return {
            "baseStats": {
                "hp": stats["base"][0],
                "atk": stats["base"][1],
                "def": stats["base"][2],
                "spatk": stats["base"][3],
                "spdef": stats["base"][4],
                "spe": stats["base"][5],
            },
            "types": {type_names[t].upper() for t in stats["types"]},
            "abilities": {ability_names[a] for a in stats["abis"] if a in ability_names},
            "innates": {ability_names[i] for i in stats["inns"] if i in ability_names},
            "levelUpMoves": {move_names[m["id"]] for m in sp["levelUpMoves"] if m["id"] in move_names},
            "tutor": {move_names[t] for t in sp["tutor"] if t in move_names},
        }

    return {sp["NAME"]: convert(sp) for sp in oracle["species"] if sp.get("NAME")}
