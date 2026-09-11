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
  - The line-based brace/guard tracker assumes each `if (cond) {` / `switch (expr) {`
    opens on the line it starts on -- NOT guaranteed, and this is a real, measured gap,
    not a hypothetical one: `_IF_RE` requires the condition and the opening `{` on one
    line, and a multi-line `if` header (a condition split across lines, e.g.
    data/maps/Route116/scripts.pory:506-515's `if(defeated(TRAINER_JOEY) &&` ... `)){`,
    or a single-line condition with the `{` on the next line, e.g.
    data/maps/LavaridgeTown/scripts.pory:657-658) matches neither `_IF_RE` nor any other
    branch-specific regex, so the block's own opening `{` falls through to the untagged
    "plain block" push -- an unguarded (None) frame, not the condition text. Measured
    directly: this happens 45 times in the corpus. See the docstring bullet further down
    on what happens when such a frame's matching `else` is reached -- a separate,
    already-parked gap. Plain `else` itself IS measured exhaustively, unlike the `if`
    case just described: the corpus contains zero `else if` constructs in any spacing
    (checked directly), only `else`, and it mixes
    `} else {` on one line (74 of 281 branches) with an own-line style, `}` closing on
    its own line and `else {` starting the next (207 of 281) -- an earlier version of
    this tracker only recognised the same-line form, which is the *minority* style here,
    and silently recorded every own-line guard as an unguarded (None) block instead of
    the negated condition. See `_join_own_line_else`'s own comment for the fix and the
    three battle events it used to get wrong. `_ELSE_IF_RE` exists and is unit-tested,
    but is dead code against the current corpus -- defensive for whenever an `else if`
    first shows up, not exercised by real data today.
  - `.string` text can itself contain literal `{`/`}` (e.g. `{PLAYER}`, `{COLOR GREEN}`)
    inside the legacy raw blocks; every occurrence found while writing this module was
    balanced within a single line, which keeps the brace-depth tracker's running count
    correct, but an unbalanced one elsewhere in the corpus would desync it silently.
  - The trainerbattle-chain detector (`_find_chains`) and the field-effect pairer
    (`_pair_field_effects`) both need the same fact battle_events' `guard` already
    carries: whether two points in a script can be reached *together*, in one
    playthrough, or are mutually exclusive alternatives. Before this was fixed, neither
    function tracked that at all -- both just grouped by script name, so "2+ distinct
    TRAINER_ ids called in the same script body" (chains) or "every trainerbattle call
    anywhere in the script" (field-effect trainer attribution) covered *mutually
    exclusive* branches exactly as if they were sequential. Confirmed wrong by reading
    the Champion fight's own script: EverGrandeCity_ChampionsRoom_EventScript_Steven's
    Gravity field effect (set at scripts.pory:314,318, only inside two of its switch's
    four cases) was attributed to all four Steven variants regardless, and the same script's
    five mutually exclusive trainerbattle calls (one if/else branch, one 4-way switch)
    read as a single five-battle "chain". Both functions now use `_is_prefix` over each
    call's/write's full guard path (`_scan_file`'s `guard_path`, every open guard from
    outermost to innermost, including switch-case labels -- see the case/default
    handling above `_scan_file`) to test that, not just the script name: a chain is
    anchored on each maximal (leaf) guard path with 2+ distinct trainer ids reachable
    together with it; a field effect's trainer attribution is narrowed to the calls
    compatible with its own activation's guard path, and a script can now emit more
    than one field-effect activation for the same effect/field pair when they complete
    independently in incompatible branches, each keeping only its own guard's trainers.
    This closed three more cases the same way, confirmed by reading each: GraniteCave_
    B2F_EventScript_HitmonStone's `random(3)`-then-`switch` (scripts.pory:21-32) fights
    exactly one of three Blackbelts, not all three, so it now correctly yields no chain
    at all; SootopolisCity_Gym_EventScript_Trigger{Bottom,Middle,Top}Battle each offer a
    genuine `FLAG_SYS_DISABLE_AUTOHEAL`-wrapped three-battle chain (one switch case) plus
    three mutually-exclusive single-battle-plus-`starttagbattle` alternatives (the other
    cases) -- previously all six calls (the real three, plus each alternative's one
    `trainerbattle_no_intro` -- `starttagbattle`'s own two trainer names are invisible
    to `_TRAINERBATTLE_RE`, a separate, already-known gap) were merged into one
    six-entry "chain"; each now correctly yields just the real three-battle chain.
    `_find_chains` still deliberately does NOT flag a script whose several trainerbattle-
    family calls all name the *same* trainer id (e.g. MossdeepCity_Gym's tate-and-liza
    switch/case, which only varies the intro/defeat text per difficulty, not the
    battle), unaffected by this fix, since requiring 2+ distinct ids already screens
    that case out.
    Four honest limitations of the fix itself, the first structural and the rest narrow:
      * `_is_prefix` (one guard path a prefix of the other) is SUFFICIENT for two points
        to co-occur in one playthrough, but not NECESSARY, so it is unsound as a general
        co-occurrence test -- two independent sibling blocks, `if (A) { battle }` then,
        later, a separate `if (B) { battle }` (not an `else`/`else if` of the first), have
        guard paths `("A",)` and `("B",)`, neither a prefix of the other, so this code
        would wrongly treat two genuinely reachable-together battles as mutually
        exclusive and drop a real chain. This is a defect in the rule, not something
        proven absent from the corpus: measured directly, of 331 pairs of recorded call
        sites (field writes and trainerbattle calls) sharing a script, 79 diverge under
        `_is_prefix` (i.e. are judged mutually exclusive), and every one of those 79 was
        checked against source and is a genuine mutually-exclusive-branch pair, not an
        independent-sibling one -- so the *data* emitted today is correct, but by measured
        absence of the failure case in this corpus, not because the rule itself is sound.
        Making it sound needs real branch-tree modelling in `_find_chains` in particular
        (maximal/leaf/ancestor reasoning stops meaning anything once siblings can be
        compatible) and is its own piece of work, deliberately not done here.
      * Guard-path compatibility is plain text equality on the recorded condition
        strings, so two textually-identical but structurally-unrelated conditions in the
        same script (e.g. two separate, unrelated `if (flag(FLAG_SYS_GAME_CLEAR))`
        checks) would be treated as compatible when they are not -- not found in the
        corpus, but not checked for either.
      * Stacked switch-case labels -- two or more `case`/`default` lines in a row
        sharing one body below them, Poryscript's own fallthrough idiom, distinct from a
        single comma-grouped case list (which the corpus never uses either, see
        `_CASE_RE`'s own comment) -- silently lose every label but the last, since
        `_scan_file`'s case handling relabels guard_stack's top in place rather than
        accumulating. `switch(var(VAR_RESULT)){ case 2: case 127: goto(...) }`
        (PetalburgCity_Gym/scripts.pory:1838-1839; also LittlerootTown/scripts.pory:
        1983-1984 among 35 occurrences measured directly across the corpus) means a call
        in that body is reachable via *either* label, but would be recorded as guarded on
        "case 127" alone, silently dropping "case 2" as a way to reach it. Inert today --
        checked directly: none of the 35 stacked-label bodies in the corpus contains a
        recorded field write or trainerbattle call -- left unfixed as a known limitation.
      * `switch`/`case` is the only non-brace-per-branch construct handled -- Poryscript
        has no loop construct and no nested `switch` in this corpus (both checked
        directly), so this isn't a currently-live gap, but a future one would silently
        behave like an unguarded plain block, same as the multi-line-`if`-header gap
        just above.
  - `battle_events`' "guard" is only the *innermost* enclosing block's own condition (or
    its negation, for an `else`) -- it is never conjoined with an outer guard from a
    block nesting further out. A `registerbattleevent` inside `if (A) { if (B) { ... } }`
    is recorded as guarded on "B" alone, dropping "A" entirely; the same drop applies to
    a sibling `else`'s negated condition once it sits inside another guard. `fieldEffects`
    has the exact same shape of drop, not a fixed one: `_pair_field_effects` matches
    trainers against the *full* guard path internally (see its own comment and
    `_is_prefix`), but the "guard" key it emits is `activation_guard[-1]`, the innermost
    element only, same convention as battle_events -- both of EverGrandeCity_
    ChampionsRoom's two Gravity rows report `"switch(var(VAR_ELITE_4_MODE)) case 2"` /
    `"case 3"` and silently drop the outer `flag(FLAG_SYS_GAME_CLEAR)` precondition
    (scripts.pory:304) that is also required to reach either case. `trainerChains` has no
    "guard" field at all to be narrow. Not exercised by anything currently emitted for
    battle_events specifically -- re-measured directly: of the 51 battleEvents entries, 7
    sit behind no guard and 44 behind exactly one, none behind two or more -- but a real
    gap for whatever reads this field, or fieldEffects' own "guard", once one does. Left
    unfixed here deliberately -- scoped as its own piece of work, not folded into the
    else fix this module just got.
  - A multi-line `if` header (see the brace-tracker bullet above -- condition split
    across lines, e.g. Route116/scripts.pory:506-515, or a single-line condition with
    the `{` on its own next line, e.g. LavaridgeTown/scripts.pory:657-658) pushes an
    unguarded (None) frame instead of the real condition. This is well-formed
    Poryscript, not malformed data, and it happens 45 times in the corpus. It is inert
    in the emitted output today only because none of those 45 blocks currently contains
    a `registerbattleevent`/`setvar(VAR_BATTLE_FIELD_*)`/`trainerbattle*` call this
    module records, not because the gap can't reach one -- see `_scan_file`'s `_ELSE_RE`
    branch for what happens when such a frame's matching `else` is reached (the literal
    "else" fallback, since there is no antecedent to negate). Same class of gap as the
    innermost-guard one just above: real, currently inert, deliberately left unfixed
    here as its own piece of work.
  - A recorded guard is the local branch's own condition text, nothing more -- reaching
    it tells you the event registers, but its absence is not itself proof that a battle
    happens some other way. SootopolisCity_Gym_1F_EventScript_Juan's `if` branch (the one
    BATTLE_EVENT_TENSE_BATTLE's `!(flag(FLAG_BADGE08_GET))` guard excludes, scripts.pory:
    269-271) is not a guaranteed rematch: its `goto_if_set(FLAG_SYS_GAME_CLEAR, ...
    JuanRematch)` only jumps there when FLAG_SYS_GAME_CLEAR is *also* set, and otherwise
    falls straight through to a `goto(...AfterBattle)` (line 281) -- no fight at all,
    badge set or not. The scraper transcribes the branch condition faithfully; it does
    not reason about what the sibling branch does.

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

