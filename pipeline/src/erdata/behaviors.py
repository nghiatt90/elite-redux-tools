"""Parse MoveBehaviorConfigList.textproto -- the declarative table of per-MoveBehavior
damage mechanics (conditional base-power modifiers, recoil fractions, super-effective
overrides, secondary-effect chances) that ER's own codegen
(tools/codegen/src/er/move/MoveDamageGenerator.kt and friends) reads to generate the
in-game C. It's fetched by the pipeline already but was never parsed until now.

Only 69 of 460 configs carry a structured `attack {}` block (27 with a `damage`
modifier); the rest are opaque `legacy_config: "BattleScript_..."` names, which we
still emit -- a damage calculator needs to know a move's mechanic is a script it
can't model, not just silently guess EFFECT_HIT-style behavior for it.
"""

from erdata.generated import MoveBehavior_pb2, MoveEffect_pb2
from erdata.move_behavior import behavior_config_to_dict
from erdata.parse import parse_move_behaviors

_MoveBehavior = MoveBehavior_pb2.MoveBehavior.Name
_MoveEffect = MoveEffect_pb2.MoveEffect.Name

# The five EnumValueOptions extensions MoveBehavior.proto declares on
# google.protobuf.EnumValueOptions (MoveBehavior.proto:10-16) -- e.g.
# `EFFECT_EXPLOSION = 7 [(no_parental_bond) = true];`. MoveEffect.proto imports
# MoveBehavior.proto and reuses the same extension numbers on its own enum values
# (e.g. `MOVE_EFFECT_FLINCH = 10 [(flinch_effect) = true];`), so one lookup table
# serves both enums. Only readable off the compiled descriptor, never from a
# textproto -- there's nothing to parse, the values are baked into the enum
# declaration itself.
_ENUM_OPTION_EXTENSIONS = ["no_sheer_force", "flinch_effect", "no_kings_rock", "two_turn", "no_parental_bond"]


def _camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(w.capitalize() for w in rest)


def _enum_value_options(value_descriptor) -> dict:
    opts = value_descriptor.GetOptions()
    extensions = MoveBehavior_pb2.DESCRIPTOR.extensions_by_name
    found = {}
    for name in _ENUM_OPTION_EXTENSIONS:
        ext = extensions.get(name)
        if ext is None:
            raise AssertionError(
                f"MoveBehavior.proto no longer declares the {name!r} EnumValueOptions "
                "extension -- update _ENUM_OPTION_EXTENSIONS"
            )
        if opts.HasExtension(ext) and opts.Extensions[ext]:
            found[_camel(name)] = True
    return found


def move_behaviors_to_dict() -> dict:
    configs = parse_move_behaviors()
    behaviors = {}
    for config in configs:
        name = _MoveBehavior(config.id)
        entry = behavior_config_to_dict(config)
        options = _enum_value_options(MoveBehavior_pb2.MoveBehavior.DESCRIPTOR.values_by_name[name])
        if options:
            entry["options"] = options
        behaviors[name] = entry

    move_effect_options = {}
    for value in MoveEffect_pb2.MoveEffect.DESCRIPTOR.values:
        options = _enum_value_options(value)
        if options:
            move_effect_options[value.name] = options

    return {"behaviors": behaviors, "moveEffectOptions": move_effect_options}


if __name__ == "__main__":
    configs = parse_move_behaviors()
    print(f"configs={len(configs)}")
    assert len(configs) == 460, len(configs)
    d = move_behaviors_to_dict()
    with_damage = sum(1 for v in d["behaviors"].values() if v.get("attack", {}).get("damage"))
    print(f"with damage modifier={with_damage}")
    assert with_damage == 27, with_damage
    assert d["moveEffectOptions"]["MOVE_EFFECT_FLINCH"] == {"flinchEffect": True}
    print("ok")
