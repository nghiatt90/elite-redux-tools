"""Scrape eliteredux-source's data/maps/**/scripts.pory for the per-battle environment
data that Elite Redux's own map scripts encode outside of er-config: field effects
(weather/terrain/room/monotype-champion) applied before specific trainer battles, the
gym "battle event" buffs/debuffs each gym registers per undefeated gym trainer, and
back-to-back trainer battle chains fought with no heal in between.

None of this is proto data -- er-config carries no map scripts at all, so every fact
here is scraped straight from Poryscript source. Only the .pory source is fetched (not
the compiled .inc bytecode, which doesn't exist in this repo -- it's generated at ROM
build time); see sources.lock.json's sparse_paths, widened to include "data" for this.

The corpus mixes two authoring styles left over from the project's history: legacy raw
pokeemerald assembly inside `raw \\`...\\`` blocks (bare labels, comma-separated opcode
arguments, no braces) and modern Poryscript (`script Name{ ... }`, C-like
`if (cond) { ... }`/`else`/`switch`, paren-called opcodes) -- see
data/maps/MossdeepCity_Gym/scripts.pory, which contains both in the same file. Every
construct this module looks for appears in both styles somewhere in the corpus, so the
regexes below accept `opcode ARG1, ARG2` and `opcode(ARG1, ARG2)` alike.

Correction against the plan's own wording: it describes registerbattleevent calls as
having "guarding flag conditions". Reading the actual scripts (e.g.
data/maps/DewfordTown_Gym/scripts.pory:686-699) shows every gym's per-trainer guard is
an `if (!defeated(TRAINER_X))` boolean check, not a raw FLAG_ literal; the one file that
deviates (MossdeepCity_Gym, whose gym leaders are tag-team pairs) guards on a defeated-
count comparison, `if (var(VAR_RESULT) < N)`, fed by a helper script that sums several
`defeated()` calls (scripts.pory:947-965). This module records the guard expression's
actual source text rather than forcing it into a "flag" shape it doesn't have.

Heuristic, not exhaustive -- this is hand-authored quest/dialogue script for 500+ maps,
not a machine format, so (unlike ability_hooks.py) there is no "fail loudly on anything
unrecognized" option that wouldn't just abort on the first typo or one-off macro in the
corpus:
  - The line-based brace/guard tracker assumes each `if (cond) {` / `} else if (cond) {`
    / `} else {` / `switch (expr) {` opens on the line it starts on, which held for
    every case this module was checked against but is not guaranteed for a multi-line
    condition or a Poryscript macro that expands braces invisibly at compile time.
  - `.string` text can itself contain literal `{`/`}` (e.g. `{PLAYER}`, `{COLOR GREEN}`)
    inside the legacy raw blocks; every occurrence found while writing this module was
    balanced within a single line, which keeps the brace-depth tracker's running count
    correct, but an unbalanced one elsewhere in the corpus would desync it silently.
  - The trainerbattle-chain detector's only signal that two calls are a genuine
    back-to-back sequence rather than mutually-exclusive dialogue branches for the same
    encounter is "2+ *distinct* TRAINER_ ids called in the same script body" (e.g.
    VictoryRoadRework/scripts.pory:98-105's Wally rematch chain) -- it cannot tell that
    apart from an `if`/`else` that merely picks one of two different NPCs to fight, and
    it deliberately does NOT flag a script whose several trainerbattle-family calls all
    name the *same* trainer id (e.g. MossdeepCity_Gym's tate-and-liza switch/case, which
    only varies the intro/defeat text per difficulty, not the battle), since requiring
    2+ distinct ids screens that case out for free.

Treat every entry here as a lead sourced to its (map, script), not a verified fact --
spot-check against the source before relying on one for something solver-critical.
"""

import re

from erdata.paths import ER_SOURCE

_MAPS_DIR = ER_SOURCE / "data" / "maps"

# Matches a Poryscript script definition (`script Name{`) or a bare top-level raw-ASM
# label (`Name::` or `Name:`, optionally followed by an `@ ADDR` offset comment) -- both
# start a new "current script" context for whichever field-effect/battle-event/
# trainerbattle calls follow, until the next such label/definition.
_SCRIPT_DEF_RE = re.compile(r"^\s*script\s+(\w+)\s*\{")
_RAW_LABEL_RE = re.compile(r"^(\w+)::?\s*(?:@.*)?$")

# `setvar VAR_BATTLE_FIELD_EFFECT_TYPE, BATTLE_FIELD_EFFECT_ROOM` (raw) or
# `setvar(VAR_BATTLE_FIELD_EFFECT_TYPE, BATTLE_FIELD_EFFECT_ROOM)` (poryscript) --
# TryToSetFieldEffect (battle_util.c:4162) reads these two vars at battle start.
_SETVAR_FIELD_RE = re.compile(
    r"\bsetvar\(?\s*(VAR_BATTLE_FIELD_EFFECT_TYPE|VAR_BATTLE_FIELD_ID)\s*,\s*([A-Za-z0-9_]+)\s*\)?"
)

