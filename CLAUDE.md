# Elite Redux Tools

Tools for Pokemon Elite Redux — a Pokemon Emerald decomp ROM hack (pokeemerald-based,
not a Pokemon Essentials game) with custom mechanics, stats, types, and movesets that
diverge from vanilla Pokemon. Hobby project: keep recurring cost near zero and scope
proportionate to that.

## Project scope

- Pokedex (Elite Redux data) — first tool, in progress (`pipeline/` + `web/`)
- Damage calculator — **built** (`web/src/engine/`), singles only
- Battle simulator + team-build solver — planned, unstarted. Turn loop, AI port and
  solver on top of the damage engine. Plan lives outside the repo, in the user's
  `~/.claude/plans/`.
- Save editor
- Build recommender — no upstream data source (`recommended_sets.h` is an empty stub).
  Likely falls out of the solver rather than needing its own source.

## Stack

- **Data pipeline** (`pipeline/`): Python 3.11+, `uv`. Elite Redux's canonical data is
  **protobuf**, not the generated C headers — `Elite-Redux/er-config` (textproto) is
  the source of truth, parsed via `google.protobuf.text_format`. Sprites and the type
  effectiveness chart (not in er-config; it's a C array in `battle_util.c`) come from
  `Elite-Redux/eliteredux-source`. Both are fetched at a pinned commit
  (`sources.lock.json`), never live. See `pipeline/src/erdata/resolve.py` for the
  non-obvious resolution rules (form_of dex inheritance, six-branch learnset
  resolution, universal tutor expansion) — these were reverse-engineered from Elite
  Redux's own Kotlin codegen (`eliteredux-source:tools/codegen/`), not guessed.
- **Frontend** (`web/`): TypeScript, React, Vite, Tailwind v4, react-router,
  TanStack Virtual. Reads the committed `data/<version>/*.json` snapshot at runtime
  (`web/public/data/`, synced from the repo root via `npm run sync-data` before
  dev/build) — no backend, no database, everything client-side.
- **Layering inside `web/src/`** — keep this boundary. `lib/` and `engine/` are pure and
  headless with **no React**, unit-tested in Node via vitest and drivable from a Web
  Worker; `features/` and `routes/` are the React layer. `lib/randomizer.ts` is the
  reference example of the pattern.
- **Battle engine** (`web/src/engine/`): a port of the game's damage path from
  `battle_util.c` at the pinned SHA, ~9.4k lines. Entry point `calculateMoveDamage`
  returns all 16 rolls plus crit rolls, multi-hit totals, type effectiveness and an
  `unmodelled[]` channel; `kochance.ts` turns those into KO probabilities. Abilities
  live in `engine/abilities/impl/NN-*.ts` batches behind a registry, with
  `abilities/coverage.test.ts` asserting a count that may **only go down**. Ability
  mechanics are not prose: `pipeline/src/erdata/ability_hooks.py` scrapes
  `src/abilities.cc` into `data/<version>/abilityHooks.json`, which carries each
  ability's bitfields and the raw C source of every hook lambda. Porting is
  transcription, not reverse engineering.
- **Hosting**: Cloudflare Pages, native Git integration (see `docs/DEPLOY.md`), not a
  GitHub Actions deploy workflow — deliberately zero-ops for a hobby project's budget.

## Notes

- Elite Redux game data (species/move/ability changes) is not vanilla Pokemon data —
  don't assume mainline values are correct; source from `er-config`/`eliteredux-source`
  (see `sources.lock.json` for pinned SHAs), never from memory of vanilla Pokemon.
- **IVs are not a variable.** `CalculateMonStatsMaster` forces every IV to 31 on every
  stat recalculation, for both the player and the AI (`src/pokemon.c:988-994` at the
  pinned SHA). Two exceptions: Hell mode with `HELL_MODE_0_IVS_FLAG` zeroes all six, and
  the `speedDown` "iron pill" flag zeroes Speed IV alone. EVs exist only when
  `gSaveBlock2Ptr->enableEvs` is set. Any tool offering IV inputs is modelling something
  the game does not do.
- **Trainer Pokemon level = the player's highest party level.**
  `battle_main.c:1819-1827` computes `GetHighestLevelInPlayerParty() + partyData[i].lvl
  + extraLevels`, and the Kotlin codegen emits no `.lvl`, so the per-mon offset is
  always zero; `extraLevels` is nonzero only under `HELL_MODE_EXTRA_LEVELS_FLAG`. Levels
  are therefore **derived, not parsed** — `TrainerList.textproto` has no level field at
  all. The codegen also emits no `.items`, so `gTrainers[].items[]` is empty and the AI
  never uses healing items.
- **Pin the released build, not branch tip.** Both upstreams only publish `upcoming`;
  ROM releases are cut from it with no tag or release branch, so the tip always runs
  ahead of any playable ROM. That is cosmetic for the Pokedex and fatal for the
  randomizer, whose LCG modulus is `ABILITIES_COUNT` — one unreleased ability makes
  every PID it reports wrong. `sources.lock.json`'s `pin_policy` records the current
  choice; `tests/test_oracle.py::test_abilities_count_matches_the_released_game`
  enforces it against ER-nextdex's released-game data. When repinning, move the SHA
  back until that test is green — never loosen the assertion.
- `data/v2.65beta/` is a **committed** generated snapshot (~42MB), not a build
  artifact to gitignore — it's what the deployed site actually reads. Regenerate via
  `uv run --directory pipeline python -m erdata.build`, review the diff, commit deliberately.
- `pipeline/src/erdata/generated/` (compiled protobuf modules) and
  `pipeline/.upstream/` (fetched upstream checkouts) ARE gitignored build artifacts —
  regenerate with `uv run --directory pipeline python -m erdata.compile_protos` /
  `... -m erdata.fetch`.
- **Shell commands: never `cd`, never chain.** The `uv` project lives in `pipeline/`, but
  reach it with `uv run --directory pipeline …`, not `cd pipeline && uv run …`. `--directory`
  changes cwd before running, and `paths.py` roots everything at `__file__` anyway, so cwd
  never affects the pipeline's own file resolution. One command per call — no `&&`, no `;`.
  Both habits make a command unmatchable against the `.claude/settings.json` allowlist, which
  is written against these exact prefixes, so they raise an approval prompt for work that
  should run silently. Prefer Glob over `find`, Grep over `grep`, Read over `cat`; those never
  prompt. Never pipe Python through a heredoc — Write the script to a file, then
  `uv run python <path>`.
- Cross-check pipeline output against ER-nextdex's published `gameData.json` as a test
  oracle (see `pipeline/tests/test_oracle.py` and `pipeline/src/erdata/oracle.py`) —
  legitimate to use as a fact-check even though its repo is GPL-3.0, since game data
  facts aren't the copyrighted thing; don't reuse its parser code.
- **Trainer parties ARE emitted**, as `data/v2.65beta/trainers.json` (932 trainers, since
  `a97bc64`): parties with natures, EVs, abilities and movesets across the three difficulty
  tiers (`ace` / `elite` / `hell`), plus the per-trainer AI toggles `risky`, `preferStall`,
  `preferStatus`, `noSwitching` and `forcedDouble`. `TrainerPartyGenerator.kt:180-194` turns
  those toggles into `gTrainers[].aiFlags` on top of an always-on base set. An earlier
  revision of this line said nothing wrote a `trainers.json`; an agent later trusted it and
  called real AI flags underivable. **`.ability` in the textproto is a real ability id, not
  a slot index** — `TrainerList.proto:248` declares it `AbilityEnum ability = 5`, so parse it
  the same way as every other `AbilityEnum` field. The slot index exists only downstream, in
  the generated C: `TrainerPartyGenerator.kt:147-156` converts the id with
  `SPECIES_MAP[species]!!.abilityList.indexOf(ability)` when emitting `gTrainers[]`, and
  **omits `.ability` entirely** when that returns -1 (the mon does not have the ability the
  textproto names, which the codegen reports as a validation error rather than fixing). An
  earlier revision of this file had these two backwards.
- `sparse_paths` in `sources.lock.json` **includes `data/`** (added in `a97bc64`), so the
  upstream map scripts and battle scripts are on disk and directly readable:
  `pipeline/.upstream/eliteredux-source/data/maps/*/scripts.pory` (Poryscript source — there
  is no compiled `.inc` in this tree) and `data/battle_scripts_1.s` / `_2.s`. Read them.
  An earlier revision of this line said they were not fetched, and that cost real work: an
  agent reasoned about whether a move deals damage from its description rather than from its
  script. `docs/battle-sim/boss-fight-coverage.md` shows what the scripts settle that the
  declared data cannot — a 95-power move whose script has no damage step at all.
- **Multi-agent work runs through OMC's `/team` skill**, not the Claude-native team setup this
  project used earlier. `.claude/agents/plan-reviewer.md`, `implementer.md` and
  `code-reviewer.md` are kept only as deprecated reference — they predate OMC and are not
  wired into the current workflow. OMC's own roster (`planner`, `executor`, `code-reviewer`,
  `verifier`, etc., see the `wiki` skill) already carries the plan → execute → review → verify
  discipline this project relies on, driven by this file's project facts the same way the old
  agents were.
