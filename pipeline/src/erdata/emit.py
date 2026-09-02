"""Build the plain-dict, JSON-ready representation of the resolved game data and write
it deterministically to data/<version>/.
"""

import json
import re
from datetime import UTC, datetime

from erdata.generated import (
    AbilityEnum_pb2,
    ItemEnum_pb2,
    ItemList_pb2,
    MoveBehavior_pb2,
    MoveEffect_pb2,
    MoveEnum_pb2,
    MoveList_pb2,
    ScriptConditions_pb2,
    SpeciesEnum_pb2,
    SpeciesList_pb2,
    Types_pb2,
)
from erdata.behaviors import move_behaviors_to_dict
from erdata.move_behavior import behavior_config_to_dict
from erdata.natures import battle_constants_to_dict
from erdata.paths import load_lock, output_dir
from erdata.parse import parse_abilities, parse_items, parse_moves, parse_species
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
_I = ItemEnum_pb2.ItemEnum.Name
_T = Types_pb2.Type.Name
_MB = MoveBehavior_pb2.MoveBehavior.Name
_ME = MoveEffect_pb2.MoveEffect.Name
_Status = ScriptConditions_pb2.Status.Name
_Gender = SpeciesList_pb2.Species.Gender.Name
_MegaType = SpeciesList_pb2.Species.MegaEvolution.MegaType.Name
_PrimalType = SpeciesList_pb2.Species.PrimalEvolution.PrimalType.Name
_Pocket = ItemList_pb2.Pocket.Name
_HoldEffect = ItemList_pb2.HoldEffect.Name
_UseType = ItemList_pb2.UseType.Name
_SplitFlag = MoveList_pb2.SplitFlag.Name
_Crit = MoveList_pb2.Crit.Name
_HitsAir = MoveList_pb2.HitsAir.Name

# A curated subset of Move's ~40 boolean flags -- the ones a Pokedex move list or a
# damage calculator actually needs to show or act on. Additive: more can be added
# later without breaking the format. Six of these keys (punchBased, biteBased,
# kickBased, sliceBased, boneBased, bulletBased) are intentionally renamed from their
# proto field names to the ability they boost (e.g. "punchBased" reads as "boosted by
# Iron Fist" even though the proto field is `iron_fist`); everything added since is
# named directly after the proto field so the mapping stays self-evident.
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
    # Damage-calculator-relevant flags added alongside MoveBehavior/argument support --
    # see MoveList.proto:143-191 for the exact (field_name)/(flag_code_value) options.
    "ignoresStatStages": "ignores_stat_stages",
    "doubleDamageVsMega": "double_damage_vs_mega",
    "everyOtherTurn": "every_other_turn",
    "isProtection": "is_protection",
    "ignoresAbility": "ignores_ability",
    "noKingsRock": "no_kings_rock",
    "noSheerForce": "no_sheer_force",
    "hitsUnderground": "hits_underground",
    "hitsUnderwater": "hits_underwater",
    "powderAffected": "powder_affected",
    "ignoresLevitation": "ignores_levitation",
    "thawUser": "thaw_user",
    "weatherBased": "weather",
    "fieldBased": "field",
    "arrowBased": "arrow",
    "hornBased": "horn",
    "airBased": "air",
    "hammerBased": "hammer",
    "throwingBased": "throwing",
    "lunarBased": "lunar",
    "drillBased": "drill",
    "noParentalBond": "no_parental_bond",
    "metronomeBanned": "metronome_banned",
    "copycatBanned": "copycat_banned",
    "sleepTalkBanned": "sleep_talk_banned",
    "mimicBanned": "mimic_banned",
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
            entry["item"] = _I(m.item)
        elif which == "move":
            entry["move"] = _M(m.move)
        out.append(entry)
    return out