# `case 2:` / `default:` -- a Poryscript switch-case label, own line, no brace of its
# own (the case body runs straight through to the next `case`/`default`/`break`/the
# switch's own closing "}"). Matched against the already comment-stripped, trimmed
# line -- every case label in the corpus is either bare or has a trailing `//` comment
# (e.g. LittlerootTown/scripts.pory:2011's `case 0:// Nurse Joy`), never a comma-
# grouped fallthrough list (`case 0, 1:`) or code on the same line as the colon (checked
# directly). The corpus DOES achieve fallthrough, just by a different syntax this regex
# alone doesn't protect against: stacking two or more separate `case`/`default` label
# lines in a row above one shared body -- see the module docstring's limitation on that.
_CASE_RE = re.compile(r"^case\s+(.+?):\s*$")
_DEFAULT_RE = re.compile(r"^default\s*:\s*$")

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


# The corpus's dominant style (measured directly against the full corpus: 207 of the
# 281 total `else` branches -- the corpus has zero `else if` in any spacing, checked
# directly) closes an if-block's brace on its own line and puts `else {` on the *next*
# line, rather than `} else {` on one line (74 of 281) -- e.g.
# data/maps/EvergrandeCity_MonoChampRoom_1/scripts.pory:390-391. _ELSE_RE above (and
# _ELSE_IF_RE, unexercised by this corpus -- see the module docstring) only ever look at
# a single line, so without this pass the dominant style falls through to the untagged
# "plain block" branch in _scan_file and a real else-guard is recorded as an unguarded
# (None) block instead of the negated condition. That silently mis-scoped three of the
# battle events this module used to emit -- two in EvergrandeCity_MonoChampRoom_1 (the
# Bug and Ice rooms' registerbattleevent calls, scripts.pory:391-396, inside the player-
# accepted `else` branch, not unconditional) and one in SootopolisCity_Gym_1F
# (BATTLE_EVENT_TENSE_BATTLE, scripts.pory:269-280, only registered on Juan's first
# fight, inside the `else` of a FLAG_BADGE08_GET check, not on the post-badge rematch --
# found by diffing this module's own output with and without this fix over the whole
# corpus, not by re-checking only the two cases above).
#
# Joins exactly that two-line "}\n(whitespace)else...{" shape onto one synthetic line
# before the main per-line scan runs, so _scan_file never needs to know which style
# produced it -- same synthetic-line trick either way. Checked directly against the
# whole corpus: every own-line else there carries its own opening "{" on the same line
# as the "else" keyword (0 exceptions), so this two-line join is exhaustive for the
# corpus as it stands today; a hypothetical three-line "}\nelse\n{" style would not be
# caught by this, same class of gap as the rest of this module's honest heuristics (see
# the docstring above).
def _join_own_line_else(text: str) -> str:
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if i + 1 < len(lines) and _strip_comment(line).strip() == "}":
            next_stripped = _strip_comment(lines[i + 1]).strip()
            if next_stripped.startswith("else"):
                # Keep line i's own comment-stripped text (just "}", modulo leading
                # whitespace) rather than the raw line -- appending the next line's raw
                # text after an un-stripped trailing "//" on line i would hide that next
                # line from _strip_comment when the main scan re-strips this merged line.
                out.append(_strip_comment(line) + " " + lines[i + 1])
                i += 2
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _iter_pory_files():
    yield from sorted(_MAPS_DIR.glob("*/scripts.pory"))


