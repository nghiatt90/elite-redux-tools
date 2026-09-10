import json

from erdata.encounters import _pair_field_effects, _scan_file, _strip_comment, scrape_encounters

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
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_ROOM"),
        ("Script", "VAR_BATTLE_FIELD_ID", "STATUS_FIELD_TRICK_ROOM"),
        ("Script", "VAR_BATTLE_FIELD_EFFECT_TYPE", "0"),
        ("Script", "VAR_BATTLE_FIELD_ID", "0"),
    ]
    out = _pair_field_effects("SomeMap", writes, {})
    assert len(out) == 1
    assert out[0] == {
        "map": "SomeMap",
        "script": "Script",
        "effectType": "BATTLE_FIELD_EFFECT_ROOM",
        "fieldId": "STATUS_FIELD_TRICK_ROOM",
        "trainers": [],
    }


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


def test_battle_events_tense_battle_is_unconditional():
    # Every gym boss fight registers BATTLE_EVENT_TENSE_BATTLE right before the
    # trainerbattle call, outside any per-trainer if-guard.
    tense = [e for e in _ENCOUNTERS["battleEvents"] if e["event"] == "BATTLE_EVENT_TENSE_BATTLE"]
    assert len(tense) >= 8  # one per gym at minimum
    assert all(e["guard"] is None for e in tense)


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
        ("RawLabel", "VAR_BATTLE_FIELD_EFFECT_TYPE", "BATTLE_FIELD_EFFECT_WEATHER"),
        ("RawLabel", "VAR_BATTLE_FIELD_ID", "WEATHER_RAIN"),
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