def _primals(species) -> list[dict]:
    return [
        {"from": _S(getattr(p, "from")), "item": _I(p.item), "primalType": _PrimalType(p.type)}
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
        "height": dex.height,  # decimetres
        "weight": dex.weight,  # hectograms -- Low Kick/Heat Crash read this via
        # GetPokedexHeightWeight, battle_util.c:6732 (form_of species inherit the
        # base's dex info, same as name/category/description above).
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


# Move.argument is a 6-way oneof (MoveList.proto:73-80) carrying the extra parameter
# some MoveBehaviors need (e.g. EFFECT_MISC_HIT reads `misc`, EFFECT_SECRET_POWER-style
# effects read `effect`). Emitted as {kind, ...} rather than flattened, same convention
# as ScriptCondition in move_behavior.py.
def _argument_to_dict(move) -> dict | None:
    if not move.HasField("argument"):
        return None
    arg = move.argument
    kind = arg.WhichOneof("argument")
    if kind is None:
        return None
    if kind == "type":
        return {"kind": "type", "type": _T(arg.type)}
    if kind == "effect":
        return {
            "kind": "effect",
            "effect": _ME(arg.effect.effect),
            "affectsUser": arg.effect.affects_user,
            "certain": arg.effect.certain,
        }
    if kind == "int":
        return {"kind": "int", "value": arg.int}
    if kind == "other":
        return {"kind": "other", "value": arg.other}
    if kind == "status":
        return {"kind": "status", "status": _Status(arg.status)}
    if kind == "misc":
        return {"kind": "misc", "misc": MoveList_pb2.MiscMoveEffect.Name(arg.misc)}
    raise ValueError(f"unhandled Move.Argument oneof case: {kind!r}")


def move_to_dict(move) -> dict:
    move_effect = move.WhichOneof("move_effect")
    entry = {
        "id": _M(move.id),
        "name": move.name,
        "shortName": move.short_name,
        "description": move.description,
        "shortDescription": move.short_description,
        "type": _T(move.type) if move.HasField("type") else None,
        "type2": _T(move.type2) if move.type2 else None,
        "power": move.power,
        "accuracy": move.accuracy,
        "pp": move.pp,
        "priority": move.priority,
        "effectChance": move.effect_chance,
        "split": MoveList_pb2.MoveSplit.Name(move.split) if move.HasField("split") else None,
        "target": (
            MoveList_pb2.MoveTarget.Name(move.target) if move.HasField("target") else None
        ),
        # `effect` is the 460-value MoveBehavior enum (nothing about a move's actual
        # mechanic -- multi-hit, recoil, fixed damage, ... -- is recoverable without
        # it); a handful of moves inline a one-off MoveBehaviorConfig instead of
        # referencing a named behavior (`customBehavior`, same shape as an entry in
        # moveBehaviors.json). Exactly one of the two is ever set.
        "effect": _MB(move.effect) if move_effect == "effect" else None,
        "customBehavior": (
            behavior_config_to_dict(move.custom_behavior) if move_effect == "custom_behavior" else None
        ),
        "flags": {key: True for key, field in _MOVE_FLAGS.items() if getattr(move, field)},
    }
    if move.tutor:
        entry["tutorCategory"] = MoveList_pb2.TutorType.Name(move.tutor)
    if move.split_modifier:
        entry["splitFlag"] = _SplitFlag(move.split_modifier)
    if move.crit:
        entry["crit"] = _Crit(move.crit)
    if move.hits_air:
        entry["hitsAir"] = _HitsAir(move.hits_air)
    if move.hit_count:
        entry["hitCount"] = move.hit_count
    argument = _argument_to_dict(move)
    if argument:
        entry["argument"] = argument
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


# Elite Redux's own in-game hint for how to unlock each Mega Stone (shown via
# GetMegaHintString in the compiled ROM) is driven by exactly one of these 4 fields
# per item -- not something reverse-engineered from map scripts, it's structured data
# straight from er-config, same as everything else this pipeline emits. See
# tools/codegen/src/er/item/MegaHintGenerator.kt in eliteredux-source for the exact
# in-game text this mirrors.
def _mega_stone_hint(item) -> dict | None:
    which = item.WhichOneof("mega_stone_hint")
    if which is None:
        return None
    if which == "unique_mega_location":
        return {"kind": "uniqueLocation", "text": item.unique_mega_location}
    # talk_to_nurse_joy / adoption_center / talk_to_legendary_sage are plain bools;
    # WhichOneof already told us which one is set, so its value is always True here.
    kind = {
        "talk_to_nurse_joy": "nurseJoy",
        "adoption_center": "adoptionCenter",
        "talk_to_legendary_sage": "legendarySage",
    }[which]
    return {"kind": kind}


# 17 of the 20 real HOLD_EFFECT_* mechanics (Life Orb, Choice Band/Specs/Scarf, Expert
# Belt, ...) collapse to HOLD_EFFECT_CUSTOM in the proto -- the real C symbol the ROM
# gets is resolved at codegen time from hold_effect_alias (if set) or the item's own id,
# per tools/codegen/src/er/item/ItemGenerator.kt:33-49. Without this, Life Orb and
# Choice Band are indistinguishable in the emitted data.
def _resolved_hold_effect(item) -> str:
    if item.hold_effect != ItemList_pb2.HOLD_EFFECT_CUSTOM:
        return _HoldEffect(item.hold_effect)
    suffix = item.hold_effect_alias if item.hold_effect_alias else _I(item.id).removeprefix("ITEM_")
    return f"HOLD_EFFECT_{suffix}"


def item_to_dict(item) -> dict:
    entry = {
        "id": _I(item.id),
        "itemNum": int(item.id),
        "name": item.name,
        "description": item.description,
        "grouping": _Pocket(item.grouping),
        "holdEffect": _HoldEffect(item.hold_effect),
        "resolvedHoldEffect": _resolved_hold_effect(item),
        "useType": _UseType(item.use_type),
    }
    if item.hold_effect_strength:
        entry["holdEffectStrength"] = item.hold_effect_strength
    if item.hold_effect_type:
        entry["holdEffectType"] = _T(item.hold_effect_type)
    if item.hold_effect_alias:
        entry["holdEffectAlias"] = item.hold_effect_alias
    if item.hold_effect_misc_param:
        entry["holdEffectMiscParam"] = item.hold_effect_misc_param
    if item.bp_price:
        entry["bpPrice"] = item.bp_price
    if item.mega_badge_requirement:
        entry["megaBadgeRequirement"] = item.mega_badge_requirement
    hint = _mega_stone_hint(item)
    if hint:
        entry["megaStoneHint"] = hint
    if item.HasField("natural_gift"):
        ng = item.natural_gift
        entry["naturalGift"] = {
            "power": ng.power,
            "type": _T(ng.type),
            "affectsUser": ng.affects_user,
            "certain": ng.certain,
        }
        if ng.effect:
            entry["naturalGift"]["effect"] = _ME(ng.effect)
        if ng.priority:
            entry["naturalGift"]["priority"] = ng.priority
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
    items = parse_items()
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
    _write_json(out / "items.json", [item_to_dict(i) for i in sorted(items, key=lambda i: _I(i.id))])
    move_behaviors = move_behaviors_to_dict()
    _write_json(out / "moveBehaviors.json", move_behaviors)
    _write_json(out / "natures.json", battle_constants_to_dict())
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
                "items": len(items),
                "moveBehaviors": len(move_behaviors["behaviors"]),
            },
        },
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    build()
