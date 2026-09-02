# Deploying to Cloudflare Pages

Uses Cloudflare Pages' native Git integration rather than a GitHub Actions workflow --
zero YAML to maintain, no API tokens to store as repo secrets, and per-PR preview
deploys come free. The build itself never runs Python; it copies the committed
`data/v2.65beta/` snapshot into the site and runs `vite build`.

## One-time setup (manual, in the Cloudflare dashboard)

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
preview URL, both free on Cloudflare's Pages plan.

## What the build actually does

`npm run build` (in `web/`) runs, via its `prebuild` hook:

```
rm -rf public/data && mkdir -p public/data && cp -r ../data/v2.65beta public/data/
tsc -b && vite build
```

The committed `data/v2.65beta/` snapshot (species/moves/abilities/type-chart JSON plus
sprites, ~42MB / ~7,600 files) is copied straight into the build -- no pipeline run, no
`uv`, no `grpcio-tools`, no Pillow in the Cloudflare build image at all. This is also
why local `npm run dev` and `npm run build` both work identically without ever fetching
from GitHub or running the Python pipeline: the data is already sitting in the repo.

## Verifying a deploy

- Cloudflare's free tier caps a deployment at 20,000 files and 25MiB per file; the
  current build ships ~7,639 files, none anywhere near 25MiB (sprites are ~1KB each).
  A second pinned game version roughly doubles the sprite count -- still comfortable
  headroom.
- `public/_redirects` (`/* /index.html 200`) makes client-side routing
  (`/pokemon/:id`) work on a hard refresh or direct link -- Cloudflare Pages honors it
  automatically once it's in the build output.
- After a deploy, load the `.pages.dev` URL directly at `/pokemon/SPECIES_PIKACHU` (not
  just `/`) to confirm the redirect rule is live, and check the browser console for
  errors on both the list and detail routes.

## Updating the data snapshot

Re-run the pipeline (`cd pipeline && uv run python -m erdata.build`), review the diff
under `data/v2.65beta/`, commit it, and push -- Cloudflare picks up the new snapshot on
the next build automatically. See the (planned) `refresh-data.yml` workflow for the
automated version of this check.
