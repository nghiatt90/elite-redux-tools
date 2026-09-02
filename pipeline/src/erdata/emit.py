"""Build the plain-dict, JSON-ready representation of the resolved game data and write
it deterministically to data/<version>/.
"""

import json
import re
from datetime import UTC, datetime

from erdata.generated import (
    AbilityEnum_pb2,
    MoveEnum_pb2,
    MoveList_pb2,
    SpeciesEnum_pb2,
    SpeciesList_pb2,
    Types_pb2,
)
from erdata.paths import load_lock, output_dir
from erdata.parse import parse_abilities, parse_moves, parse_species
from erdata.resolve import (
    build_species_map,
    expand_learnset,
    playable_species,
    resolve_abilities,
    resolve_dex_info,
    resolve_learnset,
    universal_tutor_sets,
)
from erdata.typechart import parse_type_chart

_S = SpeciesEnum_pb2.SpeciesEnum.Name
_A = AbilityEnum_pb2.AbilityEnum.Name
_M = MoveEnum_pb2.MoveEnum.Name
_T = Types_pb2.Type.Name
_Gender = SpeciesList_pb2.Species.Gender.Name
_MegaType = SpeciesList_pb2.Species.MegaEvolution.MegaType.Name
_PrimalType = SpeciesList_pb2.Species.PrimalEvolution.PrimalType.Name

# A curated subset of Move's ~40 boolean flags -- the ones a Pokedex move list or a
# damage calculator actually needs to show or act on. Additive: more can be added
# later without breaking the format.
_MOVE_FLAGS = {
    "contact": "contact",
    "sound": "sound",
    "ballistic": "ballistic",
    "dance": "dance",
    "twoTurn": "two_turn",
    "ignoresProtect": "ignores_protect",
    "ignoresSubstitute": "ignores_substitute",
    "snatchAffected": "snatch_affected",
    "magicCoatAffected": "magic_coat_affected",
    "mirrorMoveAffected": "mirror_move_affected",
    "reckless": "reckless",
    "punchBased": "iron_fist",
    "biteBased": "strong_jaw",
    "kickBased": "striker",
    "sliceBased": "keen_edge",
    "boneBased": "bone",
    "bulletBased": "mega_launcher",
}


def _types_of(species) -> list[str]:
    types = [_T(species.type)]
    if species.type2 and species.type2 != species.type:
        types.append(_T(species.type2))
    return types


def _gender_info(species) -> dict:
    which = species.WhichOneof("gender")
    if which == "genderless":
        return {"genderless": True}
    return {"percentFemale": round(species.percent_female, 3)}


def _evolutions(species) -> list[dict]:
    out = []
    for e in species.evo:
        entry = {"to": _S(e.to)}
        if e.level:
            entry["level"] = e.level
        if e.gender:
            entry["gender"] = _Gender(e.gender)
        out.append(entry)
    return out


def _megas(species) -> list[dict]:
    out = []
    for m in species.mega:
        entry = {"from": _S(getattr(m, "from")), "megaType": _MegaType(m.type)}
        which = m.WhichOneof("evo_using")
        if which == "item":
            entry["item"] = m.item
        elif which == "move":
            entry["move"] = _M(m.move)
        out.append(entry)
    return out


def _primals(species) -> list[dict]:
    return [
        {"from": _S(getattr(p, "from")), "item": p.item, "primalType": _PrimalType(p.type)}
        for p in species.primal
    ]


# ~18 abilities literally grant an extra type on top of the species' own 1-2, e.g.
# "Half Drake :: Adds Dragon type on entry." -- verified by hand against the full
# ability list, and only these plain "Adds <Type> type" phrasings; extracted here
# rather than hardcoded so it stays correct if wording changes upstream.
_TYPE_GRANT_PATTERN = re.compile(r"Adds\s+([A-Za-z]+)[- ]?type", re.I)


def _grants_type(description: str) -> str | None:
    m = _TYPE_GRANT_PATTERN.search(description)
    return m.group(1).upper() if m else None


# Compound abilities (e.g. "Big Leaves") have a description that is an exact
# " + "-joined list of other real ability names -- a genuine structural pattern (161
# of 1044 abilities match), not a guess: verified every split segment resolves to an
# existing ability by name before treating it as compound.
def _components(description: str, name_index: dict) -> list | None:
    if " + " not in description:
        return None
    parts = [p.strip().rstrip(".") for p in description.split(" + ")]
    if len(parts) < 2 or not all(p in name_index for p in parts):
        return None
    return [name_index[p] for p in parts]


