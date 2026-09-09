"""Serialize MoveBehaviorConfig's `Attack` submessage and its `ScriptCondition`
predicates into plain dicts. Shared by two call sites: emit.py's per-move inline
`custom_behavior` (26 moves embed one directly) and behaviors.py's whole-list parse
of MoveBehaviorConfigList.textproto (460 named configs) -- both describe the exact
same message shape (MoveBehaviorConfigList.proto), so this is the one place that
knows how to turn it into JSON.
"""

from erdata.generated import (
    AbilityEnum_pb2,
    ItemEnum_pb2,
    ItemList_pb2,
    MoveBehaviorConfigList_pb2,
    MoveEffect_pb2,
    ScriptConditions_pb2,
    SpeciesEnum_pb2,
    Types_pb2,
)

_MoveEffect = MoveEffect_pb2.MoveEffect.Name
_Type = Types_pb2.Type.Name
_Status = ScriptConditions_pb2.Status.Name
_Battler = ScriptConditions_pb2.Battler.Name
_Terrain = ScriptConditions_pb2.Terrain.Name
_Weather = ScriptConditions_pb2.Weather.Name
_FieldEffect = ScriptConditions_pb2.FieldEffect.Name
_HpType = ScriptConditions_pb2.ScriptCondition.Hp.HpType.Name
_Ability = AbilityEnum_pb2.AbilityEnum.Name
_Species = SpeciesEnum_pb2.SpeciesEnum.Name
_Item = ItemEnum_pb2.ItemEnum.Name
_HoldEffect = ItemList_pb2.HoldEffect.Name


def script_condition_to_dict(cond) -> dict:
    """A ScriptCondition is a 13-way oneof; emit it as {kind, ...fields}, one dict
    shape per branch, mirroring ScriptConditions.proto exactly rather than flattening
    it -- the engine's condition evaluator switches on `kind`.
    """
    kind = cond.WhichOneof("condition")
    if kind == "weather":
        return {"kind": "weather", "weather": _Weather(cond.weather.weather), "battler": _Battler(cond.weather.battler)}
    if kind == "damaged":
        return {"kind": "damaged", "battler": _Battler(cond.damaged.battler), "by": _Battler(cond.damaged.by)}
    if kind == "status":
        return {"kind": "status", "status": _Status(cond.status.status), "battler": _Battler(cond.status.battler)}
    if kind == "switching":
        return {"kind": "switching", "battler": _Battler(cond.switching.battler)}
    if kind == "acts_after":
        return {
            "kind": "actsAfter",
            "before": _Battler(cond.acts_after.before),
            "after": _Battler(cond.acts_after.after),
            "failIfSwitching": cond.acts_after.fail_if_switching,
        }
    if kind == "terrain":
        return {"kind": "terrain", "terrain": _Terrain(cond.terrain.terrain), "battler": _Battler(cond.terrain.battler)}
    if kind == "field_effect":
        return {"kind": "fieldEffect", "effect": _FieldEffect(cond.field_effect.effect)}
    if kind == "ability":
        return {
            "kind": "ability",
            "ability": _Ability(cond.ability.ability),
            "battler": _Battler(cond.ability.battler),
            "checkMoldBreaker": cond.ability.check_mold_breaker,
        }
    if kind == "hp":
        return {"kind": "hp", "hp": _HpType(cond.hp.hp), "battler": _Battler(cond.hp.battler)}
    if kind == "recent_fainted":
        return {"kind": "recentFainted", "battler": _Battler(cond.recent_fainted.battler)}
    if kind == "custom":
        return {"kind": "custom"}
    if kind == "species":
        return {
            "kind": "species",
            "species": [_Species(s) for s in cond.species.species],
            "battler": _Battler(cond.species.battler),
            "exact": cond.species.exact,
        }
    if kind == "item":
        return {
            "kind": "item",
            "item": [_Item(i) for i in cond.item.item],
            "holdEffect": [_HoldEffect(h) for h in cond.item.hold_effect],
            "battler": _Battler(cond.item.battler),
            "skipDisabling": cond.item.skip_disabling,
        }
    raise ValueError(f"unhandled ScriptCondition oneof case: {kind!r}")


def _damage_modifier_to_dict(mod) -> dict:
    which = mod.WhichOneof("modifier")
    if which == "multiply":
        return {"kind": "multiply", "value": mod.multiply}
    if which == "add":
        return {"kind": "add", "value": mod.add}
    if which == "set":
        return {"kind": "set", "value": mod.set}
    if which == "custom":
        return {"kind": "custom"}
    if which == "custom_from":
        from erdata.generated import MoveBehavior_pb2

        return {"kind": "customFrom", "behavior": MoveBehavior_pb2.MoveBehavior.Name(mod.custom_from)}
    raise ValueError(f"unhandled DamageModifier oneof case: {which!r}")


def _secondary_effect_to_dict(effect) -> dict:
    entry = {"chance": effect.chance}
    which = effect.WhichOneof("attack_effect")
    if which == "move_effect":
        entry["kind"] = "moveEffect"
        entry["effect"] = _MoveEffect(effect.move_effect.effect)
        entry["affectsUser"] = effect.move_effect.affects_user
        entry["certain"] = effect.move_effect.certain
    elif which == "argument_effect":
        entry["kind"] = "argumentEffect"
    else:
        raise ValueError(f"unhandled AttackSecondaryEffect oneof case: {which!r}")
    return entry


def attack_to_dict(attack) -> dict:
    entry = {
        "secondaryEffects": [_secondary_effect_to_dict(e) for e in attack.effect],
        "recoilFraction": attack.recoil_fraction,
    }
    which = attack.WhichOneof("resistance_modifier")
    if which == "super_effective_vs":
        entry["superEffectiveVs"] = _Type(attack.super_effective_vs)
    elif which == "ignore_type_immunity":
        entry["ignoreTypeImmunity"] = attack.ignore_type_immunity
    if attack.HasField("damage"):
        entry["damage"] = {
            "conditions": [script_condition_to_dict(c) for c in attack.damage.condition],
            "modifier": _damage_modifier_to_dict(attack.damage),
        }
    return entry


def behavior_config_to_dict(config) -> dict:
    """A MoveBehaviorConfig (top-level list entry, or a move's inline
    `custom_behavior`). `id` is omitted here -- callers key by it (either the real
    MoveBehavior enum value, for the 460-entry list, or a per-move slot with no id
    of its own, for inline custom_behavior).
    """
    entry = {"causesFlinch": config.causes_flinch, "trappingEffect": config.trapping_effect}
    which = config.WhichOneof("config_type")
    if which == "legacy_config":
        entry["legacyConfig"] = config.legacy_config
    elif which == "attack":
        entry["attack"] = attack_to_dict(config.attack)
    # `which is None` is legitimate: a handful of configs set only causes_flinch/
    # trapping_effect with neither legacy_config nor a structured attack{}.
    return entry
