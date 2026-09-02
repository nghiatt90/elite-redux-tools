# Elite Redux Tools

Community tools for [Pokemon Elite Redux](https://eliteredux.net), a Pokemon Emerald
decomp ROM hack with 1,200+ species, a multi-ability system, and rebalanced stats,
types, and movesets that diverge from vanilla Pokemon.

## Pokedex

The first tool. Not deployed yet — see [`docs/DEPLOY.md`](./docs/DEPLOY.md); once
live, the URL belongs here.

Sourced directly from Elite Redux's own protobuf data (`Elite-Redux/er-config`), not
guessed at or reverse-engineered from generated C headers — see
[`CLAUDE.md`](./CLAUDE.md) for how the pipeline works and why that source was chosen.
Searchable and filterable by type, ability, innate ability, and base stats, with
defensive type matchups, full learnsets, and evolution chains.

## Planned tools

- **Damage calculator** — compute damage ranges accounting for Elite Redux's custom
  mechanics, movesets, and stat changes.
- **Save editor** — inspect and edit Elite Redux save files.
- **Build recommender** — suggest movesets/EV spreads/held items for a given Pokemon
  and role.

## Development

```
# Data pipeline (Python, uv)
cd pipeline
uv sync --extra dev
uv run python -m erdata.build   # fetch -> parse -> resolve -> emit -> sprites
uv run pytest

# Frontend (TypeScript, Vite)
cd web
npm install
npm run dev      # copies the committed data/ snapshot into public/ first
npm run build
```

See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for deploying to Cloudflare Pages.

## Data provenance

Game data is pinned to specific upstream commits, recorded in
[`sources.lock.json`](./sources.lock.json), and the generated snapshot under
`data/` is committed to this repo rather than fetched live — every build is
reproducible from the repo alone. The pinned source and commit are also shown in the
Pokedex's own footer.

Neither `Elite-Redux/er-config` nor `Elite-Redux/eliteredux-source` declares a
license. This repository's own code is MIT-licensed (below); the Elite Redux data
itself is used with attribution and is not relicensed as this project's own.
[ER-nextdex](https://github.com/ForwardFeed/ER-nextdex) is used only as an
independent test oracle to cross-check the pipeline's output (see
`pipeline/src/erdata/oracle.py`) — no code from it is reused.

## Status

Pokedex in active development. Not affiliated with the Elite Redux development team.

## License

MIT — see [LICENSE](./LICENSE). Applies to this repository's own code; see "Data
provenance" above for the game data itself.