def _learnset(species, species_map, tutors) -> dict:
    resolved = resolve_learnset(species, species_map)
    level_up = [
        {"level": lvl.level, "moves": [_M(m) for m in lvl.move]} for lvl in resolved.level
    ]
    tutor_moves = [_M(m) for m in expand_learnset(resolved, species, tutors)]
    return {"levelUp": level_up, "tutor": tutor_moves}


def species_to_dict(species, species_map, tutors) -> dict:
    dex = resolve_dex_info(species, species_map)
    is_form = species.WhichOneof("base_species_info") == "form_of"
    entry = {
        "id": _S(species.id),
        "speciesNum": int(species.id),
        "name": dex.name,
        "category": dex.category,
        "description": dex.description,
        "nationalDexNum": dex.national_dex_num,
        "isForm": is_form,
        "formOf": _S(species.form_of) if is_form else None,
        "types": _types_of(species),
        "baseStats": {
            "hp": species.hp,
            "atk": species.atk,
            "def": getattr(species, "def"),
            "spatk": species.spatk,
            "spdef": species.spdef,
            "spe": species.spe,
        },
        "abilities": [_A(a) for a in resolve_abilities(species)],
        "innates": [_A(a) for a in species.innate],
        "gender": _gender_info(species),
        "evolutions": _evolutions(species),
        "megas": _megas(species),
        "primals": _primals(species),
        "learnset": _learnset(species, species_map, tutors),
    }
    if species.long_name:
        entry["longName"] = species.long_name
    if species.heads:
        entry["heads"] = species.heads
    return entry


def move_to_dict(move) -> dict:
    entry = {
        "id": _M(move.id),
        "name": move.name,
        "shortName": move.short_name,
        "description": move.description,
        "shortDescription": move.short_description,
        "type": _T(move.type) if move.HasField("type") else None,
        "power": move.power,
        "accuracy": move.accuracy,
        "pp": move.pp,
        "priority": move.priority,
        "effectChance": move.effect_chance,
        "split": MoveList_pb2.MoveSplit.Name(move.split) if move.HasField("split") else None,
        "target": (
            MoveList_pb2.MoveTarget.Name(move.target) if move.HasField("target") else None
        ),
        "flags": {key: True for key, field in _MOVE_FLAGS.items() if getattr(move, field)},
    }
    if move.tutor:
        entry["tutorCategory"] = MoveList_pb2.TutorType.Name(move.tutor)
    return entry


def ability_to_dict(ability, name_index: dict) -> dict:
    entry = {
        "id": _A(ability.id),
        "name": ability.name,
        "description": ability.description,
    }
    if ability.HasField("expanded_description"):
        entry["expandedDescription"] = ability.expanded_description

    grants = _grants_type(ability.description)
    if grants:
        entry["grantsType"] = grants

    components = _components(ability.description, name_index)
    if components:
        entry["components"] = [_A(c.id) for c in components]

    return entry


def type_chart_to_dict() -> dict:
    chart = parse_type_chart()
    return {
        atk.removeprefix("TYPE_"): {def_.removeprefix("TYPE_"): mult for def_, mult in row.items()}
        for atk, row in chart.items()
    }


def _write_json(path, data) -> None:
    path.write_text(json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n")


def build() -> None:
    lock = load_lock()
    species = parse_species()
    moves = parse_moves()
    abilities = parse_abilities()
    species_map = build_species_map(species)
    tutors = universal_tutor_sets(moves)

    playable = playable_species(species)
    playable.sort(key=lambda s: (resolve_dex_info(s, species_map).national_dex_num, _S(s.id)))

    out = output_dir()
    out.mkdir(parents=True, exist_ok=True)

    _write_json(
        out / "species.json",
        [species_to_dict(s, species_map, tutors) for s in playable],
    )
    _write_json(out / "moves.json", [move_to_dict(m) for m in sorted(moves, key=lambda m: _M(m.id))])
    ability_name_index = {a.name: a for a in abilities}
    _write_json(
        out / "abilities.json",
        [ability_to_dict(a, ability_name_index) for a in sorted(abilities, key=lambda a: _A(a.id))],
    )
    _write_json(out / "types.json", type_chart_to_dict())
    _write_json(
        out / "meta.json",
        {
            "gameVersion": lock["game_version"],
            "generatedAt": datetime.now(UTC).replace(microsecond=0).isoformat(),
            "sources": {
                name: {"repo": spec["repo"], "sha": spec["sha"], "date": spec["date"]}
                for name, spec in lock["sources"].items()
            },
            "counts": {
                "species": len(playable),
                "moves": len(moves),
                "abilities": len(abilities),
            },
        },
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    build()