# One line -> updated (guard_stack, current_script), plus whatever field-write/
# registerbattleevent/trainerbattle calls that line itself contains, read against the
# guard_stack *after* this line's own braces are applied (so a call guarded by an
# `if (...) {` that opens on this same line still sees that guard).
#
# `switch_base_at_depth` tracks, per open `switch(...)` frame (keyed by its position in
# guard_stack), the switch's own condition text -- keyed by depth rather than a single
# variable defensively, in case a `switch` is ever nested inside another one's still-open
# frame, though none is in the current corpus (checked directly: at most one switch
# frame is ever open at a time). Needed because `case N:`/`default:` labels carry no
# brace of their own (the case body runs straight through to the next label or the
# switch's closing "}"), so a case label
# doesn't push a new frame, it *relabels* guard_stack's current top in place (from
# "switch(EXPR)" to "switch(EXPR) case N", one case superseding the last). Without
# this, every case in a switch would share one identical guard, indistinguishable from
# each other -- exactly the gap that let EverGrandeCity_ChampionsRoom's Gravity field
# effect get attributed to every switch case, not just the two that set it (see
# _pair_field_effects's own comment).
def _scan_file(map_name: str, text: str) -> dict:
    field_writes: list[tuple[str, str, str, tuple]] = []  # (script, var, value, guard_path)
    battle_events: list[dict] = []
    trainer_calls: list[tuple[str, str, tuple]] = []  # (script, trainer_id, guard_path)

    current_script: str | None = None
    guard_stack: list[str | None] = []
    switch_base_at_depth: dict[int, str] = {}

    for raw_line in _join_own_line_else(text).splitlines():
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

        if case_m := _CASE_RE.match(stripped):
            depth = len(guard_stack) - 1
            if depth in switch_base_at_depth:
                guard_stack[depth] = f"switch({switch_base_at_depth[depth]}) case {case_m.group(1).strip()}"
        elif _DEFAULT_RE.match(stripped):
            depth = len(guard_stack) - 1
            if depth in switch_base_at_depth:
                guard_stack[depth] = f"switch({switch_base_at_depth[depth]}) default"
        elif elif_m := _ELSE_IF_RE.search(line):
            if guard_stack:
                guard_stack.pop()
            guard_stack.append(elif_m.group(1).strip())
            raw_opens -= 1
            raw_closes -= 1
        elif _ELSE_RE.search(line):
            # Record the negated sibling condition (e.g. "!(flag(FLAG_BADGE08_GET))"),
            # not the literal string "else" -- "else" told a reader THAT a block is
            # conditional but nothing evaluable, which matters here specifically because
            # the plan makes "which gym trainers are cleared" a solver decision variable:
            # a fixed-flag guard (Sootopolis's FLAG_BADGE08_GET) and an always-true-when-
            # reached one (the Monotype Champion rooms' "did you say yes" dialogue check)
            # need to be told apart, and a solver can't do that from an opaque "else".
            # popped can genuinely be None here (falling back to the literal "else"),
            # and this is not a rare or malformed-input case: measured directly, this
            # fires 45 times in the corpus. The cause is the multi-line-`if`-header gap
            # noted in the module docstring -- `_IF_RE` requires the condition and the
            # opening "{" on one line, so a header split across lines (e.g.
            # Route116/scripts.pory:506-515) or a single-line condition whose "{" sits on
            # its own next line (e.g. LavaridgeTown/scripts.pory:657-658) pushes an
            # unguarded (None) frame instead of the real condition, and this branch's
            # matching `else` pops that None with nothing to negate. With no antecedent
            # recovered, the literal "else" is the correct conservative answer -- this
            # fallback is invisible in the emitted output today only because none of
            # those 45 blocks currently contains a call this module records, not because
            # the gap itself is unreachable.
            popped = guard_stack.pop() if guard_stack else None
            guard_stack.append(f"!({popped})" if popped is not None else "else")
            raw_opens -= 1
            raw_closes -= 1
        elif if_m := _IF_RE.search(line):
            guard_stack.append(if_m.group(1).strip())
            raw_opens -= 1
        elif switch_m := _SWITCH_RE.search(line):
            switch_base_at_depth[len(guard_stack)] = switch_m.group(1).strip()
            guard_stack.append(f"switch({switch_m.group(1).strip()})")
            raw_opens -= 1

        for _ in range(max(raw_opens, 0)):  # plain blocks (script Name{, bare {) -- no guard
            guard_stack.append(None)
        for _ in range(max(raw_closes, 0)):
            if guard_stack:
                guard_stack.pop()
        if raw_closes > 0:  # drop switch_base entries for any frame(s) just popped
            for depth in [d for d in switch_base_at_depth if d >= len(guard_stack)]:
                del switch_base_at_depth[depth]

        if current_script is None:
            continue

        guard = guard_stack[-1] if guard_stack else None
        # Every *named* (non-None) guard currently open, outermost first -- unlike
        # `guard` above (battle_events' innermost-only field, see the module
        # docstring's bullet on that gap), this is the full ancestor chain, used to
        # tell whether two calls could both be reached in one playthrough (see
        # _pair_field_effects/_find_chains's shared _is_prefix helper).
        guard_path = tuple(g for g in guard_stack if g is not None)

        for var, value in _SETVAR_FIELD_RE.findall(line):
            field_writes.append((current_script, var, value, guard_path))

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
            trainer_calls.append((current_script, trainer_id, guard_path))

    return {"field_writes": field_writes, "battle_events": battle_events, "trainer_calls": trainer_calls}


