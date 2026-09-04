# Elite Redux Tools

Tools for Pokemon Elite Redux — a Pokemon Emerald decomp ROM hack (pokeemerald-based,
not a Pokemon Essentials game) with custom mechanics, stats, types, and movesets that
diverge from vanilla Pokemon. Hobby project: keep recurring cost near zero and scope
proportionate to that.

## Project scope

- Pokedex (Elite Redux data) — first tool, in progress (`pipeline/` + `web/`)
- Damage calculator — next; `MoveBehavior`/`MoveEffect` proto data already sourced for it
- Save editor
- Build recommender — no known upstream data source yet (`recommended_sets.h` is an
  empty stub); needs its own approach

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
- **Hosting**: Cloudflare Pages, native Git integration (see `docs/DEPLOY.md`), not a
  GitHub Actions deploy workflow — deliberately zero-ops for a hobby project's budget.

## Notes

- Elite Redux game data (species/move/ability changes) is not vanilla Pokemon data —
  don't assume mainline values are correct; source from `er-config`/`eliteredux-source`
  (see `sources.lock.json` for pinned SHAs), never from memory of vanilla Pokemon.
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
  `cd pipeline && uv run python -m erdata.build`, review the diff, commit deliberately.
- `pipeline/src/erdata/generated/` (compiled protobuf modules) and
  `pipeline/.upstream/` (fetched upstream checkouts) ARE gitignored build artifacts —
  regenerate with `uv run python -m erdata.compile_protos` / `erdata.fetch`.
- Cross-check pipeline output against ER-nextdex's published `gameData.json` as a test
  oracle (see `pipeline/tests/test_oracle.py` and `pipeline/src/erdata/oracle.py`) —
  legitimate to use as a fact-check even though its repo is GPL-3.0, since game data
  facts aren't the copyrighted thing; don't reuse its parser code.
