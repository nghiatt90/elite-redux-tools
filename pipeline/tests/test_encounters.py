import json

from erdata.encounters import (
    _find_chains,
    _is_prefix,
    _join_own_line_else,
    _pair_field_effects,
    _scan_file,
    _strip_comment,
    scrape_encounters,
)

# Scraping every data/maps/*/scripts.pory is the slowest fixture in this file by a wide
# margin; computed once and reused, same as test_emit.py does for ability_hooks_to_dict().
_ENCOUNTERS = scrape_encounters()


def test_encounters_dict_is_json_serializable():
    json.dumps(_ENCOUNTERS)
    assert set(_ENCOUNTERS) == {"fieldEffects", "battleEvents", "trainerChains"}


def test_strip_comment_handles_poryscript_and_raw_asm_styles():
    assert _strip_comment('registerbattleevent(BATTLE_EVENT_X) // guard note') == "registerbattleevent(BATTLE_EVENT_X) "
    assert _strip_comment("MossdeepCity_Gym_MapScripts:: @ 8220800") == "MossdeepCity_Gym_MapScripts:: "
    # a dialogue line's quoted text is the one place `@` legitimately appears mid-line --
    # must NOT be treated as a comment marker there
    assert _strip_comment('msgbox(format("mail me @ home"))') == 'msgbox(format("mail me @ home"))'


def test_strip_comment_drops_commented_out_example_code():
    # data/maps/Route116/scripts.pory:571 -- a real false positive found while writing
    # this scraper: a commented-out trainerbattle_double example line copy-pasted from
    # MossdeepCity_Gym, left unstripped it gets misread as a genuine chain link.
    line = "// trainerbattle_double TRAINER_TATE_AND_LIZA_1, Text, Text, Text, Script, NO_MUSIC"
    assert "TRAINER_TATE_AND_LIZA_1" not in _strip_comment(line)


def test_field_effects_mossdeep_gym_permanent_trick_room():
    # Gym 7's field effect: battle_util.c:4162's TryToSetFieldEffect reads
    # VAR_BATTLE_FIELD_EFFECT_TYPE/VAR_BATTLE_FIELD_ID, set here to ROOM + Trick Room.
    fe = next(
        fe
        for fe in _ENCOUNTERS["fieldEffects"]
        if fe["map"] == "MossdeepCity_Gym" and fe["script"] == "MossdeepCity_Gym_EventScript_TateAndLiza"
    )
    assert fe["effectType"] == "BATTLE_FIELD_EFFECT_ROOM"
    assert fe["fieldId"] == "STATUS_FIELD_TRICK_ROOM"
    assert fe["trainers"] == ["TRAINER_TATE_AND_LIZA_1"]


def test_is_prefix_pins_the_current_known_unsound_rule_not_a_correct_one():
    # _is_prefix is a SUFFICIENT test for two points co-occurring in one playthrough,
    # not a NECESSARY one -- see the module docstring's limitation on this, with the
    # 331-pairs/79-diverge/0-wrong measurement. The last two assertions below pin
    # today's behaviour (both currently read as "diverging", i.e. mutually exclusive),
    # not a claim that it is right: `("a",)` and `("b",)` are indistinguishable here
    # from two SIBLING BRANCHES of one if/else (genuinely mutually exclusive, the
    # common real case) and from two INDEPENDENT, separately-guarded blocks that could
    # both execute in the same playthrough (genuinely co-occurring, wrongly excluded) --
    # this function cannot tell those two shapes apart from the guard path alone. Fixing
    # that is scoped as its own batch, not done here; this test gets replaced there.
    assert _is_prefix((), ("a",))  # unconditional is compatible with anything
    assert _is_prefix(("a",), ("a",))  # identical paths are trivially compatible
    assert _is_prefix(("a",), ("a", "b"))  # ancestor is compatible with its descendant
    assert not _is_prefix(("a",), ("b",))  # read as diverging -- sound only if these
    # are genuinely mutually exclusive (e.g. if/else siblings), not independent blocks
    assert not _is_prefix(("a", "x"), ("a", "y"))  # same caveat, one level deeper