# True iff one guard path is a prefix of the other -- i.e. the shorter path's guards
# all held on the way to the longer one, so the two points could both be reached along
# a single execution of the script. Two paths that diverge (neither a prefix of the
# other, e.g. two different switch cases, or an if's branch vs its else's) never are:
# that is exactly the "mutually exclusive branches" relationship EverGrandeCity_
# ChampionsRoom_EventScript_Steven's four switch cases and its if/else are in. Shared
# by _pair_field_effects and _find_chains -- both need the same "could this trainer
# call and this other point in the script both happen in one playthrough?" test.
def _is_prefix(short: tuple, long_: tuple) -> bool:
    return long_[: len(short)] == short


# Pairs VAR_BATTLE_FIELD_EFFECT_TYPE/VAR_BATTLE_FIELD_ID writes within one script into
# {effectType, fieldId} field-effect activations, dropping the `, 0` writes every script
# above pairs with (TryToSetFieldEffect treats 0 as no effect; these are the post-battle
# cleanup writes, not new field effects). A script can activate the same field effect
# independently more than once -- EverGrandeCity_ChampionsRoom_EventScript_Steven's
# switch sets STATUS_FIELD_GRAVITY in two DIFFERENT, mutually exclusive cases
# (scripts.pory:314,318) -- so an activation is emitted whenever both vars are known
# and the write that completed them isn't just a continuation of the previous
# activation's own guard scope (`_is_prefix` again): a second completion under an
# INCOMPATIBLE guard is a second, independent activation, not a duplicate.
#
# "trainers" used to be every trainerbattle-family call anywhere in the script,
# regardless of which branch it was in or whether the branch that set the field effect
# was even the one that reached it -- the asymmetry battleEvents' `guard` field didn't
# have and fieldEffects did, which is exactly how Gravity ended up attributed to
# TRAINER_STEVEN and TRAINER_STEVEN_LEGENDS (case 0/1, and the pre-Game-Clear else --
# none of which ever executes the case 2/3 lines that set it). Now only trainer calls
# whose own guard path is compatible with (a prefix of, or extended from) the
# activation's guard path are attached. Most of the current 23 fieldEffects entries have
# only one trainerbattle call in their whole script to begin with (e.g. each of
# EvergrandeCity_MonoChampRoom_1's 18 rooms, each its own script with one battle) --
# guard-narrowing can't change those regardless of whether their own guard is
# conditional, since there is only ever one candidate to attach either way. Exactly two
# scripts in the current data have 2+ trainerbattle calls behind different guards:
# EverGrandeCity_ChampionsRoom_EventScript_Steven, where narrowing is what fixes the
# result, and MossdeepCity_Gym_EventScript_TateAndLiza (scripts.pory:998-1017, three
# calls across three switch cases), where narrowing changes nothing -- not because it
# only has one call, but because its field-effect activation completes unconditionally
# at scripts.pory:993-994, *before* the switch even opens (guard path `()`, compatible
# with every branch), and separately because all three of its calls name the same
# TRAINER_TATE_AND_LIZA_1 regardless of which case is taken.
def _pair_field_effects(map_name: str, field_writes: list, trainer_calls: list) -> list[dict]:
    by_script: dict[str, list[tuple[str, str, tuple]]] = {}
    for script, var, value, guard_path in field_writes:
        by_script.setdefault(script, []).append((var, value, guard_path))

    calls_by_script: dict[str, list[tuple[str, tuple]]] = {}
    for script, trainer_id, guard_path in trainer_calls:
        calls_by_script.setdefault(script, []).append((trainer_id, guard_path))

    out = []
    for script, writes in by_script.items():
        effect_type = field_id = None
        last_activation_guard: tuple | None = None  # None: no open activation
        for var, value, guard_path in writes:
            if value == _RESET_VALUE:
                if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                    effect_type = None
                else:
                    field_id = None
                last_activation_guard = None
                continue
            if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                effect_type = value
            else:
                field_id = value
            if not (effect_type and field_id):
                continue
            if last_activation_guard is not None and _is_prefix(
                *sorted((guard_path, last_activation_guard), key=len)
            ):
                continue  # still the same activation as before, not a new one
            # Whichever of this write's own guard path or the *other* var's own guard
            # path (set earlier, possibly shallower -- e.g. VAR_BATTLE_FIELD_EFFECT_TYPE
            # set unconditionally before the VAR_BATTLE_FIELD_ID write that completes
            # the pair inside a specific switch case) is deeper is this activation's
            # true scope; reaching the deeper one already implies the shallower one held.
            activation_guard = max(guard_path, last_activation_guard or (), key=len)
            last_activation_guard = activation_guard
            out.append(
                {
                    "map": map_name,
                    "script": script,
                    "effectType": effect_type,
                    "fieldId": field_id,
                    "guard": activation_guard[-1] if activation_guard else None,
                    "trainers": sorted(
                        {
                            tid
                            for tid, call_guard in calls_by_script.get(script, [])
                            if _is_prefix(*sorted((call_guard, activation_guard), key=len))
                        }
                    ),
                }
            )
    return out