# Always the parenthesised Poryscript form in the corpus -- no raw-ASM callers found.
_REGISTER_RE = re.compile(r"\bregisterbattleevent\(\s*(BATTLE_EVENT_\w+)\s*(?:,\s*(\d+))?\s*(?:,\s*(\d+))?\s*\)")

# `trainerbattle_single(TRAINER_X, ...)` / `trainerbattle_no_intro TRAINER_X, ...` /
# etc. -- every trainerbattle_* opcode in the corpus takes the trainer id as its first
# argument, so a single regex over the "trainerbattle" prefix covers all of them.
_TRAINERBATTLE_RE = re.compile(r"\btrainerbattle(\w*)\(?\s*(TRAINER_\w+)")

_IF_RE = re.compile(r"\bif\s*\((.*?)\)\s*\{")
_ELSE_IF_RE = re.compile(r"\}\s*else\s+if\s*\((.*?)\)\s*\{")
_ELSE_RE = re.compile(r"\}\s*else\s*\{")
_SWITCH_RE = re.compile(r"\bswitch\s*\((.*?)\)\s*\{")

_RESET_VALUE = "0"


# Strips Poryscript `//` line comments and legacy-assembly `@` line comments before any
# other regex runs over the line -- naive (no string-literal awareness), but every
# opcode line this module actually scans is comment-free in the corpus, and skipping
# this step produces a real false positive: data/maps/Route116/scripts.pory:571 has a
# *commented-out* `// trainerbattle_double TRAINER_TATE_AND_LIZA_1, ...` example line
# (leftover copy-paste from MossdeepCity_Gym) that, left unstripped, gets misread as a
# genuine trainerbattle-chain link. `@` is only stripped on lines with no `"`, since a
# dialogue line's quoted text is the one place `@` legitimately appears mid-line and
# every real `@` line-comment in the corpus (ROM address annotations, `@ NOTE: ...`) is
# quote-free.
def _strip_comment(line: str) -> str:
    if "//" in line:
        line = line[: line.index("//")]
    if "@" in line and '"' not in line:
        line = line[: line.index("@")]
    return line


def _iter_pory_files():
    yield from sorted(_MAPS_DIR.glob("*/scripts.pory"))


# One line -> updated (guard_stack, current_script), plus whatever field-write/
# registerbattleevent/trainerbattle calls that line itself contains, read against the
# guard_stack *after* this line's own braces are applied (so a call guarded by an
# `if (...) {` that opens on this same line still sees that guard).
def _scan_file(map_name: str, text: str) -> dict:
    field_writes: list[tuple[str, str, str]] = []  # (script, var, value)
    battle_events: list[dict] = []
    trainer_calls: list[tuple[str, str]] = []  # (script, trainer_id)

    current_script: str | None = None
    guard_stack: list[str | None] = []

    for raw_line in text.splitlines():
        line = _strip_comment(raw_line)
        stripped = line.strip()

        if not guard_stack:  # depth 0 -- only start a new script context outside any block
            m = _SCRIPT_DEF_RE.match(line)
            if m:
                current_script = m.group(1)
            elif m := _RAW_LABEL_RE.match(stripped):
                current_script = m.group(1)

        raw_opens = line.count("{")
        raw_closes = line.count("}")

        if elif_m := _ELSE_IF_RE.search(line):
            if guard_stack:
                guard_stack.pop()
            guard_stack.append(elif_m.group(1).strip())
            raw_opens -= 1
            raw_closes -= 1
        elif _ELSE_RE.search(line):
            if guard_stack:
                guard_stack.pop()
            guard_stack.append("else")
            raw_opens -= 1
            raw_closes -= 1
        elif if_m := _IF_RE.search(line):
            guard_stack.append(if_m.group(1).strip())
            raw_opens -= 1
        elif switch_m := _SWITCH_RE.search(line):
            guard_stack.append(f"switch({switch_m.group(1).strip()})")
            raw_opens -= 1

        for _ in range(max(raw_opens, 0)):  # plain blocks (script Name{, bare {) -- no guard
            guard_stack.append(None)
        for _ in range(max(raw_closes, 0)):
            if guard_stack:
                guard_stack.pop()

        if current_script is None:
            continue

        guard = guard_stack[-1] if guard_stack else None

        for var, value in _SETVAR_FIELD_RE.findall(line):
            field_writes.append((current_script, var, value))

        for event, data0, data1 in _REGISTER_RE.findall(line):
            battle_events.append(
                {
                    "map": map_name,
                    "script": current_script,
                    "event": event,
                    "data0": int(data0) if data0 else None,
                    "data1": int(data1) if data1 else None,
                    "guard": guard,
                }
            )

        for _suffix, trainer_id in _TRAINERBATTLE_RE.findall(line):
            trainer_calls.append((current_script, trainer_id))

    return {"field_writes": field_writes, "battle_events": battle_events, "trainer_calls": trainer_calls}


