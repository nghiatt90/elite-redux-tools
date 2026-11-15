# Deploying to Cloudflare Pages

Uses Cloudflare Pages' native Git integration rather than a GitHub Actions workflow --
zero YAML to maintain, no API tokens to store as repo secrets, and per-PR preview
deploys come free. The build itself never runs Python; it copies committed data
snapshots into the site and runs `vite build`.

## One-time setup (manual, in the Cloudflare dashboard)

Done on 2026-09-05. Before that the project existed as a **Direct Upload** one and
every release needed someone to be logged in to Cloudflare on the machine doing the
deploy -- pushes to `main` did nothing. If the project is ever recreated, these are
the steps; the settings table is the part that matters.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
   → **Pages** → **Connect to Git**.
2. Pick this repository and authorize Cloudflare's GitHub App.
3. Build settings:
   | Setting | Value |
   |---|---|
   | Framework preset | Vite |
   | Root directory | `web` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
4. Leave environment variables empty -- nothing here needs secrets.
5. **Save and Deploy**. First build takes a couple of minutes; you'll get a
   `<project-name>.pages.dev` URL.

That's it -- every push to `main` redeploys automatically, and every PR gets its own
preview URL, both free on Cloudflare's Pages plan. A push-triggered build takes about
40 seconds.

Two things worth knowing about the settings above:

- **Root directory `web` is not a default.** Left blank, the build finds no
  `package.json` and fails immediately. The output directory is relative to it, so
  `dist`, not `web/dist`.
- **`prebuild` reaches outside the root directory**, running `node scripts/sync-data.mjs`
  to copy committed data snapshots under `../data/`.
  That is fine -- Cloudflare clones the whole repo and merely runs the build inside
  `web/` -- but it is the least standard thing here, so check it first if a build
  fails.

Nothing pins the Node version (no `.node-version`, no `engines`), so builds take
whatever the Pages image defaults to. Worth pinning if a build ever breaks without a
source change.

## What the build actually does

`npm run build` (in `web/`) runs, via its `prebuild` hook:

```
node scripts/sync-data.mjs
tsc -b && vite build
```

The sync script (`web/scripts/sync-data.mjs`) ships all 3 versions (`v2.65.5`, `v2.65.4.1b`,
and `v2.65beta`):
- Cleans `public/data/`.
- Copies all 9 JSON data files (`abilities.json`, `abilityHooks.json`, `items.json`,
  `meta.json`, `moveBehaviors.json`, `moves.json`, `natures.json`, `species.json`,
  `types.json`) for each of `v2.65.5`, `v2.65.4.1b`, and `v2.65beta` into `public/data/<version>/`.
- Copies all 7,752 sprites (1,938 species × 4 variants) from `data/v2.65.5/sprites/` into
  `public/data/v2.65.5/sprites/`.
- For `v2.65.4.1b` and `v2.65beta`, compares each `<SPECIES>/<variant>.png` against
  `data/v2.65.5/sprites/<SPECIES>/<variant>.png` by byte equality (`Buffer.equals`):
  only copies differing or newly introduced sprites into `public/data/<version>/sprites/`,
  and writes the sorted list of overridden `<SPECIES>/<variant>` keys to
  `public/data/<version>/spriteOverrides.json` (`[]` for `v2.65.5`).

At runtime, `spriteUrl(speciesId, variant, version)` checks whether `version !== 'v2.65.5'`
and whether `${speciesId}/${variant}` is listed in that version's sprite overrides. If so,
it loads `/data/${version}/sprites/${speciesId}/${variant}.png`; otherwise it falls back to
`/data/v2.65.5/sprites/${speciesId}/${variant}.png`.

## Verifying a deploy

- Cloudflare's free tier caps a deployment at 20,000 files and 25MiB per file. Thanks to
  sprite deduplication across versions (only 20 overridden sprites in `v2.65.4.1b` and 311
  in `v2.65beta`), the entire deployment ships **~8,125 files / ~11MB**, well below the
  20,000-file ceiling:
  - `v2.65.5`: 9 JSONs + 7,752 sprites + `spriteOverrides.json` = 7,762 files
  - `v2.65.4.1b`: 9 JSONs + 20 sprites + `spriteOverrides.json` = 30 files
  - `v2.65beta`: 9 JSONs + 311 sprites + `spriteOverrides.json` = 321 files
  - Web application assets (HTML, JS bundles, icons, redirects) = ~12 files
  - Total: ~8,125 files.
- `public/_redirects` (`/* /index.html 200`) makes client-side routing
  (`/pokemon/:id`) work on a hard refresh or direct link -- Cloudflare Pages honors it
  automatically once it's in the build output.
- After a deploy, load the `.pages.dev` URL directly at `/pokemon/SPECIES_PIKACHU` (not
  just `/`) to confirm the redirect rule is live, and check the browser console for
  errors on both the list and detail routes.
- Confirm version switching in the header dropdown (or via `?v=v2.65.5`, `?v=v2.65.4.1b`,
  `?v=v2.65.3b`) loads the corresponding data snapshot and sprites cleanly.

## Updating the data snapshot

Re-run the pipeline (`cd pipeline && uv run python -m erdata.build`), review the diff
under `data/v2.65.5/`, commit it, and push -- Cloudflare picks up the new snapshot on
the next build automatically.

`.github/workflows/refresh-data.yml` does the same thing from CI -- run it from the
Actions tab (`workflow_dispatch`) and it opens a PR if upstream has moved. It is
**manual only, on purpose**: it advances the lockfile to each source's branch head,
and both branches are `upcoming`, which runs ahead of the released ROM, so the right
moment to run it is when a new ROM is out -- not on a timer. It decides nothing; read
`pin_policy` in `sources.lock.json` before merging its PR, since getting this wrong is
what broke the randomizer once already. The pipeline tests run before the PR is
opened, so the `ABILITIES_COUNT` assertion has to pass first.

Regenerating sprites re-encodes every PNG even when the pixels are identical (Pillow
version differences), which turns a no-op refresh into a multi-thousand-file diff. Only
commit sprites whose pixels actually changed.