def test_field_effects_champions_room_gravity_only_attributed_to_the_two_doubles_cases():
    # EverGrandeCity_ChampionsRoom_EventScript_Steven's switch sets STATUS_FIELD_GRAVITY
    # in cases 2 and 3 only (scripts.pory:314,318), not cases 0/1 or the pre-Game-Clear
    # else -- previously all four Steven variants (case 0/1's own trainers plus these
    # two) were attributed to one merged entry; now each case's Gravity activation is
    # independent and attributed only to that case's own trainer.
    gravity = [
        fe
        for fe in _ENCOUNTERS["fieldEffects"]
        if fe["map"] == "EverGrandeCity_ChampionsRoom" and fe["fieldId"] == "STATUS_FIELD_GRAVITY"
    ]
    assert len(gravity) == 2
    by_trainers = {tuple(fe["trainers"]): fe for fe in gravity}
    assert by_trainers[("TRAINER_STEVEN_DOUBLES",)]["guard"] == "switch(var(VAR_ELITE_4_MODE)) case 2"
    assert (
        by_trainers[("TRAINER_STEVEN_DOUBLES_LEGENDS",)]["guard"]
        == "switch(var(VAR_ELITE_4_MODE)) case 3"
    )
    # TRAINER_STEVEN and TRAINER_STEVEN_LEGENDS (cases 0/1, which never set Gravity)
    # must not appear in either entry.
    assert not {"TRAINER_STEVEN", "TRAINER_STEVEN_LEGENDS"} & (
        set(by_trainers[("TRAINER_STEVEN_DOUBLES",)]["trainers"])
        | set(by_trainers[("TRAINER_STEVEN_DOUBLES_LEGENDS",)]["trainers"])
    )


def test_field_effects_monochamp_room_uses_type_as_field_id():
    # EvergrandeCity_MonoChampRoom_1: BATTLE_FIELD_EFFECT_MONOCHAMP pairs
    # VAR_BATTLE_FIELD_ID with a Type enum value, not a STATUS_FIELD_* one -- the two
    # BATTLE_FIELD_EFFECT_* kinds use the same var for different value domains.
    monochamps = [
        fe for fe in _ENCOUNTERS["fieldEffects"] if fe["effectType"] == "BATTLE_FIELD_EFFECT_MONOCHAMP"
    ]
    assert len(monochamps) == 18  # one per type room in EvergrandeCity_MonoChampRoom_1
    assert all(fe["fieldId"].startswith("TYPE_") for fe in monochamps)


def test_pair_field_effects_ignores_the_post_battle_reset_to_zero():
    # Every field-effect script in the corpus resets both vars to 0 after the battle --
    # TryToSetFieldEffect treats 0 as no effect, so this must never be emitted as a
    # second, bogus field-effect activation.
    writes = [
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_ROOM", ()),
        ("Script", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_TRICK_ROOM", ()),
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "0", ()),
        ("Script", "VAR_BATTLE_FIELD_ID", "0", ()),
    ]
    out = _pair_field_effects("SomeMap", writes, [])
    assert len(out) == 1
    assert out[0] == {
        "map": "SomeMap",
        "script": "Script",
        "effectType": "BATTLE_FIELD_EFFECT_ROOM",
        "fieldId": "STATUS_FIELD_TRICK_ROOM",
        "guard": None,
        "trainers": [],
    }


