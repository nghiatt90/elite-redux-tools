"""Scrape eliteredux-source's data/maps/**/scripts.pory for the per-battle environment
data that Elite Redux's own map scripts encode outside of er-config: field effects
(weather/terrain/room/monotype-champion) applied before specific trainer battles, the
gym "battle event" buffs/debuffs each gym registers per undefeated gym trainer, and
trainer battle chains -- 2+ distinct trainers reachable together in one playthrough of a
script. That used to mean "back-to-back, no heal in between" unconditionally; it no
longer does -- see the "trainerChains asserts co-occurrence, not adjacency" limitation
below for what changed and why every row emitted today still happens to satisfy the
stronger reading anyway.

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
    read as a single five-battle "chain".
    Both functions test this via *frame identity*, not text: `_scan_file` gives every
    `if`/`switch` a fresh, unique group id when it opens, and every `else`/`else if`
    inherits its sibling's group (a new branch number within it) rather than starting a
    group of its own; a `case`/`default` label relabels the switch's own frame in place
    (same group, a fresh branch per label) since it opens no brace of its own. Two points
    are `_frames_compatible` -- could both be reached in one playthrough -- unless their
    recorded frame paths (`_scan_file`'s `frame_path`, outermost first) diverge at frames
    that share a group but differ in branch, i.e. are two arms of the *same* if/else-if/
    else chain or switch; diverging at frames from *different* groups (two independently-
    guarded constructs, neither one the other's sibling) is compatible, not exclusive.
    `_pair_field_effects` narrows a field effect's trainer attribution to the calls
    `_frames_compatible` with its own activation's frame path, and a script can emit more
    than one activation for the same effect/field pair when they complete independently
    in incompatible branches, each keeping only its own frame path's trainers.
    `_find_chains` anchors a chain on each *maximal compatible group* of call sites (every
    member pairwise `_frames_compatible` with every other, extendable by none) with 2+
    distinct trainer ids in it, found by Bron-Kerbosch clique search over the
    compatibility graph (see `_maximal_compatible_groups`) -- the "maximal path is a
    prefix of nothing else" shortcut this replaced stopped working the moment
    independent siblings became compatible, since two such siblings are each their own
    maximal path yet still exclude each other from one chain.
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
    An earlier version of this fix used plain text-path prefixing (one guard path a
    prefix of the other) instead of frame identity, which is SUFFICIENT for co-occurrence
    but not NECESSARY, so it silently misjudged two independent sibling blocks --
    `if (A) { battle }` then, later, a separate `if (B) { battle }`, not an `else`/`else
    if` of the first -- as mutually exclusive. That version's emitted data was still
    correct: measured directly, of 331 pairs of recorded call sites sharing a script, 79
    diverged under the text rule, and every one of those 79 was checked against source
    and was a genuine mutually-exclusive-branch pair, not an independent-sibling one, so
    the corpus happened not to exercise the gap. Frame identity closes it structurally
    rather than by that measured absence.
    Three narrower honest limitations remain, all pre-existing and unrelated to the
    frame-identity fix:
      * Stacked switch-case labels -- two or more `case`/`default` lines in a row
        sharing one body below them, Poryscript's own fallthrough idiom, distinct from a
        single comma-grouped case list (which the corpus never uses either, see
        `_CASE_RE`'s own comment) -- silently lose every label but the last, since
        `_scan_file`'s case handling relabels guard_stack's top in place rather than
        accumulating. `switch(var(VAR_RESULT)){ case 2: case 127: goto(...) }`
        (PetalburgCity_Gym/scripts.pory:1838-1839; also LittlerootTown/scripts.pory:
        1983-1984 among 35 occurrences measured directly across the corpus) means a call
        in that body is reachable via *either* label, but would be recorded as guarded on
        "case 127" alone, silently dropping "case 2" as a way to reach it -- both a lost
        branch label and a lost branch number, so both a wrong `guard` string and a
        wrongly-exclusive frame if a call were ever there. Inert today -- checked
        directly: none of the 35 stacked-label bodies in the corpus contains a recorded
        field write or trainerbattle call -- left unfixed as a known limitation.
      * `switch`/`case` is the only non-brace-per-branch construct handled -- Poryscript
        has no loop construct and no nested `switch` in this corpus (both checked
        directly), so this isn't a currently-live gap, but a future one would silently
        behave like an unguarded plain block, same as the multi-line-`if`-header gap
        just above.
      * Frame identity is deliberately blind to condition *text* -- it decides
        compatibility purely from group/branch structure and never reads what a
        condition actually says. That is the fix (it is what makes two unrelated `if`s
        with the same wording correctly independent instead of an accidental prefix
        match), but it has a mirror-image cost: two independent, differently-grouped
        blocks whose conditions are *logically contradictory* (e.g. `if (flag(X))
        { ... }` and, later, a separate `if (!flag(X)) { ... }`, not an `else` of the
        first) are called compatible, when they cannot in fact both hold. The
        text-equality rule this replaced would have caught that specific case (by
        accident, not by design -- it also missed the independent-siblings case this
        batch fixes) at the cost of the false exclusions described above. Not found in
        the corpus, but not checked for either -- text-blindness is the accepted price
        of the structural fix, not an oversight.
  - `trainerChains` asserts only that its members are reachable together in one
    playthrough -- not that they are adjacent, and not that nothing heals the player
    between them. Under the old text-path-prefix rule this was true anyway, by
    accident: every member necessarily lay on one nesting lineage, so "reachable
    together" and "back-to-back" coincided. Frame identity widens who counts as
    reachable together to include independent siblings, which can sit arbitrarily far
    apart in a script with anything -- including a `special(HealPlayerParty)` call --
    in between; nothing here checks for one. Measured directly against the current
    data: 0 of the 8 emitted chains contain an independent-sibling pair (every member
    of every current chain lies on a single lineage, i.e. still satisfies the old,
    stronger reading), so nothing emitted today is actually wrong under either
    definition -- but the row's *meaning* has genuinely widened, and a future corpus
    change could emit a technically-correct "chain" whose members are nowhere near
    each other. This connects to, but does not close, the separately-parked finding
    that this detector ignores `setflag(FLAG_SYS_DISABLE_AUTOHEAL)` -- that flag marks
    precisely "back-to-back, no heal in between" in the source, and reading it is what
    would let the stronger, original definition be restored honestly (by checking for
    it) rather than by the coincidence this fix just removed. Not done here.
  - `battle_events`' "guard" is only the *innermost* enclosing block's own condition (or
    its negation, for an `else`) -- it is never conjoined with an outer guard from a
    block nesting further out. A `registerbattleevent` inside `if (A) { if (B) { ... } }`
    is recorded as guarded on "B" alone, dropping "A" entirely; the same drop applies to
    a sibling `else`'s negated condition once it sits inside another guard. `fieldEffects`
    has the exact same shape of drop, not a fixed one: `_pair_field_effects` matches
    trainers against the *full* frame path internally (see its own comment and
    `_frames_compatible`), but the "guard" key it emits is the innermost frame's text
    only, same convention as battle_events -- both of EverGrandeCity_
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
from collections import namedtuple

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


# One open guard, on `_scan_file`'s guard_stack. `text` is what gets emitted (as
# battle_events' innermost-only "guard", or the last element of a frame path elsewhere).
# `group` and `branch` are synthetic, never derived from condition text, and are what
# `_frames_compatible` actually compares: `group` is shared by every arm of one
# if/else-if/else chain or one switch (a fresh id every time a *new* `if`/`switch`
# opens; `else`/`else if`/`case`/`default` all inherit the construct they belong to),
# and `branch` is which arm this frame is -- so two frames sharing a group but
# differing in branch are, structurally, mutually exclusive; two frames from different
# groups say nothing about each other either way.
_Frame = namedtuple("_Frame", ("text", "group", "branch"))


# Per open `switch(...)` frame (keyed by guard_stack position -- see _scan_file's own
# comment on why depth-keyed, defensively, rather than a single variable), the group id
# handed to every case/default label under it and a running count of how many labels
# have been seen, each becoming that label's own branch number. `base` is the switch's
# own condition text, reused to rebuild "switch(EXPR) case N" on every relabel.
class _SwitchInfo:
    __slots__ = ("group", "base", "next_branch")

    def __init__(self, group: int, base: str):
        self.group = group
        self.base = base
        self.next_branch = 0


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
# `switch_info_at_depth` tracks, per open `switch(...)` frame (keyed by its position in
# guard_stack -- depth-keyed rather than a single variable defensively, in case a
# `switch` is ever nested inside another one's still-open frame, though none is in the
# current corpus, checked directly: at most one switch frame is ever open at a time),
# the `_SwitchInfo` that hands out that switch's group id and the next branch number.
# Needed because `case N:`/`default:` labels carry no brace of their own (the case body
# runs straight through to the next label or the switch's closing "}"), so a case label
# doesn't push a new frame, it *relabels* guard_stack's current top in place.
def _scan_file(map_name: str, text: str) -> dict:
    field_writes: list[tuple[str, str, str, tuple]] = []  # (script, var, value, frame_path)
    battle_events: list[dict] = []
    trainer_calls: list[tuple[str, str, tuple]] = []  # (script, trainer_id, frame_path)

    current_script: str | None = None
    guard_stack: list[_Frame | None] = []
    switch_info_at_depth: dict[int, _SwitchInfo] = {}
    next_group = 0

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
            if depth in switch_info_at_depth:
                info = switch_info_at_depth[depth]
                branch, info.next_branch = info.next_branch, info.next_branch + 1
                guard_stack[depth] = _Frame(
                    f"switch({info.base}) case {case_m.group(1).strip()}", info.group, branch
                )
        elif _DEFAULT_RE.match(stripped):
            depth = len(guard_stack) - 1
            if depth in switch_info_at_depth:
                info = switch_info_at_depth[depth]
                branch, info.next_branch = info.next_branch, info.next_branch + 1
                guard_stack[depth] = _Frame(f"switch({info.base}) default", info.group, branch)
        elif elif_m := _ELSE_IF_RE.search(line):
            popped = guard_stack.pop() if guard_stack else None
            if popped is not None:
                group, branch = popped.group, popped.branch + 1
            else:  # see the _ELSE_RE branch below for why popped can be None
                next_group += 1
                group, branch = next_group, 0
            guard_stack.append(_Frame(elif_m.group(1).strip(), group, branch))
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
            # `else`/`else if` inherit the popped frame's group (same construct, a new
            # branch within it) -- popped can genuinely be None here (falling back to a
            # fresh, ungrouped frame), and this is not a rare or malformed-input case:
            # measured directly, this fires 45 times in the corpus. The cause is the
            # multi-line-`if`-header gap noted in the module docstring -- `_IF_RE`
            # requires the condition and the opening "{" on one line, so a header split
            # across lines (e.g. Route116/scripts.pory:506-515) or a single-line
            # condition whose "{" sits on its own next line (e.g.
            # LavaridgeTown/scripts.pory:657-658) pushes an unguarded (None) frame
            # instead of the real condition, and this branch's matching `else` pops that
            # None with nothing to inherit. With no antecedent recovered, the literal
            # "else" in a fresh group of its own -- compatible with everything, never
            # mutually exclusive with anything -- is the correct conservative answer;
            # this fallback is invisible in the emitted output today only because none
            # of those 45 blocks currently contains a call this module records, not
            # because the gap itself is unreachable.
            popped = guard_stack.pop() if guard_stack else None
            if popped is not None:
                text_, group, branch = f"!({popped.text})", popped.group, popped.branch + 1
            else:
                next_group += 1
                text_, group, branch = "else", next_group, 0
            guard_stack.append(_Frame(text_, group, branch))
            raw_opens -= 1
            raw_closes -= 1
        elif if_m := _IF_RE.search(line):
            next_group += 1
            guard_stack.append(_Frame(if_m.group(1).strip(), next_group, 0))
            raw_opens -= 1
        elif switch_m := _SWITCH_RE.search(line):
            next_group += 1
            base = switch_m.group(1).strip()
            switch_info_at_depth[len(guard_stack)] = _SwitchInfo(next_group, base)
            guard_stack.append(_Frame(f"switch({base})", next_group, -1))  # branch: no case seen yet
            raw_opens -= 1

        for _ in range(max(raw_opens, 0)):  # plain blocks (script Name{, bare {) -- no guard
            guard_stack.append(None)
        for _ in range(max(raw_closes, 0)):
            if guard_stack:
                guard_stack.pop()
        if raw_closes > 0:  # drop switch_info entries for any frame(s) just popped
            for depth in [d for d in switch_info_at_depth if d >= len(guard_stack)]:
                del switch_info_at_depth[depth]

        if current_script is None:
            continue

        top = guard_stack[-1] if guard_stack else None
        guard = top.text if top is not None else None
        # Every *named* (non-None) frame currently open, outermost first -- unlike
        # `guard` above (battle_events' innermost-only field, see the module
        # docstring's bullet on that gap), this is the full ancestor chain, used to
        # tell whether two calls could both be reached in one playthrough (see
        # _pair_field_effects/_find_chains's shared _frames_compatible helper).
        frame_path = tuple(f for f in guard_stack if f is not None)

        for var, value in _SETVAR_FIELD_RE.findall(line):
            field_writes.append((current_script, var, value, frame_path))

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
            trainer_calls.append((current_script, trainer_id, frame_path))

    return {"field_writes": field_writes, "battle_events": battle_events, "trainer_calls": trainer_calls}


# True iff two frame paths (see _Frame) could both be reached along a single execution
# of the script. Walking outermost-first, a shared frame (same group, same branch) is
# no information either way, so keep comparing deeper; two frames from the SAME group
# but a DIFFERENT branch are two arms of one if/else-if/else chain or one switch, so
# mutually exclusive -- that is exactly the relationship EverGrandeCity_
# ChampionsRoom_EventScript_Steven's four switch cases and its if/else are in. Two
# frames from DIFFERENT groups mean the two paths have reached separate, independently-
# guarded constructs -- neither is the other's sibling, so nothing rules out both
# holding at once, and this is compatible rather than exclusive (the fix that
# distinguishes this from the plain-text-prefix rule this replaced -- see the module
# docstring). Running out of frames on one side with no divergence (one path a strict
# ancestor of the other) is always compatible. Shared by _pair_field_effects and
# _find_chains -- both need the same "could this trainer call and this other point in
# the script both happen in one playthrough?" test.
def _frames_compatible(a: tuple, b: tuple) -> bool:
    for frame_a, frame_b in zip(a, b):
        if frame_a.group != frame_b.group:
            return True
        if frame_a.branch != frame_b.branch:
            return False
    return True


# Pairs VAR_BATTLE_FIELD_EFFECT_TYPE/VAR_BATTLE_FIELD_ID writes within one script into
# {effectType, fieldId} field-effect activations, dropping the `, 0` writes every script
# above pairs with (TryToSetFieldEffect treats 0 as no effect; these are the post-battle
# cleanup writes, not new field effects). A script can activate the same field effect
# independently more than once -- EverGrandeCity_ChampionsRoom_EventScript_Steven's
# switch sets STATUS_FIELD_GRAVITY in two DIFFERENT, mutually exclusive cases
# (scripts.pory:314,318) -- so an activation is emitted whenever both vars are known and
# the write that completed them isn't just a continuation of the previous activation
# (`_frames_compatible` again): a second completion under an INCOMPATIBLE frame path is
# a second, independent activation, not a duplicate. The completing write's OWN frame
# path is used as that activation's scope, which only stands when the OTHER var's own
# (earlier, textually-prior) write sits on an ANCESTOR path of the completing one --
# reaching the completing write then does genuinely imply the other one's condition
# already held, so there's nothing to combine. If the other write instead sat in an
# independent sibling block, the completing write's own path would silently drop a real
# precondition. Not exercised by anything currently emitted -- checked directly: for
# all 23 activations this function currently produces, the other var's write is on an
# ancestor path of (or equal to) the completing one, so this simplification holds for
# the current data; an earlier version of this function instead tried to pick
# "whichever of the two paths is deeper", which stopped being meaningful once path
# length no longer implied nesting order (see the module docstring's note on frame
# identity) and was no more correct against the sibling case than this one is.
#
# "trainers" used to be every trainerbattle-family call anywhere in the script,
# regardless of which branch it was in or whether the branch that set the field effect
# was even the one that reached it -- the asymmetry battleEvents' `guard` field didn't
# have and fieldEffects did, which is exactly how Gravity ended up attributed to
# TRAINER_STEVEN and TRAINER_STEVEN_LEGENDS (case 0/1, and the pre-Game-Clear else --
# none of which ever executes the case 2/3 lines that set it). Now only trainer calls
# `_frames_compatible` with the activation's own frame path are attached. Most of the
# current 23 fieldEffects entries have only one trainerbattle call in their whole script
# to begin with (e.g. each of EvergrandeCity_MonoChampRoom_1's 18 rooms, each its own
# script with one battle) -- narrowing can't change those regardless of whether their
# own guard is conditional, since there is only ever one candidate to attach either way.
# Exactly two scripts in the current data have 2+ trainerbattle calls behind different
# guards: EverGrandeCity_ChampionsRoom_EventScript_Steven, where narrowing is what fixes
# the result, and MossdeepCity_Gym_EventScript_TateAndLiza (scripts.pory:998-1017, three
# calls across three switch cases), where narrowing changes nothing -- not because it
# only has one call, but because its field-effect activation completes unconditionally
# at scripts.pory:993-994, *before* the switch even opens (an empty frame path,
# compatible with every branch), and separately because all three of its calls name the
# same TRAINER_TATE_AND_LIZA_1 regardless of which case is taken.
def _pair_field_effects(map_name: str, field_writes: list, trainer_calls: list) -> list[dict]:
    by_script: dict[str, list[tuple[str, str, tuple]]] = {}
    for script, var, value, frame_path in field_writes:
        by_script.setdefault(script, []).append((var, value, frame_path))

    calls_by_script: dict[str, list[tuple[str, tuple]]] = {}
    for script, trainer_id, frame_path in trainer_calls:
        calls_by_script.setdefault(script, []).append((trainer_id, frame_path))

    out = []
    for script, writes in by_script.items():
        effect_type = field_id = None
        last_activation_frames: tuple | None = None  # None: no open activation
        for var, value, frame_path in writes:
            if value == _RESET_VALUE:
                if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                    effect_type = None
                else:
                    field_id = None
                last_activation_frames = None
                continue
            if var == "VAR_BATTLE_FIELD_EFFECT_TYPE":
                effect_type = value
            else:
                field_id = value
            if not (effect_type and field_id):
                continue
            if last_activation_frames is not None and _frames_compatible(frame_path, last_activation_frames):
                continue  # still the same activation as before, not a new one
            last_activation_frames = frame_path
            out.append(
                {
                    "map": map_name,
                    "script": script,
                    "effectType": effect_type,
                    "fieldId": field_id,
                    "guard": frame_path[-1].text if frame_path else None,
                    "trainers": sorted(
                        {
                            tid
                            for tid, call_frames in calls_by_script.get(script, [])
                            if _frames_compatible(call_frames, frame_path)
                        }
                    ),
                }
            )
    return out


# Every maximal set of indices into `entries` (0..n-1) that is pairwise
# `compat[i][j]`-compatible -- i.e. every maximal clique of the compatibility graph.
# Plain Bron-Kerbosch, no pivoting: n (recorded call sites sharing one script) is small
# everywhere in this corpus (checked: at most a handful per script), so the textbook
# worst-case blowup of the unpivoted algorithm is a non-issue here. `_find_chains` needs
# genuine maximal cliques, not the "maximal guard path, collect its ancestors" shortcut
# an earlier version used: that shortcut relied on compatibility being closed under
# "shares a common ancestor", which held when compatible-or-not was decided by plain
# text-path prefixing, but stops holding once independent siblings are compatible --
# two such siblings are each individually "maximal" (neither's path is a prefix of the
# other's), yet still exclude each other, so anchoring on each separately would either
# emit the same real chain as two different subsets or silently drop the fact that they
# exclude each other, depending on how the ancestors were collected. `sorted(p)` below
# makes traversal order (and so the output order across multiple chains in one script,
# not currently exercised by any script in this corpus) deterministic between runs.
def _maximal_compatible_groups(n: int, compat: list) -> list:
    cliques: list = []

    def expand(r: set, p: set, x: set) -> None:
        if not p and not x:
            cliques.append(r)
            return
        for v in sorted(p):
            neighbors = {u for u in range(n) if u != v and compat[v][u]}
            expand(r | {v}, p & neighbors, x & neighbors)
            p = p - {v}
            x = x | {v}

    expand(set(), set(range(n)), set())
    return cliques


# A "chain" is 2+ *distinct* trainer ids reachable together along one execution of the
# script (see _frames_compatible) -- not just 2+ distinct ids anywhere in its text,
# which is what let EverGrandeCity_ChampionsRoom_EventScript_Steven's four mutually
# exclusive switch cases plus its if/else (five trainerbattle calls, four distinct
# trainers) read as a single five-battle chain. Anchored on each maximal compatible
# group of call sites (`_maximal_compatible_groups`, every member pairwise compatible
# with every other, extendable by none) with 2+ distinct trainer ids in it.
#
# `seen_id_sequences` is live logic, not defensive padding for a case that can't
# happen: two mutually exclusive branches that each independently name the same
# trainer ids in the same order -- e.g. an `if`/`else` where both arms fight the same
# two trainers -- are two DIFFERENT maximal cliques (their entries' frame paths are
# pairwise incompatible across the two branches, so they can never merge into one
# clique), yet produce the identical visible (id, order) sequence. Without the dedup
# that would emit the same chain row twice, which matters because a chain row carries
# no guard -- unlike battleEvents/fieldEffects, there is nothing in the emitted shape
# that could tell two such rows apart, so collapsing them here is the only place it can
# happen. Measured directly against the current data: 0 of the 761 maximal cliques
# enumerated across the whole corpus hit this shape, so the dedup has never actually
# suppressed anything yet -- but the shape itself is real and reachable, not merely
# hypothetical, and will fire the moment the corpus contains it.
def _find_chains(map_name: str, trainer_calls: list) -> list[dict]:
    by_script: dict[str, list[tuple[str, tuple]]] = {}
    for script, trainer_id, frame_path in trainer_calls:
        by_script.setdefault(script, []).append((trainer_id, frame_path))

    out = []
    for script, entries in by_script.items():
        n = len(entries)
        compat = [[_frames_compatible(a[1], b[1]) for b in entries] for a in entries]
        seen_id_sequences = set()
        for clique in _maximal_compatible_groups(n, compat):
            ids = tuple(entries[i][0] for i in sorted(clique))
            if len(set(ids)) < 2 or ids in seen_id_sequences:
                continue
            seen_id_sequences.add(ids)
            out.append({"map": map_name, "script": script, "trainers": list(ids)})
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
