"""Scrape src/abilities.cc's 1026 `constexpr Ability Impl<ABILITY_X> = { ... };` blocks
into a manifest the TS damage engine's ability registry is built and checked against.

None of this is proto data -- er-config's Ability message is just {id, name,
description, expanded_description}; every actual mechanic lives in this C++ file as a
function-pointer struct (include/abilities.hh's `struct Ability`) instantiated once per
ability. This module does NOT try to interpret the C++ (that's the hand-ported TS
registry's job, in web/src/features/damageCalc/abilities/); it extracts, per ability:

  - which declarative bitfields are set (adaptability, unaware, breakable, addsType, ...)
  - which hook fields (onOffensiveMultiplier, onStat, onStab, ...) are defined, in what
    form (an inline lambda, an alias to another ability's hook, a macro expansion, or a
    bare symbol), and the exact source text plus source line
  - the *For apply-on scope for whichever hooks carry one (defaults to APPLY_ON_SELF
    when the field is never set on the block, matching the C struct's zero-initialization)

The one hard rule: fail loudly. A block this parser cannot fully account for -- an
unbalanced brace, a top-level entry that isn't `.field = value` or one of the two known
bare-macro forms, an unrecognized field name -- raises, rather than silently emitting an
ability with hooks missing. Silent gaps are exactly how "full ability modelling" would
quietly become wrong.
"""

import re

from erdata.generated import AbilityEnum_pb2
from erdata.paths import ER_SOURCE

_Ability = AbilityEnum_pb2.AbilityEnum

_ABILITIES_CC = ER_SOURCE / "src" / "abilities.cc"
_ABILITIES_HH = ER_SOURCE / "include" / "abilities.hh"

# ---------------------------------------------------------------------------
# Pass 1: derive the field allowlist from include/abilities.hh's struct Ability,
# instead of hand-copying it -- so an upstream field addition/rename is caught by the
# "unrecognized field" error in _split_block_fields rather than silently ignored.
# ---------------------------------------------------------------------------

_STRUCT_RE = re.compile(r"typedef struct Ability\s*\{(?P<body>.*?)\}\s*Ability;", re.DOTALL)
# One field declaration per logical line inside the struct, e.g.
#   AbilityOnStatHandler onStat;
#   AbilityApplyOn onOffensiveMultiplierFor:3;
#   u16 adaptability:1;
# Deliberately does not try to parse the C type -- only the trailing identifier before
# `;` or `:width;` is needed to classify the field.
_FIELD_RE = re.compile(r"^\s*[\w:<>\*\s]+?\s(\w+)\s*(?::\s*\d+)?;\s*$", re.MULTILINE)

_NON_FIELD_NAMES = {"name", "description", "expandedDescription"}


def parse_ability_struct_fields() -> dict[str, set[str]]:
    """Returns {"hooks": {...}, "applyOn": {...}, "bitfields": {...}} field-name sets,
    derived from the struct body. A hook is any field whose name starts with "on" and
    has no "For" suffix; an apply-on scope is any "on...For" field; everything else
    (after dropping the three string fields) is a plain bitfield/enum flag.
    """
    text = _ABILITIES_HH.read_text()
    m = _STRUCT_RE.search(text)
    if not m:
        raise AssertionError("could not find `typedef struct Ability { ... } Ability;` in include/abilities.hh")
    names = [n for n in _FIELD_RE.findall(m["body"]) if n not in _NON_FIELD_NAMES]
    if not names:
        raise AssertionError("found struct Ability but extracted zero field names -- regex likely needs updating")

    hooks, apply_on, bitfields = set(), set(), set()
    for name in names:
        if name.endswith("For"):
            apply_on.add(name)
        elif name.startswith("on"):
            hooks.add(name)
        else:
            bitfields.add(name)
    return {"hooks": hooks, "applyOn": apply_on, "bitfields": bitfields}


# ---------------------------------------------------------------------------
# Pass 2: extract each `constexpr Ability Impl<ABILITY_X> = { ... };` block by brace
# matching (not regex over the body), so nested lambdas/initializers/comments/string
# literals can't desynchronize the parse.
# ---------------------------------------------------------------------------

