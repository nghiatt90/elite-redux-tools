# Deploying to Cloudflare Pages

Uses Cloudflare Pages' native Git integration rather than a GitHub Actions workflow --
zero YAML to maintain, no API tokens to store as repo secrets, and per-PR preview
deploys come free. The build itself never runs Python; it copies the committed
`data/v2.65beta/` snapshot into the site and runs `vite build`.

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
- **`prebuild` reaches outside the root directory**, copying `../data/v2.65beta`.
  That is fine -- Cloudflare clones the whole repo and merely runs the build inside
  `web/` -- but it is the least standard thing here, so check it first if a build
  fails.

Nothing pins the Node version (no `.node-version`, no `engines`), so builds take
whatever the Pages image defaults to. Worth pinning if a build ever breaks without a
source change.

## What the build actually does

`npm run build` (in `web/`) runs, via its `prebuild` hook:

```
rm -rf public/data && mkdir -p public/data && cp -r ../data/v2.65beta public/data/
tsc -b && vite build
```

The committed `data/v2.65beta/` snapshot (species/moves/abilities/type-chart JSON plus
sprites, 7,641 files / 10.2MB) is copied straight into the build -- no pipeline run, no
`uv`, no `grpcio-tools`, no Pillow in the Cloudflare build image at all. This is also
why local `npm run dev` and `npm run build` both work identically without ever fetching
from GitHub or running the Python pipeline: the data is already sitting in the repo.

## Verifying a deploy

- Cloudflare's free tier caps a deployment at 20,000 files and 25MiB per file. The
  current build ships **7,641 files / 10.2MB**, of which 7,628 are sprites -- four
  PNGs (front, front-shiny, back, icon) for each of 1,907 species, median 752 bytes.
  Everything that is not a sprite is 13 files.
  (`du` reports ~27MB for the same tree: 7,600 sub-KB files each round up to a 4KB
  filesystem cluster. 10.2MB is the number that gets served.)
- The **file count**, not the size, is the constraint worth watching. A second pinned
  game version roughly doubles the sprites to ~15,300 and a third would breach the
  20,000 cap. If multiple versions ever need to be live at once, sprites have to be
  shared across them (only 79 of 7,628 changed across five months of upstream) or
  moved out to R2.
- `public/_redirects` (`/* /index.html 200`) makes client-side routing
  (`/pokemon/:id`) work on a hard refresh or direct link -- Cloudflare Pages honors it
  automatically once it's in the build output.
- After a deploy, load the `.pages.dev` URL directly at `/pokemon/SPECIES_PIKACHU` (not
  just `/`) to confirm the redirect rule is live, and check the browser console for
  errors on both the list and detail routes.

## Updating the data snapshot

Re-run the pipeline (`cd pipeline && uv run python -m erdata.build`), review the diff
under `data/v2.65beta/`, commit it, and push -- Cloudflare picks up the new snapshot on
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
version differences), which turns a no-op refresh into a 7,600-file diff. Only commit
sprites whose pixels actually changed.