def test_pair_field_effects_reset_allows_a_second_unconditional_activation():
    # A genuine second, independent activation at the SAME (unconditional) guard scope
    # as the first must still be emitted -- the reset clears last_activation_guard the
    # same way it clears effect_type/field_id, so a same-guard re-completion after a
    # reset is never mistaken for "just a continuation of the first activation".
    writes = [
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_ROOM", ()),
        ("Script", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_TRICK_ROOM", ()),
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "0", ()),
        ("Script", "VAR_BATTLE_FIELD_ID", "0", ()),
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_ROOM", ()),
        ("Script", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_GRAVITY", ()),
    ]
    out = _pair_field_effects("SomeMap", writes, [])
    assert len(out) == 2
    assert [o["fieldId"] for o in out] == ["STATUS_FIELD_TRICK_ROOM", "STATUS_FIELD_GRAVITY"]


def test_pair_field_effects_two_incompatible_branches_each_get_their_own_entry():
    # EverGrandeCity_ChampionsRoom_EventScript_Steven's shape: the SAME effect/field
    # pair completes twice, once in each of two mutually exclusive switch cases, with no
    # reset write between them -- each must still be its own activation, attributed only
    # to the trainer(s) reachable in that same case, not both cases' trainers merged.
    case2 = ("flag(FLAG_SYS_GAME_CLEAR)", "switch(var(VAR_ELITE_4_MODE)) case 2")
    case3 = ("flag(FLAG_SYS_GAME_CLEAR)", "switch(var(VAR_ELITE_4_MODE)) case 3")
    writes = [
        ("Steven", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_ROOM", ()),
        ("Steven", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_GRAVITY", case2),
        ("Steven", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_GRAVITY", case3),
    ]
    trainer_calls = [
        ("Steven", "TRAINER_STEVEN_DOUBLES", case2),
        ("Steven", "TRAINER_STEVEN_DOUBLES_LEGENDS", case3),
    ]
    out = _pair_field_effects("EverGrandeCity_ChampionsRoom", writes, trainer_calls)
    assert len(out) == 2
    by_trainers = {tuple(o["trainers"]): o for o in out}
    assert by_trainers[("TRAINER_STEVEN_DOUBLES",)]["guard"] == case2[-1]
    assert by_trainers[("TRAINER_STEVEN_DOUBLES_LEGENDS",)]["guard"] == case3[-1]


def test_battle_events_guard_is_the_actual_defeated_check_not_a_flag():
    # Correction against the plan's "guarding flag condition" wording -- the real guard
    # is an `if (!defeated(TRAINER_X))` boolean check. See
    # data/maps/DewfordTown_Gym/scripts.pory:686-699.
    dewford = [
        e
        for e in _ENCOUNTERS["battleEvents"]
        if e["map"] == "DewfordTown_Gym" and e["script"] == "DewfordTown_Gym_EventScript_CheckTrainers"
    ]
    spikes = next(e for e in dewford if e["event"] == "BATTLE_EVENT_SPIKES")
    assert spikes["guard"] == "!defeated(TRAINER_CRISTIAN)"
    assert spikes["data0"] == 2
    assert spikes["data1"] is None


def test_battle_events_mossdeep_gym_guards_on_defeated_count_not_a_single_trainer():
    # MossdeepCity_Gym's leaders are tag-team pairs, so its battle events are guarded by
    # a defeated-count comparison fed from a helper script, not a single defeated(X) --
    # the one file in the corpus that deviates from the other 8 gyms' shape.
    mossdeep = [
        e
        for e in _ENCOUNTERS["battleEvents"]
        if e["map"] == "MossdeepCity_Gym" and e["script"] == "MossdeepCity_Gym_EventScript_CheckTrainers"
    ]
    assert len(mossdeep) == 6
    assert all(e["guard"] is not None and "var(VAR_RESULT)" in e["guard"] for e in mossdeep)


def test_battle_events_tense_battle_is_unconditional_except_sootopolis_first_encounter():
    # 7 of the 8 gyms' BATTLE_EVENT_TENSE_BATTLE registration sits right before the
    # trainerbattle call, outside any per-trainer if-guard. SootopolisCity_Gym_1F is the
    # one exception: SootopolisCity_Gym_1F_EventScript_Juan only registers it inside the
    # `else` branch of `if (flag(FLAG_BADGE08_GET)) { goto rematch } else { ... }`
    # (scripts.pory:269-280), i.e. only on the first Juan fight, not the post-badge
    # rematch (which `goto_if_set`s straight past this script). Own-line `else{}` --
    # see _join_own_line_else -- so this was misread as unguarded before that fix. The
    # guard is the negated sibling condition (see _scan_file's _ELSE_RE branch), not the
    # literal string "else" -- this one is a fixed flag check, not something the solver
    # controls the way a `defeated(TRAINER_X)` guard is.
    tense = [e for e in _ENCOUNTERS["battleEvents"] if e["event"] == "BATTLE_EVENT_TENSE_BATTLE"]
    assert len(tense) >= 8  # one per gym at minimum
    guarded = {e["map"]: e["guard"] for e in tense}
    assert guarded.pop("SootopolisCity_Gym_1F") == "!(flag(FLAG_BADGE08_GET))"
    assert all(guard is None for guard in guarded.values())


def test_battle_events_monochamp_room_bug_and_ice_are_guarded_by_the_owned_line_else():
    # EvergrandeCity_MonoChampRoom_1's Bug and Ice rooms register their battle event
    # inside the player-accepted `else` branch of `if (var(VAR_RESULT) == NO) { ... }
    # else { ... }` (scripts.pory:388-406 for Bug, same shape for Ice), not
    # unconditionally -- both are own-line `}`-then-`else{` (scripts.pory:390-391), the
    # corpus's dominant style (see _join_own_line_else), so this was misread as
    # unguarded before that fix. The guard is the negated sibling condition, not the
    # literal string "else" -- see _scan_file's _ELSE_RE branch.
    events = {
        e["script"]: e
        for e in _ENCOUNTERS["battleEvents"]
        if e["map"] == "EvergrandeCity_MonoChampRoom_1"
    }
    bug = events["EverGrandeCity_MonoChampRoom_1_EventScript_MonoChamp_Bug"]
    assert bug["event"] == "BATTLE_EVENT_PERMA_STICKY_WEB"
    assert bug["guard"] == "!(var(VAR_RESULT) == NO)"
    ice = events["EverGrandeCity_MonoChampRoom_1_EventScript_MonoChamp_Ice"]
    assert ice["guard"] == "!(var(VAR_RESULT) == NO)"


def test_scan_file_recognises_the_own_line_else_style_not_just_same_line():
    # The corpus's dominant style (207 of 281 else branches, measured directly) closes
    # an if-block's brace on its own line and puts `else{` on the next line, rather than
    # `} else {` on one line -- see _join_own_line_else's own comment. The else's guard
    # is the negated sibling condition, not the literal string "else" -- see _scan_file's
    # _ELSE_RE branch.
    text = (
        "script PoryLabel{\n"
        "\tif (!defeated(TRAINER_FOO)){\n"
        "\t\tmsgbox(format(\"hi\"))\n"
        "\t}\n"
        "\telse{\n"
        "\t\tregisterbattleevent(BATTLE_EVENT_SPIKES, 2)\n"
        "\t}\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    assert scanned["battle_events"] == [
        {
            "map": "TestMap",
            "script": "PoryLabel",
            "event": "BATTLE_EVENT_SPIKES",
            "data0": 2,
            "data1": None,
            "guard": "!(!defeated(TRAINER_FOO))",
        }
    ]


def test_scan_file_handles_else_if_even_though_the_corpus_has_none_today():
    # _ELSE_IF_RE is dead code against the current corpus (checked: zero `else if`
    # constructs in any spacing) but must still work correctly whenever one shows up --
    # this earns that claim with a test rather than just asserting it in a comment.
    # Covers the same-line `} else if (...) {` shape (own-line else-if is untested for
    # the same reason: no real example to derive the shape from) and checks that the
    # chain nets braces back to zero afterward, so a call after the whole if/else-if/
    # else chain sees no guard at all.
    text = (
        "script PoryLabel{\n"
        "\tif (var(VAR_RESULT) == NO){\n"
        "\t\tmsgbox(format(\"no\"))\n"
        "\t} else if (var(VAR_RESULT) == YES){\n"
        "\t\tregisterbattleevent(BATTLE_EVENT_SPIKES, 2)\n"
        "\t} else {\n"
        "\t\tmsgbox(format(\"neither\"))\n"
        "\t}\n"
        "\tregisterbattleevent(BATTLE_EVENT_TENSE_BATTLE)\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    assert scanned["battle_events"] == [
        {
            "map": "TestMap",
            "script": "PoryLabel",
            "event": "BATTLE_EVENT_SPIKES",
            "data0": 2,
            "data1": None,
            "guard": "var(VAR_RESULT) == YES",
        },
        {
            "map": "TestMap",
            "script": "PoryLabel",
            "event": "BATTLE_EVENT_TENSE_BATTLE",
            "data0": None,
            "data1": None,
            "guard": None,  # braces net to zero after the if/else-if/else chain closes
        },
    ]


def test_join_own_line_else_leaves_the_same_line_style_untouched():
    # The minority same-line style (`} else {`, 74 of 281 branches) must keep working
    # exactly as before -- this pass only needs to act on the own-line style. Compared
    # line-by-line, not as a raw string: splitlines()/"\n".join() round-tripping drops a
    # trailing newline, which _scan_file's own splitlines() call downstream never sees.
    text = "if (x) {\n\ty\n} else {\n\tz\n}\n"
    assert _join_own_line_else(text).splitlines() == text.splitlines()


def test_join_own_line_else_does_not_touch_an_unrelated_bare_closing_brace():
    # A `}` on its own line that is NOT followed by `else` (e.g. closing a script or an
    # unrelated if-block) must be left alone -- only the exact "}\nelse..." shape joins.
    text = "script Foo{\n\tif (x) {\n\t\ty\n\t}\n\tend\n}\n"
    assert _join_own_line_else(text).splitlines() == text.splitlines()


def test_scan_file_relabels_switch_cases_in_the_guard_path_not_just_the_switch_itself():
    # Without case-label tracking every case in a switch would share one identical
    # guard ("switch(EXPR)"), indistinguishable from each other -- exactly the gap that
    # let EverGrandeCity_ChampionsRoom's Gravity field effect get attributed to every
    # switch case. Each case's trainerbattle call must carry its OWN guard path,
    # differing only in the case label, with the switch's own condition text preserved.
    text = (
        "script PoryLabel{\n"
        "\tswitch(var(VAR_ELITE_4_MODE)){\n"
        "\t\tcase 0:\n"
        "\t\t\ttrainerbattle_no_intro(TRAINER_A, Text)\n"
        "\t\tbreak\n"
        "\t\tcase 1:\n"
        "\t\t\ttrainerbattle_no_intro(TRAINER_B, Text)\n"
        "\t\tbreak\n"
        "\t}\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    calls = {tid: guard_path for _, tid, guard_path in scanned["trainer_calls"]}
    assert calls["TRAINER_A"] == ("switch(var(VAR_ELITE_4_MODE)) case 0",)
    assert calls["TRAINER_B"] == ("switch(var(VAR_ELITE_4_MODE)) case 1",)
    assert calls["TRAINER_A"] != calls["TRAINER_B"]


def test_scan_file_switch_default_label_also_relabels_the_guard_path():
    text = (
        "script PoryLabel{\n"
        "\tswitch(var(VAR_RESULT)){\n"
        "\t\tcase 0:\n"
        "\t\t\ttrainerbattle_no_intro(TRAINER_A, Text)\n"
        "\t\tbreak\n"
        "\t\tdefault:\n"
        "\t\t\ttrainerbattle_no_intro(TRAINER_B, Text)\n"
        "\t\tbreak\n"
        "\t}\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    calls = {tid: guard_path for _, tid, guard_path in scanned["trainer_calls"]}
    assert calls["TRAINER_B"] == ("switch(var(VAR_RESULT)) default",)


def test_scan_file_guard_path_is_the_full_ancestor_chain_outermost_first():
    # guard_path (unlike battle_events' own innermost-only "guard") carries every open
    # guard, in nesting order -- needed for the prefix/ancestor test _find_chains and
    # _pair_field_effects both rely on.
    text = (
        "script PoryLabel{\n"
        "\tif (flag(FLAG_SYS_GAME_CLEAR)){\n"
        "\t\tswitch(var(VAR_ELITE_4_MODE)){\n"
        "\t\t\tcase 2:\n"
        "\t\t\t\ttrainerbattle_no_intro(TRAINER_A, Text)\n"
        "\t\t\tbreak\n"
        "\t\t}\n"
        "\t}\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    _, _, guard_path = scanned["trainer_calls"][0]
    assert guard_path == ("flag(FLAG_SYS_GAME_CLEAR)", "switch(var(VAR_ELITE_4_MODE)) case 2")


def test_find_chains_excludes_mutually_exclusive_switch_cases():
    # The exact EverGrandeCity_ChampionsRoom_EventScript_Steven shape, reduced: four
    # switch cases plus an else, five trainerbattle calls, four distinct trainers, none
    # of them reachable together with any other -- must yield NO chain at all, not a
    # four/five-name one.
    def case(n):
        return ("flag(FLAG_SYS_GAME_CLEAR)", f"switch(var(VAR_ELITE_4_MODE)) case {n}")

    trainer_calls = [
        ("Steven", "TRAINER_STEVEN", case(0)),
        ("Steven", "TRAINER_STEVEN_LEGENDS", case(1)),
        ("Steven", "TRAINER_STEVEN_DOUBLES", case(2)),
        ("Steven", "TRAINER_STEVEN_DOUBLES_LEGENDS", case(3)),
        ("Steven", "TRAINER_STEVEN", ("!(flag(FLAG_SYS_GAME_CLEAR))",)),
    ]
    assert _find_chains("EverGrandeCity_ChampionsRoom", trainer_calls) == []


def test_find_chains_still_flags_a_genuine_sequential_chain():
    # VictoryRoadRework_EventScript_Wally's shape: an unconditional first call, then a
    # second call nested inside a real `if` -- the second EXTENDS the first's guard path
    # rather than diverging from it, so this is a genuine reachable-together chain.
    trainer_calls = [
        ("Wally", "TRAINER_WALLY_VR_1", ()),
        ("Wally", "TRAINER_WALLY_VR_2", ("var(VAR_RESULT)",)),
    ]
    chains = _find_chains("VictoryRoadRework", trainer_calls)
    assert chains == [
        {
            "map": "VictoryRoadRework",
            "script": "Wally",
            "trainers": ["TRAINER_WALLY_VR_1", "TRAINER_WALLY_VR_2"],
        }
    ]


def test_find_chains_random_switch_choice_yields_no_chain():
    # GraniteCave_B2F_EventScript_HitmonStone's shape: `random(3)` then a switch that
    # picks exactly one of three Blackbelts -- only one is ever fought per visit, so
    # this must not read as a three-battle chain.
    def case(n):
        return (f"switch(var(VAR_RESULT)) case {n}",)

    trainer_calls = [
        ("HitmonStone", "TRAINER_HITMONSTONE_BLACKBELT_1", case(0)),
        ("HitmonStone", "TRAINER_HITMONSTONE_BLACKBELT_2", case(1)),
        ("HitmonStone", "TRAINER_HITMONSTONE_BLACKBELT_3", case(2)),
    ]
    assert _find_chains("GraniteCave_B2F", trainer_calls) == []


def test_trainer_chains_champions_room_no_longer_reports_a_five_name_chain():
    assert not any(
        c["map"] == "EverGrandeCity_ChampionsRoom" for c in _ENCOUNTERS["trainerChains"]
    )


def test_trainer_chains_granitecave_hitmonstone_random_choice_is_not_a_chain():
    assert not any(
        c["map"] == "GraniteCave_B2F" and c["script"] == "GraniteCave_B2F_EventScript_HitmonStone"
        for c in _ENCOUNTERS["trainerChains"]
    )


def test_trainer_chains_sootopolis_trigger_battles_are_the_real_three_not_six():
    # SootopolisCity_Gym_EventScript_Trigger{Bottom,Middle,Top}Battle each offer a
    # genuine FLAG_SYS_DISABLE_AUTOHEAL-wrapped three-battle chain (one switch case) and
    # three mutually-exclusive single-battle-plus-starttagbattle alternatives (the other
    # cases, whose second trainer is invisible to this module -- starttagbattle, not
    # trainerbattle*). Before the fix all six trainerbattle_no_intro calls in each
    # script (the real three, plus each alternative's own one) merged into one bogus
    # six-entry chain; each must now report just the real three, once.
    expected = {
        "SootopolisCity_Gym_EventScript_TriggerBottomBattle": [
            "TRAINER_BRIDGET",
            "TRAINER_CRISSY",
            "TRAINER_BETHANY",
        ],
        "SootopolisCity_Gym_EventScript_TriggerMiddleBattle": [
            "TRAINER_DAPHNE",
            "TRAINER_CONNIE",
            "TRAINER_ANDREA",
        ],
        "SootopolisCity_Gym_EventScript_TriggerTopBattle": [
            "TRAINER_OLIVIA",
            "TRAINER_BRIANNA",
            "TRAINER_ANNIKA",
        ],
    }
    chains = {
        c["script"]: c["trainers"]
        for c in _ENCOUNTERS["trainerChains"]
        if c["map"] == "SootopolisCity_Gym_1F" and c["script"] in expected
    }
    assert chains == expected


def test_trainer_chains_victory_road_wally_rematch():
    # VictoryRoadRework_EventScript_Wally fights TRAINER_WALLY_VR_1 then, with no heal
    # in between, immediately offers TRAINER_WALLY_VR_2 -- the back-to-back pattern
    # CLAUDE.md/the plan describe: "map scripts calling trainerbattle twice without
    # healing", not a special engine case.
    chain = next(
        c
        for c in _ENCOUNTERS["trainerChains"]
        if c["map"] == "VictoryRoadRework" and c["script"] == "VictoryRoadRework_EventScript_Wally"
    )
    assert chain["trainers"] == ["TRAINER_WALLY_VR_1", "TRAINER_WALLY_VR_2"]


def test_trainer_chains_excludes_same_trainer_repeated_for_dialogue_variants():
    # MossdeepCity_Gym_EventScript_TateAndLiza's switch/case only varies intro/defeat
    # text by how many sub-trainers are beaten -- every case fights the same
    # TRAINER_TATE_AND_LIZA_1, so this must NOT be reported as a 3-battle chain.
    assert not any(
        c["map"] == "MossdeepCity_Gym" and c["script"] == "MossdeepCity_Gym_EventScript_TateAndLiza"
        for c in _ENCOUNTERS["trainerChains"]
    )


def test_scan_file_tracks_script_context_across_raw_and_poryscript_styles():
    text = (
        "RawLabel:: @ 8220800\n"
        "\tsetvar VAR_BATTLE_FIELD_EFFECT_TYPE, BATTLE_FIELD_EFFECT_WEATHER\n"
        "\tsetvar VAR_BATTLE_FIELD_ID, WEATHER_RAIN\n"
        "\tend\n"
        "\n"
        "script PoryLabel{\n"
        "\tif (!defeated(TRAINER_FOO)){\n"
        "\t\tregisterbattleevent(BATTLE_EVENT_SPIKES, 2)\n"
        "\t}\n"
        "\tend\n"
        "}\n"
    )
    scanned = _scan_file("TestMap", text)
    assert scanned["field_writes"] == [
        ("RawLabel", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_WEATHER", ()),
        ("RawLabel", "VAR_BATTLE_FIELD_ID", "WEATHER_RAIN", ()),
    ]
    assert scanned["battle_events"] == [
        {
            "map": "TestMap",
            "script": "PoryLabel",
            "event": "BATTLE_EVENT_SPIKES",
            "data0": 2,
            "data1": None,
            "guard": "!defeated(TRAINER_FOO)",
        }
    ]