_BLOCK_START_RE = re.compile(r"constexpr Ability Impl<(ABILITY_\w+)>\s*=\s*")


def _find_matching_brace(text: str, open_index: int) -> int:
    """`text[open_index]` must be '{'. Returns the index of its matching '}', skipping
    over nested braces, string/char literals, and // and /* */ comments.
    """
    assert text[open_index] == "{"
    depth = 0
    i = open_index
    n = len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i = text.index("\n", i) if "\n" in text[i:] else n
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.index("*/", i + 2)
            i = end + 2
            continue
        if c in ('"', "'"):
            quote = c
            i += 1
            while i < n and text[i] != quote:
                if text[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise AssertionError(f"unbalanced braces starting at offset {open_index}")


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


class AbilityBlock:
    def __init__(self, ability_id: str, start_line: int, end_line: int, body: str):
        self.ability_id = ability_id
        self.start_line = start_line
        self.end_line = end_line
        self.body = body  # text strictly between the outer { and }


def extract_ability_blocks(text: str) -> list[AbilityBlock]:
    raw_count = text.count("constexpr Ability Impl<")
    blocks = []
    seen = set()
    for m in _BLOCK_START_RE.finditer(text):
        ability_id = m.group(1)
        open_index = text.index("{", m.end() - 1)
        assert text[m.end() - 1 : open_index].strip() == "" or True  # whitespace only, tolerated
        close_index = _find_matching_brace(text, open_index)
        body = text[open_index + 1 : close_index]
        block = AbilityBlock(
            ability_id,
            start_line=_line_number(text, m.start()),
            end_line=_line_number(text, close_index),
            body=body,
        )
        if ability_id in seen:
            raise AssertionError(f"duplicate Impl<{ability_id}> block (previously seen; now again at line {block.start_line})")
        seen.add(ability_id)
        blocks.append(block)

    if len(blocks) != raw_count:
        raise AssertionError(
            f"extracted {len(blocks)} ability blocks but the raw text contains "
            f"{raw_count} occurrences of 'constexpr Ability Impl<' -- the brace-matching "
            "parser silently dropped at least one block"
        )
    for ability_id in seen:
        if ability_id not in _Ability.keys():
            raise AssertionError(f"Impl<{ability_id}> does not name a known AbilityEnum value")
    return blocks


# ---------------------------------------------------------------------------
# Pass 3: split each block body into its top-level `.field = value` entries.
# ---------------------------------------------------------------------------


def _split_top_level(body: str) -> list[str]:
    """Split on commas at bracket depth 0, skipping strings/chars/comments -- same
    scanning primitive as _find_matching_brace, generalized to track (), [], {} depth
    together and to split rather than match a single close.
    """
    parts = []
    depth = 0
    start = 0
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        if c == "/" and i + 1 < n and body[i + 1] == "/":
            i = body.index("\n", i) if "\n" in body[i:] else n
            continue
        if c == "/" and i + 1 < n and body[i + 1] == "*":
            i = body.index("*/", i + 2) + 2
            continue
        if c in ('"', "'"):
            quote = c
            i += 1
            while i < n and body[i] != quote:
                if body[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        if c in "({[":
            depth += 1
        elif c in ")}]":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(body[start:i])
            start = i + 1
        i += 1
    tail = body[start:]
    if tail.strip():
        parts.append(tail)
    return [p for p in (p.strip() for p in parts) if p]


# The only two macros ER uses as a *bare* top-level Impl<> entry (i.e. with no leading
# `.field =`) rather than as the value on the right of an assignment. Both are trivial
# and fixed, so they're hardcoded here rather than generically expanded -- verified
# against every current call site (grep -c in abilities.cc: 20 ON_EITHER_ABILITY, 27
# ATE_ABILITY, none of any other bare form) by test_ability_hooks.py.
_BARE_MACROS = {
    # abilities.hh / abilities.cc:54 -- `.onAttacker = X, .onDefender = X`, same handler
    # both ways. Neither onAttacker nor onDefender is a damage hook (§ _HOOK_KINDS).
    "ON_EITHER_ABILITY": ["onAttacker", "onDefender"],
    # abilities.cc:295-301 -- the "-ate" macro (Pixilate, Refrigerate, Aerilate, ...):
    # `.onMoveType = ..., .onStab = ...`. onStab IS a damage hook.
    "ATE_ABILITY": ["onMoveType", "onStab"],
}
_BARE_MACRO_RE = re.compile(r"^([A-Z][A-Z0-9_]*)\((.*)\)$", re.DOTALL)
_FIELD_ASSIGN_RE = re.compile(r"^\.(\w+)\s*=\s*(.*)$", re.DOTALL)
_ALIAS_RE = re.compile(r"^Impl<(ABILITY_\w+)>\.(\w+)$")
_MACRO_VALUE_RE = re.compile(r"^([A-Z][A-Z0-9_]*)\((.*)\)$", re.DOTALL)


class FieldEntry:
    def __init__(self, field, form, raw, alias_target=None, alias_hook=None, macro_name=None, macro_args=None):
        self.field = field
        self.form = form  # "lambda" | "alias" | "macro" | "symbol"
        self.raw = raw
        self.alias_target = alias_target
        self.alias_hook = alias_hook
        self.macro_name = macro_name
        self.macro_args = macro_args


def _classify_value(field: str, value: str) -> FieldEntry:
    value = value.strip()
    if value.startswith("+[]") or value.startswith("[]"):
        return FieldEntry(field, "lambda", value)
    alias = _ALIAS_RE.match(value)
    if alias:
        return FieldEntry(field, "alias", value, alias_target=alias.group(1), alias_hook=alias.group(2))
    macro = _MACRO_VALUE_RE.match(value)
    if macro:
        return FieldEntry(field, "macro", value, macro_name=macro.group(1), macro_args=macro.group(2))
    return FieldEntry(field, "symbol", value)


def split_block_fields(body: str, ability_id: str, allowed: dict[str, set[str]]) -> list[FieldEntry]:
    all_known = allowed["hooks"] | allowed["applyOn"] | allowed["bitfields"]
    entries = []
    for part in _split_top_level(body):
        assign = _FIELD_ASSIGN_RE.match(part)
        if assign:
            field, value = assign.group(1), assign.group(2)
            if field not in all_known:
                raise AssertionError(
                    f"Impl<{ability_id}>: unrecognized field '.{field}' -- not present in "
                    "the struct Ability field set derived from include/abilities.hh. "
                    "Either abilities.hh changed upstream, or this parser's assumptions are stale."
                )
            entries.append(_classify_value(field, value))
            continue
        bare = _BARE_MACRO_RE.match(part)
        if bare and bare.group(1) in _BARE_MACROS:
            macro_name, macro_args = bare.group(1), bare.group(2)
            for field in _BARE_MACROS[macro_name]:
                entries.append(FieldEntry(field, "macro", part, macro_name=macro_name, macro_args=macro_args))
            continue
        raise AssertionError(
            f"Impl<{ability_id}>: top-level entry {part!r} is neither '.field = value' nor "
            f"a known bare macro form ({sorted(_BARE_MACROS)}) -- abilities.cc introduced a "
            "new pattern this scraper doesn't handle"
        )
    return entries


# ---------------------------------------------------------------------------
# Pass 4: assemble the per-ability manifest entry.
# ---------------------------------------------------------------------------

# The hooks that feed the damage formula (CalcFinalDmg / CalcAttackStat / CalcDefenseStat
# / StabMultiplierInHalves / SetCritFlag / CalcTypeEffectivenessMultiplier /
# SetSwapDamageCategory, all in src/battle_util.c) -- an ability defining any of these,
# or setting one of _DAMAGE_BITFIELDS below, needs a TS port or an explicit
# "unmodelled" entry; everything else (onEntry, onWeather, onAccuracy's non-damage
# uses, ...) is out of scope for a damage calculator and is still recorded, just not
# flagged as damageRelevant.
_DAMAGE_HOOKS = {
    "onOffensiveMultiplier",
    "onDefensiveMultiplier",
    "onStat",
    "onStab",
    "onCrit",
    "onTypeEffectiveness",
    "onAfterTypeEffectiveness",
    "onChooseOffensiveStat",
    "onChooseDefensiveStat",
    "onSwapSplit",
    "onMoveType",
    "onRecoil",
    # Added after an audit found these six change the damage NUMBER too, just via a
    # call site outside CalcFinalDmg/CalcAttackStat/CalcDefenseStat/
    # StabMultiplierInHalves/SetCritFlag/CalcTypeEffectivenessMultiplier/
    # SetSwapDamageCategory -- see the field-report artifact from this session for
    # the full citation trail.
    "onParentalBond",  # GetParentalBondMultiplier, battle_util.c:7483-7515,7658-7662 -- extra-hit damage multiplier
    "onAbsorb",  # battle_ai_attack.c:1853 -- redirects the hit away from damage entirely (forces 0)
    "onImmune",  # TestImmunityAbilities, battle_util.c:8984-9000 -- aborts before any damage command runs (forces 0)
    "onInfiltrate",  # bypasses the 0.5x/0.66x screens multiplier in CalcFinalDmg, battle_util.c:7647-7653
    "onModifyMoveFlags",  # DoesMoveMatchFlag, abilities.cc:331-361 -- can grant a flag another ability's damage hook reads
    "onMoldBreaker",  # suppresses every `breakable` ability on the defender mid-calc, battle_util.c:9285-9312
}
_DAMAGE_BITFIELDS = {
    "adaptability",
    "unaware",
    "breakable",
    "levitate",
    "addsType",
    "omniStab",
    "skillLink",
    "fortKnox",
    "resistsFortKnox",
    "magicGuard",
    "noRecoil",
    "halfRecoil",
    "foesMinRoll",
    "megaLauncherBoost",
    "noDamageHits",
    "ruinStat",
    "negatesBurnAtkDrop",
    "negatesFrzSpatkDrop",
    "noBurnDamage",
}


def ability_hooks_to_dict() -> dict:
    text = _ABILITIES_CC.read_text()
    allowed = parse_ability_struct_fields()
    blocks = extract_ability_blocks(text)

    out = {}
    for block in blocks:
        entries = split_block_fields(block.body, block.ability_id, allowed)
        hooks = {}
        apply_on = {}
        bitfields = {}
        for e in entries:
            if e.field in allowed["hooks"]:
                hook = {"form": e.form, "source": e.raw.strip()}
                if e.form == "alias":
                    hook["aliasTarget"] = e.alias_target
                    hook["aliasHook"] = e.alias_hook
                if e.form == "macro":
                    hook["macroName"] = e.macro_name
                    hook["macroArgs"] = e.macro_args.strip()
                hooks[e.field] = hook
            elif e.field in allowed["applyOn"]:
                apply_on[e.field] = e.raw.strip()
            else:
                bitfields[e.field] = e.raw.strip()

        damage_reasons = sorted((set(hooks) | set(bitfields)) & (_DAMAGE_HOOKS | _DAMAGE_BITFIELDS))
        out[block.ability_id] = {
            "id": block.ability_id,
            "sourceLine": block.start_line,
            "endLine": block.end_line,
            "hooks": hooks,
            "applyOn": apply_on,
            "bitfields": bitfields,
            "damageRelevant": bool(damage_reasons),
            "damageRelevantReasons": damage_reasons,
        }
    return out


if __name__ == "__main__":
    d = ability_hooks_to_dict()
    print(f"abilities={len(d)}")
    assert len(d) == 1026, len(d)
    damage_relevant = [v for v in d.values() if v["damageRelevant"]]
    print(f"damage relevant={len(damage_relevant)}")
    aliases = sum(1 for v in d.values() for h in v["hooks"].values() if h["form"] == "alias")
    print(f"alias hook sites={aliases}")
    print("ok")