# Pairs VAR_BATTLE_FIELD_EFFECT_TYPE/VAR_BATTLE_FIELD_ID writes within one script into
# {effectType, fieldId} field-effect activations, dropping the `, 0` writes every script
# above pairs with (TryToSetFieldEffect treats 0 as no effect; these are the post-battle
# cleanup writes, not new field effects). A script can activate more than one field
# effect in sequence (case-by-case difficulty scaling does not do this in the corpus
# today, but nothing rules it out), so each activation is emitted once, the instant both
# vars are known and not yet reset.
def _pair_field_effects(map_name: str, field_writes: list, trainers_by_script: dict) -> list[dict]:
    by_script: dict[str, list[tuple[str, str]]] = {}
    for script, var, value in field_writes:
        by_script.setdefault(script, []).append((var, value))

    out = []
    for script, writes in by_script.items():
        effect_type = field_id = None
        emitted = False
        for var, value in writes:
            if value == _RESET_VALUE:
                if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                    effect_type = None
                else:
                    field_id = None
                emitted = False
                continue
            if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                effect_type = value
            else:
                field_id = value
            if effect_type and field_id and not emitted:
                out.append(
                    {
                        "map": map_name,
                        "script": script,
                        "effectType": effect_type,
                        "fieldId": field_id,
                        "trainers": sorted(set(trainers_by_script.get(script, []))),
                    }
                )
                emitted = True
    return out


def _find_chains(map_name: str, trainer_calls: list) -> list[dict]:
    by_script: dict[str, list[str]] = {}
    for script, trainer_id in trainer_calls:
        by_script.setdefault(script, []).append(trainer_id)

    return [
        {"map": map_name, "script": script, "trainers": ids}
        for script, ids in by_script.items()
        if len(set(ids)) >= 2
    ]


def scrape_encounters() -> dict:
    """Full scrape across every data/maps/*/scripts.pory. Returns
    {"fieldEffects": [...], "battleEvents": [...], "trainerChains": [...]}, each entry
    tagged with the (map, script) it was found in -- see module docstring for what each
    list means and this module's honest limitations.
    """
    field_effects: list[dict] = []
    battle_events: list[dict] = []
    trainer_chains: list[dict] = []

    for path in _iter_pory_files():
        map_name = path.parent.name
        text = path.read_text(encoding="utf-8")
        scanned = _scan_file(map_name, text)

        trainers_by_script: dict[str, list[str]] = {}
        for script, trainer_id in scanned["trainer_calls"]:
            trainers_by_script.setdefault(script, []).append(trainer_id)

        field_effects.extend(_pair_field_effects(map_name, scanned["field_writes"], trainers_by_script))
        battle_events.extend(scanned["battle_events"])
        trainer_chains.extend(_find_chains(map_name, scanned["trainer_calls"]))

    return {
        "fieldEffects": field_effects,
        "battleEvents": battle_events,
        "trainerChains": trainer_chains,
    }


def encounters_to_dict() -> dict:
    """JSON-ready wrapper around scrape_encounters() -- the result is already plain
    dicts/lists/strs/ints/None, same convention as ability_hooks_to_dict() etc."""
    return scrape_encounters()


if __name__ == "__main__":
    result = scrape_encounters()
    print(f"fieldEffects={len(result['fieldEffects'])}")
    print(f"battleEvents={len(result['battleEvents'])}")
    print(f"trainerChains={len(result['trainerChains'])}")

    mossdeep_room = next(
        fe
        for fe in result["fieldEffects"]
        if fe["map"] == "MossdeepCity_Gym" and fe["script"] == "MossdeepCity_Gym_EventScript_TateAndLiza"
    )
    assert mossdeep_room["effectType"] == "BATTLE_FIELD_EFFECT_ROOM"
    assert mossdeep_room["fieldId"] == "STATUS_FIELD_TRICK_ROOM"

    dewford = [
        e
        for e in result["battleEvents"]
        if e["map"] == "DewfordTown_Gym" and e["script"] == "DewfordTown_Gym_EventScript_CheckTrainers"
    ]
    assert any(e["event"] == "BATTLE_EVENT_SPIKES" and e["guard"] == "!defeated(TRAINER_CRISTIAN)" for e in dewford)

    wally = next(
        c
        for c in result["trainerChains"]
        if c["map"] == "VictoryRoadRework" and c["script"] == "VictoryRoadRework_EventScript_Wally"
    )
    assert wally["trainers"] == ["TRAINER_WALLY_VR_1", "TRAINER_WALLY_VR_2"]
    print("ok")