# A "chain" is 2+ *distinct* trainer ids reachable together along one execution of the
# script (see _is_prefix) -- not just 2+ distinct ids anywhere in its text, which is
# what let EverGrandeCity_ChampionsRoom_EventScript_Steven's four mutually exclusive
# switch cases plus its if/else (five trainerbattle calls, four distinct trainers) read
# as a single five-battle chain. Anchored on each *maximal* guard path present (one not
# itself a prefix of some other path in the script, i.e. a "leaf" of the script's
# branch tree) -- collecting every call whose guard path is an ancestor of that leaf
# gives exactly the trainers fought along one playthrough that reaches it, and anchoring
# only on leaves (not every path) avoids emitting the same chain again as a shorter,
# redundant prefix of itself.
def _find_chains(map_name: str, trainer_calls: list) -> list[dict]:
    by_script: dict[str, list[tuple[str, tuple]]] = {}
    for script, trainer_id, guard_path in trainer_calls:
        by_script.setdefault(script, []).append((trainer_id, guard_path))

    out = []
    for script, entries in by_script.items():
        distinct_paths = {guard_path for _, guard_path in entries}
        leaves = sorted(
            p for p in distinct_paths if not any(q != p and _is_prefix(p, q) for q in distinct_paths)
        )
        for leaf in leaves:
            ids = [trainer_id for trainer_id, guard_path in entries if _is_prefix(guard_path, leaf)]
            if len(set(ids)) >= 2:
                out.append({"map": map_name, "script": script, "trainers": ids})
    return out


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

        field_effects.extend(_pair_field_effects(map_name, scanned["field_writes"], scanned["trainer_calls"]))
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
