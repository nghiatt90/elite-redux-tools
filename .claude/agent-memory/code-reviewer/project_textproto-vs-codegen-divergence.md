---
name: textproto-vs-codegen-divergence
description: When reviewing pipeline emitters, check whether the Kotlin codegen drops or transforms the field before it reaches the ROM -- textproto truth is not always game truth; includes the settled trainer-ability resolution chain
metadata:
  type: project
---

An emitter that faithfully transcribes `er-config`'s textproto can still publish a fact
the game does not honour, because `eliteredux-source/tools/codegen/` sits between the
textproto and `gTrainers[]`/`gBaseStats[]` and is allowed to drop or reshape fields.

**Settled: the trainer-mon ability chain** (found 2026-09-11, fix reviewed the same day;
do not re-derive). `TrainerMon.ability` is a real `AbilityEnum`.
`TrainerPartyGenerator.kt:147-156` converts it with `abilityList.indexOf(ability)` and
**omits** `.ability` when that returns -1 (diagnostics only, inside
`#ifdef VALIDATE_TRAINERS` at line 224-228, never a build failure). The omitted field is
zero-initialised; `battle_main.c:1854` feeds it to
`SetMonData(MON_DATA_ABILITY_NUM, ...)`; **`pokemon.c:2147-2156` `GetAbilityBySpecies`**
is what turns slot 0 into `gBaseStats[species].abilities[0]`. That last step is *not* in
`battle_util.c` -- an earlier comment cited `battle_util.c:5001-5002`, which is sleep-clause
code, and `battle_main.c:5001-5002` is `GetMonMoveType`, not the trainer path.

`Species.abilityList` and `Species.innateList` are **separate** proto fields
(`SpeciesList.proto:162-163`; `BaseStatsGenerator.kt:26` unions them explicitly), so
`indexOf` searches the three slots only. Measured on the pinned data: every species has
either 3 abilities (1908) or 0 (3: `SPECIES_NONE`, `SPECIES_EGG`,
`SPECIES_INFERNAPE_REDUX_B`, none used by a trainer); 155 species repeat an ability across
slots; 149 have one distinct ability. 252 party entries across 130 trainers (of 12,210
entries, 932 trainers) name an ability the species lacks, and **80 of those name one of the
species' own innates** -- the regime a Barbaracle-style example cannot exercise.

**Why:** the pipeline's contract is "what the game does", and the codegen is the last
authority before the ROM.

**How to apply:** for any new `*_to_dict` in `emit.py`, open the matching generator under
`tools/codegen/src/er/` and read what it does with each field, looking for `indexOf`,
`takeIf`, `ifEmpty`, and conditional `appendLine`. Also note the Python `build_species_map`
keys every parsed species (1911) while Kotlin's `SPECIES_MAP` filters
`randomizerBanned == SPECIES_HIDDEN` (1909) -- harmless today because no trainer references
either hidden species, but it is a real population difference. See
[[verify-cited-numbers-and-corpus-claims]].
